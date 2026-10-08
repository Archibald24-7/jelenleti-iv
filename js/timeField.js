// ============================================================================
// TIMEFIELD – szegmentált, mindig 24 órás idő-widget.
//
// Miért kell? A sima szöveges "ÓÓ:PP" mezőbe telefonon számbillentyűzettel nem
// lehet kettőspontot írni, a natív <input type="time"> megjelenése pedig a
// böngésző nyelvétől függ (de./du.). Itt az óra és a perc KÜLÖN, két számjegyes
// mező, köztük FIX kettősponttal - így a kettőspontot soha nem kell begépelni.
//
//  - GÉPELÉS (PC és telefon): két számjegy után automatikusan a percre ugrik.
//    Ha az első számjegy már nem lehet tízes (óránál 3-9, percnél 6-9), a mező
//    azonnal "0X"-re egészül ki és továbblép (pl. 9 -> 09).
//  - LÉPTETŐ: a ▲/▼ gombok (vagy a fel/le nyíl a billentyűzeten) körbeforognak:
//    óránál 23 után 0, 0 előtt 23; percnél 59 után 0, 0 előtt 59.
//  - A kanonikus érték egy rejtett input-ban él ("ÓÓ:PP", vagy üres, ha az
//    opcionális mező üres) - ezt olvassa a FormData.
// ============================================================================

// ---------------------------------------------------------------------------
// Tiszta segédfüggvények (DOM-független, külön tesztelhetők)
// ---------------------------------------------------------------------------

export const SEG_MAX = { h: 23, m: 59 };

/** Számként értelmezett szegmens a megengedett tartományra szorítva (NaN -> null). */
export function clampSegment(value, seg) {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) return null;
  return Math.min(SEG_MAX[seg], Math.max(0, n));
}

/** Körbeforgó léptetés: dir = +1 / -1. Üres (null) értéknél 0-ról indul. */
export function stepSegment(current, dir, seg) {
  const max = SEG_MAX[seg] + 1; // 24 vagy 60 érték
  if (current == null) return dir > 0 ? 0 : SEG_MAX[seg];
  return (((current + dir) % max) + max) % max;
}

export function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 'ÓÓ:PP' -> { h, m } (számok), vagy null. */
export function splitTime(value) {
  const m = String(value || '').match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  return m ? { h: Number(m[1]), m: Number(m[2]) } : null;
}

/** Az első beírt számjegy után eldönti, hogy a szegmens "kész"-e (nem lehet tízes helyi érték). */
export function digitCompletesSegment(digit, seg) {
  const tensMax = seg === 'h' ? 2 : 5;
  return Number(digit) > tensMax;
}

// ---------------------------------------------------------------------------
// HTML + élesítés
// ---------------------------------------------------------------------------

/**
 * A mező statikus HTML-je.
 * @param {{name:string, value?:string, ariaLabel?:string}} o
 *   value: 'ÓÓ:PP' vagy üres (az üres opcionális mezőt jelent, pl. "még tart").
 */
export function timeFieldHtml({ name, value = '', ariaLabel = 'Idő' }) {
  const t = splitTime(value);
  const hv = t ? pad2(t.h) : '';
  const mv = t ? pad2(t.m) : '';
  const seg = (s, v, label) => `
    <div class="time-seg-wrap">
      <input type="text" class="time-seg-input" data-seg="${s}" inputmode="numeric" pattern="[0-9]*"
        maxlength="2" autocomplete="off" placeholder="--" value="${v}" aria-label="${ariaLabel} – ${label}">
      <div class="time-seg-steppers">
        <button type="button" class="time-step" data-seg="${s}" data-dir="1" tabindex="-1" aria-label="${label} növelése">▲</button>
        <button type="button" class="time-step" data-seg="${s}" data-dir="-1" tabindex="-1" aria-label="${label} csökkentése">▼</button>
      </div>
    </div>`;
  return `
    <div class="time-field" data-time-field>
      <input type="hidden" name="${name}" value="${t ? `${hv}:${mv}` : ''}">
      ${seg('h', hv, 'Óra')}
      <span class="time-colon" aria-hidden="true">:</span>
      ${seg('m', mv, 'Perc')}
    </div>`;
}

/**
 * A konténeren belüli összes [data-time-field] élesítése.
 * @param {Element} root
 * @param {Object<string,function>} [onChangeMap] mezőnév -> ('ÓÓ:PP' vagy '') => void
 */
export function wireTimeFields(root, onChangeMap = {}) {
  root.querySelectorAll('[data-time-field]').forEach((field) => {
    const hidden = field.querySelector('input[type="hidden"]');
    const inputs = { h: field.querySelector('[data-seg="h"].time-seg-input'), m: field.querySelector('[data-seg="m"].time-seg-input') };
    const onChange = onChangeMap[hidden.name];

    function syncHidden() {
      const h = inputs.h.value;
      const m = inputs.m.value;
      const next = h.length === 2 && m.length === 2 ? `${h}:${m}` : '';
      if (next !== hidden.value) {
        hidden.value = next;
        if (typeof onChange === 'function') onChange(next);
      }
    }

    function setSeg(seg, n) {
      inputs[seg].value = n == null ? '' : pad2(n);
    }

    function focusSeg(seg) {
      inputs[seg].focus();
      try { inputs[seg].select(); } catch (e) { /* nem kritikus */ }
    }

    function step(seg, dir) {
      const current = clampSegment(inputs[seg].value, seg);
      setSeg(seg, stepSegment(current, dir, seg));
      const other = seg === 'h' ? 'm' : 'h';
      if (inputs[other].value === '') setSeg(other, 0); // egyik szegmens léptetése a másikat is kitölti
      syncHidden();
    }

    (['h', 'm']).forEach((seg) => {
      const input = inputs[seg];

      input.addEventListener('focus', () => { try { input.select(); } catch (e) { /* nem kritikus */ } });

      input.addEventListener('input', () => {
        input.value = input.value.replace(/\D/g, '').slice(0, 2);
        if (input.value.length === 1 && digitCompletesSegment(input.value, seg)) {
          input.value = pad2(Number(input.value)); // pl. 9 -> 09
        }
        if (input.value.length === 2) {
          input.value = pad2(clampSegment(input.value, seg)); // pl. 75 perc -> 59
          if (seg === 'h') focusSeg('m');
        }
        syncHidden();
      });

      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'ArrowUp') { ev.preventDefault(); step(seg, 1); }
        else if (ev.key === 'ArrowDown') { ev.preventDefault(); step(seg, -1); }
        else if (ev.key === 'Backspace' && input.value === '' && seg === 'm') { ev.preventDefault(); focusSeg('h'); }
        else if (ev.key === ':' || ev.key === '.') { ev.preventDefault(); if (seg === 'h') focusSeg('m'); }
        else if (ev.key === 'Enter') { ev.preventDefault(); }
      });
    });

    field.querySelectorAll('.time-step').forEach((btn) => {
      // mousedown-ra: a gomb ne vegye el a fókuszt a szegmenstől
      btn.addEventListener('mousedown', (ev) => ev.preventDefault());
      btn.addEventListener('click', () => step(btn.dataset.seg, Number(btn.dataset.dir)));
    });

    // Ha a fókusz elhagyja a teljes mezőt: az egyik szegmens kitöltése esetén a másik "00" lesz.
    field.addEventListener('focusout', (ev) => {
      if (ev.relatedTarget && field.contains(ev.relatedTarget)) return;
      const hFilled = inputs.h.value !== '';
      const mFilled = inputs.m.value !== '';
      if (hFilled && !mFilled) setSeg('m', 0);
      if (!hFilled && mFilled) setSeg('h', 0);
      if (inputs.h.value.length === 1) setSeg('h', clampSegment(inputs.h.value, 'h'));
      if (inputs.m.value.length === 1) setSeg('m', clampSegment(inputs.m.value, 'm'));
      syncHidden();
    });
  });
}
