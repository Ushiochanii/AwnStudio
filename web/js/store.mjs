// Browser autosave: one IndexedDB record per page, the image kept as a Blob.

const DB = 'awnstudio';
const STORE = 'pages';

function open() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, {keyPath: 'id'});
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function run(mode, action) {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const result = action(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(result?.result);
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export const putPage = record => run('readwrite', store => store.put(record));
export const deletePage = id => run('readwrite', store => store.delete(id));
export const clearPages = () => run('readwrite', store => store.clear());
export const loadPages = () => run('readonly', store => store.getAll());

// Coalesce frequent edits into one write per page.
export function createAutosave(write, delay = 600) {
  const timers = new Map();
  const pending = new Map();
  let onState = () => {};
  const flushOne = async id => {
    clearTimeout(timers.get(id));
    timers.delete(id);
    const record = pending.get(id);
    pending.delete(id);
    if (!record) return;
    onState('saving');
    try {
      await write(record());
      if (!pending.size) onState('saved');
    } catch (error) {
      onState('error', error);
    }
  };
  return {
    schedule(id, makeRecord) {
      pending.set(id, makeRecord);
      clearTimeout(timers.get(id));
      timers.set(id, setTimeout(() => flushOne(id), delay));
      onState('dirty');
    },
    cancel(id) {
      clearTimeout(timers.get(id));
      timers.delete(id);
      pending.delete(id);
    },
    flush: () => Promise.all([...pending.keys()].map(flushOne)),
    onState(fn) { onState = fn; }
  };
}
