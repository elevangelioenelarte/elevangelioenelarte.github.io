// Utilidades de interfaz: toasts, menús, diálogos, markdown.
const $ = (sel, root = document) => root.querySelector(sel);
export { $ };
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let toastTimer = null;
export function toast(msg, type = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast ' + type;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, type === 'error' ? 5000 : 2600);
}

export function showMenu(anchorOrPoint, items) {
  const menu = $('#ctx-menu');
  menu.innerHTML = '';
  for (const it of items) {
    if (it === '-') { menu.appendChild(document.createElement('hr')); continue; }
    const b = document.createElement('button');
    b.innerHTML = (it.icon || '') + '<span>' + esc(it.label) + '</span>';
    if (it.danger) b.classList.add('danger');
    b.addEventListener('click', () => { hideMenu(); it.onClick(); });
    menu.appendChild(b);
  }
  menu.hidden = false;
  let x, y;
  if (anchorOrPoint instanceof Element) {
    const r = anchorOrPoint.getBoundingClientRect();
    x = r.left; y = r.bottom + 6;
  } else { x = anchorOrPoint.x; y = anchorOrPoint.y; }
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  x = Math.min(x, window.innerWidth - mw - 8); y = Math.min(y, window.innerHeight - mh - 8);
  menu.style.left = Math.max(8, x) + 'px'; menu.style.top = Math.max(8, y) + 'px';
  setTimeout(() => {
    document.addEventListener('pointerdown', onDocDown, { once: true, capture: true });
  }, 0);
  function onDocDown(e) { if (!menu.contains(e.target)) hideMenu(); else document.addEventListener('pointerdown', onDocDown, { once: true, capture: true }); }
}
export function hideMenu() { $('#ctx-menu').hidden = true; }

export function promptText(title, value = '', okLabel = 'Aceptar') {
  return new Promise(resolve => {
    const dlg = $('#dlg-prompt');
    $('#prompt-title').textContent = title;
    const input = $('#prompt-input');
    input.value = value;
    $('#prompt-ok').textContent = okLabel;
    const onClose = () => { dlg.removeEventListener('close', onClose); resolve(dlg.returnValue === 'ok' ? input.value.trim() : null); };
    dlg.addEventListener('close', onClose);
    dlg.showModal();
    setTimeout(() => { input.focus(); input.select(); }, 50);
  });
}

export function confirmDlg(msg) { return Promise.resolve(window.confirm(msg)); }

/* Markdown mínimo y seguro */
function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}
export function md(text) {
  const lines = String(text || '').split('\n');
  let html = '', list = null, para = [], table = null;
  const flushPara = () => { if (para.length) { html += '<p>' + inline(para.join(' ')) + '</p>'; para = []; } };
  const closeList = () => { if (list) { html += `</${list}>`; list = null; } };
  const closeTable = () => { if (table) { html += '</tbody></table>'; table = null; } };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    let m;
    if (/^\s*\|.*\|\s*$/.test(line)) {
      flushPara(); closeList();
      const cells = line.trim().slice(1, -1).split('|').map(c => c.trim());
      if (cells.every(c => /^:?-{2,}:?$/.test(c))) continue;
      if (!table) { table = true; html += '<table><thead><tr>' + cells.map(c => '<th>' + inline(c) + '</th>').join('') + '</tr></thead><tbody>'; }
      else html += '<tr>' + cells.map(c => '<td>' + inline(c) + '</td>').join('') + '</tr>';
      continue;
    }
    closeTable();
    if ((m = line.match(/^(#{1,3})\s+(.*)/))) { flushPara(); closeList(); html += `<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`; continue; }
    if ((m = line.match(/^\s*[-*•]\s+\[( |x|X)\]\s+(.*)/))) { flushPara(); if (list !== 'ul') { closeList(); list = 'ul'; html += '<ul>'; } html += `<li>${m[1] === ' ' ? '☐' : '☑'} ${inline(m[2])}</li>`; continue; }
    if ((m = line.match(/^\s*[-*•]\s+(.*)/))) { flushPara(); if (list !== 'ul') { closeList(); list = 'ul'; html += '<ul>'; } html += `<li>${inline(m[1])}</li>`; continue; }
    if ((m = line.match(/^\s*\d+[.)]\s+(.*)/))) { flushPara(); if (list !== 'ol') { closeList(); list = 'ol'; html += '<ol>'; } html += `<li>${inline(m[1])}</li>`; continue; }
    if ((m = line.match(/^>\s?(.*)/))) { flushPara(); closeList(); html += `<blockquote>${inline(m[1])}</blockquote>`; continue; }
    if (!line.trim()) { flushPara(); closeList(); continue; }
    closeList(); para.push(line);
  }
  flushPara(); closeList(); closeTable();
  return html;
}

export function relTime(ts) {
  const d = new Date(ts), now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'Ayer';
  if (now - d < 6 * 86400000) return d.toLocaleDateString('es-ES', { weekday: 'long' });
  return d.toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });
}

export function fmtDuration(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return (h ? h + ':' : '') + String(m).padStart(h ? 2 : 1, '0') + ':' + String(ss).padStart(2, '0');
}

export function download(filename, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}

export const ICONS = {
  folder: '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  note: '<svg viewBox="0 0 24 24"><path d="M6 3h9l5 5v13H6z"/><path d="M15 3v5h5M9 13h6M9 17h6"/></svg>',
  mic: '<svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
  edit: '<svg viewBox="0 0 24 24"><path d="M4 20l4-1 11-11-3-3L5 16z"/></svg>',
  move: '<svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  spark: '<svg viewBox="0 0 24 24"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/></svg>',
  cal: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>',
  copy: '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a1 1 0 0 1 1-1h10"/></svg>',
  share: '<svg viewBox="0 0 24 24"><path d="M12 3v12M8 7l4-4 4 4M5 13v6a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-6"/></svg>',
  pin: '<svg viewBox="0 0 24 24"><path d="M9 4h6l-1 6 3 3v2H7v-2l3-3z"/><path d="M12 15v6"/></svg>',
};
