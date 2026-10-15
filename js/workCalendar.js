// ============================================================================
// WORKCALENDAR – a magyar munkanaptár (munkaszüneti napok + áthelyezett
// munkanapok/pihenőnapok) betöltése a `data/hu_munkarend_naptar.json` fájlból.
//
// MIÉRT KÜLÖN FÁJL? Az áthelyezett munkanapokat/pihenőnapokat évente kormányrendelet
// határozza meg (október 31-ig kell közzétenni a következő évre), ezek NEM számolhatók
// ki képlettel. A fájlt kézzel kell évente kiegészíteni (lásd README → Munkanaptár).
//
// MI A FALLBACK? Ahol a fájl nem fed le egy napot (pl. 2027, amíg nincs benne), ott a
// régi szabály dolgozik: hétvége és (képlettel kiszámolt) munkaszüneti nap = nem munkanap.
// Így az app a fájl lejárta után sem áll le, csak az áthelyezéseket nem ismeri.
//
// A tiszta függvények (build/getDayInfo/reminder...) cal paramétert is kapnak, így
// külön tesztelhetők; az app a modul-szintű, betöltött naptárat használja.
// ============================================================================

import { addDays, isWeekend, isHungarianHoliday, formatDateHu } from './models.js';

export const CALENDAR_URL = './data/hu_munkarend_naptar.json';

const STATUS_TO_KIND = {
  working_day: 'workday',
  weekend_rest_day: 'weekend',
  public_holiday: 'holiday',
  transferred_workday: 'transferred_workday',
  transferred_rest_day: 'transferred_rest_day',
};

const RE_DATE = /^\d{4}-\d{2}-\d{2}$/;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function isLeap(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

let current = null;
let loadError = null;

export function setWorkCalendar(cal) { current = cal; }
export function getWorkCalendar() { return current; }
export function getWorkCalendarLoadError() { return loadError; }

/**
 * A JSON-ból gyors, memóriabeli naptárat épít. Érvénytelen/üres bemenetre null.
 * @returns {{days:Map<string,object>, fullYears:Set<number>, startDate:string, endDate:string,
 *            generatedAt:string, calendarId:string}|null}
 */
export function buildWorkCalendar(json) {
  if (!json || !Array.isArray(json.days) || json.days.length === 0) return null;
  const days = new Map();
  const perYear = new Map();
  for (const d of json.days) {
    if (!d || typeof d.date !== 'string' || !RE_DATE.test(d.date)) continue;
    const kind = STATUS_TO_KIND[d.status];
    if (!kind) continue;
    days.set(d.date, {
      kind,
      working: !!d.isWorkingDay,
      name: (d.holiday && d.holiday.name) || '',
      paired: (d.transfer && d.transfer.pairedDate) || '',
    });
    const y = Number(d.date.slice(0, 4));
    perYear.set(y, (perYear.get(y) || 0) + 1);
  }
  if (days.size === 0) return null;
  // Egy év akkor "teljesen lefedett", ha mind a 365/366 napja szerepel a fájlban.
  const fullYears = new Set();
  for (const [y, n] of perYear) if (n === (isLeap(y) ? 366 : 365)) fullYears.add(y);
  const dates = [...days.keys()].sort();
  return {
    days,
    fullYears,
    startDate: dates[0],
    endDate: dates[dates.length - 1],
    generatedAt: typeof json.generatedAt === 'string' ? json.generatedAt : '',
    calendarId: typeof json.calendarId === 'string' ? json.calendarId : '',
  };
}

/** Betölti és beállítja a naptárat. Hiba esetén null (és az app a fallback szabályra áll). */
export async function loadWorkCalendar(url = CALENDAR_URL) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const cal = buildWorkCalendar(await res.json());
    if (!cal) throw new Error('A naptárfájl üres vagy hibás szerkezetű.');
    loadError = null;
    current = cal;
    return cal;
  } catch (e) {
    loadError = (e && e.message) || String(e);
    current = null;
    return null;
  }
}

/**
 * Egy nap besorolása.
 * @returns {{kind:'workday'|'weekend'|'holiday'|'transferred_workday'|'transferred_rest_day',
 *            isWorkingDay:boolean, name:string, pairedDate:string, covered:boolean}}
 */
export function getDayInfo(dateStr, cal = current) {
  const rec = cal && cal.days.get(dateStr);
  if (rec) {
    return { kind: rec.kind, isWorkingDay: rec.working, name: rec.name, pairedDate: rec.paired, covered: true };
  }
  // A naptár nem fedi le ezt a napot -> hétvége/képlettel számolt ünnepnap szabály.
  if (isHungarianHoliday(dateStr)) return { kind: 'holiday', isWorkingDay: false, name: '', pairedDate: '', covered: false };
  if (isWeekend(dateStr)) return { kind: 'weekend', isWorkingDay: false, name: '', pairedDate: '', covered: false };
  return { kind: 'workday', isWorkingDay: true, name: '', pairedDate: '', covered: false };
}

export function isWorkingDay(dateStr, cal = current) {
  return getDayInfo(dateStr, cal).isWorkingDay;
}

/** Olvasható leírás a naptárban/irányítópulton megjelenítéshez. */
export function describeDay(info) {
  switch (info.kind) {
    case 'weekend': return 'hétvége';
    case 'holiday': return info.name ? `munkaszüneti nap: ${info.name}` : 'munkaszüneti nap';
    case 'transferred_rest_day':
      return info.pairedDate ? `áthelyezett pihenőnap (ledolgozás: ${formatDateHu(info.pairedDate)})` : 'áthelyezett pihenőnap';
    case 'transferred_workday':
      return info.pairedDate ? `áthelyezett munkanap (pihenőnap: ${formatDateHu(info.pairedDate)})` : 'áthelyezett munkanap';
    default: return 'munkanap';
  }
}

export function hasFullYear(year, cal = current) {
  return !!cal && cal.fullYears.has(year);
}

/** A [from, to] tartomány azon évei, amelyekben van olyan nap, amit a naptár nem fed le. */
export function uncoveredYearsInRange(fromDate, toDate, cal = current) {
  const years = new Set();
  let d = fromDate;
  let guard = 0;
  while (d <= toDate && guard++ < 4000) {
    if (!cal || !cal.days.has(d)) years.add(Number(d.slice(0, 4)));
    d = addDays(d, 1);
  }
  return [...years].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// FRISSÍTÉSI EMLÉKEZTETŐ
// A következő évi munkarendet október 31-ig kell közzétenni. November 1-jétől a
// KÖVETKEZŐ évnek kell szerepelnie a fájlban; azelőtt legalább az IDEI évnek (így az
// emlékeztető akkor sem némul el januárban, ha novemberben/decemberben elmaradt a frissítés).
// ---------------------------------------------------------------------------

/** @returns {{unknown:boolean, requiredYear:number, missing:boolean}} */
export function calendarUpdateStatus(todayStr, cal = current) {
  const year = Number(todayStr.slice(0, 4));
  const afterDeadline = Number(todayStr.slice(5, 7)) >= 11; // november 1. vagy később
  const requiredYear = afterDeadline ? year + 1 : year;
  if (!cal) return { unknown: true, requiredYear, missing: false };
  return { unknown: false, requiredYear, missing: !cal.fullYears.has(requiredYear) };
}

/**
 * Meg kell-e jeleníteni most az emlékeztetőt?
 * Csak adminnak, csak ha hiányzik a szükséges év, és legfeljebb hetente egyszer.
 * @param {{today:string, cal?:object|null, isAdmin:boolean, lastShownAt?:string|null, now?:Date}} o
 */
export function reminderDue({ today, cal = current, isAdmin, lastShownAt = null, now = new Date() }) {
  const status = calendarUpdateStatus(today, cal);
  if (!isAdmin) return { due: false, reason: 'not-admin', ...status };
  if (!status.missing) return { due: false, reason: status.unknown ? 'unknown' : 'up-to-date', ...status };
  if (lastShownAt) {
    const last = new Date(lastShownAt).getTime();
    if (!Number.isNaN(last) && now.getTime() - last < WEEK_MS) return { due: false, reason: 'shown-recently', ...status };
  }
  return { due: true, reason: 'missing-year', ...status };
}
