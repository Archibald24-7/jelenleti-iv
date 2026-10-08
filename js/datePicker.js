// ============================================================================
// DATEPICKER – saját dátum-widget, mert a natív <input type="date"> megjelenése
// (sorrend, elválasztó, hét első napja) a böngésző/OS nyelvét követi.
//
// KÉT BEVITELI MÓD EGYSZERRE:
//  1) GÉPELÉS: a szövegmezőbe csak számjegyeket kell írni, a pontokat a mező
//     magától beilleszti (pl. 20160315 -> 2016.03.15.). Az elválasztónak a "."
//     és a "/" jel is megfelel. Elhagyva a fókuszt (vagy Enterre) ellenőrizzük,
//     hogy valódi naptári nap-e (pl. 2026.02.30. nem az).
//  2) NAPTÁR: az ikonra kattintva felugró naptár nyílik, hétfővel kezdődő héttel.
//     A fejlécre kattintva háromszintű gyors lapozás: napok -> hónapok -> évek
//     (pl. 10 évvel korábbra két-három kattintással el lehet jutni).
//
// A kanonikus érték egy rejtett input-ban él ISO 'YYYY-MM-DD' alakban (ezt
// olvassa a FormData), a látható szövegmező csak megjelenítés/gépelés.
// ============================================================================

import { toDateStr, formatDateHu, isWeekend, isHungarianHoliday } from './models.js';

const HU_WEEKDAYS_MIN = ['H', 'K', 'Sze', 'Cs', 'P', 'Szo', 'V']; // hétfővel kezdve
const HU_MONTHS = [
  'Január', 'Február', 'Március', 'Április', 'Május', 'Június',
  'Július', 'Augusztus', 'Szeptember', 'Október', 'November', 'December',
];
const HU_MONTHS_SHORT = ['Jan', 'Feb', 'Már', 'Ápr', 'Máj', 'Jún', 'Júl', 'Aug', 'Szep', 'Okt', 'Nov', 'Dec'];

// ---------------------------------------------------------------------------
// Tiszta (DOM-független) segédfüggvények - külön tesztelhetők
// ---------------------------------------------------------------------------

/** A beírt számjegyekből éééé.hh.nn. alakú szöveget épít (pontokat magától illeszt be). */
export function formatTypedDate(raw) {
  const digits = String(raw || '').replace(/\D/g, '').slice(0, 8);
  let out = digits.slice(0, 4);
  if (digits.length > 4) out += '.' + digits.slice(4, 6);
  if (digits.length > 6) out += '.' + digits.slice(6, 8);
  if (digits.length >= 8) out += '.';
  return out;
}

/** "2016.03.15." / "2016.3.5" / "2016/03/15" -> '2016-03-15'. Érvénytelen (pl. feb. 30.) esetén null. */
export function parseHuDate(text) {
  const m = String(text || '').trim().match(/^(\d{4})[./](\d{1,2})[./](\d{1,2})\.?$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const date = new Date(y, mo - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
  return toDateStr(date);
}

/** A hónap 42 cellás (6 hét x 7 nap) rácsa, hétfővel kezdve. month: 0-indexelt. */
export function buildMonthGrid(year, month) {
  const first = new Date(year, month, 1);
  const offset = (first.getDay() + 6) % 7; // hétfő=0 ... vasárnap=6
  const start = new Date(year, month, 1 - offset);
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    cells.push(d);
  }
  return cells;
}

/** Az évválasztó 12 éves "oldalának" első éve (pl. 2026 -> 2016, hogy az oldal 2016..2027). */
export function yearPageStart(year) {
  return year - (((year % 12) + 12) % 12);
}

// ---------------------------------------------------------------------------
// Felugró naptár
// ---------------------------------------------------------------------------

let activePopup = null;

const raf =
  (typeof window !== 'undefined' && window.requestAnimationFrame && window.requestAnimationFrame.bind(window)) ||
  ((fn) => setTimeout(fn, 0));

function closePopup() {
  if (activePopup) {
    activePopup.remove();
    activePopup = null;
  }
  document.removeEventListener('mousedown', onDocClick, true);
  document.removeEventListener('keydown', onDocKey, true);
}

function onDocClick(e) {
  if (activePopup && !activePopup.contains(e.target) && e.target !== activePopup._anchorEl && !activePopup._anchorEl.contains(e.target)) {
    closePopup();
  }
}

function onDocKey(e) {
  if (e.key === 'Escape') closePopup();
}

function positionPopup(popup, anchor) {
  popup.style.visibility = 'hidden';
  raf(() => {
    const rect = anchor.getBoundingClientRect();
    const pw = popup.offsetWidth;
    const ph = popup.offsetHeight;
    let left = rect.right - pw; // a mező jobb széléhez igazítjuk
    if (left < 8) left = 8;
    if (left + pw > window.innerWidth - 8) left = Math.max(8, window.innerWidth - pw - 8);
    let top = rect.bottom + 4;
    if (top + ph > window.innerHeight - 8) top = Math.max(8, rect.top - ph - 4);
    popup.style.left = `${left}px`;
    popup.style.top = `${top}px`;
    popup.style.visibility = 'visible';
  });
}

/** Érték beállítása kódból/naptárból: rejtett ISO mező + látható szöveg + visszahívás. */
function setFieldValue(wrapper, isoOrEmpty) {
  const hidden = wrapper.querySelector('input[type="hidden"]');
  const text = wrapper.querySelector('.date-field-input');
  hidden.value = isoOrEmpty;
  text.value = isoOrEmpty ? formatDateHu(isoOrEmpty) : '';
  text.classList.remove('invalid');
  if (typeof wrapper._onDateChange === 'function') wrapper._onDateChange(isoOrEmpty);
}

function openCalendar(wrapper) {
  closePopup();
  const hidden = wrapper.querySelector('input[type="hidden"]');
  const anchor = wrapper;
  const currentVal = hidden.value || '';
  const base = currentVal ? currentVal.split('-').map(Number) : null;
  const now = new Date();

  let view = 'days'; // 'days' | 'months' | 'years'
  let viewYear = base ? base[0] : now.getFullYear();
  let viewMonth = base ? base[1] - 1 : now.getMonth();
  let yearsStart = yearPageStart(viewYear);

  const popup = document.createElement('div');
  popup.className = 'dp-popup';
  popup.setAttribute('role', 'dialog');
  popup.setAttribute('aria-label', 'Naptár');
  popup._anchorEl = anchor;

  const todayStr = toDateStr(now);

  function titleHtml() {
    if (view === 'days') return `${HU_MONTHS[viewMonth]} ${viewYear}`;
    if (view === 'months') return `${viewYear}`;
    return `${yearsStart} – ${yearsStart + 11}`;
  }

  function bodyHtml() {
    if (view === 'days') {
      const cells = buildMonthGrid(viewYear, viewMonth);
      return `
        <div class="dp-weekdays">${HU_WEEKDAYS_MIN.map((w) => `<span>${w}</span>`).join('')}</div>
        <div class="dp-grid">
          ${cells
            .map((d) => {
              const ds = toDateStr(d);
              const cls = ['dp-cell'];
              if (d.getMonth() !== viewMonth) cls.push('dp-muted');
              if (ds === todayStr) cls.push('dp-today');
              if (ds === currentVal) cls.push('dp-selected');
              if (isWeekend(ds) || isHungarianHoliday(ds)) cls.push('dp-weekend');
              return `<button type="button" class="${cls.join(' ')}" data-date="${ds}">${d.getDate()}</button>`;
            })
            .join('')}
        </div>`;
    }
    if (view === 'months') {
      return `<div class="dp-pick-grid">
        ${HU_MONTHS_SHORT.map((name, i) => {
          const cls = ['dp-pick'];
          if (base && base[0] === viewYear && base[1] - 1 === i) cls.push('dp-selected');
          if (now.getFullYear() === viewYear && now.getMonth() === i) cls.push('dp-today');
          return `<button type="button" class="${cls.join(' ')}" data-month="${i}">${name}</button>`;
        }).join('')}
      </div>`;
    }
    return `<div class="dp-pick-grid">
      ${Array.from({ length: 12 }, (_, i) => yearsStart + i).map((y) => {
        const cls = ['dp-pick'];
        if (base && base[0] === y) cls.push('dp-selected');
        if (now.getFullYear() === y) cls.push('dp-today');
        return `<button type="button" class="${cls.join(' ')}" data-year="${y}">${y}</button>`;
      }).join('')}
    </div>`;
  }

  function render() {
    popup.innerHTML = `
      <div class="dp-header">
        <button type="button" class="dp-nav" data-dir="-1" aria-label="Előző">‹</button>
        <button type="button" class="dp-title ${view === 'years' ? 'dp-title-static' : ''}" aria-label="Nézet váltása">${titleHtml()}</button>
        <button type="button" class="dp-nav" data-dir="1" aria-label="Következő">›</button>
      </div>
      ${bodyHtml()}
      <div class="dp-footer">
        <button type="button" class="dp-footer-btn" data-date="${todayStr}">Ma</button>
        <button type="button" class="dp-footer-btn dp-footer-clear">Törlés</button>
      </div>`;

    popup.querySelectorAll('.dp-nav').forEach((b) =>
      b.addEventListener('click', () => {
        const dir = Number(b.dataset.dir);
        if (view === 'days') {
          viewMonth += dir;
          if (viewMonth < 0) { viewMonth = 11; viewYear -= 1; }
          if (viewMonth > 11) { viewMonth = 0; viewYear += 1; }
        } else if (view === 'months') {
          viewYear += dir;
        } else {
          yearsStart += dir * 12;
        }
        render();
      })
    );
    popup.querySelector('.dp-title').addEventListener('click', () => {
      if (view === 'days') view = 'months';
      else if (view === 'months') { view = 'years'; yearsStart = yearPageStart(viewYear); }
      render();
    });
    popup.querySelectorAll('[data-month]').forEach((b) =>
      b.addEventListener('click', () => { viewMonth = Number(b.dataset.month); view = 'days'; render(); })
    );
    popup.querySelectorAll('[data-year]').forEach((b) =>
      b.addEventListener('click', () => { viewYear = Number(b.dataset.year); view = 'months'; render(); })
    );
    popup.querySelectorAll('[data-date]').forEach((b) =>
      b.addEventListener('click', () => {
        setFieldValue(wrapper, b.dataset.date);
        closePopup();
      })
    );
    const clearBtn = popup.querySelector('.dp-footer-clear');
    if (clearBtn) clearBtn.addEventListener('click', () => { setFieldValue(wrapper, ''); closePopup(); });
  }

  render();
  document.body.appendChild(popup);
  activePopup = popup;
  positionPopup(popup, anchor);
  setTimeout(() => {
    document.addEventListener('mousedown', onDocClick, true);
    document.addEventListener('keydown', onDocKey, true);
  }, 0);
}

// ---------------------------------------------------------------------------
// Gépelt bevitel
// ---------------------------------------------------------------------------

function onTypedInput(ev) {
  const input = ev.target;
  const before = input.value;
  const caret = input.selectionStart == null ? before.length : input.selectionStart;
  const digitsBeforeCaret = before.slice(0, caret).replace(/\D/g, '').length;
  const formatted = formatTypedDate(before);
  if (formatted !== before) {
    input.value = formatted;
    // a kurzort ugyanannyi számjegy mögé tesszük vissza
    let count = 0;
    let pos = 0;
    if (digitsBeforeCaret > 0) {
      for (; pos < formatted.length; pos++) {
        if (/\d/.test(formatted[pos])) count++;
        if (count === digitsBeforeCaret) { pos++; break; }
      }
    }
    try { input.setSelectionRange(pos, pos); } catch (e) { /* nem kritikus */ }
  }
  input.classList.remove('invalid');
}

function commitTyped(wrapper) {
  const hidden = wrapper.querySelector('input[type="hidden"]');
  const text = wrapper.querySelector('.date-field-input');
  const raw = text.value.trim();
  if (raw === '') {
    if (hidden.value !== '') setFieldValue(wrapper, '');
    text.classList.remove('invalid');
    return;
  }
  const iso = parseHuDate(raw);
  if (iso) {
    if (iso !== hidden.value || text.value !== formatDateHu(iso)) setFieldValue(wrapper, iso);
    else text.classList.remove('invalid');
  } else {
    // Érvénytelen/hiányos: jelezzük, és a kanonikus értéket is töröljük, hogy a
    // megjelenített szöveg és az elküldendő érték ne mondjon ellent egymásnak.
    // Az élő szűrőt SZÁNDÉKOSAN nem értesítjük: ott a visszahívás újrarenderelné a
    // mezőt, és ezzel elnyelné a beírt (piros) szöveget, mielőtt javíthatná.
    text.classList.add('invalid');
    hidden.value = '';
  }
}

// ---------------------------------------------------------------------------
// Nyilvános API
// ---------------------------------------------------------------------------

const CAL_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4"/></svg>';

/** A mező statikus HTML-je - ezt kell a sablonba illeszteni. */
export function dateFieldHtml({ name, value = '', placeholder = 'éééé.hh.nn.', ariaLabel }) {
  const display = value ? formatDateHu(value) : '';
  const label = ariaLabel || placeholder;
  return `
    <div class="date-field" data-date-field>
      <input type="hidden" name="${name}" value="${value}">
      <input type="text" class="date-field-input" inputmode="numeric" autocomplete="off"
        placeholder="${placeholder}" value="${display}" maxlength="11" aria-label="${label}">
      <button type="button" class="date-field-icon-btn" aria-label="Naptár megnyitása: ${label}">${CAL_ICON}</button>
    </div>`;
}

/**
 * A konténeren belüli összes [data-date-field] élesítése.
 * @param {Element} root
 * @param {Object<string,function>} [onChangeMap] mezőnév -> (isoVagyÜres) => void;
 *   csak ott kell, ahol a változásnak AZONNAL hatnia kell (pl. élő szűrő).
 */
export function wireDateFields(root, onChangeMap = {}) {
  root.querySelectorAll('[data-date-field]').forEach((wrapper) => {
    const hidden = wrapper.querySelector('input[type="hidden"]');
    const text = wrapper.querySelector('.date-field-input');
    const iconBtn = wrapper.querySelector('.date-field-icon-btn');
    if (onChangeMap[hidden.name]) wrapper._onDateChange = onChangeMap[hidden.name];

    iconBtn.addEventListener('click', () => openCalendar(wrapper));
    text.addEventListener('input', onTypedInput);
    text.addEventListener('blur', () => commitTyped(wrapper));
    text.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        // Enter ne küldje el az űrlapot a dátum rögzítése helyett
        ev.preventDefault();
        commitTyped(wrapper);
      }
    });
  });
}

/** Esetleg nyitva hagyott naptár bezárása - háttérben történő újrarenderelés előtt hívandó. */
export function closeAnyOpenCalendar() {
  closePopup();
}
