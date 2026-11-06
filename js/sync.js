// ============================================================================
// SYNC – a megosztott OneDrive-mappában lévő adatfájl olvasása/írása a
// Microsoft Graph API-n keresztül, és a helyi (IndexedDB) állapottal való
// összefésülése.
//
// MŰKÖDÉS DIÓHÉJBAN
// 1. A config.js-ben megadott OneDrive MEGOSZTÁSI LINKET egyszer "feloldjuk"
//    a Graph /shares végpontján keresztül -> megkapjuk a mappa driveId+itemId
//    párosát, amit elmentünk (nem kell minden szinkronnál újra feloldani).
// 2. Lekérjük a mappában lévő adatfájl metaadatait (eTag) és letöltjük. Ha
//    még nem létezik, az normális az első indításkor.
// 3. Összefésüljük a helyi és a távoli adatokat: rekordonként az updatedAt
//    mező dönt ("aki utoljára módosított egy bejegyzést, az nyer"). A törlés
//    "sírkő" (deleted:true) jelöléssel terjed, így a törlések is szinkronizálódnak.
// 4. Az összefésült állapotot elmentjük helyben, és - ha van mit feltölteni -
//    visszaírjuk a OneDrive-fájlba. A feltöltés eTag-alapú (If-Match) feltétellel
//    történik: ha közben egy másik eszköz módosította a fájlt, a feltöltés
//    elutasításra kerül (412), és a teljes kört újrafuttatjuk a friss adattal.
//
// Mivel minden eszköz megőrzi a saját teljes helyi másolatát is, a rendszer
// "végül konzisztens": még egy ritka egyidejű-írás esetén sem vész el adat.
// ============================================================================

import * as Auth from './auth.js';
import * as DB from './db.js';
import { mergeById, nowISO, normalizeBreakRules } from './models.js';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const SCHEMA_VERSION = 1;
const MAX_ATTEMPTS = 3;

export function encodeSharingUrl(url) {
  // Hivatalos Microsoft Graph kódolás: base64 -> base64url (padding nélkül) -> "u!" előtag.
  // https://learn.microsoft.com/graph/api/shares-get
  const bytes = new TextEncoder().encode(url.trim());
  let binary = '';
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  const base64 = btoa(binary);
  return 'u!' + base64.replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-');
}

function httpError(code, status) {
  const err = new Error(code);
  err.status = status;
  return err;
}

async function graphFetch(path, { interactive = false, ...options } = {}) {
  const token = await Auth.getAccessToken({ interactive });
  return fetch(`${GRAPH_BASE}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) },
  });
}

// ---------------------------------------------------------------------------
// A megosztott mappa feloldása
// ---------------------------------------------------------------------------

async function resolveSharedFolder(sharedFolderLink, { interactive, forceRefresh = false } = {}) {
  if (!forceRefresh) {
    const cached = await DB.getMeta('sharedFolder');
    if (cached && cached.link === sharedFolderLink && cached.driveId && cached.itemId) return cached;
  }
  const res = await graphFetch(`/shares/${encodeSharingUrl(sharedFolderLink)}/driveItem`, {
    interactive,
    // "redeemSharingLink": tartós hozzáférést ad a megosztott elemhez (mintha a felhasználó
    // egyszer megnyitotta volna a linket) - a későbbi közvetlen /drives/... hívásokhoz kell.
    headers: { Prefer: 'redeemSharingLink' },
  });
  if (!res.ok) throw httpError('SHARE_RESOLVE_FAILED', res.status);
  const item = await res.json();
  const resolved = {
    link: sharedFolderLink,
    driveId: item.parentReference && item.parentReference.driveId,
    itemId: item.id,
  };
  if (!resolved.driveId || !resolved.itemId) throw httpError('SHARE_RESOLVE_INCOMPLETE', 0);
  await DB.setMeta('sharedFolder', resolved);
  return resolved;
}

// ---------------------------------------------------------------------------
// Távoli fájl olvasása / írása
// ---------------------------------------------------------------------------

function itemPath(folder, fileName) {
  return `/drives/${encodeURIComponent(folder.driveId)}/items/${encodeURIComponent(folder.itemId)}:/${encodeURIComponent(fileName)}`;
}

/** A távoli adatfájl beolvasása. `null`, ha még nem létezik. Egyébként { eTag, data }. */
async function getRemoteFile(folder, fileName, { interactive }) {
  const metaRes = await graphFetch(itemPath(folder, fileName), { interactive });
  if (metaRes.status === 404) return null;
  if (!metaRes.ok) throw httpError('REMOTE_META_FAILED', metaRes.status);
  const meta = await metaRes.json();

  if (meta.size === 0) return { eTag: meta.eTag, data: null }; // üres fájl - úgy kezeljük, mintha nem lenne tartalma

  let text;
  const downloadUrl = meta['@microsoft.graph.downloadUrl'];
  if (downloadUrl) {
    // Az előre hitelesített letöltő-URL-hez nem kell Authorization fejléc (egyszerű CORS-kérés).
    const dl = await fetch(downloadUrl);
    if (!dl.ok) throw httpError('REMOTE_DOWNLOAD_FAILED', dl.status);
    text = await dl.text();
  } else {
    const c = await graphFetch(`/drives/${encodeURIComponent(folder.driveId)}/items/${encodeURIComponent(meta.id)}/content`, { interactive });
    if (!c.ok) throw httpError('REMOTE_DOWNLOAD_FAILED', c.status);
    text = await c.text();
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw httpError('REMOTE_DATA_CORRUPT', 0); // SOSEM írjuk felül automatikusan a sérült fájlt
  }
  if (!data || typeof data !== 'object' || !Array.isArray(data.users) || !Array.isArray(data.entries)) {
    throw httpError('REMOTE_DATA_CORRUPT', 0);
  }
  if (typeof data.schemaVersion === 'number' && data.schemaVersion > SCHEMA_VERSION) {
    throw httpError('REMOTE_SCHEMA_NEWER', 0); // régebbi app ne írja felül az újabb formátumot
  }
  return { eTag: meta.eTag, data: sanitizeRemote(data) };
}

async function putRemote(folder, fileName, data, { ifMatch = null, failIfExists = false, interactive }) {
  const qs = failIfExists ? '?@microsoft.graph.conflictBehavior=fail' : '';
  const send = () =>
    graphFetch(`${itemPath(folder, fileName)}:/content${qs}`, {
      interactive,
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        ...(ifMatch ? { 'If-Match': ifMatch } : {}),
      },
      body: JSON.stringify(data),
    });
  // Soha nem írunk feltétel nélkül egy már létező fájlra: a korábbi CORS
  // fallback észrevétlenül felülírhatta másik eszköz módosításait.
  const res = await send();
  if (!res.ok) throw httpError('REMOTE_WRITE_FAILED', res.status);
  return res.json();
}

// ---------------------------------------------------------------------------
// Összefésülés
// ---------------------------------------------------------------------------

const RE_DATE = /^\d{4}-\d{2}-\d{2}$/;
const RE_TIME = /^\d{2}:\d{2}$/;

/** A távolról érkező adatokból kiszűri a hibás/szabálytalan rekordokat, hogy azok ne
 * tudják összeomlasztani a felületet (a megosztott fájlt bárki szerkesztheti, aki hozzáfér). */
export function sanitizeRemote(data) {
  const users = (data.users || []).filter(
    (u) =>
      u && typeof u.id === 'string' && typeof u.email === 'string' && typeof u.name === 'string' &&
      (u.role === 'admin' || u.role === 'user') && typeof u.updatedAt === 'string'
  );
  const entries = (data.entries || []).filter(
    (e) =>
      e && typeof e.id === 'string' && typeof e.userId === 'string' &&
      RE_DATE.test(e.date || '') && RE_TIME.test(e.startTime || '') &&
      (e.endTime === null || e.endTime === undefined || e.endTime === '' || RE_TIME.test(e.endTime)) &&
      typeof e.updatedAt === 'string'
  ).map((e) => {
    const brk = Number(e.breakMinutes);
    return {
      ...e,
      endTime: e.endTime || null,
      // régebbi bejegyzéseknél a mező hiányzik -> 0 perc levonás
      breakMinutes: Number.isFinite(brk) && brk > 0 ? Math.round(brk) : 0,
      breakManual: !!e.breakManual,
    };
  });
  return { ...data, users: users.map((u) => ({ ...u, breakRules: normalizeBreakRules(u.breakRules) })), entries };
}

export function mergeData(local, remoteData) {
  return {
    schemaVersion: SCHEMA_VERSION,
    users: mergeById(local.users, remoteData ? remoteData.users : []),
    entries: mergeById(local.entries, remoteData ? remoteData.entries : []),
    updatedAt: nowISO(),
  };
}

/** Csak akkor érdemes feltölteni, ha az összefésült adat tényleg eltér a távolitól. */
export function needsUpload(merged, remoteData) {
  if (!remoteData) return true;
  const sig = (list) => new Map((list || []).map((x) => [x.id, x.updatedAt]));
  const ru = sig(remoteData.users);
  const re = sig(remoteData.entries);
  return (
    merged.users.some((u) => ru.get(u.id) !== u.updatedAt) ||
    merged.entries.some((e) => re.get(e.id) !== e.updatedAt)
  );
}

// ---------------------------------------------------------------------------
// SZEMÉLYENKÉNT ELKÜLÖNÍTETT TÁROLÁS
// A Microsoft 365 fájl-ACL-je a tényleges biztonsági határ: minden dolgozó
// csak a saját adatfájljára kap írási jogot. A külön névjegyzéket az admin írja.
// A böngészőben mutatott admin szerepkör önmagában NEM jogosultsági kontroll.
// ---------------------------------------------------------------------------

const DIRECTORY_FIELDS = ['id', 'email', 'name', 'role', 'active', 'deleted', 'createdAt', 'directoryUpdatedAt', 'dataFolderLink'];

function normalizedEmail(value) {
  return String(value || '').trim().toLowerCase();
}

export function directoryRecord(user) {
  if (!user || !user.id || !normalizedEmail(user.email)) throw new Error('INVALID_DIRECTORY_USER');
  const record = {};
  for (const field of DIRECTORY_FIELDS) {
    if (user[field] !== undefined) record[field] = user[field];
  }
  record.email = normalizedEmail(record.email);
  record.directoryUpdatedAt = user.directoryUpdatedAt || user.updatedAt || '';
  record.updatedAt = record.directoryUpdatedAt;
  return record;
}

export function mergeDirectoryRecords(remoteUsers, localUsers, isAdmin) {
  const result = new Map(remoteUsers.map((user) => [user.id, directoryRecord(user)]));
  if (isAdmin) {
    for (const local of localUsers) {
      if (!local.directoryUpdatedAt) continue; // csak kifejezett admin-módosítás írhat a névjegyzékbe
      const existing = result.get(local.id);
      if (!existing || local.directoryUpdatedAt > existing.directoryUpdatedAt) {
        result.set(local.id, directoryRecord(local));
      }
    }
  }
  const records = [...result.values()];
  const seen = new Set();
  for (const user of records) {
    if (seen.has(user.email)) throw new Error('DUPLICATE_DIRECTORY_EMAIL');
    seen.add(user.email);
  }
  return records;
}

export function selectSyncUsers(directoryUsers, signedInEmail) {
  const signedIn = directoryUsers.find((user) => !user.deleted && user.email === normalizedEmail(signedInEmail));
  if (!signedIn || signedIn.active === false) throw new Error('ACCESS_DENIED');
  const isAdmin = signedIn.role === 'admin';
  return {
    signedIn,
    isAdmin,
    targets: directoryUsers.filter((user) => !user.deleted && (isAdmin || user.id === signedIn.id)),
  };
}

/** A felhasználói fájlban levő szerepkör nem megbízható: a névjegyzék
 * felülírja az identitás- és szerepkörmezőket. Csak a saját profilbeállításai
 * (szünet-szabályok, naptáremlékeztető) származhatnak a személyes fájlból. */
export function mergeUserProfile(directoryUser, localUser, remoteUser) {
  const stamp = (user) => user && (user.profileUpdatedAt || user.updatedAt) || '';
  const profile = stamp(localUser) > stamp(remoteUser) ? localUser : (remoteUser || localUser || {});
  const profileUpdatedAt = stamp(profile) || directoryUser.directoryUpdatedAt;
  return {
    ...directoryUser,
    breakRules: normalizeBreakRules(profile.breakRules),
    calendarReminderShownAt: profile.calendarReminderShownAt || null,
    profileUpdatedAt,
    updatedAt: profileUpdatedAt > directoryUser.directoryUpdatedAt ? profileUpdatedAt : directoryUser.directoryUpdatedAt,
  };
}

/** Egy hibásan megosztott vagy szennyezett fájlból sosem emelünk át másik
 * dolgozó bejegyzéseit. A helyi kliensnek továbbra sem szabad ACL-t helyettesítenie. */
export function assertUserFileOwnership(data, userId) {
  if (!data || !Array.isArray(data.users) || !Array.isArray(data.entries) ||
      data.users.some((user) => user.id !== userId) ||
      data.entries.some((entry) => entry.userId !== userId)) {
    throw new Error('WRONG_USER_FILE');
  }
}

function requireLink(url, code) {
  if (typeof url !== 'string' || !/^https:\/\//i.test(url.trim())) throw new Error(code);
  return url.trim();
}

async function performIsolatedSync(config, { interactive = false } = {}) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { status: 'offline', error: null, needsLogin: false };
  }
  try {
    const syncStartedAt = nowISO();
    const account = Auth.getCurrentAccount();
    if (!account) throw new Error('NOT_LOGGED_IN');
    const email = normalizedEmail(account.username);
    const directoryLink = requireLink(config.directoryFolderLink, 'ISOLATED_NOT_CONFIGURED');
    const directoryFileName = config.directoryFileName || 'felhasznalok.json';
    const directoryFolder = await resolveSharedFolder(directoryLink, { interactive });
    const localUsers = await DB.getAllUsers();
    const localEntries = await DB.getAllEntries();

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const directoryRemote = await getRemoteFile(directoryFolder, directoryFileName, { interactive });
      if (!directoryRemote || !directoryRemote.data || directoryRemote.data.entries.length !== 0) {
        throw new Error('INVALID_DIRECTORY_FILE');
      }
      const directoryUsers = directoryRemote.data.users.map(directoryRecord);
      const { signedIn, isAdmin } = selectSyncUsers(directoryUsers, email);
      const mergedDirectory = mergeDirectoryRecords(directoryUsers, localUsers, isAdmin);

      // Egy normál felhasználó kizárólag a saját fájlját olvashatja. Az admin
      // mindegyiket olvashatja, de ezt az OneDrive ACL-nek is engednie kell.
      const { targets } = selectSyncUsers(mergedDirectory, email);
      const loaded = [];
      for (const user of targets) {
        const link = requireLink(user.dataFolderLink, 'USER_FOLDER_NOT_CONFIGURED');
        const folder = await resolveSharedFolder(link, { interactive });
        const remote = await getRemoteFile(folder, config.dataFileName, { interactive });
        // Hiányzó fájlt kizárólag az admin frissen hozzáadott tagjánál
        // inicializálunk. Régi tag hiányzó fájlját tilos üresen újra létrehozni,
        // mert ezzel a migrációból kimaradt jelenléti adatok elveszhetnének.
        const newMember = isAdmin && !directoryUsers.some((record) => record.id === user.id);
        if ((!remote || !remote.data) && !newMember) throw new Error('USER_FILE_NOT_INITIALIZED');
        if (remote && remote.data) assertUserFileOwnership(remote.data, user.id);
        const localProfile = localUsers.find((item) => item.id === user.id);
        const remoteProfile = remote && remote.data ? remote.data.users[0] || null : null;
        const profile = mergeUserProfile(user, localProfile, remoteProfile);
        const entries = mergeById(localEntries.filter((entry) => entry.userId === user.id), remote && remote.data ? remote.data.entries : []);
        const data = { schemaVersion: SCHEMA_VERSION, users: [profile], entries, updatedAt: nowISO() };
        const changed = needsUpload(data, remote && remote.data) ||
          JSON.stringify(remoteProfile) !== JSON.stringify(profile);
        loaded.push({ user, folder, remote, profile, entries, data, changed });
      }

      // Minden célfájlt és jogosultságot ellenőrzünk írás előtt.
      try {
        for (const item of loaded) {
          if (item.changed) await putRemote(item.folder, config.dataFileName, item.data, {
            ...(item.remote ? { ifMatch: item.remote.eTag } : { failIfExists: true }),
            interactive,
          });
        }
        const directoryChanged = isAdmin &&
          JSON.stringify(mergedDirectory) !== JSON.stringify(directoryUsers);
        if (directoryChanged) {
          await putRemote(directoryFolder, directoryFileName,
            { schemaVersion: SCHEMA_VERSION, users: mergedDirectory, entries: [], updatedAt: nowISO() },
            { ifMatch: directoryRemote.eTag, interactive });
        }
      } catch (error) {
        if ((error.status === 412 || error.status === 409) && attempt < MAX_ATTEMPTS) continue;
        throw error;
      }

      const profiles = new Map(loaded.map((item) => [item.user.id, item.profile]));
      const users = mergedDirectory.map((user) => profiles.get(user.id) || {
        ...user, breakRules: [], calendarReminderShownAt: null, updatedAt: user.directoryUpdatedAt,
      });
      await DB.replaceCloudData(users, loaded.flatMap((item) => item.entries), targets.map((user) => user.id));
      const finishedAt = nowISO();
      // Az utolsó ellenőrzés alatt létrejött helyi módosításokat a következő
      // szinkronnak még észlelnie kell.
      await DB.setMeta('lastSyncedAt', syncStartedAt);
      await DB.setMeta('verifiedAccountEmail', email);
      return { status: 'synced', error: null, needsLogin: false, finishedAt };
    }
    throw httpError('REMOTE_WRITE_FAILED', 412);
  } catch (error) {
    return { status: 'error', error: describeError(error), needsLogin: needsRelogin(error), rawError: error };
  }
}

// ---------------------------------------------------------------------------
// Hibaüzenetek (magyarul, emberi nyelven)
// ---------------------------------------------------------------------------

export function needsRelogin(err) {
  return !!err && (err.code === 'NOT_LOGGED_IN' || err.code === 'INTERACTION_REQUIRED' ||
    err.code === 'TOKEN_ACQUISITION_FAILED' || err.status === 401);
}

export function describeError(err) {
  if (!err) return 'Ismeretlen hiba történt.';
  switch (err.code || err.message) {
    case 'NOT_LOGGED_IN':
      return 'Nem vagy bejelentkezve Microsoft-fiókkal.';
    case 'INTERACTION_REQUIRED':
    case 'TOKEN_ACQUISITION_FAILED':
      return 'A Microsoft-bejelentkezés lejárt. Jelentkezz be újra a szinkronizáláshoz – az adataid addig is biztonságban vannak az eszközön.';
    case 'TOKEN_NETWORK':
      return 'Nem sikerült elérni a Microsoft bejelentkezési szolgáltatását (hálózati hiba). Később újra próbálkozunk.';
    case 'MSAL_NOT_LOADED':
      return 'A Microsoft bejelentkezési könyvtár nem töltődött be.';
    case 'REMOTE_DATA_CORRUPT':
      return 'A megosztott adatfájl sérültnek tűnik, ezért nem írtuk felül. Kérd az adminisztrátor segítségét (OneDrive → Verzióelőzmények).';
    case 'REMOTE_SCHEMA_NEWER':
      return 'A megosztott adatfájl újabb alkalmazásverzióval készült. Frissítsd az alkalmazást (töltsd újra az oldalt).';
    case 'SHARE_RESOLVE_INCOMPLETE':
      return 'A megosztott mappa adatai hiányosak. Ellenőrizd a megosztási linket a config.js-ben.';
    case 'ISOLATED_NOT_CONFIGURED':
    case 'USER_FOLDER_NOT_CONFIGURED':
      return 'Az elkülönített OneDrive-mappák még nincsenek teljesen beállítva a config.js-ben.';
    case 'INVALID_DIRECTORY_FILE':
      return 'A névjegyzékfájl hiányzik vagy nem megfelelő. Ellenőrizd az átállás lépéseit.';
    case 'USER_FILE_NOT_INITIALIZED':
      return 'A személyes adatfájl hiányzik. Az adminisztrátornak előbb importálnia kell a mentést.';
    case 'WRONG_USER_FILE':
      return 'Biztonsági hiba: a személyes fájl idegen felhasználói adatot tartalmaz.';
    case 'ACCESS_DENIED':
      return 'Ez a Microsoft-fiók nincs engedélyezve a céges névjegyzékben, vagy inaktív.';
    case 'DUPLICATE_DIRECTORY_EMAIL':
      return 'Két felhasználóhoz ugyanaz az e-mail-cím tartozik a névjegyzékben.';
  }
  const status = err.status;
  if (status === 401) return 'A bejelentkezés lejárt. Jelentkezz be újra.';
  if (status === 403) return 'Nincs jogosultságod a megosztott mappához. Kérd meg az adminisztrátort, hogy ossza meg veled szerkesztési joggal.';
  if (status === 404) return 'A megosztott mappa nem található. Ellenőrizd a megosztási linket (config.js).';
  if (status === 409 || status === 412) return 'A megosztott adatfájl közben többször módosult. Rövidesen újra próbálkozunk.';
  if (status === 429) return 'A Microsoft szolgáltatás átmenetileg túlterhelt. Kis idő múlva újra próbálkozunk.';
  if (status >= 500) return 'A Microsoft/OneDrive szolgáltatás átmenetileg nem elérhető. Később újra próbálkozunk.';
  if (err instanceof TypeError) {
    return 'Nem érhető el a Microsoft/OneDrive szolgáltatás (nincs internet, vagy a szolgáltatás nem elérhető).';
  }
  return `Szinkronizálási hiba történt (${err.code || err.message || 'ismeretlen ok'}).`;
}

// ---------------------------------------------------------------------------
// Egy teljes szinkron-kör
// ---------------------------------------------------------------------------

/**
 * Lefuttat egy teljes szinkron-kört. SOSEM dob kivételt: mindig egy állapot-objektumot ad vissza:
 * { status: 'synced' | 'offline' | 'error' | 'not-configured', error, needsLogin, finishedAt }
 * @param {object} config a config.js CONFIG objektuma
 * @param {{interactive?: boolean}} opts interactive=true: felhasználói kattintásra indult (felugorhat bejelentkezés)
 */
export async function performSync(config, { interactive = false } = {}) {
  if (config.storageMode === 'isolated') return performIsolatedSync(config, { interactive });
  const configured =
    Auth.isAuthConfigured(config.clientId) &&
    typeof config.sharedFolderLink === 'string' &&
    config.sharedFolderLink.trim() !== '' &&
    !/^IDE-/i.test(config.sharedFolderLink.trim());
  if (!configured) {
    return { status: 'not-configured', error: 'A OneDrive-szinkron még nincs beállítva.', needsLogin: false };
  }

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { status: 'offline', error: null, needsLogin: false };
  }

  try {
    let folder;
    try {
      folder = await resolveSharedFolder(config.sharedFolderLink, { interactive });
    } catch (e) {
      // A gyorsítótárazott driveId/itemId elévülhetett - egyszer frissen is megpróbáljuk.
      if (e.status === 404 || e.status === 400) {
        folder = await resolveSharedFolder(config.sharedFolderLink, { interactive, forceRefresh: true });
      } else {
        throw e;
      }
    }

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const remote = await getRemoteFile(folder, config.dataFileName, { interactive });
      const local = { users: await DB.getAllUsers(), entries: await DB.getAllEntries() };
      const merged = mergeData(local, remote && remote.data);

      await DB.bulkPutUsers(merged.users);
      await DB.bulkPutEntries(merged.entries);

      if (needsUpload(merged, remote && remote.data)) {
        try {
          await putRemote(
            folder,
            config.dataFileName,
            merged,
            remote ? { ifMatch: remote.eTag, interactive } : { failIfExists: true, interactive }
          );
        } catch (e) {
          // 412 = az eTag nem egyezik (közben más módosította), 409 = a fájl közben létrejött.
          if ((e.status === 412 || e.status === 409) && attempt < MAX_ATTEMPTS) continue;
          throw e;
        }
      }

      const finishedAt = nowISO();
      await DB.setMeta('lastSyncedAt', finishedAt);
      return { status: 'synced', error: null, needsLogin: false, finishedAt };
    }
    throw httpError('REMOTE_WRITE_FAILED', 412);
  } catch (err) {
    const offlineNow = typeof navigator !== 'undefined' && navigator.onLine === false;
    if (offlineNow) return { status: 'offline', error: null, needsLogin: false };
    return { status: 'error', error: describeError(err), needsLogin: needsRelogin(err), rawError: err };
  }
}
