// ============================================================================
// RANDOM GENERATOR – munkakezdő időpont és munkaidő-hossz véletlenszerű
// generálása, három egymásra épülő szinten:
//
//  1) NAPI SZINT: a kezdés egy megadott időtartományban (pl. 8:00-9:00)
//     egyenletes eloszlású véletlen; a munkaidő HOSSZA egy megadott
//     minimum-maximum sávon belül GAUSS-ELOSZLÁSÚ (a sáv közepe körül a
//     leggyakoribb, a szélsőértékek felé egyre ritkább) - ez adja ki a
//     záró időpontot (kezdés + hossz).
//
//  2) HETI/HAVI KVÓTA: ha be van kapcsolva, a napokat hét (hétfő-vasárnap)
//     vagy hónap szerint csoportosítjuk, és csoportonként FUTÓ ÁTLAGGAL
//     dolgozunk: minden nap előtt újraszámoljuk, hogy a cél óraszámból mennyi
//     van még hátra, és azt osztjuk el a még hátralévő napok között - pontosan
//     ahogy kérted: "ha 26 óra hiányzik és 3 nap van hátra, a napi átlagot
//     ~8,67 órára kell növelni". A már meglévő (nem újragenerált) bejegyzések
//     óraszáma is beleszámít az adott hét/hónap "alap" teljesítésébe.
//
//  3) TŰRÉS: a hét/hónap-szintű tűrés (±óra) statisztikailag határozza meg a
//     napi Gauss-szórást (sigma = tűrés / sqrt(napok száma)) - így szűkebb
//     tűrésnél a napi értékek szorosabban a kiszámolt átlag körül mozognak,
//     tágabb tűrésnél nagyobb a napi ingadozás. A cél SOSEM lesz perc-pontos
//     (ahogy kérted sem kell annak lennie), de ez adja meg, "mennyire
//     próbálkozzon" pontosan találni.
// ============================================================================

import { addDays, isWeekend, isHungarianHoliday, getWeekStart, createEntry, durationMinutes } from './models.js';

function timeToMinutes(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function minutesToTime(mins) {
  const m = ((mins % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

function randomInRange(fromTime, toTime) {
  const a = timeToMinutes(fromTime);
  const b = timeToMinutes(toTime);
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return minutesToTime(lo + Math.floor(Math.random() * (hi - lo + 1)));
}

/** Standard normális eloszlású véletlen szám (Box-Muller transzformáció). */
function gaussianSample(mean, stdDev) {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return mean + z * stdDev;
}

/** Gauss-eloszlású munkaidő-hossz (percben), [minM, maxM] sávra szorítva. */
function sampleDurationMinutes(meanMinutes, minM, maxM, sigma) {
  const clampedMean = Math.min(maxM, Math.max(minM, meanMinutes));
  const value = Math.round(gaussianSample(clampedMean, sigma));
  return Math.min(maxM, Math.max(minM, value));
}

function groupKeyFor(date, quotaPeriod) {
  if (quotaPeriod === 'weekly') return getWeekStart(date);
  if (quotaPeriod === 'monthly') return date.slice(0, 7);
  return '__flat__';
}

function makeEntry(cfg, date, durationMins) {
  const startTime = randomInRange(cfg.startFrom, cfg.startTo);
  const endTime = minutesToTime(timeToMinutes(startTime) + durationMins);
  return createEntry({
    userId: cfg.userId,
    date,
    startTime,
    endTime,
    source: 'random',
    deviceId: cfg.deviceId || '',
    deviceName: cfg.deviceName || '',
    note: 'Automatikusan generált időpont',
  });
}

/**
 * Bejegyzések legyártása egy dátumtartományra.
 *
 * @param {object} cfg
 * @param {string} cfg.userId
 * @param {string} cfg.fromDate 'YYYY-MM-DD'
 * @param {string} cfg.toDate 'YYYY-MM-DD'
 * @param {string} cfg.startFrom 'HH:MM' - kezdés tartomány eleje
 * @param {string} cfg.startTo 'HH:MM' - kezdés tartomány vége
 * @param {number} cfg.minDurationHours - napi minimum munkaidő (óra, lehet tizedes)
 * @param {number} cfg.maxDurationHours - napi maximum munkaidő (óra, lehet tizedes)
 * @param {boolean} [cfg.skipWeekends]
 * @param {boolean} [cfg.skipHolidays] - magyar munkaszüneti napok kihagyása
 * @param {'none'|'weekly'|'monthly'} [cfg.quotaPeriod] - kvóta-alapú elosztás időegysége
 * @param {number} [cfg.quotaTargetHours] - cél óraszám a kvóta-időszakra (csak ha quotaPeriod!='none')
 * @param {number} [cfg.quotaToleranceHours] - ± tűrés órában (befolyásolja a napi szórást)
 * @param {string} [cfg.deviceId]
 * @param {string} [cfg.deviceName]
 *
 * @param {object} context
 * @param {Array<{date:string, startTime:string, endTime:string|null}>} context.existingEntriesForUser
 *   A felhasználó azon bejegyzései, amik a generálás UTÁN is megmaradnak (tehát ha
 *   overwrite=true, a hívónak ELŐBB törölnie/tombstone-olnia kell az érintett
 *   tartományban lévőket, és csak az ez UTÁNI állapotot kell ideadnia). Ez egyszerre
 *   szolgálja a "ne írjunk felül meglévő napot" döntést ÉS a heti/havi kvóta alap-
 *   óraszámának számítását (a nem érintett napok órái beleszámítanak a kvótába).
 * @param {boolean} [context.overwrite]
 *
 * @returns {Array} újonnan létrehozott Entry rekordok listája
 */
export function generateForDateRange(cfg, context) {
  const existing = context.existingEntriesForUser || [];
  const existingDateSet = new Set(existing.map((e) => e.date));

  const candidates = [];
  let cursor = cfg.fromDate;
  while (cursor <= cfg.toDate) {
    const skip =
      (cfg.skipWeekends && isWeekend(cursor)) ||
      (cfg.skipHolidays && isHungarianHoliday(cursor)) ||
      (existingDateSet.has(cursor) && !context.overwrite);
    if (!skip) candidates.push(cursor);
    cursor = addDays(cursor, 1);
  }
  if (candidates.length === 0) return [];

  const minM = Math.round((cfg.minDurationHours ?? 7) * 60);
  const maxM = Math.round((cfg.maxDurationHours ?? 9) * 60);
  const safeMin = Math.min(minM, maxM);
  const safeMax = Math.max(minM, maxM);
  const flatMean = (safeMin + safeMax) / 2;
  const flatSigma = Math.max(10, (safeMax - safeMin) / 5);

  const quotaPeriod = cfg.quotaPeriod || 'none';

  if (quotaPeriod === 'none') {
    return candidates.map((date) => makeEntry(cfg, date, sampleDurationMinutes(flatMean, safeMin, safeMax, flatSigma)));
  }

  // --- Kvóta-alapú elosztás (heti vagy havi csoportosítással) ---
  const groups = new Map(); // key -> { dates: string[], baselineMinutes: number }
  for (const date of candidates) {
    const key = groupKeyFor(date, quotaPeriod);
    if (!groups.has(key)) groups.set(key, { dates: [], baselineMinutes: 0 });
    groups.get(key).dates.push(date);
  }
  for (const e of existing) {
    const key = groupKeyFor(e.date, quotaPeriod);
    const group = groups.get(key);
    if (!group) continue; // ez a hét/hónap nincs érintve a mostani generálásban
    group.baselineMinutes += (e.endTime ? durationMinutes({ startTime: e.startTime, endTime: e.endTime }) : 0) || 0;
  }

  const targetMinutes = Math.round((cfg.quotaTargetHours || 0) * 60);
  const toleranceMinutes = Math.round((cfg.quotaToleranceHours ?? 2) * 60);

  const results = [];
  for (const { dates, baselineMinutes } of groups.values()) {
    const groupSigma = Math.max(10, Math.min(toleranceMinutes / Math.sqrt(dates.length), (safeMax - safeMin) / 2 || flatSigma));
    let remainingTarget = targetMinutes - baselineMinutes;
    let remainingDays = dates.length;
    for (const date of dates) {
      const runningAverage = remainingDays > 0 ? remainingTarget / remainingDays : flatMean;
      const duration = sampleDurationMinutes(runningAverage, safeMin, safeMax, groupSigma);
      results.push(makeEntry(cfg, date, duration));
      remainingTarget -= duration;
      remainingDays -= 1;
    }
  }
  // Végigmegyünk az eredeti dátumsorrendben, hogy a lista mindig kronologikus legyen.
  results.sort((a, b) => a.date.localeCompare(b.date));
  return results;
}
