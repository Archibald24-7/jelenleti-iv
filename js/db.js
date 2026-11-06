// ============================================================================
// DB – IndexedDB alapú helyi tároló. Ez a "forrás igazság" minden eszközön:
// az app MINDIG innen olvas és ide ír, a szinkron csak utólag egyezteti a
// megosztott OneDrive-fájllal. Emiatt az app internet nélkül is 100%-ban
// használható.
// ============================================================================

import { CONFIG } from '../config.js';

// Ne emeljünk át automatikusan minden felhasználó adatát tartalmazó, régi
// IndexedDB-állományt az elkülönített módba. A régi adatbázis megmarad
// visszaállításhoz, az új mód tiszta és külön tárolóból indul.
const DB_NAME = CONFIG.storageMode === 'isolated' ? 'jelenleti_iv_isolated_v2' : 'jelenleti_iv_db';
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

/** Az engedélyezett fiókhoz tartozó teljes lokális pillanatkép atomikus cseréje.
 * A régebbről bent maradt, más felhasználóhoz tartozó rekordokat is eltávolítja. */
export async function replaceCloudData(users, entries, editableUserIds) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction([STORE_USERS, STORE_ENTRIES], 'readwrite');
    const userStore = t.objectStore(STORE_USERS);
    const entryStore = t.objectStore(STORE_ENTRIES);
    const allowed = new Set(editableUserIds);
    // Közben is keletkezhet helyi (offline-first) módosítás. Ezért a tranzakció
    // legfrissebb tartalmából is megtartjuk a még nem szinkronizált rekordokat.
    const oldUsersRequest = userStore.getAll();
    const oldEntriesRequest = entryStore.getAll();
    let oldUsers = null;
    let oldEntries = null;
    const mergeAndReplace = () => {
      if (!oldUsers || !oldEntries) return;
      const nextUsers = new Map(users.map((user) => [user.id, user]));
      for (const user of oldUsers) {
        const remote = nextUsers.get(user.id);
        if (!remote || !allowed.has(user.id)) continue;
        if ((user.profileUpdatedAt || '') > (remote.profileUpdatedAt || '')) {
          nextUsers.set(user.id, {
            ...remote,
            breakRules: user.breakRules,
            calendarReminderShownAt: user.calendarReminderShownAt,
            profileUpdatedAt: user.profileUpdatedAt,
            updatedAt: user.updatedAt,
          });
        }
      }
      const nextEntries = new Map(entries.map((entry) => [entry.id, entry]));
      for (const entry of oldEntries) {
        if (!allowed.has(entry.userId)) continue;
        const remote = nextEntries.get(entry.id);
        if (!remote || entry.updatedAt > remote.updatedAt) nextEntries.set(entry.id, entry);
      }
      userStore.clear();
      entryStore.clear();
      for (const user of nextUsers.values()) userStore.put(user);
      for (const entry of nextEntries.values()) entryStore.put(entry);
    };
    oldUsersRequest.onsuccess = () => { oldUsers = oldUsersRequest.result; mergeAndReplace(); };
    oldEntriesRequest.onsuccess = () => { oldEntries = oldEntriesRequest.result; mergeAndReplace(); };
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Local database transaction aborted'));
  });
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
