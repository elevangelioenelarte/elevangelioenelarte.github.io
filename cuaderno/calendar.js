// Calendarios: importación de .ics (iCloud, Outlook, Google) y conexión opcional a Google Calendar.
import { db, uid, loadSettings } from './db.js';

/* ---------- Parser ICS ---------- */
function unfold(text) {
  return text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '');
}
function unescapeText(v) {
  return (v || '').replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\;/g, ';').replace(/\\\\/g, '\\');
}
function parseDate(value, params) {
  // 20240101 | 20240101T093000 | 20240101T093000Z
  const m = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (!h) return { date: new Date(+y, +mo - 1, +d), allDay: true };
  if (z) return { date: new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +(s || 0))), allDay: false };
  // Con TZID o flotante: lo interpretamos en hora local del dispositivo (suficiente para reuniones locales).
  return { date: new Date(+y, +mo - 1, +d, +h, +mi, +(s || 0)), allDay: false };
}
function parseLine(line) {
  const idx = line.indexOf(':');
  if (idx < 0) return null;
  const left = line.slice(0, idx);
  const value = line.slice(idx + 1);
  const [name, ...paramParts] = left.split(';');
  const params = {};
  paramParts.forEach(p => { const [k, v] = p.split('='); params[k.toUpperCase()] = v; });
  return { name: name.toUpperCase(), params, value };
}

export function parseICS(text, sourceName = 'ics') {
  const lines = unfold(text).split('\n');
  const events = [];
  let cur = null;
  let calName = sourceName;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line === 'BEGIN:VEVENT') { cur = { attendees: [] }; continue; }
    if (line === 'END:VEVENT') { if (cur) events.push(cur); cur = null; continue; }
    const p = parseLine(line);
    if (!p) continue;
    if (!cur) { if (p.name === 'X-WR-CALNAME') calName = p.value; continue; }
    switch (p.name) {
      case 'UID': cur.uid = p.value; break;
      case 'SUMMARY': cur.title = unescapeText(p.value); break;
      case 'DESCRIPTION': cur.description = unescapeText(p.value); break;
      case 'LOCATION': cur.location = unescapeText(p.value); break;
      case 'DTSTART': cur.dtstart = parseDate(p.value, p.params); break;
      case 'DTEND': cur.dtend = parseDate(p.value, p.params); break;
      case 'RRULE': cur.rrule = p.value; break;
      case 'EXDATE': (cur.exdates ||= []).push(...p.value.split(',').map(v => parseDate(v)?.date?.getTime()).filter(Boolean)); break;
      case 'RECURRENCE-ID': cur.recurrenceId = parseDate(p.value)?.date?.getTime(); break;
      case 'STATUS': cur.status = p.value; break;
      case 'ATTENDEE': {
        const cn = p.params.CN ? p.params.CN.replace(/^"|"$/g, '') : p.value.replace(/^mailto:/i, '');
        cur.attendees.push(cn);
        break;
      }
      case 'ORGANIZER': {
        cur.organizer = p.params.CN ? p.params.CN.replace(/^"|"$/g, '') : p.value.replace(/^mailto:/i, '');
        break;
      }
    }
  }
  return { calName, events: events.filter(e => e.dtstart && e.status !== 'CANCELLED') };
}

/* Expansión básica de recurrencias (DAILY/WEEKLY/MONTHLY/YEARLY con INTERVAL, COUNT, UNTIL, BYDAY semanal) */
const DOW = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
function expand(ev, windowStart, windowEnd) {
  const start = ev.dtstart.date;
  const dur = ev.dtend ? ev.dtend.date - start : (ev.dtstart.allDay ? 86400000 : 3600000);
  const out = [];
  const push = (d) => {
    if (ev.exdates && ev.exdates.includes(d.getTime())) return;
    if (d < windowStart - dur || d > windowEnd) return;
    out.push({ start: new Date(d), end: new Date(d.getTime() + dur) });
  };
  if (!ev.rrule) { push(start); return out; }
  const rule = {};
  ev.rrule.split(';').forEach(kv => { const [k, v] = kv.split('='); rule[k] = v; });
  const freq = rule.FREQ;
  const interval = +(rule.INTERVAL || 1);
  const count = rule.COUNT ? +rule.COUNT : Infinity;
  const until = rule.UNTIL ? parseDate(rule.UNTIL)?.date : null;
  let n = 0;
  let cursor = new Date(start);
  const limit = until ? Math.min(until, windowEnd) : windowEnd;
  let guard = 0;
  if (freq === 'WEEKLY' && rule.BYDAY) {
    const days = rule.BYDAY.split(',').map(d => DOW[d.slice(-2)]).filter(d => d !== undefined);
    // semana de inicio
    const weekStart = new Date(start); weekStart.setDate(start.getDate() - start.getDay());
    while (weekStart <= limit && n < count && guard++ < 5000) {
      for (const d of days.sort()) {
        const occ = new Date(weekStart); occ.setDate(weekStart.getDate() + d);
        occ.setHours(start.getHours(), start.getMinutes(), start.getSeconds(), 0);
        if (occ < start) continue;
        if (occ > limit || n >= count) break;
        push(occ); n++;
      }
      weekStart.setDate(weekStart.getDate() + 7 * interval);
    }
    return out;
  }
  while (cursor <= limit && n < count && guard++ < 5000) {
    push(cursor); n++;
    cursor = new Date(cursor);
    if (freq === 'DAILY') cursor.setDate(cursor.getDate() + interval);
    else if (freq === 'WEEKLY') cursor.setDate(cursor.getDate() + 7 * interval);
    else if (freq === 'MONTHLY') cursor.setMonth(cursor.getMonth() + interval);
    else if (freq === 'YEARLY') cursor.setFullYear(cursor.getFullYear() + interval);
    else break;
  }
  return out;
}

/** Convierte un ICS en eventos de la app dentro de una ventana (-30 días, +120 días) */
export function icsToEvents(text, sourceName) {
  const { calName, events } = parseICS(text, sourceName);
  const now = Date.now();
  const windowStart = now - 30 * 86400000;
  const windowEnd = now + 120 * 86400000;
  const overrides = new Set(events.filter(e => e.recurrenceId).map(e => e.uid + '@' + e.recurrenceId));
  const out = [];
  for (const ev of events) {
    const occs = expand(ev, windowStart, windowEnd);
    for (const o of occs) {
      if (!ev.recurrenceId && ev.rrule && overrides.has(ev.uid + '@' + o.start.getTime())) continue;
      out.push({
        id: 'ics:' + (ev.uid || uid()) + ':' + o.start.getTime(),
        uid: ev.uid,
        source: 'ics:' + calName,
        calendarName: calName,
        title: ev.title || '(sin título)',
        description: ev.description || '',
        location: ev.location || '',
        attendees: ev.attendees || [],
        organizer: ev.organizer || '',
        start: o.start.getTime(),
        end: o.end.getTime(),
        allDay: !!ev.dtstart.allDay,
      });
    }
  }
  return out;
}

export async function importICSText(text, sourceName) {
  const evs = icsToEvents(text, sourceName);
  if (!evs.length) throw new Error('No se han encontrado eventos en ese calendario.');
  const src = evs[0].source;
  // Reemplaza los eventos anteriores de la misma fuente
  const old = await db.byIndex('events', 'source', src);
  if (old.length) await db.delMany('events', old.map(e => e.id));
  await db.putMany('events', evs);
  return { count: evs.length, calendarName: evs[0].calendarName };
}

export async function importICSUrl(url) {
  const res = await fetch(url.replace(/^webcal:/i, 'https:'), { mode: 'cors' });
  if (!res.ok) throw new Error('No se pudo descargar el calendario (' + res.status + ').');
  const text = await res.text();
  let name = 'suscripción';
  try { name = new URL(url).hostname; } catch {}
  return importICSText(text, name);
}

/* ---------- Google Calendar (opcional, requiere un ID de cliente OAuth propio) ---------- */
let gisLoaded = null;
function loadGIS() {
  if (gisLoaded) return gisLoaded;
  gisLoaded = new Promise((resolve, reject) => {
    if (window.google?.accounts?.oauth2) return resolve();
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('No se pudo cargar Google Identity.'));
    document.head.appendChild(s);
  });
  return gisLoaded;
}

export async function syncGoogleCalendar() {
  const { googleClientId } = loadSettings();
  if (!googleClientId) throw new Error('Añade tu ID de cliente de Google en Ajustes.');
  await loadGIS();
  const token = await new Promise((resolve, reject) => {
    const client = google.accounts.oauth2.initTokenClient({
      client_id: googleClientId,
      scope: 'https://www.googleapis.com/auth/calendar.readonly',
      callback: (r) => r.access_token ? resolve(r.access_token) : reject(new Error('Google no concedió acceso.')),
      error_callback: (e) => reject(new Error(e.message || 'Google canceló el acceso.')),
    });
    client.requestAccessToken({ prompt: '' });
  });
  const timeMin = new Date(Date.now() - 30 * 86400000).toISOString();
  const timeMax = new Date(Date.now() + 120 * 86400000).toISOString();
  const listRes = await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList', { headers: { Authorization: 'Bearer ' + token } });
  if (!listRes.ok) throw new Error('Google Calendar respondió ' + listRes.status);
  const list = await listRes.json();
  const calendars = (list.items || []).filter(c => c.selected !== false);
  const all = [];
  for (const cal of calendars) {
    const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal.id)}/events`);
    url.search = new URLSearchParams({ timeMin, timeMax, singleEvents: 'true', orderBy: 'startTime', maxResults: '500' }).toString();
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    if (!r.ok) continue;
    const j = await r.json();
    for (const e of j.items || []) {
      if (e.status === 'cancelled') continue;
      const allDay = !!e.start?.date;
      const start = new Date(e.start?.dateTime || e.start?.date).getTime();
      const end = new Date(e.end?.dateTime || e.end?.date).getTime();
      all.push({
        id: 'google:' + e.id,
        uid: e.iCalUID || e.id,
        source: 'google',
        calendarName: cal.summary || 'Google',
        title: e.summary || '(sin título)',
        description: e.description || '',
        location: e.location || '',
        attendees: (e.attendees || []).map(a => a.displayName || a.email),
        organizer: e.organizer?.displayName || e.organizer?.email || '',
        start, end, allDay,
        link: e.hangoutLink || '',
      });
    }
  }
  const old = await db.byIndex('events', 'source', 'google');
  if (old.length) await db.delMany('events', old.map(e => e.id));
  await db.putMany('events', all);
  return { count: all.length, calendars: calendars.length };
}

/* ---------- Consultas ---------- */
export async function eventsBetween(from, to) {
  const all = await db.all('events');
  return all.filter(e => e.end >= from && e.start <= to).sort((a, b) => a.start - b.start);
}
export function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
}
export function fmtDateLong(ts) {
  return new Date(ts).toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
}
