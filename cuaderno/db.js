// Almacenamiento local (IndexedDB). Todo vive en el iPad.
const DB_NAME = 'cuaderno';
const DB_VERSION = 1;
const STORES = {
  folders: { keyPath: 'id', indexes: [['parentId', 'parentId']] },
  notes: { keyPath: 'id', indexes: [['folderId', 'folderId'], ['eventId', 'eventId'], ['updatedAt', 'updatedAt']] },
  pages: { keyPath: 'id', indexes: [['noteId', 'noteId']] },
  sessions: { keyPath: 'id', indexes: [['noteId', 'noteId']] },
  audio: { keyPath: 'id' },
  events: { keyPath: 'id', indexes: [['start', 'start'], ['source', 'source']] },
};

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const [name, def] of Object.entries(STORES)) {
        if (!db.objectStoreNames.contains(name)) {
          const store = db.createObjectStore(name, { keyPath: def.keyPath });
          (def.indexes || []).forEach(([idx, key]) => store.createIndex(idx, key));
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    try { result = fn(s); } catch (e) { reject(e); return; }
    t.oncomplete = () => resolve(result && result.result !== undefined ? result.result : result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

function reqToPromise(store, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const r = fn(t.objectStore(store));
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }));
}

export const db = {
  get: (store, id) => reqToPromise(store, 'readonly', s => s.get(id)),
  all: (store) => reqToPromise(store, 'readonly', s => s.getAll()),
  byIndex: (store, index, value) => reqToPromise(store, 'readonly', s => s.index(index).getAll(value)),
  put: (store, obj) => tx(store, 'readwrite', s => s.put(obj)).then(() => obj),
  putMany: (store, objs) => tx(store, 'readwrite', s => { objs.forEach(o => s.put(o)); }),
  del: (store, id) => tx(store, 'readwrite', s => s.delete(id)),
  delMany: (store, ids) => tx(store, 'readwrite', s => { ids.forEach(id => s.delete(id)); }),
  clear: (store) => tx(store, 'readwrite', s => s.clear()),
  count: (store) => reqToPromise(store, 'readonly', s => s.count()),
};

export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10));

// Ajustes sencillos en localStorage
const SETTINGS_KEY = 'cuaderno.settings';
const DEFAULTS = {
  apiKey: '',
  model: 'claude-fable-5-1',
  persona: '',
  pencilOnly: true,
  paper: 'ruled',
  lang: 'es-ES',
  autoSummaryMin: 5,
  googleClientId: '',
  icsUrls: [],
};
export function loadSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; }
  catch { return { ...DEFAULTS }; }
}
export function saveSettings(s) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

export async function exportBackup() {
  const [folders, notes, pages, sessions, events] = await Promise.all([
    db.all('folders'), db.all('notes'), db.all('pages'), db.all('sessions'), db.all('events'),
  ]);
  const settings = loadSettings();
  delete settings.apiKey;
  return { app: 'cuaderno', version: 1, exportedAt: new Date().toISOString(), folders, notes, pages, sessions, events, settings };
}

export async function importBackup(data) {
  if (!data || data.app !== 'cuaderno') throw new Error('Archivo no reconocido');
  await db.putMany('folders', data.folders || []);
  await db.putMany('notes', data.notes || []);
  await db.putMany('pages', data.pages || []);
  await db.putMany('sessions', data.sessions || []);
  await db.putMany('events', data.events || []);
}

export async function storageEstimate() {
  if (!navigator.storage || !navigator.storage.estimate) return null;
  try { return await navigator.storage.estimate(); } catch { return null; }
}
export async function persistStorage() {
  if (navigator.storage && navigator.storage.persist) { try { await navigator.storage.persist(); } catch {} }
}
