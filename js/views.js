// ============================================================================
// VIEWS – az összes képernyő renderelése egyszerű, natív JavaScripttel
// (nincs build-lépés, nincs keretrendszer-függőség). Minden render-függvény
// beállítja egy tartály innerHTML-jét, majd feliratkozik a szükséges
// eseményekre. A tényleges állapotváltoztatást mindig az app.js-ből kapott
// callback-ek végzik el - a views.js csak megjelenít.
//
// BIZTONSÁG: minden adatból származó szöveg az esc() függvényen megy át, mielőtt
// innerHTML-be kerül - a megosztott adatfájlt bárki szerkesztheti, aki hozzáfér,
// ezért a benne lévő szövegeket SOSEM tekintjük megbízhatónak.
// ============================================================================

import {
  formatDateHu, formatDuration, durationMinutes, escapeHtml as esc,
  todayDateStr, formatMonthHu, formatDateTimeHu, matchesTextFilter,
} from './models.js';
import { dateFieldHtml, wireDateFields, closeAnyOpenCalendar } from './datePicker.js';

const HU_MONTHS_SHORT = [
  'január', 'február', 'március', 'április', 'május', 'június',
  'július', 'augusztus', 'szeptember', 'október', 'november', 'december',
];

// A "random" (véletlen generátorral létrehozott) bejegyzések a felhasználó kérésére
// a felületen ÉS a szűrőkben is "Kézi"-ként jelennek meg - megkülönböztethetetlenek a
// kézzel felvett bejegyzésektől. A belső 'source' mező értéke emiatt NEM változik
// (megmarad 'random'-nak, lásd randomGenerator.js) - csak a megjelenített szöveg.
const SOURCE_LABELS = {
  'auto-login': 'Automatikus (bejelentkezés)',
  'auto-app-open': 'Automatikus (app megnyitás)',
  manual: 'Kézi',
  random: 'Kézi',
};
export const sourceLabel = (s) => SOURCE_LABELS[s] || String(s || '');

/** Az adott bejegyzéslistában TÉNYLEGESEN előforduló forrás-címkék, csoportosítva
 * (ha több nyers 'source' érték ugyanazt a címkét adja - pl. manual és random egyaránt
 * "Kézi" -, egyetlen szűrő-opcióként jelennek meg). A szűrő `value`-ja a hozzá tartozó
 * nyers source-értékek '|'-el összefűzött listája. */
function buildSourceFilterOptions(entries) {
  const labelToValues = new Map();
  for (const e of entries) {
    const label = sourceLabel(e.source);
    if (!labelToValues.has(label)) labelToValues.set(label, new Set());
    labelToValues.get(label).add(e.source);
  }
  return [...labelToValues.entries()]
    .map(([label, values]) => ({ label, value: [...values].sort().join('|') }))
    .sort((a, b) => a.label.localeCompare(b.label, 'hu'));
}

const byNewest = (a, b) => (b.date + b.startTime).localeCompare(a.date + a.startTime);

// ---------------------------------------------------------------------------
// Ikonok (egyszerű vonalas SVG-k)
// ---------------------------------------------------------------------------

const ICONS = {
  dashboard: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  entries: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6"/><circle cx="17.5" cy="9" r="2.5"/><path d="M17 14.2c2.6.2 4.5 2 4.5 5.3"/>',
  calendar: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4M8 14h2M14 14h2M8 18h2"/>',
  settings: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  play: '<path d="M7 4l12 8-12 8z"/>',
};

export function icon(name) {
  return `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

// ---------------------------------------------------------------------------
// Toast (rövid, eltűnő üzenet, opcionális művelet-gombbal, pl. "Visszavonás")
// ---------------------------------------------------------------------------

export function showToast(message, type = 'info', { actionLabel, onAction, duration } = {}) {
  let host = document.getElementById('toast-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toast-host';
    host.className = 'toast-host';
    host.setAttribute('role', 'status');
    host.setAttribute('aria-live', 'polite');
    document.body.appendChild(host);
  }
  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  const span = document.createElement('span');
  span.textContent = message;
  t.appendChild(span);
  if (actionLabel && onAction) {
    const b = document.createElement('button');
    b.className = 'toast-action';
    b.textContent = actionLabel;
    b.addEventListener('click', () => { onAction(); t.remove(); });
    t.appendChild(b);
  }
  host.appendChild(t);
  setTimeout(() => t.remove(), duration || (actionLabel ? 7000 : 4500));
}

// ---------------------------------------------------------------------------
// Modális ablak segéd
// ---------------------------------------------------------------------------

function openModal({ title, bodyHtml }) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="modal-header">
        <h2 class="mb-0">${esc(title)}</h2>
        <button class="icon-btn" data-close aria-label="Bezárás">${icon('close')}</button>
      </div>
      ${bodyHtml}
    </div>`;
  document.body.appendChild(overlay);
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const close = () => { document.removeEventListener('keydown', onKey); overlay.remove(); };
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  overlay.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
  const first = overlay.querySelector('input:not([type=hidden]), select, textarea');
  if (first) first.focus();
  return { overlay, close };
}

function showFormError(form, message) {
  const box = form.querySelector('.form-error');
  if (!box) return;
  box.textContent = message;
  box.hidden = false;
}

// ---------------------------------------------------------------------------
// Bejelentkezés, első indítás, üzenet-képernyők
// ---------------------------------------------------------------------------

export function renderLogin(root, { onLogin, error, loading }) {
  root.innerHTML = `
    <div class="login-screen">
      <div class="card login-card">
        <div class="login-mark">JI</div>
        <div class="brand-title">Jelenléti Ív Kezelő</div>
        <p class="text-muted text-sm">Jelentkezz be a Microsoft-fiókoddal a folytatáshoz.
        Ugyanez a fiók biztosítja a hozzáférést a megosztott OneDrive-adatokhoz is.</p>
        ${error ? `<div class="notice notice-err">${esc(error)}</div>` : ''}
        <button class="btn btn-primary" id="btn-login" style="width:100%;" ${loading ? 'disabled' : ''}>
          ${loading ? 'Bejelentkezés…' : 'Bejelentkezés Microsoft-fiókkal'}
        </button>
      </div>
    </div>`;
  root.querySelector('#btn-login').addEventListener('click', onLogin);
}

export function renderLocalSetup(root, { onSubmit }) {
  root.innerHTML = `
    <div class="login-screen">
      <div class="card login-card" style="text-align:left;">
        <div class="login-mark">JI</div>
        <h2>Üdv a Jelenléti Ívben</h2>
        <p class="text-muted text-sm">Az alkalmazás jelenleg <strong>helyi módban</strong> fut:
        az adatok csak ezen az eszközön tárolódnak. A OneDrive-szinkron beállításához lásd a README-t.
        Első lépésként add meg magad – te leszel az adminisztrátor.</p>
        <form id="setup-form">
          <div class="field"><label>Neved</label><input type="text" name="name" required autocomplete="name"></div>
          <div class="field"><label>E-mail címed</label>
            <input type="email" name="email" required autocomplete="email">
            <div class="field-hint">Add meg ugyanazt a címet, amivel később a Microsoft-fiókba jelentkezel be – így a helyi adataid a szinkron bekapcsolásakor a fiókodhoz kapcsolódnak.</div>
          </div>
          <div class="form-error" hidden></div>
          <button type="submit" class="btn btn-primary" style="width:100%;">Kezdés</button>
        </form>
      </div>
    </div>`;
  const form = root.querySelector('#setup-form');
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    if (!data.name.trim() || !data.email.trim()) return showFormError(form, 'Add meg a neved és az e-mail címed.');
    onSubmit({ name: data.name.trim(), email: data.email.trim() });
  });
}

/** Általános teljes képernyős üzenet. actions: [{ label, primary, onClick }] */
export function renderMessageScreen(root, { title, message, emphasis, busy = false, actions = [] }) {
  root.innerHTML = `
    <div class="login-screen">
      <div class="card login-card">
        <div class="login-mark">JI</div>
        <h2>${esc(title)}</h2>
        ${message ? `<p class="text-muted text-sm">${esc(message)}</p>` : ''}
        ${emphasis ? `<p><strong>${esc(emphasis)}</strong></p>` : ''}
        ${busy ? '<div class="badge badge-info" style="margin-top:8px;"><span class="badge-dot"></span>Folyamatban…</div>' : ''}
        <div class="flex gap-8" style="justify-content:center; margin-top:16px; flex-wrap:wrap;">
          ${actions.map((a, i) => `<button class="btn ${a.primary ? 'btn-primary' : ''}" data-action="${i}">${esc(a.label)}</button>`).join('')}
        </div>
      </div>
    </div>`;
  root.querySelectorAll('[data-action]').forEach((b) =>
    b.addEventListener('click', () => actions[Number(b.dataset.action)].onClick())
  );
}

// ---------------------------------------------------------------------------
// App shell (oldalsáv + mobil alsó navigáció + szinkron-sáv + tartalom)
// ---------------------------------------------------------------------------

const NAV_ITEMS = [
  { id: 'dashboard', label: 'Irányítópult', icon: 'dashboard' },
  { id: 'entries', label: 'Bejegyzéseim', icon: 'entries' },
  { id: 'admin-users', label: 'Felhasználók', icon: 'users', adminOnly: true },
  { id: 'admin-entries', label: 'Összes bejegyzés', icon: 'calendar', adminOnly: true },
  { id: 'settings', label: 'Beállítások', icon: 'settings' },
];

export function renderShell(root, { user, currentView, onNavigate, onLogout, showLogout }) {
  const isAdmin = user.role === 'admin';
  const items = NAV_ITEMS.filter((i) => !i.adminOnly || isAdmin);

  root.innerHTML = `
    <div class="app-shell">
      <div class="sidebar">
        <div class="brand">
          <div class="brand-title">Jelenléti Ív</div>
          <div class="brand-sub">${esc(user.name)} ${isAdmin ? '<span class="role-tag">admin</span>' : ''}</div>
        </div>
        <nav class="nav">
          ${items.map((i) => `<button class="nav-item ${i.id === currentView ? 'active' : ''}" data-nav="${i.id}">
            ${icon(i.icon)}<span>${i.label}</span></button>`).join('')}
        </nav>
        ${showLogout ? `<div class="sidebar-footer"><button class="btn btn-ghost btn-sm" id="btn-logout-side" style="width:100%;">Kijelentkezés</button></div>` : ''}
      </div>
      <div class="main">
        <div id="sync-banner"></div>
        <div id="view-content"></div>
      </div>
    </div>
    <div class="bottom-nav">
      <div class="bottom-nav-row">
        ${items.map((i) => `<button class="bottom-nav-item ${i.id === currentView ? 'active' : ''}" data-nav="${i.id}">
          ${icon(i.icon)}<span>${i.label}</span></button>`).join('')}
      </div>
    </div>`;

  root.querySelectorAll('[data-nav]').forEach((btn) => btn.addEventListener('click', () => onNavigate(btn.dataset.nav)));
  const lo = root.querySelector('#btn-logout-side');
  if (lo) lo.addEventListener('click', onLogout);
  return root.querySelector('#view-content');
}

// ---------------------------------------------------------------------------
// Szinkron-jelzők
// ---------------------------------------------------------------------------

export function syncBadgeHtml(syncState) {
  const map = {
    synced: { cls: 'badge-ok', text: 'Szinkronizálva' },
    syncing: { cls: 'badge-info', text: 'Szinkronizálás…' },
    offline: { cls: 'badge-warn', text: 'Nincs internet – offline mód' },
    error: { cls: 'badge-err', text: 'Szinkronizálási hiba' },
    'not-configured': { cls: 'badge-neutral', text: 'Helyi mód (nincs szinkron)' },
    idle: { cls: 'badge-neutral', text: 'Szinkron még nem futott' },
  };
  const s = map[syncState.status] || map.idle;
  return `<span class="badge ${s.cls}"><span class="badge-dot"></span>${s.text}</span>`;
}

/** A minden oldalon látható sáv, ami offline állapotról / szinkronhibáról tájékoztat. */
export function renderSyncBanner(root, { mode, syncState, pendingCount, onRetry, onRelogin }) {
  const slot = root.querySelector('#sync-banner');
  if (!slot) return;
  if (mode !== 'cloud') { slot.innerHTML = ''; return; }

  const banner = (kind, title, text, actions) => `
    <div class="sync-banner banner-${kind}" role="alert">
      <div class="banner-text"><strong>${esc(title)}</strong><span>${esc(text)}</span></div>
      <div class="banner-actions">${actions
        .map((a) => `<button class="btn btn-sm ${a.primary ? 'btn-primary' : ''}" data-banner="${a.id}">${esc(a.label)}</button>`)
        .join('')}</div>
    </div>`;

  const pendingText = pendingCount > 0
    ? `${pendingCount} módosítás vár szinkronizálásra – az adataid biztonságban vannak az eszközön, és automatikusan szinkronizálódnak, amint lehetséges.`
    : 'Az adataid az eszközön tárolódnak, és automatikusan szinkronizálódnak, amint lehetséges.';

  let html = '';
  if (syncState.status === 'offline') {
    html = banner('warn', 'Nincs internetkapcsolat – offline módban dolgozol.', pendingText, [{ id: 'retry', label: 'Újrapróbálom' }]);
  } else if (syncState.status === 'error') {
    const actions = syncState.needsLogin
      ? [{ id: 'relogin', label: 'Bejelentkezés', primary: true }, { id: 'retry', label: 'Újrapróbálom' }]
      : [{ id: 'retry', label: 'Újrapróbálom' }];
    html = banner('err', 'Nem sikerült a szinkronizálás', `${syncState.error} ${pendingCount > 0 ? `(${pendingCount} módosítás vár szinkronra, az eszközön biztonságban van.)` : ''}`, actions);
  }
  slot.innerHTML = html;
  slot.querySelectorAll('[data-banner]').forEach((b) =>
    b.addEventListener('click', () => (b.dataset.banner === 'relogin' ? onRelogin() : onRetry()))
  );
}

// ---------------------------------------------------------------------------
// IRÁNYÍTÓPULT
// ---------------------------------------------------------------------------

function minutesSince(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  const d = new Date();
  return Math.max(0, d.getHours() * 60 + d.getMinutes() - (h * 60 + m));
}

export function renderDashboard(container, { user, entries, syncState, onCheckIn, onCheckOut, onEditEntry, onSyncNow, onGoEntries, showSync }) {
  const mine = entries.filter((e) => !e.deleted && e.userId === user.id);
  const today = todayDateStr();
  const openToday = mine.find((e) => !e.endTime && e.date === today);
  const stale = mine.filter((e) => !e.endTime && e.date < today).sort(byNewest);
  const todayClosed = mine.filter((e) => e.date === today && e.endTime).sort(byNewest);

  const todayMinutes =
    mine.filter((e) => e.date === today).reduce((sum, e) => sum + (durationMinutes(e) || 0), 0) +
    (openToday ? minutesSince(openToday.startTime) : 0);
  const monthPrefix = today.slice(0, 7);
  const monthMinutes =
    mine.filter((e) => e.date.startsWith(monthPrefix)).reduce((sum, e) => sum + (durationMinutes(e) || 0), 0) +
    (openToday ? minutesSince(openToday.startTime) : 0);

  const recent = [...mine].sort(byNewest).slice(0, 5);

  let heroLabel; let heroTime; let heroSub = '';
  if (openToday) {
    heroLabel = 'Bejelentkezve ekkor';
    heroTime = openToday.startTime;
    heroSub = [openToday.deviceName, sourceLabel(openToday.source)].filter(Boolean).join(' – ');
  } else if (todayClosed.length > 0) {
    heroLabel = 'Ma lezárt munka – legutóbbi befejezés';
    heroTime = todayClosed[0].endTime;
  } else {
    heroLabel = 'Ma még nem jelentkeztél be';
    heroTime = '--:--';
  }

  container.innerHTML = `
    <div class="page-header">
      <h1>Irányítópult</h1>
      ${showSync ? `<div class="sync-bar">${syncBadgeHtml(syncState)}<button class="btn btn-sm" id="btn-sync-now">Szinkronizálj most</button></div>` : ''}
    </div>

    ${stale.length ? `
      <div class="card notice-card">
        <h2>Le nem zárt bejegyzés</h2>
        <p class="text-muted text-sm">Ezeknél nincs megadva a munka befejezése. Add meg az időpontot, hogy az óraszám helyes legyen.</p>
        ${stale.map((e) => `
          <div class="flex-between" style="padding:6px 0; gap:12px; flex-wrap:wrap;">
            <span>${esc(formatDateHu(e.date, { withWeekday: true }))} – kezdés: <span class="mono">${esc(e.startTime)}</span></span>
            <button class="btn btn-sm" data-fix="${esc(e.id)}">Befejezés megadása</button>
          </div>`).join('')}
      </div>` : ''}

    <div class="card">
      <div class="hero-status">
        <div>
          <div class="hero-label">${esc(heroLabel)}</div>
          <div class="hero-time mono">${esc(heroTime)}</div>
          ${heroSub ? `<div class="text-muted text-sm">${esc(heroSub)}</div>` : ''}
        </div>
        <div class="hero-actions">
          ${openToday
            ? `<button class="btn btn-primary" id="btn-checkout">Munka befejezése</button>
               <button class="btn btn-ghost" id="btn-edit-open">Kezdés módosítása</button>`
            : `<button class="btn btn-primary" id="btn-checkin">Bejelentkezés (kézi)</button>`}
        </div>
      </div>
    </div>

    <div class="stat-row">
      <div class="stat-box"><div class="stat-value mono">${esc(formatDuration(todayMinutes))}</div><div class="stat-label">Ma eddig</div></div>
      <div class="stat-box"><div class="stat-value mono">${esc(formatDuration(monthMinutes))}</div><div class="stat-label">Ebben a hónapban</div></div>
    </div>

    <div class="section-toolbar" style="margin-top:22px;">
      <h2 class="mb-0">Legutóbbi bejegyzések</h2>
      <button class="btn btn-sm btn-ghost" id="btn-go-entries">Összes megtekintése</button>
    </div>
    ${recent.length === 0
      ? `<div class="empty-state card"><h3>Még nincs bejegyzés</h3><p>Jelentkezz be kézzel, vagy várd meg az automatikus rögzítést.</p></div>`
      : `<div class="ledger">${recent.map((e) => `
          <div class="ledger-row">
            <div class="ledger-date">${esc(formatDateHu(e.date, { withWeekday: false }))}</div>
            <div class="ledger-time mono">${esc(e.startTime)}<span class="sep">–</span>${esc(e.endTime || '…')}</div>
            <div class="ledger-duration mono">${esc(formatDuration(durationMinutes(e)))}</div>
            <div class="ledger-source"><span class="source-tag">${esc(sourceLabel(e.source))}</span></div>
          </div>`).join('')}</div>`}
  `;

  const on = (sel, fn) => { const el = container.querySelector(sel); if (el) el.addEventListener('click', fn); };
  on('#btn-sync-now', onSyncNow);
  on('#btn-go-entries', onGoEntries);
  on('#btn-checkin', onCheckIn);
  on('#btn-checkout', () => onCheckOut(openToday));
  on('#btn-edit-open', () => onEditEntry(openToday));
  container.querySelectorAll('[data-fix]').forEach((b) =>
    b.addEventListener('click', () => onEditEntry(stale.find((e) => e.id === b.dataset.fix)))
  );
}

// ---------------------------------------------------------------------------
// BEJEGYZÉSEK (saját, vagy admin-nézetben bárkié)
// ---------------------------------------------------------------------------

const EMPTY_FILTERS = { year: '', month: '', fromDate: '', toDate: '', source: '', text: '' };

function scopeEntries({ entries, isAdminView, selectedUserId, currentUserId }) {
  let list = entries.filter((e) => !e.deleted);
  if (isAdminView) {
    if (selectedUserId) list = list.filter((e) => e.userId === selectedUserId);
  } else {
    list = list.filter((e) => e.userId === currentUserId);
  }
  return list;
}

export function applyEntryFilters(list, filters) {
  const f = { ...EMPTY_FILTERS, ...filters };
  let out = list;
  if (f.year) out = out.filter((e) => e.date.slice(0, 4) === f.year);
  if (f.month) out = out.filter((e) => e.date.slice(5, 7) === f.month);
  if (f.fromDate) out = out.filter((e) => e.date >= f.fromDate);
  if (f.toDate) out = out.filter((e) => e.date <= f.toDate);
  if (f.source) {
    const allowed = f.source.split('|');
    out = out.filter((e) => allowed.includes(e.source));
  }
  if (f.text) out = out.filter((e) => matchesTextFilter(e.note, f.text));
  return out;
}

export function filterEntries(opts) {
  return applyEntryFilters(scopeEntries(opts), opts.filters).sort(byNewest);
}

function hasActiveFilters(f) {
  return !!(f && (f.year || f.month || f.fromDate || f.toDate || f.source || f.text));
}

function describeFilters(filters, isAdminView, scopeName) {
  const f = { ...EMPTY_FILTERS, ...filters };
  const parts = [];
  if (isAdminView) parts.push(scopeName || 'Összes felhasználó');
  if (f.year) parts.push(`${f.year}. év`);
  if (f.month) parts.push(HU_MONTHS_SHORT[Number(f.month) - 1]);
  if (f.fromDate || f.toDate) {
    parts.push(`${f.fromDate ? formatDateHu(f.fromDate) : '…'} – ${f.toDate ? formatDateHu(f.toDate) : '…'}`);
  }
  if (f.source) parts.push(`forrás: ${sourceLabel(f.source.split('|')[0])}`);
  if (f.text) parts.push(`keresés: „${f.text}”`);
  return parts.length ? parts.join(', ') : 'összes bejegyzés';
}

export function renderEntries(container, opts) {
  closeAnyOpenCalendar();
  const { entries, users, isAdminView, selectedUserId, currentUserId } = opts;
  const filters = { ...EMPTY_FILTERS, ...opts.filters };
  const userById = Object.fromEntries(users.map((u) => [u.id, u]));
  const selectedIds = opts.selectedEntryIds || new Set();

  // Az évválasztó és a forrás-szűrő mindig az adott felhasználó(k) TELJES
  // adatkészletéből épül fel, függetlenül az aktuális szűréstől - így a lista
  // sosem "tűnik el" saját magától, és csak ténylegesen létező forrás jelenik meg.
  const scoped = scopeEntries({ entries, isAdminView, selectedUserId, currentUserId });
  const years = [...new Set(scoped.map((e) => e.date.slice(0, 4)))].sort().reverse();
  const currentYear = String(new Date().getFullYear());
  if (!years.includes(currentYear)) years.unshift(currentYear);
  const sourceOptions = buildSourceFilterOptions(scoped);

  const list = applyEntryFilters(scoped, filters).sort(byNewest);
  const visibleIds = list.map((e) => e.id);
  const selectedVisibleCount = visibleIds.filter((id) => selectedIds.has(id)).length;
  const allVisibleSelected = visibleIds.length > 0 && selectedVisibleCount === visibleIds.length;

  const totalMinutes = list.reduce((s, e) => s + (durationMinutes(e) || 0), 0);
  const workDays = new Set(list.filter((e) => durationMinutes(e) != null).map((e) => e.date)).size;

  const printName = isAdminView
    ? (selectedUserId && userById[selectedUserId] ? userById[selectedUserId].name : 'Összes felhasználó')
    : (userById[currentUserId] ? userById[currentUserId].name : '');
  const filterSummary = describeFilters(filters, isAdminView, printName);

  // Fókusz/kurzorpozíció megőrzése újrarenderelés között (fontos a szöveges keresőnél,
  // hogy gépelés közben ne ugorjon ki a mező).
  const active = document.activeElement;
  const activeId = active && container.contains(active) ? active.id : null;
  const activeSelStart = active && typeof active.selectionStart === 'number' ? active.selectionStart : null;

  container.innerHTML = `
    <div class="page-header no-print-actions">
      <h1>${isAdminView ? 'Összes bejegyzés' : 'Bejegyzéseim'}</h1>
      <div class="flex gap-8">
        <button class="btn btn-sm" id="btn-random">Véletlen generátor</button>
        <button class="btn btn-primary btn-sm" id="btn-add">Új bejegyzés</button>
      </div>
    </div>

    <div class="print-only print-title">Jelenléti ív – ${esc(filterSummary)}</div>
    <p class="text-muted text-sm no-print-actions" style="margin-top:-10px;">Szűrés: ${esc(filterSummary)}</p>

    <div class="filter-bar">
      ${isAdminView ? `
        <div class="field mb-0"><select id="filter-user" aria-label="Felhasználó szűrése">
          <option value="">Összes felhasználó</option>
          ${users.filter((u) => !u.deleted).map((u) => `<option value="${esc(u.id)}" ${u.id === selectedUserId ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}
        </select></div>` : ''}
      <div class="field mb-0"><select id="filter-year" aria-label="Év szűrése">
        <option value="">Összes év</option>
        ${years.map((y) => `<option value="${y}" ${y === filters.year ? 'selected' : ''}>${y}</option>`).join('')}
      </select></div>
      <div class="field mb-0"><select id="filter-month" aria-label="Hónap szűrése">
        <option value="">Összes hónap</option>
        ${HU_MONTHS_SHORT.map((name, i) => {
          const val = String(i + 1).padStart(2, '0');
          return `<option value="${val}" ${val === filters.month ? 'selected' : ''}>${name}</option>`;
        }).join('')}
      </select></div>
      <div class="field mb-0"><select id="filter-source" aria-label="Forrás szűrése">
        <option value="">Összes forrás</option>
        ${sourceOptions.map((o) => `<option value="${esc(o.value)}" ${o.value === filters.source ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
      </select></div>
      <div class="field mb-0">${dateFieldHtml({ name: 'filter-from', value: filters.fromDate, placeholder: 'Dátumtól', ariaLabel: 'Dátumtól' })}</div>
      <div class="field mb-0">${dateFieldHtml({ name: 'filter-to', value: filters.toDate, placeholder: 'Dátumig', ariaLabel: 'Dátumig' })}</div>
      <div class="field mb-0"><input type="text" id="filter-text" value="${esc(filters.text)}" placeholder="Megjegyzés keresése… (pl. proj*terv)" aria-label="Megjegyzés szűrése" style="min-width:220px;"></div>
      ${hasActiveFilters(filters) ? `<button class="btn btn-ghost btn-sm" id="btn-clear-filters">Szűrők törlése</button>` : ''}
      <span style="flex:1;"></span>
      <button class="btn btn-sm" id="btn-csv">Exportálás (CSV)</button>
      <button class="btn btn-sm" id="btn-print">Nyomtatás</button>
    </div>

    <div class="stat-row" style="margin-bottom:14px;">
      <div class="stat-box"><div class="stat-value mono">${esc(formatDuration(totalMinutes))}</div><div class="stat-label">Összes munkaidő</div></div>
      <div class="stat-box"><div class="stat-value mono">${workDays}</div><div class="stat-label">Munkanap</div></div>
      <div class="stat-box"><div class="stat-value mono">${list.length}</div><div class="stat-label">Bejegyzés</div></div>
    </div>

    ${selectedVisibleCount > 0 ? `
      <div class="bulk-bar no-print-actions">
        <strong>${selectedVisibleCount} bejegyzés kiválasztva</strong>
        <span class="flex-spacer"></span>
        <button class="btn btn-sm" id="btn-bulk-edit">Tömeges szerkesztés</button>
        <button class="btn btn-sm btn-danger" id="btn-bulk-delete">Törlés</button>
        <button class="btn btn-sm btn-ghost" id="btn-bulk-clear">Kijelölés törlése</button>
      </div>` : ''}

    ${list.length === 0
      ? `<div class="empty-state card"><h3>Nincs megjeleníthető bejegyzés</h3><p>Nincs a szűrésnek megfelelő bejegyzés. Módosítsd a szűrőket, adj hozzá egy új bejegyzést, vagy használd a véletlen generátort.</p></div>`
      : `<div class="ledger">
          <div class="ledger-row header">
            <div class="ledger-select"><input type="checkbox" id="select-all" aria-label="Összes megjelenített kijelölése" ${allVisibleSelected ? 'checked' : ''}></div>
            ${isAdminView ? '<div class="ledger-user">Felhasználó</div>' : ''}
            <div class="ledger-date">Dátum</div>
            <div class="ledger-time">Kezdés–Vége</div>
            <div class="ledger-duration">Időtartam</div>
            <div class="ledger-source">Forrás</div>
            <div class="ledger-note">Megjegyzés</div>
            <div class="ledger-actions"></div>
          </div>
          ${list.map((e) => `
            <div class="ledger-row" data-entry-id="${esc(e.id)}">
              <div class="ledger-select"><input type="checkbox" class="row-select" data-select="${esc(e.id)}" aria-label="Bejegyzés kijelölése" ${selectedIds.has(e.id) ? 'checked' : ''}></div>
              ${isAdminView ? `<div class="ledger-user">${esc(userById[e.userId] ? userById[e.userId].name : '—')}</div>` : ''}
              <div class="ledger-date">${esc(formatDateHu(e.date))}</div>
              <div class="ledger-time mono">${esc(e.startTime)}<span class="sep">–</span>${esc(e.endTime || '…')}</div>
              <div class="ledger-duration mono">${esc(formatDuration(durationMinutes(e)))}</div>
              <div class="ledger-source"><span class="source-tag">${esc(sourceLabel(e.source))}</span></div>
              <div class="ledger-note">${esc(e.note || '')}</div>
              <div class="ledger-actions">
                <button class="icon-btn" data-edit="${esc(e.id)}" title="Szerkesztés" aria-label="Szerkesztés">${icon('edit')}</button>
                <button class="icon-btn" data-delete="${esc(e.id)}" title="Törlés" aria-label="Törlés">${icon('trash')}</button>
              </div>
            </div>`).join('')}
        </div>`}
  `;

  const on = (sel, ev, fn) => { const el = container.querySelector(sel); if (el) el.addEventListener(ev, fn); };
  on('#btn-add', 'click', () => opts.onAdd());
  on('#btn-random', 'click', () => opts.onOpenRandom());
  on('#btn-csv', 'click', () => opts.onExportCsv(list));
  on('#btn-print', 'click', () => opts.onPrint());
  on('#filter-user', 'change', (ev) => opts.onFilterUser(ev.target.value || null));
  on('#filter-year', 'change', (ev) => opts.onFilterChange('year', ev.target.value));
  on('#filter-month', 'change', (ev) => opts.onFilterChange('month', ev.target.value));
  on('#filter-source', 'change', (ev) => opts.onFilterChange('source', ev.target.value));
  on('#filter-text', 'input', (ev) => opts.onFilterChange('text', ev.target.value, { debounce: true }));
  on('#btn-clear-filters', 'click', () => opts.onClearFilters());
  wireDateFields(container, {
    'filter-from': (v) => opts.onFilterChange('fromDate', v),
    'filter-to': (v) => opts.onFilterChange('toDate', v),
  });
  container.querySelectorAll('[data-edit]').forEach((b) =>
    b.addEventListener('click', () => opts.onEdit(list.find((e) => e.id === b.dataset.edit)))
  );
  container.querySelectorAll('[data-delete]').forEach((b) =>
    b.addEventListener('click', () => opts.onDelete(b.dataset.delete))
  );
  on('#select-all', 'change', () => opts.onToggleSelectAll(visibleIds, !allVisibleSelected));
  container.querySelectorAll('[data-select]').forEach((cb) =>
    cb.addEventListener('change', () => opts.onToggleSelect(cb.dataset.select, cb.checked))
  );
  on('#btn-bulk-edit', 'click', () => opts.onBulkEdit());
  on('#btn-bulk-delete', 'click', () => opts.onBulkDelete());
  on('#btn-bulk-clear', 'click', () => opts.onClearSelection());

  if (activeId) {
    const el = container.querySelector('#' + CSS.escape(activeId));
    if (el && typeof el.focus === 'function') {
      el.focus();
      if (activeSelStart != null && typeof el.setSelectionRange === 'function') {
        try { el.setSelectionRange(activeSelStart, activeSelStart); } catch (e) { /* nem minden input típus támogatja */ }
      }
    }
  }
}

/** Tömeges szerkesztés dialógus - csak a Forrás és a Megjegyzés mezőt lehet
 * egyszerre, több kiválasztott bejegyzésre alkalmazni. Mindkettőnél külön
 * jelölőnégyzet dönti el, hogy az adott mezőt egyáltalán módosítani kell-e
 * (így egyértelmű a "ne nyúlj hozzá" és a "töröld üresre" közötti különbség). */
export function renderBulkEditModal({ count, onApply }) {
  const { overlay, close } = openModal({
    title: `${count} bejegyzés tömeges szerkesztése`,
    bodyHtml: `
      <form id="bulk-edit-form" novalidate>
        <label class="checkbox-field"><input type="checkbox" id="bulk-set-source"> Forrás módosítása erre:</label>
        <div class="field">
          <select name="source" id="bulk-source-select" disabled>
            <option value="manual">Kézi</option>
            <option value="auto-login">Automatikus (bejelentkezés)</option>
            <option value="auto-app-open">Automatikus (app megnyitás)</option>
          </select>
        </div>
        <label class="checkbox-field"><input type="checkbox" id="bulk-set-note"> Megjegyzés módosítása erre:</label>
        <div class="field">
          <input type="text" name="note" id="bulk-note-input" placeholder="Új megjegyzés (üresen hagyva törli a megjegyzést)" disabled>
        </div>
        <div class="form-error" hidden></div>
        <div class="form-actions">
          <button type="button" class="btn" data-close>Mégse</button>
          <button type="submit" class="btn btn-primary">Alkalmazás ${count} bejegyzésre</button>
        </div>
      </form>`,
  });
  const form = overlay.querySelector('#bulk-edit-form');
  const setSource = overlay.querySelector('#bulk-set-source');
  const sourceSelect = overlay.querySelector('#bulk-source-select');
  const setNote = overlay.querySelector('#bulk-set-note');
  const noteInput = overlay.querySelector('#bulk-note-input');
  setSource.addEventListener('change', () => { sourceSelect.disabled = !setSource.checked; });
  setNote.addEventListener('change', () => { noteInput.disabled = !setNote.checked; });

  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    if (!setSource.checked && !setNote.checked) {
      return showFormError(form, 'Válassz legalább egy módosítandó mezőt (Forrás vagy Megjegyzés).');
    }
    const changes = {};
    if (setSource.checked) changes.source = sourceSelect.value;
    if (setNote.checked) changes.note = noteInput.value;
    close();
    onApply(changes);
  });
}

/** Bejegyzés felvétele / szerkesztése modális ablakban. */
export function renderEntryModal({ entry, users, isAdmin, defaultUserId, onSave, onDelete }) {
  const isNew = !entry;
  const e = entry || { date: todayDateStr(), startTime: '', endTime: '', note: '', userId: defaultUserId };

  const { overlay, close } = openModal({
    title: isNew ? 'Új bejegyzés' : 'Bejegyzés szerkesztése',
    bodyHtml: `
      <form id="entry-form" novalidate>
        ${isAdmin
          ? `<div class="field"><label>Felhasználó</label>
              <select name="userId" required>
                ${users.filter((u) => !u.deleted).map((u) => `<option value="${esc(u.id)}" ${u.id === e.userId ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}
              </select></div>`
          : `<input type="hidden" name="userId" value="${esc(e.userId || defaultUserId)}">`}
        <div class="field"><label>Dátum</label>${dateFieldHtml({ name: 'date', value: e.date, ariaLabel: 'Dátum' })}</div>
        <div class="field-row">
          <div class="field"><label>Kezdés (24 órás, ÓÓ:PP)</label><input type="text" inputmode="numeric" name="startTime" value="${esc(e.startTime || '')}" placeholder="08:00" required></div>
          <div class="field"><label>Vége (üresen hagyható, ha még tart)</label><input type="text" inputmode="numeric" name="endTime" value="${esc(e.endTime || '')}" placeholder="16:30"></div>
        </div>
        <div class="field"><label>Megjegyzés</label><textarea name="note">${esc(e.note || '')}</textarea></div>
        <div class="form-error" hidden></div>
        <div class="form-actions">
          ${!isNew ? `<button type="button" class="btn btn-danger" id="btn-delete-in-modal" style="margin-right:auto;">Törlés</button>` : ''}
          <button type="button" class="btn" data-close>Mégse</button>
          <button type="submit" class="btn btn-primary">Mentés</button>
        </div>
      </form>`,
  });

  wireDateFields(overlay);
  const form = overlay.querySelector('#entry-form');
  const del = overlay.querySelector('#btn-delete-in-modal');
  if (del) del.addEventListener('click', () => { close(); onDelete(entry.id); });

  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data.date || '')) return showFormError(form, 'Válassz dátumot.');
    if (!TIME_RE.test(data.startTime || '')) return showFormError(form, 'Add meg a kezdés időpontját 24 órás ÓÓ:PP formátumban (pl. 08:00).');
    if (data.endTime && !TIME_RE.test(data.endTime)) return showFormError(form, 'Add meg a befejezés időpontját 24 órás ÓÓ:PP formátumban (pl. 16:30), vagy hagyd üresen.');
    if (data.endTime) {
      if (data.endTime === data.startTime) return showFormError(form, 'A kezdés és a befejezés időpontja nem lehet azonos.');
      if (data.endTime < data.startTime &&
          !window.confirm('A befejezés korábbi, mint a kezdés. Éjszakai műszakként (a következő napra átnyúlóként) rögzítsem?')) {
        return;
      }
    }
    close();
    onSave({ id: entry ? entry.id : null, userId: data.userId, date: data.date, startTime: data.startTime, endTime: data.endTime || null, note: data.note || '' });
  });
}

/** Véletlen időpont-generátor dialógus. */
export function renderRandomGeneratorModal({ users, isAdmin, defaultUserId, onGenerate }) {
  const today = todayDateStr();
  const { overlay, close } = openModal({
    title: 'Véletlen időpont-generátor',
    bodyHtml: `
      <p class="text-muted text-sm">A kezdés a megadott tartományban egyenletesen véletlenszerű; a napi munkaidő
        hossza a minimum-maximum sávon belül <strong>Gauss-eloszlású</strong> (a sáv közepe a leggyakoribb, a
        szélsőértékek felé egyre ritkább). A létrehozott bejegyzések a Forrás oszlopban "Kézi"-ként jelennek meg.</p>
      <form id="random-form" novalidate>
        ${isAdmin
          ? `<div class="field"><label>Felhasználó</label>
              <select name="userId" required>
                ${users.filter((u) => !u.deleted).map((u) => `<option value="${esc(u.id)}" ${u.id === defaultUserId ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}
              </select></div>`
          : `<input type="hidden" name="userId" value="${esc(defaultUserId)}">`}

        <div class="field-row">
          <div class="field"><label>Ettől a naptól</label>${dateFieldHtml({ name: 'fromDate', value: today, ariaLabel: 'Ettől a naptól' })}</div>
          <div class="field"><label>Eddig a napig</label>${dateFieldHtml({ name: 'toDate', value: today, ariaLabel: 'Eddig a napig' })}</div>
        </div>
        <div class="field-row">
          <div class="field"><label>Kezdés – tól (ÓÓ:PP)</label><input type="text" inputmode="numeric" name="startFrom" value="08:00" placeholder="08:00" required></div>
          <div class="field"><label>Kezdés – ig (ÓÓ:PP)</label><input type="text" inputmode="numeric" name="startTo" value="09:00" placeholder="09:00" required></div>
        </div>
        <div class="field-row">
          <div class="field"><label>Napi min. munkaidő (óra)</label><input type="number" name="minDurationHours" min="0" max="24" step="0.25" value="7" required></div>
          <div class="field"><label>Napi max. munkaidő (óra)</label><input type="number" name="maxDurationHours" min="0" max="24" step="0.25" value="9" required></div>
        </div>

        <label class="checkbox-field"><input type="checkbox" name="skipWeekends" checked> Hétvégék kihagyása</label>
        <label class="checkbox-field"><input type="checkbox" name="skipHolidays" checked> Magyar munkaszüneti napok kihagyása</label>
        <label class="checkbox-field"><input type="checkbox" name="overwrite"> Meglévő bejegyzések felülírása</label>

        <hr class="divider">
        <div class="field">
          <label>Heti/havi célkitűzés (opcionális)</label>
          <select name="quotaPeriod" id="quota-period-select">
            <option value="none">Nincs – csak a napi min./max. sáv számít</option>
            <option value="weekly">Heti célóraszám (hétfőtől vasárnapig számolva)</option>
            <option value="monthly">Havi célóraszám</option>
          </select>
          <div class="field-hint">Ha beállítod, a generátor a hét/hónap hátralévő napjaira dinamikusan újraszámolja
            a szükséges napi átlagot, hogy megközelítse a célt (a meglévő, nem érintett bejegyzések óraszáma is beleszámít).
            Nem lesz perc-pontos - a napi min./max. sáv mindig felülbírálja, ha ütköznének.</div>
        </div>
        <div class="field-row" id="quota-fields" hidden>
          <div class="field"><label>Cél óraszám / időszak</label><input type="number" name="quotaTargetHours" min="0" step="0.5" placeholder="pl. 40"></div>
          <div class="field"><label>Tűrés (± óra)</label><input type="number" name="quotaToleranceHours" min="0" step="0.5" value="2"></div>
        </div>

        <div class="form-error" hidden></div>
        <div class="form-actions">
          <button type="button" class="btn" data-close>Mégse</button>
          <button type="submit" class="btn btn-primary">Generálás</button>
        </div>
      </form>`,
  });

  wireDateFields(overlay);
  const form = overlay.querySelector('#random-form');
  const quotaSelect = overlay.querySelector('#quota-period-select');
  const quotaFields = overlay.querySelector('#quota-fields');
  const quotaTargetInput = form.querySelector('[name="quotaTargetHours"]');
  quotaSelect.addEventListener('change', () => {
    const active = quotaSelect.value !== 'none';
    quotaFields.hidden = !active;
    quotaTargetInput.required = active;
  });

  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const fd = new FormData(form);
    const d = Object.fromEntries(fd.entries());
    d.skipWeekends = fd.has('skipWeekends');
    d.skipHolidays = fd.has('skipHolidays');
    d.overwrite = fd.has('overwrite');
    d.minDurationHours = Number(d.minDurationHours);
    d.maxDurationHours = Number(d.maxDurationHours);
    d.quotaTargetHours = d.quotaTargetHours ? Number(d.quotaTargetHours) : null;
    d.quotaToleranceHours = d.quotaToleranceHours ? Number(d.quotaToleranceHours) : 2;

    const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
    if (!d.fromDate || !d.toDate) return showFormError(form, 'Válaszd ki a dátumtartományt.');
    if (d.fromDate > d.toDate) return showFormError(form, 'A kezdő dátum nem lehet későbbi, mint a záró dátum.');
    const days = Math.round((new Date(d.toDate) - new Date(d.fromDate)) / 86400000) + 1;
    if (days > 366) return showFormError(form, 'Egyszerre legfeljebb 366 napot lehet generálni.');
    if (!TIME_RE.test(d.startFrom) || !TIME_RE.test(d.startTo)) return showFormError(form, 'Add meg a kezdés-tartományt 24 órás ÓÓ:PP formátumban (pl. 08:00).');
    if (d.startFrom > d.startTo) return showFormError(form, 'A kezdés tartománya hibás: a „tól” későbbi, mint az „ig”.');
    if (d.minDurationHours <= 0 || d.maxDurationHours <= 0) return showFormError(form, 'A munkaidőnek pozitívnak kell lennie.');
    if (d.minDurationHours > d.maxDurationHours) return showFormError(form, 'A minimum munkaidő nem lehet nagyobb a maximumnál.');
    if (d.quotaPeriod !== 'none' && !d.quotaTargetHours) return showFormError(form, 'Add meg a cél óraszámot, vagy válaszd a "Nincs" opciót.');

    close();
    onGenerate(d);
  });
}

// ---------------------------------------------------------------------------
// ADMIN – FELHASZNÁLÓK
// ---------------------------------------------------------------------------

export function renderAdminUsers(container, { users, currentUserId, onAdd, onEdit, onToggleActive }) {
  const list = users.filter((u) => !u.deleted);
  container.innerHTML = `
    <div class="page-header">
      <h1>Felhasználók</h1>
      <button class="btn btn-primary btn-sm" id="btn-add-user">Felhasználó felvétele</button>
    </div>
    <p class="text-muted text-sm" style="margin-top:-8px;">Csak az itt felvett Microsoft-fiókok használhatják az alkalmazást.
      A felhasználó az itt megadott e-mail címmel tud bejelentkezni.</p>
    <div class="ledger">
      <div class="ledger-row header">
        <div class="col-name">Név</div>
        <div class="col-email">E-mail</div>
        <div class="col-role">Szerepkör</div>
        <div class="col-state">Állapot</div>
        <div class="ledger-actions"></div>
      </div>
      ${list.map((u) => `
        <div class="ledger-row user-row">
          <div class="col-name">${esc(u.name)}${u.id === currentUserId ? ' <span class="text-muted text-sm">(te)</span>' : ''}</div>
          <div class="col-email text-muted text-sm">${esc(u.email)}</div>
          <div class="col-role">${u.role === 'admin' ? '<span class="role-tag">admin</span>' : 'felhasználó'}</div>
          <div class="col-state">${u.active ? '<span class="badge badge-ok"><span class="badge-dot"></span>aktív</span>' : '<span class="badge badge-neutral">inaktív</span>'}</div>
          <div class="ledger-actions">
            <button class="icon-btn" data-edit-user="${esc(u.id)}" title="Szerkesztés" aria-label="Szerkesztés">${icon('edit')}</button>
            <button class="icon-btn" data-toggle-user="${esc(u.id)}" title="${u.active ? 'Inaktiválás' : 'Aktiválás'}" aria-label="${u.active ? 'Inaktiválás' : 'Aktiválás'}">${icon(u.active ? 'pause' : 'play')}</button>
          </div>
        </div>`).join('')}
    </div>`;
  container.querySelector('#btn-add-user').addEventListener('click', () => onAdd());
  container.querySelectorAll('[data-edit-user]').forEach((b) =>
    b.addEventListener('click', () => onEdit(list.find((u) => u.id === b.dataset.editUser)))
  );
  container.querySelectorAll('[data-toggle-user]').forEach((b) =>
    b.addEventListener('click', () => onToggleActive(b.dataset.toggleUser))
  );
}

export function renderUserModal({ user, onSave }) {
  const isNew = !user;
  const u = user || { name: '', email: '', role: 'user' };
  const { overlay, close } = openModal({
    title: isNew ? 'Felhasználó felvétele' : 'Felhasználó szerkesztése',
    bodyHtml: `
      <form id="user-form" novalidate>
        <div class="field"><label>Név</label><input type="text" name="name" value="${esc(u.name)}" required></div>
        <div class="field"><label>E-mail (a Microsoft-fiók bejelentkezési címe)</label>
          <input type="email" name="email" value="${esc(u.email)}" required ${isNew ? '' : 'readonly'}>
          <div class="field-hint">Pontosan ezzel a címmel kell majd bejelentkeznie a felhasználónak.</div>
        </div>
        <div class="field"><label>Szerepkör</label>
          <select name="role">
            <option value="user" ${u.role === 'user' ? 'selected' : ''}>Felhasználó (csak a saját adatai)</option>
            <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Adminisztrátor (mindenkié)</option>
          </select>
        </div>
        <div class="form-error" hidden></div>
        <div class="form-actions">
          <button type="button" class="btn" data-close>Mégse</button>
          <button type="submit" class="btn btn-primary">Mentés</button>
        </div>
      </form>`,
  });
  const form = overlay.querySelector('#user-form');
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const d = Object.fromEntries(new FormData(form).entries());
    if (!d.name.trim()) return showFormError(form, 'Add meg a nevet.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email.trim())) return showFormError(form, 'Adj meg érvényes e-mail címet.');
    close();
    onSave({ id: user ? user.id : null, name: d.name.trim(), email: d.email.trim().toLowerCase(), role: d.role });
  });
}

// ---------------------------------------------------------------------------
// BEÁLLÍTÁSOK
// ---------------------------------------------------------------------------

export function renderSettings(container, o) {
  const localMode = o.mode !== 'cloud';
  container.innerHTML = `
    <div class="page-header"><h1>Beállítások</h1></div>

    <div class="card">
      <h2>Szinkronizáció</h2>
      <div class="sync-bar" style="margin:8px 0 6px;">${syncBadgeHtml(o.syncState)}</div>
      ${localMode
        ? `<p class="text-muted text-sm">Az alkalmazás helyi módban fut, az adatok csak ezen az eszközön vannak. A több eszközös
           OneDrive-szinkron bekapcsolásához töltsd ki a <code>config.js</code> fájlt (lásd README → 2. és 3. lépés).</p>`
        : `${o.syncState.status === 'error' ? `<p class="text-sm" style="color:var(--err-600);">${esc(o.syncState.error)}</p>` : ''}
           <p class="text-muted text-sm">
             Utolsó sikeres szinkron: ${o.lastSyncedAt ? esc(formatDateTimeHu(o.lastSyncedAt)) : 'még nem történt'}<br>
             Szinkronra váró módosítás: ${o.pendingCount} db<br>
             Automatikus szinkron: ${o.config.autoSyncIntervalMinutes} percenként, minden módosítás után, és amint helyreáll az internetkapcsolat.
           </p>
           <button class="btn" id="btn-sync-now">Szinkronizálj most</button>`}
    </div>

    ${localMode ? '' : `
    <div class="card">
      <h2>Fiók</h2>
      <p class="text-sm">Bejelentkezve mint: <strong>${esc(o.account ? o.account.username : '—')}</strong></p>
      <button class="btn btn-ghost btn-sm" id="btn-logout">Kijelentkezés</button>
    </div>`}

    <div class="card">
      <h2>Ez az eszköz</h2>
      <div class="field">
        <label>Eszköz neve (ez jelenik meg a bejegyzéseknél)</label>
        <input type="text" id="device-name-input" value="${esc(o.deviceName)}">
      </div>
      <button class="btn btn-sm" id="btn-save-device-name">Mentés</button>
      <hr class="divider">
      <label class="checkbox-field">
        <input type="checkbox" id="auto-checkin-toggle" ${o.autoCheckinEnabled ? 'checked' : ''}>
        Automatikus bejegyzés-észlelés ezen az eszközön
      </label>
      <p class="text-muted text-sm">
        Telefonon: az app megnyitása rögzíti a munkakezdést (naponta egyszer). Windowson: a bejelentkezéskor automatikusan
        induló app (lásd lejjebb). Ha már van nyitott bejegyzésed a mai napra, nem készül újabb.
      </p>
    </div>

    ${o.isStandalone ? '' : `
    <div class="card">
      <h2>Alkalmazás telepítése</h2>
      ${o.canInstall
        ? `<p class="text-muted text-sm">Telepítsd az appot, hogy saját ablakban, ikonnal induljon, és offline is működjön.</p>
           <button class="btn btn-primary btn-sm" id="btn-install">Telepítés</button>`
        : o.isIos
          ? `<p class="text-muted text-sm">iPhone/iPad: Safariban koppints a Megosztás ikonra, majd válaszd a „Főképernyőhöz adás” lehetőséget.</p>`
          : `<p class="text-muted text-sm">Böngésződ menüjében keresd a „Telepítés” / „Alkalmazás telepítése” lehetőséget
             (Edge: … menü → Alkalmazások; Chrome: címsor jobb szélén a telepítés ikon; Android: menü → „Hozzáadás a kezdőképernyőhöz”).</p>`}
    </div>`}

    ${o.isWindows ? `
    <div class="card">
      <h2>Windows automatikus indítás</h2>
      <p class="text-muted text-sm">Ha az appot a Windows-bejelentkezéskor automatikusan elindítod, az rögzíti a munkakezdést.
        Nyisd meg a PowerShellt (Start → „PowerShell”), és illeszd be az alábbi parancsot: egy indítási parancsikont hoz létre az
        Automatikus indítás mappában (Startup). Eltávolítás: Win+R → <code>shell:startup</code> → a „Jelenleti Iv” parancsikon törlése.</p>
      <textarea readonly class="code-box" rows="7" id="autostart-cmd">${esc(o.autostartCommand)}</textarea>
      <button class="btn btn-sm" id="btn-copy-cmd">Parancs másolása</button>
    </div>` : ''}

    <div class="card">
      <h2>Adatok</h2>
      ${o.isAdmin ? `<button class="btn btn-sm" id="btn-backup">Biztonsági mentés letöltése (JSON)</button>` : ''}
      ${localMode ? `<p class="text-muted text-sm">Helyi módban az adatok csak ezen az eszközön vannak – érdemes időnként biztonsági mentést készíteni.</p>` : `
      <hr class="divider">
      <p class="text-muted text-sm">Hibaelhárításhoz törölheted az eszközön tárolt helyi adatokat; a következő szinkron újra letölti őket a OneDrive-ról.
        A még nem szinkronizált módosítások elvesznek!</p>
      <button class="btn btn-danger btn-sm" id="btn-reset-local">Helyi adatok törlése</button>`}
    </div>
  `;

  const on = (sel, fn) => { const el = container.querySelector(sel); if (el) el.addEventListener('click', fn); };
  on('#btn-sync-now', o.onSyncNow);
  on('#btn-logout', o.onLogout);
  on('#btn-install', o.onInstall);
  on('#btn-copy-cmd', () => o.onCopy(o.autostartCommand));
  on('#btn-backup', o.onBackup);
  on('#btn-reset-local', o.onResetLocal);
  on('#btn-save-device-name', () => o.onSaveDeviceName(container.querySelector('#device-name-input').value.trim()));
  const tgl = container.querySelector('#auto-checkin-toggle');
  if (tgl) tgl.addEventListener('change', (ev) => o.onToggleAutoCheckin(ev.target.checked));
}
