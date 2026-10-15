#!/usr/bin/env node
// ============================================================================
// A MUNKANAPTÁR-FÁJL ELLENŐRZŐJE
//
// Használat (Node.js 18 vagy újabb szükséges, a projekt gyökeréből):
//     node tools/validate-calendar.mjs
//     node tools/validate-calendar.mjs data/hu_munkarend_naptar.json
//
// Futtasd minden kézi frissítés UTÁN, feltöltés előtt: megtalálja az elgépelt dátumot,
// a rossz hétköznapot, a hézagot a napok között, és azt, ha egy áthelyezett munkanapnak
// nincs párja. A kilépési kód hibánál 1, hibátlan fájlnál 0.
// (Az app futásához nem kell - ez csak a frissítést segítő eszköz.)
// ============================================================================

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const STATUSES = ['working_day', 'weekend_rest_day', 'public_holiday', 'transferred_workday', 'transferred_rest_day'];
const RE_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isoWeekday(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=vasárnap
  return w === 0 ? 7 : w;
}

function nextDay(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/** @returns {{errors:string[], warnings:string[], stats:object}} */
export function validateCalendar(json) {
  const errors = [];
  const warnings = [];
  const err = (m) => { if (errors.length < 60) errors.push(m); };

  if (!json || typeof json !== 'object') return { errors: ['A fájl nem érvényes JSON-objektum.'], warnings, stats: {} };
  if (!Array.isArray(json.days) || json.days.length === 0) return { errors: ['Hiányzik vagy üres a "days" lista.'], warnings, stats: {} };

  const byDate = new Map();
  let prev = null;
  for (const [i, d] of json.days.entries()) {
    const where = `days[${i}] (${d && d.date})`;
    if (!d || typeof d.date !== 'string' || !RE_DATE.test(d.date)) { err(`${where}: hibás dátum-formátum (ÉÉÉÉ-HH-NN kell).`); continue; }
    if (byDate.has(d.date)) err(`${where}: kétszer szerepel ez a dátum.`);
    byDate.set(d.date, d);
    if (prev) {
      if (d.date <= prev) err(`${where}: nem növekvő sorrend (az előző nap ${prev}).`);
      else if (d.date !== nextDay(prev)) err(`${where}: hézag a napok között (az előző nap ${prev}, a várt ${nextDay(prev)}).`);
    }
    prev = d.date;

    const wd = isoWeekday(d.date);
    const weekend = wd >= 6;
    if (d.weekday !== wd) err(`${where}: a "weekday" értéke ${d.weekday}, de ez a nap a hét ${wd}. napja (1=hétfő).`);
    if (!STATUSES.includes(d.status)) { err(`${where}: ismeretlen "status": ${d.status}.`); continue; }
    if (typeof d.isWorkingDay !== 'boolean' || typeof d.isRestDay !== 'boolean') { err(`${where}: hiányzik az isWorkingDay/isRestDay logikai érték.`); continue; }
    if (d.isWorkingDay === d.isRestDay) err(`${where}: az isWorkingDay és az isRestDay nem lehet azonos.`);
    if (d.isWeekend !== weekend) err(`${where}: az isWeekend értéke nem egyezik a hétköznappal.`);
    switch (d.status) {
      case 'working_day': if (weekend || !d.isWorkingDay) err(`${where}: "working_day" csak hétköznapi munkanap lehet.`); break;
      case 'weekend_rest_day': if (!weekend || d.isWorkingDay) err(`${where}: "weekend_rest_day" csak hétvégi pihenőnap lehet.`); break;
      case 'public_holiday': if (d.isWorkingDay) err(`${where}: "public_holiday" nem lehet munkanap.`); break;
      case 'transferred_workday': if (!weekend || !d.isWorkingDay) err(`${where}: "transferred_workday" hétvégére eső munkanap kell legyen.`); break;
      case 'transferred_rest_day': if (weekend || d.isWorkingDay) err(`${where}: "transferred_rest_day" hétköznapi pihenőnap kell legyen.`); break;
      default: break;
    }
  }

  const dates = [...byDate.keys()];
  const first = dates[0];
  const last = dates[dates.length - 1];
  const c = json.coverage || {};
  if (c.dayCount !== json.days.length) err(`coverage.dayCount (${c.dayCount}) nem egyezik a napok számával (${json.days.length}).`);
  if (c.startDate !== first) err(`coverage.startDate (${c.startDate}) nem egyezik az első nappal (${first}).`);
  if (c.endDate !== last) err(`coverage.endDate (${c.endDate}) nem egyezik az utolsó nappal (${last}).`);
  if (!first.endsWith('-01-01')) warnings.push(`Az első nap (${first}) nem január 1.`);
  if (!last.endsWith('-12-31')) warnings.push(`Az utolsó nap (${last}) nem december 31. - az utolsó év nem teljes, a program ezért nem tekinti lefedettnek.`);

  // Áthelyezések párosítása
  const changes = Array.isArray(json.workScheduleChanges) ? json.workScheduleChanges : [];
  const usedWork = new Set();
  const usedRest = new Set();
  for (const ch of changes) {
    const w = byDate.get(ch.workingDate);
    const r = byDate.get(ch.restDate);
    if (!w || w.status !== 'transferred_workday') err(`workScheduleChanges ${ch.id}: a ledolgozós nap (${ch.workingDate}) nem "transferred_workday" a napok között.`);
    if (!r || r.status !== 'transferred_rest_day') err(`workScheduleChanges ${ch.id}: a pihenőnap (${ch.restDate}) nem "transferred_rest_day" a napok között.`);
    if (usedWork.has(ch.workingDate)) err(`workScheduleChanges ${ch.id}: a ledolgozós nap (${ch.workingDate}) többször szerepel.`);
    if (usedRest.has(ch.restDate)) err(`workScheduleChanges ${ch.id}: a pihenőnap (${ch.restDate}) többször szerepel.`);
    usedWork.add(ch.workingDate);
    usedRest.add(ch.restDate);
  }
  const tw = dates.filter((d) => byDate.get(d).status === 'transferred_workday');
  const tr = dates.filter((d) => byDate.get(d).status === 'transferred_rest_day');
  if (tw.length !== tr.length) err(`Az áthelyezett munkanapok (${tw.length}) és pihenőnapok (${tr.length}) száma nem egyezik - valahol hiányzik a pár.`);
  for (const d of tw) if (!usedWork.has(d)) err(`${d}: áthelyezett munkanap, de nincs hozzá bejegyzés a workScheduleChanges listában.`);
  for (const d of tr) if (!usedRest.has(d)) err(`${d}: áthelyezett pihenőnap, de nincs hozzá bejegyzés a workScheduleChanges listában.`);

  const years = [...new Set(dates.map((d) => d.slice(0, 4)))];
  if (json.years && typeof json.years === 'object') {
    for (const y of years) if (!json.years[y]) warnings.push(`A "years" szakaszból hiányzik a(z) ${y}. év.`);
  }

  return {
    errors,
    warnings,
    stats: { first, last, dayCount: dates.length, years: years.length, transferredPairs: tw.length, lastYear: Number(last.slice(0, 4)) },
  };
}

// ---- Parancssori futtatás ----
const isCli = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isCli) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const file = resolve(process.argv[2] || resolve(root, 'data/hu_munkarend_naptar.json'));
  let json;
  try {
    json = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`Nem olvasható/érvénytelen JSON: ${file}\n${e.message}`);
    process.exit(1);
  }
  const { errors, warnings, stats } = validateCalendar(json);
  console.log(`Fájl: ${file}`);
  if (stats.first) console.log(`Lefedettség: ${stats.first} – ${stats.last} (${stats.dayCount} nap, ${stats.years} év, ${stats.transferredPairs} áthelyezett nap-pár)`);
  warnings.forEach((w) => console.log(`FIGYELMEZTETÉS: ${w}`));
  errors.forEach((e) => console.log(`HIBA: ${e}`));
  if (errors.length === 0) {
    const now = new Date();
    const needYear = now.getMonth() >= 10 ? now.getFullYear() + 1 : now.getFullYear();
    console.log(stats.lastYear >= needYear
      ? `OK – a fájl hibátlan, és lefedi a(z) ${needYear}. évet is.`
      : `A fájl hibátlan, DE nem tartalmaz adatot a(z) ${needYear}. évre - frissítés szükséges.`);
  }
  process.exit(errors.length ? 1 : 0);
}
