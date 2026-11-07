// Cuaderno — controlador principal
import { db, uid, loadSettings, saveSettings, exportBackup, importBackup, storageEstimate, persistStorage } from './db.js';
import { $, $$, esc, toast, showMenu, promptText, confirmDlg, md, relTime, fmtDuration, download, ICONS } from './ui.js';
import { InkCanvas, strokesToPNG } from './ink.js';
import { handwritingToText, secretary, askAboutNote, hasKey, SECRETARY_LABELS, ClaudeError } from './claude.js';
import { LiveRecorder } from './live.js';
import { importICSText, importICSUrl, syncGoogleCalendar, eventsBetween, dayKey, fmtTime, fmtDateLong } from './calendar.js';

const state = {
  settings: loadSettings(),
  folders: [],
  openFolders: new Set(JSON.parse(localStorage.getItem('cuaderno.open') || '[]')),
  folderId: null,
  noteId: null,
  note: null,
  pages: [],
  view: 'home',
  tool: { tool: 'pen', color: '#1f1b14', width: 2.5 },
  undo: [], redo: [],
  canvases: new Map(), // pageId -> InkCanvas
  activePageId: null,
  search: '',
  live: null, // sesión en curso o abierta
  saveTimers: new Map(),
};

const app = $('#app');

/* =====================================================================
   Arranque
===================================================================== */
async function init() {
  if ('serviceWorker' in navigator) { try { navigator.serviceWorker.register('./sw.js'); } catch {} }
  persistStorage();
  applySettingsToUI();
  state.folders = await db.all('folders');
  if (!state.folders.length) {
    const f = { id: uid(), parentId: null, name: 'General', createdAt: Date.now(), order: 0 };
    const r = { id: uid(), parentId: null, name: 'Reuniones', createdAt: Date.now(), order: 1 };
    await db.putMany('folders', [f, r]);
    state.folders = [f, r];
  }
  bindGlobal();
  renderTree();
  setView('home');
  if (!state.settings.apiKey) setTimeout(() => toast('Añade tu clave de API de Anthropic en Ajustes para activar a Claude.'), 1200);
}

function applySettingsToUI() {
  const s = state.settings;
  $('#set-apikey').value = s.apiKey || '';
  $('#set-model').value = s.model || 'claude-fable-5-1';
  $('#set-persona').value = s.persona || '';
  $('#set-pencil-only').checked = !!s.pencilOnly;
  $('#set-paper').value = s.paper || 'ruled';
  $('#set-lang').value = s.lang || 'es-ES';
  $('#set-auto-summary').value = String(s.autoSummaryMin ?? 5);
  $('#set-google-client').value = s.googleClientId || '';
}

function readSettingsFromUI() {
  const s = { ...state.settings };
  s.apiKey = $('#set-apikey').value.trim();
  s.model = $('#set-model').value;
  s.persona = $('#set-persona').value.trim();
  s.pencilOnly = $('#set-pencil-only').checked;
  s.paper = $('#set-paper').value;
  s.lang = $('#set-lang').value;
  s.autoSummaryMin = +$('#set-auto-summary').value;
  s.googleClientId = $('#set-google-client').value.trim();
  return s;
}

/* =====================================================================
   Navegación
===================================================================== */
function setView(view) {
  state.view = view;
  app.dataset.view = view;
  $$('.nav-item[data-nav]').forEach(b => b.classList.toggle('active', b.dataset.nav === view || (view === 'note' && false)));
  closeSidebar();
  if (view === 'home') renderHome();
  if (view === 'agenda') renderAgenda();
  if (view === 'live') renderLive();
}
function openSidebar() { app.classList.add('sidebar-open'); }
function closeSidebar() { app.classList.remove('sidebar-open'); }

function bindGlobal() {
  $$('.nav-item[data-nav]').forEach(b => b.addEventListener('click', () => { state.noteId = null; setView(b.dataset.nav); renderTree(); }));
  $('#btn-sidebar-open').addEventListener('click', openSidebar);
  $('#btn-sidebar-close').addEventListener('click', closeSidebar);
  $('#scrim').addEventListener('click', closeSidebar);
  $('#btn-settings').addEventListener('click', openSettings);
  $('#btn-new-root-folder').addEventListener('click', () => newFolder(null));
  $('#btn-new-note').addEventListener('click', () => newNote());
  $('#btn-folder-menu').addEventListener('click', (e) => folderMenu(e.currentTarget, state.folderId));
  $('#btn-back-list').addEventListener('click', () => { app.dataset.view = 'list'; });
  $('#search').addEventListener('input', (e) => { state.search = e.target.value.trim(); if (state.search) { state.folderId = null; app.dataset.view = state.view === 'note' ? 'note' : 'list'; if (state.view !== 'note') { state.view = 'list'; } renderList(); renderTree(); } else renderList(); });

  // Botón flotante de menú en vistas sin columna de lista (pantallas estrechas)
  const fab = document.createElement('button');
  fab.className = 'main-menu-btn'; fab.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h16"/></svg>';
  fab.addEventListener('click', openSidebar);
  app.appendChild(fab);

  // Ajustes
  $('#btn-settings-save').addEventListener('click', () => {
    state.settings = readSettingsFromUI();
    saveSettings(state.settings);
    toast('Ajustes guardados');
    if (state.view === 'note') renderPages();
  });
  $('#btn-export').addEventListener('click', async () => {
    const data = await exportBackup();
    download(`cuaderno-${new Date().toISOString().slice(0, 10)}.json`, new Blob([JSON.stringify(data)], { type: 'application/json' }));
  });
  $('#btn-import').addEventListener('click', () => $('#file-import').click());
  $('#file-import').addEventListener('change', async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try { await importBackup(JSON.parse(await f.text())); state.folders = await db.all('folders'); renderTree(); renderList(); toast('Copia importada'); }
    catch (err) { toast(err.message, 'error'); }
    e.target.value = '';
  });

  // Editor
  $$('#toolbar .tool[data-tool]').forEach(b => b.addEventListener('click', () => setTool(b.dataset.tool)));
  $$('#colors .swatch').forEach(b => b.addEventListener('click', () => { state.tool.color = b.dataset.color; if (state.tool.tool === 'eraser' || state.tool.tool === 'text') setTool('pen'); syncToolbar(); }));
  $$('#widths .width').forEach(b => b.addEventListener('click', () => { state.tool.width = +b.dataset.width; if (state.tool.tool === 'eraser' || state.tool.tool === 'text') setTool('pen'); syncToolbar(); }));
  $('#btn-undo').addEventListener('click', undo);
  $('#btn-redo').addEventListener('click', redo);
  $('#btn-add-page').addEventListener('click', () => addPage());
  $('#btn-convert').addEventListener('click', () => convertPage(state.activePageId || state.pages[0]?.id));
  $('#note-title').addEventListener('input', (e) => { if (!state.note) return; state.note.title = e.target.value; scheduleSave('note'); });
  $('#btn-note-menu').addEventListener('click', (e) => noteMenu(e.currentTarget));
  $('#dlg-convert-close').addEventListener('click', () => { convertAbort && convertAbort.abort(); $('#dlg-convert').close(); });
  $('#dlg-move-close').addEventListener('click', () => $('#dlg-move').close());

  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod || state.view !== 'note') return;
    const tag = document.activeElement?.tagName;
    const editing = tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable;
    if (editing) return;
    if (e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
    else if ((e.key === 'z' && e.shiftKey) || e.key === 'y') { e.preventDefault(); redo(); }
  });
  window.addEventListener('beforeunload', (e) => { if (state.live?.recorder?.running) { e.preventDefault(); e.returnValue = ''; } });
  syncToolbar();
}

function openSettings() {
  applySettingsToUI();
  storageEstimate().then(est => {
    if (est) $('#storage-info').textContent = `Usados ${(est.usage / 1048576).toFixed(1)} MB de ${(est.quota / 1073741824).toFixed(1)} GB disponibles en este dispositivo.`;
  });
  $('#dlg-settings').showModal();
}

/* =====================================================================
   Carpetas
===================================================================== */
function childrenOf(parentId) {
  return state.folders.filter(f => (f.parentId || null) === parentId).sort((a, b) => (a.order - b.order) || a.name.localeCompare(b.name));
}
function folderPath(id) {
  const parts = []; let f = state.folders.find(x => x.id === id);
  while (f) { parts.unshift(f.name); f = state.folders.find(x => x.id === f.parentId); }
  return parts;
}
function descendants(id) {
  const out = [];
  const walk = (pid) => childrenOf(pid).forEach(c => { out.push(c.id); walk(c.id); });
  walk(id);
  return out;
}

async function renderTree() {
  const tree = $('#tree');
  const counts = {};
  (await db.all('notes')).forEach(n => { counts[n.folderId] = (counts[n.folderId] || 0) + 1; });
  tree.innerHTML = '';
  const build = (parentId, container) => {
    for (const f of childrenOf(parentId)) {
      const kids = childrenOf(f.id);
      const node = document.createElement('div');
      node.className = 'tree-node' + (state.folderId === f.id && !state.search ? ' active' : '') + (state.openFolders.has(f.id) ? ' open' : '');
      node.innerHTML = `<span class="twisty${kids.length ? '' : ' empty'}"><svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg></span>${ICONS.folder.replace('<svg', '<svg class="folder"')}<span class="fname">${esc(f.name)}</span><span class="fcount">${counts[f.id] || ''}</span>`;
      node.querySelector('.twisty').addEventListener('click', (e) => { e.stopPropagation(); toggleFolder(f.id); });
      node.addEventListener('click', () => openFolder(f.id));
      node.addEventListener('contextmenu', (e) => { e.preventDefault(); folderMenu({ x: e.clientX, y: e.clientY }, f.id); });
      let pressTimer; node.addEventListener('pointerdown', (e) => { if (e.pointerType === 'mouse') return; pressTimer = setTimeout(() => folderMenu({ x: e.clientX, y: e.clientY }, f.id), 550); });
      node.addEventListener('pointerup', () => clearTimeout(pressTimer)); node.addEventListener('pointermove', () => clearTimeout(pressTimer));
      container.appendChild(node);
      if (kids.length) {
        const ch = document.createElement('div'); ch.className = 'tree-children'; ch.hidden = !state.openFolders.has(f.id);
        build(f.id, ch); container.appendChild(ch);
      }
    }
  };
  build(null, tree);
  if (!state.folders.length) tree.innerHTML = '<div class="tree-empty">Crea tu primera carpeta con el botón +.</div>';
}
function toggleFolder(id) {
  state.openFolders.has(id) ? state.openFolders.delete(id) : state.openFolders.add(id);
  localStorage.setItem('cuaderno.open', JSON.stringify([...state.openFolders]));
  renderTree();
}
function openFolder(id) {
  state.folderId = id; state.search = ''; $('#search').value = '';
  state.openFolders.add(id);
  let p = state.folders.find(f => f.id === id)?.parentId; while (p) { state.openFolders.add(p); p = state.folders.find(f => f.id === p)?.parentId; }
  if (state.view !== 'note' || !state.note || state.note.folderId !== id) { state.view = 'list'; app.dataset.view = 'list'; state.noteId = null; }
  $$('.nav-item[data-nav]').forEach(b => b.classList.remove('active'));
  closeSidebar();
  renderTree(); renderList();
}
async function newFolder(parentId) {
  const name = await promptText(parentId ? 'Nueva subcarpeta' : 'Nueva carpeta', '', 'Crear');
  if (!name) return;
  const f = { id: uid(), parentId: parentId || null, name, createdAt: Date.now(), order: childrenOf(parentId || null).length };
  await db.put('folders', f); state.folders.push(f);
  if (parentId) state.openFolders.add(parentId);
  openFolder(f.id);
}
function folderMenu(anchor, id) {
  const f = state.folders.find(x => x.id === id);
  const items = [];
  if (f) {
    items.push({ icon: ICONS.folder, label: 'Nueva subcarpeta', onClick: () => newFolder(id) });
    items.push({ icon: ICONS.note, label: 'Nueva nota aquí', onClick: () => { state.folderId = id; newNote(); } });
    items.push('-');
    items.push({ icon: ICONS.edit, label: 'Renombrar', onClick: async () => { const n = await promptText('Renombrar carpeta', f.name, 'Guardar'); if (n) { f.name = n; await db.put('folders', f); renderTree(); renderList(); } } });
    items.push({ icon: ICONS.move, label: 'Mover a…', onClick: () => pickFolder(async (target) => { if (target === id || descendants(id).includes(target)) return toast('No se puede mover dentro de sí misma', 'error'); f.parentId = target; await db.put('folders', f); renderTree(); }, { allowRoot: true, exclude: [id, ...descendants(id)] }) });
    items.push({ icon: ICONS.trash, label: 'Eliminar carpeta', danger: true, onClick: () => deleteFolder(id) });
  } else {
    items.push({ icon: ICONS.folder, label: 'Nueva carpeta', onClick: () => newFolder(null) });
  }
  showMenu(anchor, items);
}
async function deleteFolder(id) {
  const ids = [id, ...descendants(id)];
  const notes = (await db.all('notes')).filter(n => ids.includes(n.folderId));
  const ok = await confirmDlg(`¿Eliminar la carpeta y su contenido? Se borrarán ${ids.length - 1} subcarpetas y ${notes.length} notas.`);
  if (!ok) return;
  for (const n of notes) await deleteNoteData(n.id);
  await db.delMany('folders', ids);
  state.folders = state.folders.filter(f => !ids.includes(f.id));
  if (ids.includes(state.folderId)) { state.folderId = null; setView('home'); }
  renderTree(); renderList();
}
function pickFolder(onPick, { allowRoot = false, exclude = [] } = {}) {
  const list = $('#move-list'); list.innerHTML = '';
  if (allowRoot) { const b = document.createElement('button'); b.innerHTML = ICONS.folder + '<span>Nivel superior</span>'; b.addEventListener('click', () => { $('#dlg-move').close(); onPick(null); }); list.appendChild(b); }
  const walk = (pid, depth) => {
    for (const f of childrenOf(pid)) {
      if (exclude.includes(f.id)) continue;
      const b = document.createElement('button'); b.style.paddingLeft = (10 + depth * 18) + 'px';
      b.innerHTML = ICONS.folder + '<span>' + esc(f.name) + '</span>';
      b.addEventListener('click', () => { $('#dlg-move').close(); onPick(f.id); });
      list.appendChild(b); walk(f.id, depth + 1);
    }
  };
  walk(null, 0);
  $('#dlg-move').showModal();
}

/* =====================================================================
   Lista de notas
===================================================================== */
let listTimer = null;
function renderListSoon() { clearTimeout(listTimer); listTimer = setTimeout(renderList, 400); }

async function renderList() {
  const list = $('#note-list');
  let notes;
  if (state.search) {
    const q = state.search.toLowerCase();
    const all = await db.all('notes');
    const sessions = await db.all('sessions');
    const sessText = {}; sessions.forEach(s => { sessText[s.noteId] = (s.transcript || []).map(t => t.text).join(' ') + ' ' + Object.values(s.outputs || {}).join(' '); });
    notes = all.filter(n => (n.title || '').toLowerCase().includes(q) || (n.text || '').toLowerCase().includes(q) || (sessText[n.id] || '').toLowerCase().includes(q));
    $('#list-title').textContent = `Resultados · ${notes.length}`;
  } else if (state.folderId) {
    notes = await db.byIndex('notes', 'folderId', state.folderId);
    $('#list-title').textContent = folderPath(state.folderId).join(' / ');
  } else {
    notes = await db.all('notes');
    $('#list-title').textContent = 'Todas las notas';
  }
  notes.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.updatedAt - a.updatedAt);
  list.innerHTML = '';
  if (!notes.length) {
    list.innerHTML = state.search ? '<div class="list-empty">Nada coincide con esa búsqueda.</div>' : '<div class="list-empty"><b>Carpeta vacía</b><br>Crea una nota y empieza a escribir con el lápiz.</div>';
    return;
  }
  for (const n of notes) {
    const b = document.createElement('button');
    b.className = 'note-card' + (n.id === state.noteId ? ' active' : '');
    const snippet = (n.text || n.summary || '').replace(/[#*>\-]/g, ' ').trim().slice(0, 140);
    b.innerHTML = `<div class="t">${n.kind === 'session' ? ICONS.mic : ''}${n.pinned ? ICONS.pin : ''}<span>${esc(n.title || 'Sin título')}</span></div>
      ${snippet ? `<div class="s">${esc(snippet)}</div>` : ''}
      <div class="m"><span>${relTime(n.updatedAt)}</span>${n.pageCount ? `<span>${n.pageCount} pág.</span>` : ''}${n.eventTitle ? `<span class="ev">${esc(n.eventTitle)}</span>` : ''}${state.search || !state.folderId ? `<span>${esc(folderPath(n.folderId).join('/'))}</span>` : ''}</div>`;
    b.addEventListener('click', () => openNote(n.id));
    b.addEventListener('contextmenu', (e) => { e.preventDefault(); noteMenu({ x: e.clientX, y: e.clientY }, n); });
    let pressTimer; b.addEventListener('pointerdown', (e) => { if (e.pointerType === 'mouse') return; pressTimer = setTimeout(() => noteMenu({ x: e.clientX, y: e.clientY }, n), 550); });
    b.addEventListener('pointerup', () => clearTimeout(pressTimer)); b.addEventListener('pointermove', () => clearTimeout(pressTimer));
    list.appendChild(b);
  }
}

/* =====================================================================
   Notas
===================================================================== */
async function newNote({ folderId, title, eventObj, kind = 'note' } = {}) {
  const fid = folderId || state.folderId || state.folders[0]?.id;
  if (!fid) return toast('Crea primero una carpeta', 'error');
  const now = Date.now();
  const note = { id: uid(), folderId: fid, title: title || '', kind, text: '', createdAt: now, updatedAt: now, pageCount: 1 };
  if (eventObj) { note.eventId = eventObj.id; note.eventTitle = eventObj.title; note.eventStart = eventObj.start; if (!title) note.title = eventObj.title; }
  await db.put('notes', note);
  const page = { id: uid(), noteId: note.id, index: 0, strokes: [], text: '' };
  await db.put('pages', page);
  state.folderId = fid;
  renderTree();
  await openNote(note.id);
  return note;
}

async function openNote(id) {
  const note = await db.get('notes', id);
  if (!note) return;
  if (note.kind === 'session') return openSessionNote(note);
  flushSaves();
  state.noteId = id; state.note = note;
  state.view = 'note'; app.dataset.view = 'note';
  state.undo = []; state.redo = [];
  $$('.nav-item[data-nav]').forEach(b => b.classList.remove('active'));
  $('#note-title').value = note.title || '';
  renderNoteMeta();
  state.pages = (await db.byIndex('pages', 'noteId', id)).sort((a, b) => a.index - b.index);
  if (!state.pages.length) { const p = { id: uid(), noteId: id, index: 0, strokes: [], text: '' }; await db.put('pages', p); state.pages = [p]; }
  state.activePageId = state.pages[0].id;
  renderPages();
  renderList();
}

function renderNoteMeta() {
  const n = state.note; const meta = $('#note-meta');
  meta.innerHTML = '';
  if (n.eventTitle) {
    const c = document.createElement('span'); c.className = 'chip'; c.innerHTML = ICONS.cal + esc(n.eventTitle);
    c.title = 'Ver en agenda'; c.addEventListener('click', () => setView('agenda')); meta.appendChild(c);
  }
  const s = document.createElement('span'); s.textContent = relTime(n.updatedAt); meta.appendChild(s);
}

function scheduleSave(what, pageId) {
  const key = what + (pageId || '');
  clearTimeout(state.saveTimers.get(key));
  state.saveTimers.set(key, setTimeout(() => doSave(what, pageId), 500));
}
async function doSave(what, pageId) {
  if (!state.note) return;
  state.note.updatedAt = Date.now();
  state.note.pageCount = state.pages.length;
  if (what === 'page') {
    const p = state.pages.find(x => x.id === pageId); if (p) await db.put('pages', p);
    state.note.text = state.pages.map(p => p.text || '').filter(Boolean).join('\n\n');
  }
  await db.put('notes', state.note);
  renderList();
}
function flushSaves() {
  for (const [key, t] of state.saveTimers) { clearTimeout(t); const what = key.startsWith('page') ? 'page' : 'note'; doSave(what, key.slice(4)); }
  state.saveTimers.clear();
}

async function deleteNoteData(id) {
  const pages = await db.byIndex('pages', 'noteId', id);
  await db.delMany('pages', pages.map(p => p.id));
  const sessions = await db.byIndex('sessions', 'noteId', id);
  for (const s of sessions) { if (s.audioId) await db.del('audio', s.audioId); }
  await db.delMany('sessions', sessions.map(s => s.id));
  await db.del('notes', id);
}

function noteMenu(anchor, note = state.note) {
  if (!note) return;
  const items = [
    { icon: ICONS.edit, label: 'Renombrar', onClick: async () => { const t = await promptText('Título', note.title || '', 'Guardar'); if (t !== null) { note.title = t; note.updatedAt = Date.now(); await db.put('notes', note); if (state.note?.id === note.id) $('#note-title').value = t; renderList(); } } },
    { icon: ICONS.pin, label: note.pinned ? 'Desfijar' : 'Fijar arriba', onClick: async () => { note.pinned = !note.pinned; await db.put('notes', note); renderList(); } },
    { icon: ICONS.move, label: 'Mover a carpeta…', onClick: () => pickFolder(async (fid) => { note.folderId = fid; await db.put('notes', note); renderTree(); renderList(); toast('Nota movida'); }) },
    { icon: ICONS.cal, label: note.eventId ? 'Cambiar reunión vinculada…' : 'Vincular a una reunión…', onClick: () => linkNoteToEvent(note) },
    '-',
  ];
  if (note.kind !== 'session') {
    items.push({ icon: ICONS.spark, label: 'Convertir todas las páginas a texto', onClick: () => convertAllPages() });
    items.push({ icon: ICONS.spark, label: 'Preguntar a Claude sobre esta nota', onClick: () => askNote() });
  }
  items.push({ icon: ICONS.share, label: 'Compartir / exportar texto', onClick: () => shareNoteText(note) });
  items.push('-');
  items.push({ icon: ICONS.trash, label: 'Eliminar nota', danger: true, onClick: async () => {
    if (!(await confirmDlg('¿Eliminar esta nota?'))) return;
    await deleteNoteData(note.id);
    if (state.noteId === note.id) { state.noteId = null; state.note = null; app.dataset.view = 'list'; state.view = 'list'; }
    renderTree(); renderList();
  } });
  showMenu(anchor, items);
}

async function shareNoteText(note) {
  let text = '';
  if (note.kind === 'session') {
    const s = (await db.byIndex('sessions', 'noteId', note.id))[0];
    text = sessionToMarkdown(note, s);
  } else {
    const pages = (await db.byIndex('pages', 'noteId', note.id)).sort((a, b) => a.index - b.index);
    text = `# ${note.title || 'Sin título'}\n\n` + pages.map((p, i) => p.text ? p.text : '').filter(Boolean).join('\n\n---\n\n');
  }
  if (navigator.share) { try { await navigator.share({ title: note.title || 'Nota', text }); return; } catch (e) { if (e.name === 'AbortError') return; } }
  download((note.title || 'nota').replace(/[\\/:*?"<>|]/g, '') + '.md', new Blob([text], { type: 'text/markdown' }));
}

async function linkNoteToEvent(note) {
  const evs = await eventsBetween(Date.now() - 7 * 86400000, Date.now() + 30 * 86400000);
  if (!evs.length) return toast('No hay reuniones en la agenda. Importa un calendario primero.', 'error');
  const list = $('#move-list'); list.innerHTML = '';
  $('#dlg-move h3').textContent = 'Vincular a reunión';
  for (const e of evs) {
    const b = document.createElement('button');
    b.innerHTML = ICONS.cal + `<span>${esc(e.title)}<small>${fmtDateLong(e.start)} · ${e.allDay ? 'todo el día' : fmtTime(e.start)}</small></span>`;
    b.addEventListener('click', async () => {
      $('#dlg-move').close(); $('#dlg-move h3').textContent = 'Mover a carpeta';
      note.eventId = e.id; note.eventTitle = e.title; note.eventStart = e.start; await db.put('notes', note);
      if (state.note?.id === note.id) { state.note = note; renderNoteMeta(); }
      renderList(); toast('Nota vinculada a la reunión');
    });
    list.appendChild(b);
  }
  $('#dlg-move').showModal();
  $('#dlg-move').addEventListener('close', () => { $('#dlg-move h3').textContent = 'Mover a carpeta'; }, { once: true });
}

/* =====================================================================
   Editor de páginas (tinta)
===================================================================== */
function setTool(tool) {
  state.tool.tool = tool;
  syncToolbar();
  $$('.page').forEach(p => p.classList.toggle('text-mode', tool === 'text'));
}
function syncToolbar() {
  $$('#toolbar .tool[data-tool]').forEach(b => b.classList.toggle('active', b.dataset.tool === state.tool.tool));
  $$('#colors .swatch').forEach(b => b.classList.toggle('active', b.dataset.color === state.tool.color));
  $$('#widths .width').forEach(b => b.classList.toggle('active', +b.dataset.width === state.tool.width));
  $('#toolbar').classList.toggle('text-mode', state.tool.tool === 'text');
  $('#btn-undo').disabled = !state.undo.length;
  $('#btn-redo').disabled = !state.redo.length;
}

let pagesRO = null;
function renderPages() {
  const wrap = $('#pages');
  for (const c of state.canvases.values()) c.destroy();
  state.canvases.clear();
  wrap.innerHTML = '';
  state.pages.forEach((p, i) => wrap.appendChild(buildPage(p, i)));
  if (!pagesRO) {
    pagesRO = new ResizeObserver(() => updateLineHeights());
    pagesRO.observe(wrap);
    wrap.addEventListener('scroll', () => { clearTimeout(wrap._st); wrap._st = setTimeout(updateActivePage, 120); }, { passive: true });
  }
  updateLineHeights();
  setTool(state.tool.tool);
}
function updateLineHeights() {
  $$('.page').forEach(p => { p.style.setProperty('--lh', (p.clientWidth / 26) + 'px'); });
}
function updateActivePage() {
  const wrap = $('#pages'); const mid = wrap.getBoundingClientRect().top + wrap.clientHeight / 2;
  let best = null, bd = Infinity;
  $$('.page').forEach(p => { const r = p.getBoundingClientRect(); const d = Math.abs((r.top + r.bottom) / 2 - mid); if (d < bd) { bd = d; best = p; } });
  if (best) state.activePageId = best.dataset.id;
}

function buildPage(page, index) {
  const el = document.createElement('div');
  el.className = 'page' + (state.settings.pencilOnly ? ' pen-only' : ' touch-draw');
  el.dataset.id = page.id; el.dataset.paper = state.settings.paper || 'ruled';
  el.innerHTML = `<div class="paper"></div><canvas></canvas><div class="typed" contenteditable="true" data-placeholder="" spellcheck="true"></div><span class="pnum">${index + 1}</span><button class="icon-btn pdel" title="Eliminar página">${ICONS.trash}</button>`;
  const typed = el.querySelector('.typed');
  typed.textContent = page.text || '';
  typed.addEventListener('input', () => { page.text = typed.innerText.replace(/\n\n$/, '\n'); scheduleSave('page', page.id); });
  typed.addEventListener('focus', () => { state.activePageId = page.id; });
  el.querySelector('.pdel').addEventListener('click', () => deletePage(page.id));
  const canvas = el.querySelector('canvas');
  const ink = new InkCanvas(canvas, {
    getStrokes: () => page.strokes,
    getTool: () => state.tool,
    pencilOnly: () => !!state.settings.pencilOnly,
    onStrokeAdded: (stroke) => {
      page.strokes.push(stroke);
      state.undo.push({ pageId: page.id, type: 'add', stroke }); state.redo = [];
      if (state.undo.length > 100) state.undo.shift();
      state.activePageId = page.id;
      scheduleSave('page', page.id); syncToolbar();
    },
    onStrokesRemoved: (removed) => {
      state.undo.push({ pageId: page.id, type: 'remove', removed }); state.redo = [];
      state.activePageId = page.id;
      scheduleSave('page', page.id); syncToolbar();
    },
  });
  state.canvases.set(page.id, ink);
  return el;
}

function undo() {
  const op = state.undo.pop(); if (!op) return;
  const page = state.pages.find(p => p.id === op.pageId); if (!page) return;
  if (op.type === 'add') { const i = page.strokes.lastIndexOf(op.stroke); if (i >= 0) page.strokes.splice(i, 1); }
  else { [...op.removed].sort((a, b) => a.index - b.index).forEach(r => page.strokes.splice(Math.min(r.index, page.strokes.length), 0, r.stroke)); }
  state.redo.push(op);
  state.canvases.get(page.id)?.render(); scheduleSave('page', page.id); syncToolbar();
}
function redo() {
  const op = state.redo.pop(); if (!op) return;
  const page = state.pages.find(p => p.id === op.pageId); if (!page) return;
  if (op.type === 'add') page.strokes.push(op.stroke);
  else { for (const r of op.removed) { const i = page.strokes.indexOf(r.stroke); if (i >= 0) page.strokes.splice(i, 1); } }
  state.undo.push(op);
  state.canvases.get(page.id)?.render(); scheduleSave('page', page.id); syncToolbar();
}

async function addPage() {
  if (!state.note) return;
  const p = { id: uid(), noteId: state.note.id, index: state.pages.length, strokes: [], text: '' };
  state.pages.push(p); await db.put('pages', p);
  const el = buildPage(p, state.pages.length - 1); $('#pages').appendChild(el);
  updateLineHeights(); setTool(state.tool.tool);
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  state.activePageId = p.id;
  scheduleSave('note');
}
async function deletePage(pageId) {
  if (state.pages.length === 1) return toast('La nota necesita al menos una página');
  const p = state.pages.find(x => x.id === pageId);
  if ((p.strokes.length || p.text) && !(await confirmDlg('¿Eliminar esta página y su contenido?'))) return;
  state.pages = state.pages.filter(x => x.id !== pageId);
  state.pages.forEach((x, i) => { x.index = i; });
  await db.del('pages', pageId); await db.putMany('pages', state.pages);
  state.undo = state.undo.filter(o => o.pageId !== pageId); state.redo = state.redo.filter(o => o.pageId !== pageId);
  renderPages(); scheduleSave('note');
}

/* ---------- Manuscrito a texto ---------- */
let convertAbort = null;
async function convertPage(pageId) {
  const page = state.pages.find(p => p.id === pageId);
  if (!page) return;
  if (!hasKey()) { toast('Añade tu clave de API en Ajustes', 'error'); return openSettings(); }
  const png = strokesToPNG(page.strokes);
  if (!png) return toast('Esta página no tiene tinta que convertir');
  const dlg = $('#dlg-convert'); const status = $('#convert-status'); const ta = $('#convert-text');
  ta.value = ''; status.textContent = 'Leyendo tu letra con Claude…';
  $('#convert-keep').disabled = true; $('#convert-replace').disabled = true;
  dlg.showModal();
  const pageEl = $(`.page[data-id="${pageId}"]`); pageEl?.classList.add('converting');
  convertAbort = new AbortController();
  try {
    const text = await handwritingToText(png, { signal: convertAbort.signal, onDelta: (_, full) => { ta.value = full; } });
    ta.value = text.trim();
    status.textContent = 'Revisa el texto y decide qué hacer con la tinta.';
    $('#convert-keep').disabled = false; $('#convert-replace').disabled = false;
  } catch (e) {
    if (e.name === 'AbortError') return;
    status.textContent = e.message; toast(e.message, 'error');
  } finally { pageEl?.classList.remove('converting'); }
  const apply = async (clear) => {
    const t = ta.value.trim();
    if (t && t !== '(sin texto)') { page.text = (page.text ? page.text + '\n' : '') + t; }
    if (clear) { state.undo.push({ pageId, type: 'remove', removed: page.strokes.map((s, i) => ({ index: i, stroke: s })) }); page.strokes.splice(0); }
    const el = $(`.page[data-id="${pageId}"]`); if (el) { el.querySelector('.typed').textContent = page.text; state.canvases.get(pageId)?.render(); }
    scheduleSave('page', pageId); syncToolbar(); dlg.close(); toast(clear ? 'Texto insertado y tinta limpiada' : 'Texto insertado');
  };
  $('#convert-keep').onclick = () => apply(false);
  $('#convert-replace').onclick = () => apply(true);
}
async function convertAllPages() {
  if (!hasKey()) { toast('Añade tu clave de API en Ajustes', 'error'); return openSettings(); }
  const withInk = state.pages.filter(p => strokesToPNG(p.strokes));
  if (!withInk.length) return toast('No hay tinta que convertir');
  toast(`Convirtiendo ${withInk.length} página(s)…`);
  for (const p of withInk) {
    const el = $(`.page[data-id="${p.id}"]`); el?.classList.add('converting');
    try {
      const t = (await handwritingToText(strokesToPNG(p.strokes))).trim();
      if (t && t !== '(sin texto)') { p.text = (p.text ? p.text + '\n' : '') + t; el && (el.querySelector('.typed').textContent = p.text); scheduleSave('page', p.id); }
    } catch (e) { toast(e.message, 'error'); break; }
    finally { el?.classList.remove('converting'); }
  }
  toast('Conversión terminada. La tinta se conserva.');
}
async function askNote() {
  if (!hasKey()) { toast('Añade tu clave de API en Ajustes', 'error'); return openSettings(); }
  const text = state.pages.map(p => p.text || '').filter(Boolean).join('\n\n');
  if (!text) return toast('La nota no tiene texto todavía. Convierte primero la tinta a texto.');
  const q = await promptText('¿Qué quieres que haga Claude con esta nota?', 'Resume esta nota en puntos clave y acciones', 'Preguntar');
  if (!q) return;
  const dlg = $('#dlg-convert'); const status = $('#convert-status'); const ta = $('#convert-text');
  ta.value = ''; status.textContent = 'Pensando…'; $('#convert-keep').disabled = true; $('#convert-replace').disabled = true;
  $('#convert-keep').textContent = 'Cerrar'; $('#convert-replace').textContent = 'Añadir como página';
  dlg.showModal();
  convertAbort = new AbortController();
  try {
    const out = await askAboutNote({ title: state.note.title, text, question: q, signal: convertAbort.signal, onDelta: (_, full) => { ta.value = full; } });
    status.textContent = 'Respuesta de Claude'; $('#convert-keep').disabled = false; $('#convert-replace').disabled = false;
    $('#convert-keep').onclick = () => { dlg.close(); };
    $('#convert-replace').onclick = async () => { await addPage(); const p = state.pages[state.pages.length - 1]; p.text = out.trim(); $(`.page[data-id="${p.id}"] .typed`).textContent = p.text; scheduleSave('page', p.id); dlg.close(); };
  } catch (e) { if (e.name !== 'AbortError') { status.textContent = e.message; toast(e.message, 'error'); } }
  dlg.addEventListener('close', () => { $('#convert-keep').textContent = 'Insertar y conservar tinta'; $('#convert-replace').textContent = 'Insertar y limpiar tinta'; }, { once: true });
}

/* =====================================================================
   Hoy
===================================================================== */
async function renderHome() {
  const v = $('#view-home');
  const now = new Date();
  const h = now.getHours();
  const greet = h < 6 ? 'Buenas noches' : h < 13 ? 'Buenos días' : h < 20 ? 'Buenas tardes' : 'Buenas noches';
  const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart); dayEnd.setDate(dayEnd.getDate() + 1);
  const events = await eventsBetween(dayStart.getTime(), dayEnd.getTime());
  const notes = (await db.all('notes')).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 6);
  const linked = await db.all('notes');
  v.innerHTML = `<div class="home-wrap">
    <div class="greet">${greet}.</div>
    <div class="greet-sub">${esc(now.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' }))} · ${events.length ? `${events.length} ${events.length > 1 ? 'reuniones' : 'reunión'} hoy` : 'sin reuniones en la agenda'}</div>
    <div class="quick">
      <button class="btn primary" id="home-new">${ICONS.note}<span>Nueva nota</span></button>
      <button class="btn rec" id="home-live">${ICONS.mic}<span>Sesión en vivo</span></button>
      <button class="btn" id="home-agenda">${ICONS.cal}<span>Agenda</span></button>
    </div>
    <div class="section-title">Hoy</div>
    <div id="home-events">${events.length ? '' : '<div class="empty-hint">Importa tu calendario desde la Agenda y aquí verás tus reuniones de hoy con sus apuntes.</div>'}</div>
    <div class="section-title">Recientes</div>
    <div class="cards" id="home-recent">${notes.length ? '' : '<div class="empty-hint">Todavía no hay notas.</div>'}</div>
  </div>`;
  $('#home-new').addEventListener('click', () => newNote());
  $('#home-live').addEventListener('click', () => setView('live'));
  $('#home-agenda').addEventListener('click', () => setView('agenda'));
  const evWrap = $('#home-events');
  events.forEach(e => evWrap.appendChild(eventCard(e, linked.filter(n => n.eventId === e.id))));
  const rec = $('#home-recent');
  notes.forEach(n => {
    const b = document.createElement('button'); b.className = 'card';
    b.innerHTML = `<div class="t">${n.kind === 'session' ? '🎙 ' : ''}${esc(n.title || 'Sin título')}</div><div class="s">${esc((n.text || n.summary || '').replace(/[#*>]/g, '').slice(0, 160))}</div><div class="m">${relTime(n.updatedAt)} · ${esc(folderPath(n.folderId).join(' / '))}</div>`;
    b.addEventListener('click', () => openNote(n.id)); rec.appendChild(b);
  });
}

/* =====================================================================
   Agenda
===================================================================== */
let agendaPast = false;
async function renderAgenda() {
  const v = $('#view-agenda');
  const now = Date.now();
  const from = agendaPast ? now - 14 * 86400000 : new Date(new Date().setHours(0, 0, 0, 0)).getTime();
  const events = await eventsBetween(from, now + 45 * 86400000);
  const notes = await db.all('notes');
  const sources = [...new Set((await db.all('events')).map(e => e.calendarName))];
  v.innerHTML = `<div class="agenda-wrap">
    <div class="greet">Agenda</div>
    <div class="cal-bar">
      <button class="btn" id="cal-import">${ICONS.cal}<span>Importar .ics</span></button>
      <input type="file" id="cal-file" accept=".ics,text/calendar" hidden>
      <button class="btn" id="cal-url"><span>Suscribirse a URL</span></button>
      <button class="btn" id="cal-google"><span>Google Calendar</span></button>
      <button class="btn" id="cal-past"><span>${agendaPast ? 'Ocultar pasadas' : 'Ver pasadas'}</span></button>
      <span class="src">${sources.length ? 'Calendarios: ' + esc(sources.join(', ')) : ''}</span>
    </div>
    <div id="agenda-days"></div>
  </div>`;
  $('#cal-import').addEventListener('click', () => $('#cal-file').click());
  $('#cal-file').addEventListener('change', async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try { const r = await importICSText(await f.text(), f.name.replace(/\.ics$/i, '')); toast(`${r.count} eventos importados de ${r.calendarName}`); renderAgenda(); }
    catch (err) { toast(err.message, 'error'); }
  });
  $('#cal-url').addEventListener('click', async () => {
    const url = await promptText('URL del calendario (.ics / webcal)', state.settings.icsUrls?.[0] || '', 'Suscribirse');
    if (!url) return;
    try { const r = await importICSUrl(url); state.settings.icsUrls = [url]; saveSettings(state.settings); toast(`${r.count} eventos de ${r.calendarName}`); renderAgenda(); }
    catch (err) { toast('No se pudo leer la URL (muchos calendarios bloquean el acceso desde apps web). Exporta el .ics e impórtalo.', 'error'); }
  });
  $('#cal-google').addEventListener('click', async () => {
    try { toast('Conectando con Google…'); const r = await syncGoogleCalendar(); toast(`${r.count} eventos de ${r.calendars} calendario(s) de Google`); renderAgenda(); }
    catch (err) { toast(err.message, 'error'); if (!state.settings.googleClientId) openSettings(); }
  });
  $('#cal-past').addEventListener('click', () => { agendaPast = !agendaPast; renderAgenda(); });

  const days = $('#agenda-days');
  if (!events.length) {
    days.innerHTML = `<div class="empty-hint">No hay eventos en este periodo.<br><br>En el iPad: abre Calendario → toca el calendario → Compartir → exportar .ics, o en iCloud.com/Google/Outlook exporta tu calendario y súbelo aquí. Cada reunión tendrá sus apuntes y su sesión en vivo.</div>`;
    return;
  }
  const todayKey = dayKey(now);
  let currentKey = null, dayEl = null;
  for (const e of events) {
    const k = dayKey(e.start);
    if (k !== currentKey) {
      currentKey = k;
      const head = document.createElement('div'); head.className = 'day-head' + (k === todayKey ? ' today' : '');
      const d = new Date(e.start);
      head.innerHTML = `${esc(d.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' }))} ${k === todayKey ? '<span>hoy</span>' : ''}`;
      days.appendChild(head);
      dayEl = document.createElement('div'); days.appendChild(dayEl);
    }
    dayEl.appendChild(eventCard(e, notes.filter(n => n.eventId === e.id)));
  }
}

function eventCard(e, linkedNotes) {
  const now = Date.now();
  const el = document.createElement('div');
  el.className = 'event' + (e.start <= now && e.end >= now ? ' now' : '');
  const who = (e.attendees || []).slice(0, 4).join(', ') + ((e.attendees || []).length > 4 ? ` +${e.attendees.length - 4}` : '');
  el.innerHTML = `<div class="time">${e.allDay ? '<b>Todo el día</b>' : `<b>${fmtTime(e.start)}</b>${fmtTime(e.end)}`}</div>
    <div><div class="t">${esc(e.title)}</div>
      <div class="s">${esc([e.location, who].filter(Boolean).join(' · ')) || '<span style="color:var(--ink-3)">' + esc(e.calendarName || '') + '</span>'}</div>
      <div class="links"></div></div>
    <div class="actions">
      <button class="icon-btn" title="Apuntes de la reunión">${ICONS.note}</button>
      <button class="icon-btn" title="Sesión en vivo">${ICONS.mic}</button>
    </div>`;
  const links = el.querySelector('.links');
  linkedNotes.forEach(n => { const c = document.createElement('button'); c.className = 'chip'; c.innerHTML = (n.kind === 'session' ? ICONS.mic : ICONS.note) + esc(n.title || 'Sin título'); c.addEventListener('click', () => openNote(n.id)); links.appendChild(c); });
  if (!linkedNotes.length) links.innerHTML = '<span class="chip ghost">sin apuntes</span>';
  const [bNote, bLive] = el.querySelectorAll('.actions button');
  bNote.addEventListener('click', async () => {
    const existing = linkedNotes.find(n => n.kind !== 'session');
    if (existing) return openNote(existing.id);
    const fid = state.folders.find(f => f.name === 'Reuniones')?.id || state.folders[0]?.id;
    await newNote({ folderId: fid, eventObj: e });
  });
  bLive.addEventListener('click', () => startLiveFromEvent(e));
  return el;
}

/* =====================================================================
   Sesión en vivo
===================================================================== */
async function startLiveFromEvent(e) {
  if (state.live?.recorder?.running) { setView('live'); return toast('Ya hay una sesión en curso'); }
  state.live = newLiveState({ title: e.title, event: e });
  setView('live');
}
function newLiveState(opts = {}) {
  return {
    recorder: null, note: null, session: null, title: opts.title || '', event: opts.event || null,
    transcript: [], interim: '', outputs: {}, chat: [], activeTab: 'resumen', timer: null, autoTimer: null, busy: null, audioUrl: null, readonly: false,
  };
}

async function openSessionNote(note) {
  if (state.live?.recorder?.running && state.live.note?.id !== note.id) { toast('Hay una grabación en curso. Detenla antes de abrir otra sesión.'); setView('live'); return; }
  if (state.live?.note?.id === note.id) { setView('live'); return; }
  const session = (await db.byIndex('sessions', 'noteId', note.id))[0];
  state.live = newLiveState({ title: note.title });
  state.live.note = note; state.live.session = session || null; state.live.readonly = true;
  state.live.transcript = session?.transcript || [];
  state.live.outputs = session?.outputs || {};
  state.live.chat = session?.chat || [];
  if (session?.eventId) state.live.event = await db.get('events', session.eventId);
  if (session?.audioId) { const a = await db.get('audio', session.audioId); if (a) state.live.audioUrl = URL.createObjectURL(a.blob); }
  state.noteId = note.id;
  setView('live');
  renderList();
}

async function renderLive() {
  const v = $('#view-live');
  if (!state.live) state.live = newLiveState();
  const L = state.live;
  const recording = !!L.recorder?.running;
  const hasSession = recording || L.readonly || L.transcript.length;
  if (!hasSession) return renderLiveStart(v);

  v.innerHTML = `
    <div class="live-head">
      <input class="note-title" id="live-title" placeholder="Título de la reunión" value="${esc(L.title)}">
      ${L.event ? `<span class="chip">${ICONS.cal}${esc(fmtDateLong(L.event.start))} · ${fmtTime(L.event.start)}</span>` : ''}
      <span class="live-timer ${recording ? 'on' : ''}" id="live-timer">${fmtDuration(L.recorder ? L.recorder.elapsed() : (L.session?.duration || 0))}</span>
      <span class="levels" id="live-levels" ${recording ? '' : 'hidden'}>${'<i></i>'.repeat(12)}</span>
      <span class="live-status" id="live-status"></span>
      <div class="spacer"></div>
      ${recording ? `<button class="btn rec" id="live-stop"><svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2"/></svg><span>Terminar</span></button>` :
        `<button class="btn" id="live-share">${ICONS.share}<span>Exportar</span></button><button class="btn primary" id="live-new">${ICONS.mic}<span>Nueva sesión</span></button>`}
    </div>
    <div class="live-grid">
      <div class="pane">
        <div class="pane-head">Transcripción<div class="spacer"></div><button class="chip" id="live-copy">${ICONS.copy}Copiar</button></div>
        <div class="pane-body transcript" id="live-transcript"></div>
        ${L.audioUrl ? `<div class="audio-row"><audio controls src="${L.audioUrl}"></audio><button class="btn" id="live-audio-dl">Guardar audio</button></div>` : ''}
        <div class="transcript-input"><input id="live-note-input" placeholder="Añade una nota (escríbela con el lápiz aquí mismo)"><button class="btn" id="live-note-add">Anotar</button></div>
      </div>
      <div class="pane">
        <div class="pane-head">${ICONS.spark}Secretario<div class="spacer"></div><span class="live-status" id="live-auto"></span></div>
        <div class="chips" id="live-chips">${Object.entries(SECRETARY_LABELS).map(([k, l]) => `<button class="chip" data-task="${k}">${l}</button>`).join('')}<button class="chip" data-task="chat">Preguntas</button></div>
        <div class="pane-body md" id="live-output"></div>
        <div class="chat-input"><input id="live-chat-input" placeholder="Pregunta al secretario: ¿qué ha dicho X sobre…?"><button class="btn primary" id="live-chat-send">Enviar</button></div>
      </div>
    </div>`;

  $('#live-title').addEventListener('input', (e) => { L.title = e.target.value; if (L.note) { L.note.title = L.title; L.note.updatedAt = Date.now(); db.put('notes', L.note); renderListSoon(); } });
  $('#live-copy').addEventListener('click', () => { navigator.clipboard?.writeText(transcriptText()); toast('Transcripción copiada'); });
  $('#live-note-add').addEventListener('click', addManualNote);
  $('#live-note-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') addManualNote(); });
  $$('#live-chips .chip').forEach(c => c.addEventListener('click', () => { L.activeTab = c.dataset.task; if (c.dataset.task !== 'chat') runSecretary(c.dataset.task); renderLiveOutput(); }));
  $('#live-chat-send').addEventListener('click', sendChat);
  $('#live-chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });
  if (recording) $('#live-stop').addEventListener('click', stopLive);
  else {
    $('#live-new').addEventListener('click', () => { if (L.audioUrl) URL.revokeObjectURL(L.audioUrl); state.live = newLiveState(); renderLive(); });
    $('#live-share').addEventListener('click', () => L.note && shareNoteText(L.note));
    $('#live-audio-dl')?.addEventListener('click', async () => { const a = await db.get('audio', L.session.audioId); download((L.title || 'sesion') + (a.blob.type.includes('mp4') ? '.m4a' : '.webm'), a.blob); });
  }
  renderTranscript(); renderLiveOutput();
  if (recording) startTimer();
}

function renderLiveStart(v) {
  const L = state.live;
  const canRec = LiveRecorder.supportsRecording();
  const canSpeech = LiveRecorder.supportsSpeech();
  eventsBetween(Date.now() - 2 * 3600000, Date.now() + 86400000).then(evs => {
    const sel = $('#live-event'); if (!sel) return;
    evs.forEach(e => { const o = document.createElement('option'); o.value = e.id; o.textContent = `${fmtTime(e.start)} · ${e.title}`; if (L.event?.id === e.id) o.selected = true; sel.appendChild(o); });
  });
  v.innerHTML = `<div class="home-wrap" style="padding:24px 32px">
    <div class="greet">Sesión en vivo</div>
    <div class="greet-sub">Graba la reunión, transcribe en directo y deja que Claude vaya preparando el acta.</div>
    <div class="pane" style="margin-top:24px;padding:22px;gap:14px">
      <label class="settings" style="padding:0"><span style="font-size:13px;color:var(--ink-3)">Título</span><input type="text" id="live-start-title" value="${esc(L.title)}" placeholder="Ej.: Comité de dirección" style="padding:10px 12px;border-radius:10px;border:1px solid var(--line);background:var(--bg);outline:none;font-size:16px;width:100%"></label>
      <label class="settings" style="padding:0"><span style="font-size:13px;color:var(--ink-3)">Reunión de la agenda (opcional)</span><select id="live-event" style="padding:10px 12px;border-radius:10px;border:1px solid var(--line);background:var(--bg);font-size:15px;width:100%"><option value="">— ninguna —</option></select></label>
      <label class="settings" style="padding:0"><span style="font-size:13px;color:var(--ink-3)">Guardar en</span><select id="live-folder" style="padding:10px 12px;border-radius:10px;border:1px solid var(--line);background:var(--bg);font-size:15px;width:100%">${state.folders.map(f => `<option value="${f.id}" ${(state.folderId === f.id || (!state.folderId && f.name === 'Reuniones')) ? 'selected' : ''}>${esc(folderPath(f.id).join(' / '))}</option>`).join('')}</select></label>
      <div class="btn-row" style="margin-top:6px"><button class="btn rec" id="live-start" ${canRec ? '' : 'disabled'}>${ICONS.mic}<span>Empezar a grabar</span></button></div>
      <small>${canRec ? '' : 'Este navegador no permite grabar audio. '}${canSpeech ? 'La transcripción en vivo usa el dictado del iPad (Ajustes → General → Teclado → Activar dictado).' : 'Este navegador no ofrece transcripción en vivo; se grabará el audio y podrás anotar a mano.'} ${hasKey() ? '' : 'Añade tu clave de API en Ajustes para que el secretario funcione.'}</small>
    </div>
  </div>`;
  $('#live-start').addEventListener('click', async () => {
    L.title = $('#live-start-title').value.trim();
    const evId = $('#live-event').value; L.event = evId ? await db.get('events', evId) : null;
    if (!L.title) L.title = L.event?.title || 'Reunión ' + new Date().toLocaleDateString('es-ES', { day: 'numeric', month: 'short' }) + ' ' + fmtTime(Date.now());
    await startLive($('#live-folder').value);
  });
}

async function startLive(folderId) {
  const L = state.live;
  const now = Date.now();
  L.note = { id: uid(), folderId, title: L.title, kind: 'session', text: '', createdAt: now, updatedAt: now };
  if (L.event) { L.note.eventId = L.event.id; L.note.eventTitle = L.event.title; L.note.eventStart = L.event.start; }
  L.session = { id: uid(), noteId: L.note.id, startedAt: now, eventId: L.event?.id || null, transcript: [], outputs: {}, chat: [], duration: 0 };
  L.recorder = new LiveRecorder({
    lang: state.settings.lang,
    onFinal: (text) => { L.transcript.push({ t: Date.now() - L.session.startedAt, text, kind: 'speech' }); L.interim = ''; renderTranscript(true); saveLiveSoon(); },
    onInterim: (text) => { L.interim = text; renderTranscript(true); },
    onLevel: (lv) => { const bars = $$('#live-levels i'); bars.forEach((b, i) => { b.style.height = Math.max(3, Math.min(20, (lv * 20) * (0.5 + Math.random() * 0.8) * (1 - Math.abs(i - 6) / 9))) + 'px'; }); },
    onStatus: (s) => { const el = $('#live-status'); if (el) el.textContent = s; },
  });
  try { await L.recorder.start(); }
  catch (e) { L.recorder = null; return toast('No se pudo acceder al micrófono: ' + e.message, 'error'); }
  await db.put('notes', L.note); await db.put('sessions', L.session);
  $('#nav-rec-dot').hidden = false;
  renderTree(); renderLive();
  const mins = +state.settings.autoSummaryMin;
  if (mins > 0 && hasKey()) L.autoTimer = setInterval(() => { if (L.transcript.length && !L.busy) runSecretary('resumen', { silent: true }); }, mins * 60000);
}

async function stopLive() {
  const L = state.live; if (!L.recorder) return;
  const blob = await L.recorder.stop();
  clearInterval(L.timer); clearInterval(L.autoTimer); L.timer = null; L.autoTimer = null;
  L.session.duration = Date.now() - L.session.startedAt; L.session.endedAt = Date.now();
  if (blob && blob.size) {
    const audio = { id: uid(), blob, mime: blob.type, createdAt: Date.now() };
    await db.put('audio', audio); L.session.audioId = audio.id; L.audioUrl = URL.createObjectURL(blob);
  }
  L.recorder = null; L.readonly = true;
  $('#nav-rec-dot').hidden = true;
  await saveLive();
  renderLive();
  if (hasKey() && L.transcript.length) {
    toast('Preparando acta y acciones…');
    await runSecretary('acta'); await runSecretary('acciones', { silent: true });
  }
}

function startTimer() {
  const L = state.live; clearInterval(L.timer);
  L.timer = setInterval(() => { const el = $('#live-timer'); if (el && L.recorder) el.textContent = fmtDuration(L.recorder.elapsed()); }, 1000);
}
function transcriptText() {
  return state.live.transcript.map(t => `[${fmtDuration(t.t)}] ${t.kind === 'note' ? '[nota] ' : ''}${t.text}`).join('\n');
}
function renderTranscript(keepScroll) {
  const L = state.live; const el = $('#live-transcript'); if (!el) return;
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  if (!L.transcript.length && !L.interim) {
    el.innerHTML = `<div class="live-empty"><b>${L.recorder ? 'Escuchando…' : 'Sin transcripción'}</b>${L.recorder ? 'Habla con normalidad. El texto aparecerá aquí con su minuto.' : ''}</div>`;
    return;
  }
  el.innerHTML = L.transcript.map(t => `<p class="${t.kind === 'note' ? 'note-line' : ''}"><time>${fmtDuration(t.t)}</time>${esc(t.text)}</p>`).join('') + (L.interim ? `<p class="interim">${esc(L.interim)}</p>` : '');
  if (!keepScroll || atBottom) el.scrollTop = el.scrollHeight;
}
function addManualNote() {
  const L = state.live; const input = $('#live-note-input'); const text = input.value.trim(); if (!text) return;
  const t = L.session ? Date.now() - L.session.startedAt : 0;
  L.transcript.push({ t, text, kind: 'note' }); input.value = ''; renderTranscript(); saveLiveSoon();
}
let liveSaveTimer = null;
function saveLiveSoon() { clearTimeout(liveSaveTimer); liveSaveTimer = setTimeout(saveLive, 1500); }
async function saveLive() {
  const L = state.live; if (!L.session || !L.note) return;
  L.session.transcript = L.transcript; L.session.outputs = L.outputs; L.session.chat = L.chat;
  await db.put('sessions', L.session);
  L.note.title = L.title; L.note.updatedAt = Date.now();
  L.note.summary = L.outputs.resumen || L.outputs.acta || L.transcript.slice(0, 3).map(t => t.text).join(' ');
  L.note.text = L.outputs.acta || L.outputs.resumen || '';
  await db.put('notes', L.note);
}

function renderLiveOutput() {
  const L = state.live; const out = $('#live-output'); if (!out) return;
  $$('#live-chips .chip').forEach(c => { c.classList.toggle('active', c.dataset.task === L.activeTab); c.classList.toggle('busy', L.busy === c.dataset.task); });
  if (L.activeTab === 'chat') {
    out.innerHTML = L.chat.length ? L.chat.map(m => m.role === 'user' ? `<div class="chat-q">${esc(m.text)}</div>` : `<div>${md(m.text)}${m.streaming ? '<span class="cursor"></span>' : ''}</div>`).join('') : '<div class="live-empty"><b>Pregunta lo que quieras</b>Sobre lo que se ha dicho, quién propuso qué, o pide un borrador.</div>';
  } else {
    const text = L.outputs[L.activeTab];
    out.innerHTML = text ? md(text) + (L.busy === L.activeTab ? '<span class="cursor"></span>' : '') : `<div class="live-empty"><b>${SECRETARY_LABELS[L.activeTab]}</b>${L.busy === L.activeTab ? 'Redactando…' : (hasKey() ? 'Toca de nuevo para generar con la transcripción actual.' : 'Añade tu clave de API en Ajustes.')}</div>`;
  }
  out.scrollTop = L.activeTab === 'chat' ? out.scrollHeight : 0;
  const auto = $('#live-auto'); if (auto) auto.textContent = L.autoTimer ? `auto-resumen cada ${state.settings.autoSummaryMin} min` : '';
}

function liveCtx() {
  const L = state.live; const e = L.event;
  return { title: L.title, when: e ? fmtDateLong(e.start) + ' ' + fmtTime(e.start) : new Date().toLocaleDateString('es-ES'), attendees: e?.attendees?.join(', '), description: e?.description?.slice(0, 1500) };
}
async function runSecretary(task, { silent = false } = {}) {
  const L = state.live;
  if (!hasKey()) { if (!silent) { toast('Añade tu clave de API en Ajustes', 'error'); openSettings(); } return; }
  if (L.busy) { if (!silent) toast('El secretario está redactando…'); return; }
  if (!L.transcript.length) { if (!silent) toast('Todavía no hay nada transcrito'); return; }
  L.busy = task; if (!silent) L.activeTab = task; renderLiveOutput();
  const notes = L.transcript.filter(t => t.kind === 'note').map(t => t.text).join('\n');
  const transcript = L.transcript.filter(t => t.kind === 'speech').map(t => `[${fmtDuration(t.t)}] ${t.text}`).join('\n');
  try {
    const text = await secretary({ task, transcript, notes, ctx: liveCtx(), onDelta: (_, full) => { L.outputs[task] = full; if (L.activeTab === task) renderLiveOutput(); } });
    L.outputs[task] = text; saveLiveSoon();
  } catch (e) { if (!silent) toast(e.message, 'error'); }
  finally { L.busy = null; renderLiveOutput(); }
}
async function sendChat() {
  const L = state.live; const input = $('#live-chat-input'); const q = input.value.trim(); if (!q) return;
  if (!hasKey()) { toast('Añade tu clave de API en Ajustes', 'error'); return openSettings(); }
  if (L.busy) return toast('El secretario está redactando…');
  input.value = ''; L.activeTab = 'chat';
  const history = L.chat.slice(-8).map(m => ({ role: m.role, content: m.text }));
  L.chat.push({ role: 'user', text: q }); const a = { role: 'assistant', text: '', streaming: true }; L.chat.push(a);
  L.busy = 'chat'; renderLiveOutput();
  const notes = L.transcript.filter(t => t.kind === 'note').map(t => t.text).join('\n');
  const transcript = L.transcript.filter(t => t.kind === 'speech').map(t => `[${fmtDuration(t.t)}] ${t.text}`).join('\n');
  try {
    a.text = await secretary({ question: q, transcript, notes, ctx: liveCtx(), history, onDelta: (_, full) => { a.text = full; renderLiveOutput(); } });
  } catch (e) { a.text = '⚠️ ' + e.message; }
  finally { a.streaming = false; L.busy = null; renderLiveOutput(); saveLiveSoon(); }
}

function sessionToMarkdown(note, s) {
  const L = state.live?.note?.id === note.id ? state.live : null;
  const transcript = (L ? L.transcript : s?.transcript) || [];
  const outputs = (L ? L.outputs : s?.outputs) || {};
  let out = `# ${note.title || 'Reunión'}\n\n${new Date(s?.startedAt || note.createdAt).toLocaleString('es-ES')}${s?.duration ? ' · ' + fmtDuration(s.duration) : ''}\n\n`;
  for (const [k, label] of Object.entries(SECRETARY_LABELS)) if (outputs[k]) out += `## ${label}\n\n${outputs[k]}\n\n`;
  out += `## Transcripción\n\n` + transcript.map(t => `**${fmtDuration(t.t)}** ${t.kind === 'note' ? '📝 ' : ''}${t.text}`).join('\n\n');
  return out;
}

init().catch(e => { console.error(e); toast('Error al iniciar: ' + e.message, 'error'); });
