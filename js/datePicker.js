// ============================================================================
// DATEPICKER – saját naptár-választó widget, mert a natív <input type="date">
// megjelenése (sorrend, elválasztó, a hét első napja) a böngésző/OS nyelvi
// beállítását követi, amit egy weboldal nem tud felülírni. Ez a komponens
// mindig magyar szabály szerint jelenik meg: éééé.hh.nn., hét hétfővel kezdve.
//
// HASZNÁLAT: a mezőt a dateFieldHtml() épater sablonba illesztve kell
// beszúrni (hidden input adja az ISO 'YYYY-MM-DD' értéket FormData számára),
// majd a beillesztés UTÁN meg kell hívni a wireDateFields(root, onChangeMap)-ot,
// ami minden [data-date-field]-et "élesít" a megadott konténeren belül.
// Él onChangeMap csak olyan mezőknél kell, ahol a választás AZONNAL hatnia
// kell (pl. élő szűrő) - sima űrlapoknál elég a hidden input FormData-ból
// való beolvasása submit-kor.
// ============================================================================

import { toDateStr, formatDateHu, isWeekend, isHungarianHoliday } from './models.js';

const HU_WEEKDAYS_MIN = ['H', 'K', 'Sze', 'Cs', 'P', 'Szo', 'V']; // hétfővel kezdve
const HU_MONTHS = [
  'Január', 'Február', 'Március', 'Április', 'Május', 'Június',
  'Július', 'Augusztus', 'Szeptember', 'Október', 'November', 'December',
];

let activePopup = null;

function closePopup() {
  if (activePopup) {
    activePopup.remove();
    activePopup = null;
  }
  document.removeEventListener('mousedown', onDocClick, true);
  document.removeEventListener('keydown', onDocKey, true);
}

function onDocClick(e) {
  if (activePopup && !activePopup.contains(e.target) && e.target !== activePopup._triggerEl) {
    closePopup();
  }
}

function onDocKey(e) {
  if (e.key === 'Escape') closePopup();
}

function buildMonthGrid(year, month) {
  // month: 0-indexelt (0=január). A rács mindig hétfővel kezdődik.
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

const raf =
  (typeof window !== 'undefined' && window.requestAnimationFrame && window.requestAnimationFrame.bind(window)) ||
  ((fn) => setTimeout(fn, 0));

function positionPopup(popup, trigger) {
  popup.style.visibility = 'hidden';
  raf(() => {
    const rect = trigger.getBoundingClientRect();
    const pw = popup.offsetWidth;
    const ph = popup.offsetHeight;
    let left = rect.left;
    let top = rect.bottom + 4;
    if (left + pw > window.innerWidth - 8) left = Math.max(8, window.innerWidth - pw - 8);
    if (top + ph > window.innerHeight - 8) top = Math.max(8, rect.top - ph - 4);
    popup.style.left = `${left}px`;
    popup.style.top = `${top}px`;
    popup.style.visibility = 'visible';
  });
}

function selectDate(wrapper, dateStr) {
  const hidden = wrapper.querySelector('input[type="hidden"]');
  const trigger = wrapper.querySelector('.date-field-trigger');
  hidden.value = dateStr;
  trigger.textContent = dateStr ? formatDateHu(dateStr) : (wrapper.dataset.placeholder || 'Válassz dátumot');
  trigger.classList.toggle('dp-empty', !dateStr);
  if (typeof wrapper._onDateChange === 'function') wrapper._onDateChange(dateStr);
}

function openCalendar(trigger, wrapper) {
  closePopup();
  const hidden = wrapper.querySelector('input[type="hidden"]');
  const currentVal = hidden.value || '';
  const base = currentVal ? currentVal.split('-').map(Number) : null;
  let viewYear = base ? base[0] : new Date().getFullYear();
  let viewMonth = base ? base[1] - 1 : new Date().getMonth();

  const popup = document.createElement('div');
  popup.className = 'dp-popup';
  popup.setAttribute('role', 'dialog');
  popup.setAttribute('aria-label', 'Naptár');
  popup._triggerEl = trigger;

  function render() {
    const cells = buildMonthGrid(viewYear, viewMonth);
    const todayStr = toDateStr(new Date());
    popup.innerHTML = `
      <div class="dp-header">
        <button type="button" class="dp-nav" data-dir="-1" aria-label="Előző hónap">‹</button>
        <div class="dp-title">${HU_MONTHS[viewMonth]} ${viewYear}</div>
        <button type="button" class="dp-nav" data-dir="1" aria-label="Következő hónap">›</button>
      </div>
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
      </div>
      <div class="dp-footer">
        <button type="button" class="dp-footer-btn" data-date="${todayStr}">Ma</button>
        <button type="button" class="dp-footer-btn dp-footer-clear">Törlés</button>
      </div>`;

    popup.querySelectorAll('.dp-nav').forEach((b) =>
      b.addEventListener('click', () => {
        viewMonth += Number(b.dataset.dir);
        if (viewMonth < 0) { viewMonth = 11; viewYear -= 1; }
        if (viewMonth > 11) { viewMonth = 0; viewYear += 1; }
        render();
      })
    );
    popup.querySelectorAll('.dp-cell, .dp-footer-btn[data-date]').forEach((b) =>
      b.addEventListener('click', () => {
        selectDate(wrapper, b.dataset.date);
        closePopup();
        trigger.focus();
      })
    );
    const clearBtn = popup.querySelector('.dp-footer-clear');
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        selectDate(wrapper, '');
        closePopup();
        trigger.focus();
      });
    }
  }

  render();
  document.body.appendChild(popup);
  activePopup = popup;
  positionPopup(popup, trigger);
  setTimeout(() => {
    document.addEventListener('mousedown', onDocClick, true);
    document.addEventListener('keydown', onDocKey, true);
  }, 0);
}

/** A mező statikus HTML-je - ezt kell a sablonba illeszteni. */
export function dateFieldHtml({ name, value = '', placeholder = 'Válassz dátumot', ariaLabel }) {
  const display = value ? formatDateHu(value) : placeholder;
  return `
    <div class="date-field" data-date-field data-placeholder="${placeholder}">
      <input type="hidden" name="${name}" value="${value}">
      <button type="button" class="date-field-trigger ${value ? '' : 'dp-empty'}" aria-label="${ariaLabel || placeholder}">
        <span>${display}</span><span class="date-field-icon" aria-hidden="true">${CAL_ICON}</span>
      </button>
    </div>`;
}

const CAL_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="15" height="15"><rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4"/></svg>';

/**
 * Az adott konténeren belüli összes [data-date-field] widget "élesítése".
 * @param {Element} root
 * @param {Object<string,function>} [onChangeMap] - mezőnév -> (dateStr) => void,
 *   csak olyan mezőknél kell, ahol a választásnak AZONNAL hatnia kell (pl. élő szűrő).
 */
export function wireDateFields(root, onChangeMap = {}) {
  root.querySelectorAll('[data-date-field]').forEach((wrapper) => {
    const hidden = wrapper.querySelector('input[type="hidden"]');
    const trigger = wrapper.querySelector('.date-field-trigger');
    if (onChangeMap[hidden.name]) wrapper._onDateChange = onChangeMap[hidden.name];
    trigger.addEventListener('click', () => openCalendar(trigger, wrapper));
  });
}

/** Esetleg nyitva hagyott naptár bezárása - háttérben történő újrarenderelés előtt hívandó. */
export function closeAnyOpenCalendar() {
  closePopup();
}
