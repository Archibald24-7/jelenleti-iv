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
  const send = (withIfMatch) =>
    graphFetch(`${itemPath(folder, fileName)}:/content${qs}`, {
      interactive,
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        ...(withIfMatch && ifMatch ? { 'If-Match': ifMatch } : {}),
      },
      body: JSON.stringify(data),
    });

  let res;
  try {
    res = await send(true);
  } catch (e) {
    // Ha a böngésző valamiért nem engedi az If-Match fejlécet (CORS), egyszer megpróbáljuk anélkül.
    if (e instanceof TypeError && ifMatch) res = await send(false);
    else throw e;
  }
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
