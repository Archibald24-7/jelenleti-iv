// ============================================================================
// DB – IndexedDB alapú helyi tároló. Ez a "forrás igazság" minden eszközön:
// az app MINDIG innen olvas és ide ír, a szinkron csak utólag egyezteti a
// megosztott OneDrive-fájllal. Emiatt az app internet nélkül is 100%-ban
// használható.
// ============================================================================

const DB_NAME = 'jelenleti_iv_db';
const DB_VERSION = 1;
const STORE_USERS = 'users';
const STORE_ENTRIES = 'entries';
const STORE_META = 'meta';

let dbPromise = null;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_USERS)) {
        db.createObjectStore(STORE_USERS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_ENTRIES)) {
        const store = db.createObjectStore(STORE_ENTRIES, { keyPath: 'id' });
        store.createIndex('by_user', 'userId');
        store.createIndex('by_date', 'date');
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: 'key' });
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
  return dbPromise;
}

function tx(db, storeName, mode) {
  return db.transaction(storeName, mode).objectStore(storeName);
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ---- generic helpers ----

async function getAll(storeName) {
  const db = await openDB();
  return reqToPromise(tx(db, storeName, 'readonly').getAll());
}

async function put(storeName, value) {
  const db = await openDB();
  return reqToPromise(tx(db, storeName, 'readwrite').put(value));
}

async function bulkPut(storeName, values) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, 'readwrite');
    const store = t.objectStore(storeName);
    for (const v of values) store.put(v);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

// ---- users ----

export async function getAllUsers() {
  return getAll(STORE_USERS);
}

export async function putUser(user) {
  return put(STORE_USERS, user);
}

export async function bulkPutUsers(users) {
  return bulkPut(STORE_USERS, users);
}

// ---- entries ----

export async function getAllEntries() {
  return getAll(STORE_ENTRIES);
}

export async function putEntry(entry) {
  return put(STORE_ENTRIES, entry);
}

export async function bulkPutEntries(entries) {
  return bulkPut(STORE_ENTRIES, entries);
}

/** Az adott felhasználó adott napi, adott ESZKÖZRŐL (deviceId) származó automatikus
 * bejegyzésének megkeresése - a duplikáció elkerülésére. */
export async function findAutoEntryForToday(userId, deviceId, dateStr) {
  const all = await getAllEntries();
  return (
    all.find(
      (e) =>
        !e.deleted &&
        e.userId === userId &&
        e.date === dateStr &&
        e.deviceId === deviceId &&
        (e.source === 'auto-login' || e.source === 'auto-app-open')
    ) || null
  );
}

/** Az adott felhasználó adott napi, még nyitott (endTime nélküli) bejegyzése - bármelyik eszközről. */
export async function findOpenEntryForDate(userId, dateStr) {
  const all = await getAllEntries();
  return all.find((e) => !e.deleted && e.userId === userId && e.date === dateStr && !e.endTime) || null;
}

// ---- meta / settings key-value ----

export async function getMeta(key, fallback = null) {
  const db = await openDB();
  const row = await reqToPromise(tx(db, STORE_META, 'readonly').get(key));
  return row ? row.value : fallback;
}

export async function setMeta(key, value) {
  return put(STORE_META, { key, value });
}

/** A teljes helyi adatbázis törlése (pl. hibaelhárításhoz vagy tesztekhez). A még
 * nem szinkronizált módosítások elvesznek! */
export async function resetLocalDatabase() {
  if (dbPromise) {
    try {
      const db = await dbPromise;
      db.close();
    } catch (e) { /* nem gond */ }
  }
  dbPromise = null;
  await new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}
