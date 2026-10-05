// ============================================================================
// AUTO CHECKIN – automatikus bejegyzés létrehozása, amikor:
//  - Windows-on az app a bejelentkezéskor beállított automatikus indítással
//    nyílik meg (ezt a "?autostart=1" URL-paraméter jelzi - lásd
//    windows-setup/setup-autostart.ps1), VAGY
//  - a felhasználó telefonon (mobil eszközön) megnyitja az appot.
//
// FONTOS, ŐSZINTE MEGJEGYZÉS: egy böngészős alkalmazás nem tud közvetlenül
// "belehallgatni" a Windows bejelentkezési eseménybe. Amit itt csinálunk:
// az app induláskor rögzíti, hogy "elindultam", és ha ez az indítás a
// bejelentkezéskor futó automatikus indításból jött (?autostart=1), akkor
// ezt "bejelentkezés"-ként kezeljük. A gyakorlatban ugyanazt az eredményt
// adja, mint egy közvetlen esemény-figyelés.
//
// SZABÁLYOK (hogy ne szaporodjanak a duplikátumok és ne számoljon duplán az óra):
//  1. Ha a felhasználónak MA már van nyitott (le nem zárt) bejegyzése - bármelyik
//     eszközről -, nem hozunk létre újat: már "bent van".
//  2. Egy eszközről naponta legfeljebb EGY automatikus bejegyzés készül, akkor
//     is, ha közben lezárta a munkát (különben a nap végi újranyitás új
//     bejegyzést csinálna). Második műszakhoz kézi bejegyzés való.
// ============================================================================

import * as DB from './db.js';
import { createEntry, todayDateStr, nowTimeStr } from './models.js';

export function detectLaunchContext() {
  const search = (typeof window !== 'undefined' && window.location && window.location.search) || '';
  const params = new URLSearchParams(search);
  const isAutostart = params.get('autostart') === '1';
  const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
  const isMobile = /Android|iPhone|iPad|iPod/i.test(ua);
  return { isAutostart, isMobile };
}

/**
 * Ha indokolt, létrehoz egy automatikus bejegyzést a mai napra ezen az eszközön.
 * @returns {Promise<object|null>} az újonnan létrehozott bejegyzés, vagy null, ha nem kellett.
 */
export async function maybeAutoCheckin({ userId, deviceId, deviceName }) {
  const enabled = await DB.getMeta('autoCheckinEnabled', true);
  if (enabled === false) return null;

  const { isAutostart, isMobile } = detectLaunchContext();

  // Asztali gépen: KIZÁRÓLAG a bejelentkezéskor indított (autostart) indítás számít.
  // Telefonon: minden appnyitás számít, hiszen ott ez maga a "belépés az appba".
  if (!isAutostart && !isMobile) return null;

  const today = todayDateStr();

  const openToday = await DB.findOpenEntryForDate(userId, today);
  if (openToday) return null; // már be van jelentkezve (bármelyik eszközről)

  const already = await DB.findAutoEntryForToday(userId, deviceId, today);
  if (already) return null; // ezen az eszközön ma már volt automatikus bejegyzés

  const entry = createEntry({
    userId,
    date: today,
    startTime: nowTimeStr(),
    endTime: null,
    source: isAutostart ? 'auto-login' : 'auto-app-open',
    deviceId,
    deviceName,
    note: '',
  });
  await DB.putEntry(entry);
  return entry;
}
