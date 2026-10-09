// ============================================================================
// MODELS – a Felhasználó (User) és Bejegyzés (Entry) adatmodellek, valamint
// néhány apró segédfüggvény (dátum/idő formázás, egyedi azonosító generálás).
// ============================================================================

export function uuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Egyszerű tartalék, ha valamiért nem elérhető a crypto.randomUUID (régebbi böngésző).
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function nowISO() {
  return new Date().toISOString();
}

export function todayDateStr() {
  return toDateStr(new Date());
}

export function toDateStr(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function nowTimeStr() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * Új felhasználó rekord létrehozása.
 * @param {{name:string, email:string, role?: 'admin'|'user'}} opts
 */
export function createUser({ name, email, role = 'user' }) {
  const ts = nowISO();
  return {
    id: uuid(),
    name: (name || '').trim(),
    email: (email || '').trim().toLowerCase(),
    role,
    active: true,
    breakRules: [], // munkaközi szünet levonási szabályok (lásd normalizeBreakRules)
    createdAt: ts,
    updatedAt: ts,
    deleted: false,
  };
}

export function touchUser(user, changes) {
  return { ...user, ...changes, updatedAt: nowISO() };
}

/**
 * Új bejegyzés (munkaidő) létrehozása.
 * @param {{userId:string, date:string, startTime:string, endTime?:string|null,
 *          source?:string, deviceId?:string, deviceName?:string, note?:string}} opts
 */
export function createEntry({
  userId,
  date,
  startTime,
  endTime = null,
  source = 'manual',
  deviceId = '',
  deviceName = '',
  breakMinutes = 0,
  breakManual = false,
  note = '',
}) {
  const ts = nowISO();
  return {
    id: uuid(),
    userId,
    date,
    startTime,
    endTime,
    source, // 'auto-login' | 'auto-app-open' | 'manual' | 'random'
    breakMinutes, // a munkaidőből levonandó szünet (perc)
    breakManual, // true: kézzel beállított levonás (a szabályok újraalkalmazása nem írja felül)
    deviceId,
    deviceName,
    note: (note || '').trim(),
    createdAt: ts,
    updatedAt: ts,
    deleted: false,
  };
}

export function touchEntry(entry, changes) {
  return { ...entry, ...changes, updatedAt: nowISO() };
}

/** Munkaidő hossza percben, vagy null, ha a bejegyzés még nyitott (nincs endTime). */
export function durationMinutes(entry) {
  if (!entry || !entry.startTime || !entry.endTime) return null;
  const [sh, sm] = entry.startTime.split(':').map(Number);
  const [eh, em] = entry.endTime.split(':').map(Number);
  let mins = (eh * 60 + em) - (sh * 60 + sm);
  if (mins < 0) mins += 24 * 60; // éjfélen átnyúló műszak esetére
  return mins;
}

/** Az adott bejegyzés levonandó szünete percben (hiányzó/érvénytelen érték = 0). */
export function entryBreak(entry) {
  const n = Number(entry && entry.breakMinutes);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/** LEDOLGOZOTT idő percben: (befejezés - kezdés) - levonandó szünet. Nyitott bejegyzésnél null.
 * Mindig innen számolunk, így a levonás utólagos módosítása azonnal újraszámol mindent. */
export function workedMinutes(entry) {
  const gross = durationMinutes(entry);
  if (gross == null) return null;
  return Math.max(0, gross - entryBreak(entry));
}

// ---------------------------------------------------------------------------
// MUNKAKÖZI SZÜNET LEVONÁSI SZABÁLYOK – felhasználónként, dátumtartományokkal.
// Egy szabály: { id, from, to, minutes }. Üres `from` = "kezdettől", üres `to` =
// "nincs vége" (folyamatban). Átfedés esetén a KÉSŐBB kezdődő szabály érvényes.
// ---------------------------------------------------------------------------

const RE_ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function normalizeBreakRules(rules) {
  return (Array.isArray(rules) ? rules : [])
    .map((r) => {
      const minutes = Number(r && r.minutes);
      return {
        id: r && typeof r.id === 'string' && r.id ? r.id : uuid(),
        from: r && RE_ISO_DATE.test(r.from || '') ? r.from : '',
        to: r && RE_ISO_DATE.test(r.to || '') ? r.to : '',
        minutes: Number.isFinite(minutes) ? Math.min(1440, Math.max(0, Math.round(minutes))) : null,
      };
    })
    .filter((r) => r.minutes !== null)
    .sort((a, b) => (a.from || '').localeCompare(b.from || '') || (a.to || '\uffff').localeCompare(b.to || '\uffff'));
}

/** A megadott napra érvényes levonás (perc); ha egy szabály sem illik rá, 0. */
export function resolveBreakMinutes(rules, dateStr) {
  let best = null;
  let bestIdx = -1;
  (rules || []).forEach((r, i) => {
    if (r.from && dateStr < r.from) return;
    if (r.to && dateStr > r.to) return;
    const better =
      best === null ||
      (r.from || '') > (best.from || '') ||
      ((r.from || '') === (best.from || '') && i > bestIdx);
    if (better) { best = r; bestIdx = i; }
  });
  return best ? best.minutes : 0;
}

/** Az űrlap sorainak ({from,to,minutes}) ellenőrzése. -> { rules } vagy { error } */
export function validateBreakRules(rows) {
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const n = i + 1;
    const from = r.from || '';
    const to = r.to || '';
    if (r.fromInvalid || r.toInvalid) return { error: `${n}. sor: érvénytelen dátum.` };
    if (from && to && from > to) return { error: `${n}. sor: a kezdő dátum nem lehet későbbi a záró dátumnál.` };
    const raw = String(r.minutes == null ? '' : r.minutes).trim();
    if (raw === '' || !/^\d+$/.test(raw)) return { error: `${n}. sor: add meg a levonandó percet (egész szám).` };
    const minutes = Number(raw);
    if (minutes > 600) return { error: `${n}. sor: a levonandó idő legfeljebb 600 perc lehet.` };
    out.push({ id: r.id || uuid(), from, to, minutes });
  }
  return { rules: normalizeBreakRules(out) };
}

/** A szabályok olvasható, soronkénti leírása (megjelenítéshez). */
export function describeBreakRules(rules) {
  return (rules || []).map((r) => {
    const from = r.from ? formatDateHu(r.from) : 'kezdettől';
    const to = r.to ? formatDateHu(r.to) : 'folyamatban';
    return `${r.minutes} perc: ${from} – ${to}`;
  });
}

export function formatDuration(minutes) {
  if (minutes == null) return '—';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} perc`;
  if (m === 0) return `${h} óra`;
  return `${h} óra ${m} perc`;
}

const HU_WEEKDAYS = ['vasárnap', 'hétfő', 'kedd', 'szerda', 'csütörtök', 'péntek', 'szombat'];
const HU_MONTHS = [
  'január', 'február', 'március', 'április', 'május', 'június',
  'július', 'augusztus', 'szeptember', 'október', 'november', 'december',
];

// ---------------------------------------------------------------------------
// DÁTUM/IDŐ FORMÁZÁS – magyar szabvány szerint: év.hónap.nap. sorrend, pontokkal
// elválasztva (nem kettősponttal - a kettőspont magyarul hagyományosan az
// időt jelöli, és Windows-fájlnévben sem használható), az idő pedig mindig
// 24 órás (a belső adatmodell is mindig "ÓÓ:PP" 24 órás formátumot tárol,
// tehát ehhez nem kell konverzió). A hét Hétfővel kezdődik mindenhol, ahol az
// app hetet számol (lásd getWeekStart lent).
// ---------------------------------------------------------------------------

/** 'YYYY-MM-DD' -> '2026.09.29.' (opcionálisan zárójeles napnévvel). */
export function formatDateHu(dateStr, { withWeekday = false } = {}) {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-').map(Number);
  let out = `${y}.${String(m).padStart(2, '0')}.${String(d).padStart(2, '0')}.`;
  if (withWeekday) {
    const date = new Date(y, m - 1, d);
    out += ` (${HU_WEEKDAYS[date.getDay()]})`;
  }
  return out;
}

/** 'YYYY-MM' -> '2026.09.' */
export function formatMonthHu(monthStr) {
  if (!monthStr) return '';
  const [y, m] = monthStr.split('-').map(Number);
  return `${y}.${String(m).padStart(2, '0')}.`;
}

/** 'YYYY-MM-DDTHH:mm:ss...Z' (ISO) vagy Date -> '2026.09.29. 18:42' */
export function formatDateTimeHu(isoOrDate) {
  if (!isoOrDate) return '';
  const d = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate);
  if (Number.isNaN(d.getTime())) return '';
  const datePart = formatDateHu(toDateStr(d));
  const timePart = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `${datePart} ${timePart}`;
}

export function isWeekend(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const day = new Date(y, m - 1, d).getDay();
  return day === 0 || day === 6;
}

/** Az a hét-kezdő (HÉTFŐ) dátum, amelyikbe a megadott nap esik - hetenkénti csoportosításhoz. */
export function getWeekStart(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const day = date.getDay(); // 0=vasárnap .. 6=szombat
  const diffToMonday = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + diffToMonday);
  return toDateStr(date);
}

/** A hét utolsó napja (VASÁRNAP), a getWeekStart párja. */
export function getWeekEnd(dateStr) {
  return addDays(getWeekStart(dateStr), 6);
}

export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + n);
  return toDateStr(date);
}

// ---------------------------------------------------------------------------
// MAGYAR MUNKASZÜNETI NAPOK – a mozgó ünnepeket (nagypéntek, húsvéthétfő,
// pünkösdhétfő) a húsvét dátumából számoljuk ki (Meeus/Jones/Butcher-algoritmus),
// ezért ÉVFÜGGETLENÜL, bármelyik jövőbeli évre is helyesen működik, nem csak
// egy előre rögzített évre. A fix dátumú ünnepekkel együtt ez a hivatalos,
// 11 napos magyar munkaszüneti nap lista. (A naptári "ledolgozós szombat" /
// "kapott pihenőnap" áthelyezéseket - amik évente egyedi kormányrendelettel
// változnak - ez szándékosan NEM tartalmazza, mert azok nem előre
// kiszámíthatók algoritmikusan.)
// ---------------------------------------------------------------------------

/** Húsvétvasárnap dátuma a megadott (Gergely-naptár szerinti) évre. */
export function computeEasterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const mo = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * mo + 114) / 31);
  const day = ((h + l - 7 * mo + 114) % 31) + 1;
  return toDateStr(new Date(year, month - 1, day));
}

const holidayCache = new Map();

/** Az adott év magyar munkaszüneti napjainak halmaza ('YYYY-MM-DD' Set). */
export function getHungarianHolidays(year) {
  if (holidayCache.has(year)) return holidayCache.get(year);
  const easter = computeEasterSunday(year);
  const set = new Set([
    `${year}-01-01`, // Újév
    addDays(easter, -2), // Nagypéntek
    addDays(easter, 1), // Húsvéthétfő
    `${year}-03-15`, // Nemzeti ünnep
    `${year}-05-01`, // A munka ünnepe
    addDays(easter, 50), // Pünkösdhétfő
    `${year}-08-20`, // Az államalapítás ünnepe
    `${year}-10-23`, // Nemzeti ünnep
    `${year}-11-01`, // Mindenszentek
    `${year}-12-25`, // Karácsony
    `${year}-12-26`, // Karácsony másnapja
  ]);
  holidayCache.set(year, set);
  return set;
}

export function isHungarianHoliday(dateStr) {
  const year = Number(dateStr.slice(0, 4));
  return getHungarianHolidays(year).has(dateStr);
}

// ---------------------------------------------------------------------------
// SZÖVEGES SZŰRÉS – részleges egyezés alapértelmezetten, '*' joker-karakterrel
// bővíthető (mint a Windows Intéző keresője): pl. "beteg" megtalálja a
// "tegnap beteg voltam" szöveget is, "proj*terv" pedig a "projekt terv"-et.
// ---------------------------------------------------------------------------

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function matchesTextFilter(text, query) {
  const q = (query || '').trim();
  if (!q) return true;
  const haystack = (text || '').toLowerCase();
  if (q.includes('*')) {
    const pattern = q.split('*').map(escapeRegExp).join('.*');
    try {
      return new RegExp(pattern, 'i').test(text || '');
    } catch (e) {
      return haystack.includes(q.toLowerCase());
    }
  }
  return haystack.includes(q.toLowerCase());
}

export function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Két lista (pl. users vagy entries) összefésülése id szerint; azonos id esetén az újabb updatedAt nyer. */
export function mergeById(listA, listB) {
  const map = new Map();
  for (const item of listA || []) map.set(item.id, item);
  for (const item of listB || []) {
    const existing = map.get(item.id);
    if (!existing || new Date(item.updatedAt) > new Date(existing.updatedAt)) {
      map.set(item.id, item);
    }
  }
  return Array.from(map.values());
}
