// ============================================================================
// APP – a fő vezérlő. Ez köti össze a DB / Auth / Sync / RandomGenerator /
// AutoCheckin modulokat a Views által rajzolt felülettel.
//
// ÁLTALÁNOS ELV: minden felhasználói művelet ELŐSZÖR a helyi IndexedDB-be ír,
// és A FELÜLET AZONNAL FRISSÜL - a OneDrive-szinkron csak ez UTÁN, a háttérben
// fut le. Így az app internetkapcsolat nélkül is azonnal reagál.
// ============================================================================

import { CONFIG } from '../config.js';
import * as DB from './db.js';
import * as Models from './models.js';
import * as Auth from './auth.js';
import * as Sync from './sync.js';
import * as RandomGen from './randomGenerator.js';
import { maybeAutoCheckin } from './autoCheckin.js';
import * as Views from './views.js';

const root = document.getElementById('app');

const state = {
  mode: null, // 'local' (nincs OneDrive-szinkron beállítva) | 'cloud'
  account: null,
  currentUser: null,
  users: [],
  entries: [],
  lastSyncedAt: null,
  pendingCount: 0,
  syncState: { status: 'idle', error: null, needsLogin: false },
  currentView: 'dashboard',
  selectedUserId: null,
  filters: { year: '', month: '', fromDate: '', toDate: '', source: '', breakMin: '', text: '' },
  selectedEntryIds: new Set(),
  deviceId: '',
  deviceName: '',
  autoCheckinEnabled: true,
  canInstall: false,
  isStandalone: false,
  isIos: false,
  isWindows: false,
};

let deferredInstallPrompt = null;
let syncTimer = null;
let syncInFlight = false;

// ---------------------------------------------------------------------------
// Segédfüggvények
// ---------------------------------------------------------------------------

function detectEnvironment() {
  const ua = navigator.userAgent || '';
  state.isStandalone =
    (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
    window.navigator.standalone === true;
  state.isIos = /iPad|iPhone|iPod/i.test(ua) && !window.MSStream;
  state.isWindows = /Windows/i.test(ua);
}

function guessDeviceName() {
  const ua = navigator.userAgent || '';
  if (/Android/i.test(ua)) return 'Android telefon';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'iOS eszköz';
  if (/Windows/i.test(ua)) return 'Windows gép';
  if (/Macintosh/i.test(ua)) return 'Mac';
  return 'Ismeretlen eszköz';
}

/** Az adott felhasználóra és napra érvényes levonás (perc) a felhasználó szabályai szerint. */
function resolveBreakFor(userId, dateStr) {
  const user = state.users.find((u) => u.id === userId) || (state.currentUser && state.currentUser.id === userId ? state.currentUser : null);
  return Models.resolveBreakMinutes(user ? user.breakRules : [], dateStr);
}

/** Kézi-jelző: igaz, ha a bejegyzés levonása eltér a szabályból adódótól. Szerkesztésnél, ha a
 * levonás értéke nem változott, a korábbi jelző marad (így egy régi bejegyzés megnyitása és
 * mentése nem "kézi" jelölésűvé teszi). */
function computeBreakManual(existing, userId, date, newBreak) {
  const ruleValue = resolveBreakFor(userId, date);
  if (!existing) return newBreak !== ruleValue;
  if (newBreak !== Models.entryBreak(existing)) return newBreak !== ruleValue;
  return !!existing.breakManual;
}

async function computePendingCount() {
  const all = [...state.users, ...state.entries];
  if (!state.lastSyncedAt) return all.length;
  return all.filter((x) => x.updatedAt > state.lastSyncedAt).length;
}

async function loadLocalData() {
  state.users = await DB.getAllUsers();
  state.entries = await DB.getAllEntries();
  if (state.currentUser) {
    // szinkron után a más eszközön módosított adatok (pl. levonási szabályok) is látszanak
    const fresh = state.users.find((u) => u.id === state.currentUser.id && !u.deleted);
    if (fresh) state.currentUser = fresh;
  }
  state.lastSyncedAt = await DB.getMeta('lastSyncedAt', null);
  state.pendingCount = await computePendingCount();
}

function registerServiceWorker() {
  const isLocalDev = ['localhost', '127.0.0.1'].includes(window.location.hostname);
  if (isLocalDev) {
    // Helyi fejlesztés közben (pl. VS Code Live Server) SZÁNDÉKOSAN nem
    // regisztrálunk Service Workert, hogy mindig a ténylegesen aktuális
    // fájlok töltődjenek be, gyorsítótárazás nélkül. Egy korábbi munkamenetből
    // esetleg visszamaradt Service Workert és gyorsítótárat is eltávolítjuk,
    // hogy a fejlesztői gép ne ragadjon be egy régi verzióba.
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistrations().then((regs) => regs.forEach((r) => r.unregister()));
    }
    if ('caches' in window) {
      caches.keys().then((keys) => keys.forEach((k) => caches.delete(k)));
    }
    return;
  }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./service-worker.js').catch(() => {});
  }
}

function buildAutostartCommand() {
  const basePath = window.location.pathname.replace(/index\.html$/i, '');
  const base = window.location.origin + basePath;
  const target = (base.endsWith('/') ? base : base + '/') + 'index.html?autostart=1';
  return [
    '$paths = @(',
    '  "$env:ProgramFiles\\Microsoft\\Edge\\Application\\msedge.exe",',
    '  "${env:ProgramFiles(x86)}\\Microsoft\\Edge\\Application\\msedge.exe",',
    '  "$env:ProgramFiles\\Google\\Chrome\\Application\\chrome.exe",',
    '  "${env:ProgramFiles(x86)}\\Google\\Chrome\\Application\\chrome.exe"',
    ')',
    '$browser = $paths | Where-Object { Test-Path $_ } | Select-Object -First 1',
    'if (-not $browser) {',
    '  Write-Host "Nem talalhato Edge vagy Chrome a szokasos helyen." -ForegroundColor Red',
    '} else {',
    '  $startup = [Environment]::GetFolderPath("Startup")',
    '  $sc = (New-Object -ComObject WScript.Shell).CreateShortcut("$startup\\JelenletiIv.lnk")',
    '  $sc.TargetPath = $browser',
    `  $sc.Arguments = '--app="${target}"'`,
    '  $sc.Save()',
    '  Write-Host "Kesz! Legkozelebbi bejelentkezeskor automatikusan elindul az app." -ForegroundColor Green',
    '}',
  ].join('\n');
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function csvEscape(v) {
  const s = String(v == null ? '' : v);
  return /[",;\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// ---------------------------------------------------------------------------
// Indítás
// ---------------------------------------------------------------------------

async function init() {
  await DB.openDB();
  registerServiceWorker();
  detectEnvironment();

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    state.canInstall = true;
    if (state.currentUser && state.currentView === 'settings') renderApp();
  });
  window.addEventListener('appinstalled', () => {
    state.isStandalone = true;
    state.canInstall = false;
    if (state.currentUser && state.currentView === 'settings') renderApp();
  });

  state.deviceId = await DB.getMeta('deviceId');
  if (!state.deviceId) {
    state.deviceId = Models.uuid();
    await DB.setMeta('deviceId', state.deviceId);
  }
  state.deviceName = await DB.getMeta('deviceName');
  if (!state.deviceName) {
    state.deviceName = guessDeviceName();
    await DB.setMeta('deviceName', state.deviceName);
  }
  state.autoCheckinEnabled = await DB.getMeta('autoCheckinEnabled', true);

  const cloudConfigured =
    Auth.isAuthConfigured(CONFIG.clientId) &&
    typeof CONFIG.sharedFolderLink === 'string' &&
    CONFIG.sharedFolderLink.trim() !== '' &&
    !/^IDE-/i.test(CONFIG.sharedFolderLink.trim());
  state.mode = cloudConfigured ? 'cloud' : 'local';

  if (state.mode === 'cloud') await startCloudMode();
  else await startLocalMode();
}

async function startLocalMode() {
  await loadLocalData();
  if (state.users.length === 0) {
    Views.renderLocalSetup(root, {
      onSubmit: async ({ name, email }) => {
        const admin = Models.createUser({ name, email, role: 'admin' });
        await DB.putUser(admin);
        await loadLocalData();
        await DB.setMeta('localUserId', admin.id);
        state.currentUser = admin;
        await afterIdentityResolved();
      },
    });
    return;
  }
  const localUserId = await DB.getMeta('localUserId');
  state.currentUser =
    state.users.find((u) => u.id === localUserId && !u.deleted) ||
    state.users.find((u) => !u.deleted) ||
    state.users[0];
  await afterIdentityResolved();
}

async function startCloudMode() {
  try {
    await Auth.initAuth(CONFIG.clientId, CONFIG.msalAuthority);
  } catch (e) {
    Views.renderMessageScreen(root, {
      title: 'Nem sikerült betölteni a Microsoft bejelentkezési szolgáltatást',
      message: Sync.describeError(e),
      actions: [{ label: 'Újratöltés', primary: true, onClick: () => location.reload() }],
    });
    return;
  }
  state.account = Auth.getCurrentAccount();
  if (!state.account) {
    renderLoginScreen();
    return;
  }
  await resolveCloudIdentity();
}

function renderLoginScreen(error) {
  Views.renderLogin(root, {
    error,
    loading: false,
    onLogin: async () => {
      Views.renderLogin(root, { loading: true });
      try {
        const account = await Auth.login();
        if (!account) return; // átirányításos bejelentkezés - az oldal újratöltődik
        state.account = account;
        await resolveCloudIdentity();
      } catch (e) {
        renderLoginScreen(Sync.describeError(e));
      }
    },
  });
}

async function resolveCloudIdentity() {
  Views.renderMessageScreen(root, { title: 'Bejelentkezés folyamatban…', busy: true, actions: [] });

  const result = await Sync.performSync(CONFIG, { interactive: false });
  state.syncState = result;
  await loadLocalData();

  const email = (state.account.username || '').toLowerCase();
  let user = state.users.find((u) => !u.deleted && u.email.toLowerCase() === email);

  if (!user) {
    if (state.users.length === 0 && result.status === 'synced') {
      // Megerősítetten üres a megosztott adatbázis is - ez a csapat legelső indulása.
      const admin = Models.createUser({ name: state.account.name || email, email, role: 'admin' });
      await DB.putUser(admin);
      await loadLocalData();
      user = admin;
    } else if (result.status !== 'synced') {
      const reason = result.status === 'offline' ? 'Nincs internetkapcsolat.' : result.error || 'Ismeretlen hiba.';
      Views.renderMessageScreen(root, {
        title: 'Nem sikerült ellenőrizni a fiókodat',
        message: `${reason} Emiatt egyelőre nem tudjuk megállapítani, hogy regisztrálva vagy-e a rendszerben.`,
        actions: [
          { label: 'Újrapróbálom', primary: true, onClick: () => resolveCloudIdentity() },
          { label: 'Kijelentkezés', onClick: async () => { await Auth.logout(); location.reload(); } },
        ],
      });
      return;
    } else {
      Views.renderMessageScreen(root, {
        title: 'Ez a fiók még nincs regisztrálva',
        message: 'Sikeresen bejelentkeztél, de az adminisztrátornak előbb fel kell vennie a rendszerbe (Admin → Felhasználók), mielőtt használhatnád az appot.',
        emphasis: email,
        actions: [
          { label: 'Újraellenőrzés', primary: true, onClick: () => resolveCloudIdentity() },
          { label: 'Kijelentkezés', onClick: async () => { await Auth.logout(); location.reload(); } },
        ],
      });
      return;
    }
  }

  if (user.active === false) {
    Views.renderMessageScreen(root, {
      title: 'A fiókod inaktiválva van',
      message: 'Kérd meg az adminisztrátort, hogy aktiválja a fiókodat.',
      actions: [{ label: 'Kijelentkezés', onClick: async () => { await Auth.logout(); location.reload(); } }],
    });
    return;
  }

  state.currentUser = user;
  await afterIdentityResolved();
}

async function afterIdentityResolved() {
  const entry = await maybeAutoCheckin({
    userId: state.currentUser.id,
    deviceId: state.deviceId,
    deviceName: state.deviceName,
    breakMinutes: resolveBreakFor(state.currentUser.id, Models.todayDateStr()),
  });
  if (entry) await loadLocalData();

  renderApp();

  if (state.mode === 'cloud') {
    if (syncTimer) clearInterval(syncTimer);
    syncTimer = setInterval(() => runSync(), CONFIG.autoSyncIntervalMinutes * 60000);
    window.addEventListener('online', () => runSync());
    runSync();
  }
}

// ---------------------------------------------------------------------------
// Szinkronizáció futtatása
// ---------------------------------------------------------------------------

async function runSync({ interactive = false } = {}) {
  if (state.mode !== 'cloud' || syncInFlight) return;
  syncInFlight = true;
  state.syncState = { status: 'syncing', error: null, needsLogin: false };
  renderApp();
  const result = await Sync.performSync(CONFIG, { interactive });
  state.syncState = result;
  await loadLocalData();
  syncInFlight = false;
  renderApp();
  if (result.status === 'synced') {
    // csendes siker - nincs toast, hogy ne zavarjon; hiba esetén a sávban úgyis látszik
  }
}

async function afterMutation() {
  await loadLocalData();
  renderApp();
  if (state.mode === 'cloud') runSync();
}

// ---------------------------------------------------------------------------
// Renderelés / útválasztás
// ---------------------------------------------------------------------------

function renderApp() {
  detectEnvironment();
  const content = Views.renderShell(root, {
    user: state.currentUser,
    currentView: state.currentView,
    showLogout: state.mode === 'cloud',
    onNavigate: (view) => {
      if (view !== state.currentView) state.selectedEntryIds = new Set();
      state.currentView = view;
      renderApp();
    },
    onLogout: async () => { await Auth.logout(); location.reload(); },
  });
  Views.renderSyncBanner(root, {
    mode: state.mode,
    syncState: state.syncState,
    pendingCount: state.pendingCount,
    onRetry: () => runSync({ interactive: true }),
    onRelogin: () => runSync({ interactive: true }),
  });

  const isAdmin = state.currentUser.role === 'admin';
  if ((state.currentView === 'admin-users' || state.currentView === 'admin-entries') && !isAdmin) {
    state.currentView = 'dashboard';
  }

  switch (state.currentView) {
    case 'entries':
      renderEntriesView(content, false);
      break;
    case 'admin-users':
      renderAdminUsersView(content);
      break;
    case 'admin-entries':
      renderEntriesView(content, true);
      break;
    case 'settings':
      renderSettingsView(content);
      break;
    default:
      renderDashboardView(content);
  }
}

function renderDashboardView(content) {
  Views.renderDashboard(content, {
    user: state.currentUser,
    entries: state.entries,
    syncState: state.syncState,
    showSync: state.mode === 'cloud',
    onCheckIn: async () => {
      const entry = Models.createEntry({
        userId: state.currentUser.id,
        date: Models.todayDateStr(),
        startTime: Models.nowTimeStr(),
        endTime: null,
        source: 'manual',
        breakMinutes: resolveBreakFor(state.currentUser.id, Models.todayDateStr()),
        deviceId: state.deviceId,
        deviceName: state.deviceName,
      });
      await DB.putEntry(entry);
      await afterMutation();
    },
    onCheckOut: async (openEntry) => {
      if (!openEntry) return;
      const updated = Models.touchEntry(openEntry, { endTime: Models.nowTimeStr() });
      await DB.putEntry(updated);
      await afterMutation();
      Views.showToast('Munka befejezve.', 'success');
    },
    onEditEntry: (entry) => openEntryModal(entry, false),
    onSyncNow: () => runSync({ interactive: true }),
    onGoEntries: () => { state.currentView = 'entries'; renderApp(); },
  });
}

let textFilterDebounceTimer = null;

/** A jelenleg (szűréssel) látható bejegyzések listája - a tömeges műveletek
 * mindig CSAK erre a listára vonatkoznak, még akkor is, ha a kijelölés
 * időközben szűréssel épp nem látható elemeket is tartalmazna. */
function getVisibleEntries(isAdminView) {
  return Views.filterEntries({
    entries: state.entries,
    isAdminView,
    selectedUserId: state.selectedUserId,
    currentUserId: state.currentUser.id,
    filters: state.filters,
  });
}

function renderEntriesView(content, isAdminView) {
  Views.renderEntries(content, {
    entries: state.entries,
    users: state.users,
    isAdminView,
    selectedUserId: state.selectedUserId,
    currentUserId: state.currentUser.id,
    filters: state.filters,
    selectedEntryIds: state.selectedEntryIds,
    onAdd: () => openEntryModal(null, isAdminView),
    onEdit: (entry) => openEntryModal(entry, isAdminView),
    onDelete: (id) => deleteEntry(id),
    onOpenRandom: () => openRandomModal(isAdminView),
    onFilterUser: (userId) => { state.selectedUserId = userId; state.selectedEntryIds = new Set(); renderApp(); },
    onFilterChange: (key, value, opts) => {
      state.filters = { ...state.filters, [key]: value };
      if (opts && opts.debounce) {
        clearTimeout(textFilterDebounceTimer);
        textFilterDebounceTimer = setTimeout(() => renderApp(), 200);
      } else {
        renderApp();
      }
    },
    onClearFilters: () => {
      state.filters = { year: '', month: '', fromDate: '', toDate: '', source: '', breakMin: '', text: '' };
      renderApp();
    },
    onExportCsv: (list) => exportCsv(list, isAdminView),
    onPrint: () => window.print(),
    onToggleSelect: (id, checked) => {
      if (checked) state.selectedEntryIds.add(id);
      else state.selectedEntryIds.delete(id);
      renderApp();
    },
    onToggleSelectAll: (visibleIds, selectAll) => {
      if (selectAll) visibleIds.forEach((id) => state.selectedEntryIds.add(id));
      else visibleIds.forEach((id) => state.selectedEntryIds.delete(id));
      renderApp();
    },
    onClearSelection: () => { state.selectedEntryIds = new Set(); renderApp(); },
    onBulkEdit: () => openBulkEditModal(isAdminView),
    onBulkDelete: () => bulkDeleteSelected(isAdminView),
  });
}

function openBulkEditModal(isAdminView) {
  const targetIds = getVisibleEntries(isAdminView)
    .map((e) => e.id)
    .filter((id) => state.selectedEntryIds.has(id));
  if (targetIds.length === 0) return;
  Views.renderBulkEditModal({
    count: targetIds.length,
    onApply: async (changes) => {
      const { breakMode, breakMinutes, ...plain } = changes;
      for (const id of targetIds) {
        const existing = state.entries.find((e) => e.id === id);
        if (!existing) continue;
        const patch = { ...plain };
        if (breakMode === 'rules') {
          patch.breakMinutes = resolveBreakFor(existing.userId, existing.date);
          patch.breakManual = false;
        } else if (breakMode === 'custom') {
          patch.breakMinutes = breakMinutes;
          patch.breakManual = breakMinutes !== resolveBreakFor(existing.userId, existing.date);
        }
        await DB.putEntry(Models.touchEntry(existing, patch));
      }
      state.selectedEntryIds = new Set();
      await afterMutation();
      Views.showToast(`${targetIds.length} bejegyzés módosítva.`, 'success');
    },
  });
}

async function bulkDeleteSelected(isAdminView) {
  const targetIds = getVisibleEntries(isAdminView)
    .map((e) => e.id)
    .filter((id) => state.selectedEntryIds.has(id));
  if (targetIds.length === 0) return;
  if (!window.confirm(`Biztosan törlöd a kiválasztott ${targetIds.length} bejegyzést?`)) return;
  const snapshots = targetIds.map((id) => state.entries.find((e) => e.id === id)).filter(Boolean);
  for (const e of snapshots) await DB.putEntry(Models.touchEntry(e, { deleted: true }));
  state.selectedEntryIds = new Set();
  await afterMutation();
  Views.showToast(`${snapshots.length} bejegyzés törölve.`, 'info', {
    actionLabel: 'Visszavonás',
    onAction: async () => {
      for (const e of snapshots) await DB.putEntry(Models.touchEntry(e, { deleted: false }));
      await afterMutation();
    },
  });
}

function openEntryModal(entry, isAdminView) {
  const isAdmin = state.currentUser.role === 'admin';
  Views.renderEntryModal({
    entry,
    users: state.users,
    isAdmin: isAdmin && isAdminView,
    defaultUserId: (isAdmin && isAdminView && state.selectedUserId) || state.currentUser.id,
    resolveBreak: (userId, date) => resolveBreakFor(userId, date),
    onSave: async (data) => {
      if (data.id) {
        const existing = state.entries.find((e) => e.id === data.id);
        if (!existing) return;
        const updated = Models.touchEntry(existing, {
          date: data.date, startTime: data.startTime, endTime: data.endTime, note: data.note, userId: data.userId,
          breakMinutes: data.breakMinutes,
          breakManual: computeBreakManual(existing, data.userId, data.date, data.breakMinutes),
        });
        await DB.putEntry(updated);
      } else {
        const created = Models.createEntry({
          userId: data.userId, date: data.date, startTime: data.startTime, endTime: data.endTime,
          note: data.note, source: 'manual', deviceId: state.deviceId, deviceName: state.deviceName,
          breakMinutes: data.breakMinutes,
          breakManual: computeBreakManual(null, data.userId, data.date, data.breakMinutes),
        });
        await DB.putEntry(created);
      }
      await afterMutation();
    },
    onDelete: (id) => deleteEntry(id),
  });
}

async function deleteEntry(id) {
  const existing = state.entries.find((e) => e.id === id);
  if (!existing) return;
  const updated = Models.touchEntry(existing, { deleted: true });
  await DB.putEntry(updated);
  state.selectedEntryIds.delete(id);
  await afterMutation();
  Views.showToast('Bejegyzés törölve.', 'info', {
    actionLabel: 'Visszavonás',
    onAction: async () => {
      const restored = Models.touchEntry(updated, { deleted: false });
      await DB.putEntry(restored);
      await afterMutation();
    },
  });
}

function openRandomModal(isAdminView) {
  const isAdmin = state.currentUser.role === 'admin';
  Views.renderRandomGeneratorModal({
    users: state.users,
    isAdmin: isAdmin && isAdminView,
    defaultUserId: (isAdmin && isAdminView && state.selectedUserId) || state.currentUser.id,
    breakRulesByUser: Object.fromEntries(state.users.map((u) => [u.id, u.breakRules || []])),
    onGenerate: async (cfg) => {
      const targetUserId = cfg.userId || state.currentUser.id;
      if (cfg.overwrite) {
        const toRemove = state.entries.filter(
          (e) => !e.deleted && e.userId === targetUserId && e.date >= cfg.fromDate && e.date <= cfg.toDate
        );
        for (const e of toRemove) await DB.putEntry(Models.touchEntry(e, { deleted: true }));
      }
      // Azok a bejegyzések, amik a művelet UTÁN is megmaradnak (nincsenek törölve) -
      // ez adja egyszerre a napi ütközés-ellenőrzést ÉS a heti/havi kvóta "már meglévő"
      // alap-óraszámát (lásd randomGenerator.js fejléc-kommentje).
      const remainingForUser = state.entries.filter((e) => {
        if (e.deleted || e.userId !== targetUserId) return false;
        if (cfg.overwrite && e.date >= cfg.fromDate && e.date <= cfg.toDate) return false; // épp most töröltük
        return true;
      });
      const newEntries = RandomGen.generateForDateRange(
        {
          ...cfg, userId: targetUserId, deviceId: state.deviceId, deviceName: state.deviceName,
          breakRules: (state.users.find((u) => u.id === targetUserId) || {}).breakRules || [],
        },
        {
          existingEntriesForUser: remainingForUser.map((e) => ({ date: e.date, startTime: e.startTime, endTime: e.endTime, breakMinutes: e.breakMinutes })),
          overwrite: cfg.overwrite,
        }
      );
      for (const e of newEntries) await DB.putEntry(e);
      await afterMutation();
      Views.showToast(
        newEntries.length > 0
          ? `${newEntries.length} bejegyzés létrehozva.`
          : 'Nem készült új bejegyzés (a napok már ki voltak töltve, vagy mind hétvégére/ünnepnapra estek).',
        newEntries.length > 0 ? 'success' : 'info'
      );
    },
  });
}

function renderAdminUsersView(content) {
  Views.renderAdminUsers(content, {
    users: state.users,
    currentUserId: state.currentUser.id,
    onAdd: () => openUserModal(null),
    onEdit: (user) => openUserModal(user),
    onToggleActive: (id) => toggleUserActive(id),
    onEditBreaks: (user) => openBreakRulesModal(user),
  });
}

/** Szünet-levonási szabályok szerkesztése (saját: Beállítások; admin: bárkié a Felhasználók oldalon). */
function openBreakRulesModal(user) {
  if (!user) return;
  Views.renderBreakRulesModal({
    user,
    onSave: async (rules, applyExisting) => {
      const prevUser = user;
      const updatedUser = Models.touchUser(prevUser, { breakRules: rules });
      await DB.putUser(updatedUser);

      // Meglévő bejegyzések újraszámolása az új szabályok szerint (a kézzel módosítottak kimaradnak)
      const changedBefore = [];
      if (applyExisting) {
        for (const e of state.entries) {
          if (e.deleted || e.userId !== user.id || e.breakManual) continue;
          const wanted = Models.resolveBreakMinutes(rules, e.date);
          if (wanted !== Models.entryBreak(e)) {
            changedBefore.push(e);
            await DB.putEntry(Models.touchEntry(e, { breakMinutes: wanted }));
          }
        }
      }
      await afterMutation();
      Views.showToast(
        applyExisting
          ? `Levonási szabályok mentve, ${changedBefore.length} meglévő bejegyzés frissítve.`
          : 'Levonási szabályok mentve.',
        'success',
        {
          actionLabel: 'Visszavonás',
          onAction: async () => {
            await DB.putUser(Models.touchUser(prevUser, { breakRules: prevUser.breakRules || [] }));
            for (const e of changedBefore) await DB.putEntry(Models.touchEntry(e, { breakMinutes: Models.entryBreak(e) }));
            await afterMutation();
          },
        }
      );
    },
  });
}

function openUserModal(user) {
  Views.renderUserModal({
    user,
    onSave: async (data) => {
      if (data.id) {
        const existing = state.users.find((u) => u.id === data.id);
        if (!existing) return;
        const updated = Models.touchUser(existing, { name: data.name, role: data.role });
        await DB.putUser(updated);
      } else {
        const clash = state.users.find((u) => !u.deleted && u.email.toLowerCase() === data.email.toLowerCase());
        if (clash) {
          Views.showToast('Már létezik felhasználó ezzel az e-mail címmel.', 'error');
          return;
        }
        const created = Models.createUser({ name: data.name, email: data.email, role: data.role });
        await DB.putUser(created);
      }
      await afterMutation();
    },
  });
}

async function toggleUserActive(id) {
  const existing = state.users.find((u) => u.id === id);
  if (!existing) return;
  if (existing.id === state.currentUser.id && existing.active) {
    if (!window.confirm('Biztosan inaktiválod a saját fiókodat? A következő szinkron után ki fogsz jelentkezni.')) return;
  }
  const updated = Models.touchUser(existing, { active: !existing.active });
  await DB.putUser(updated);
  await afterMutation();
}

function renderSettingsView(content) {
  Views.renderSettings(content, {
    mode: state.mode,
    syncState: state.syncState,
    pendingCount: state.pendingCount,
    lastSyncedAt: state.lastSyncedAt,
    account: state.account,
    config: CONFIG,
    deviceName: state.deviceName,
    autoCheckinEnabled: state.autoCheckinEnabled,
    isAdmin: state.currentUser.role === 'admin',
    isStandalone: state.isStandalone,
    canInstall: state.canInstall,
    isIos: state.isIos,
    isWindows: state.isWindows,
    breakRules: state.currentUser.breakRules || [],
    onEditBreaks: () => openBreakRulesModal(state.currentUser),
    autostartCommand: buildAutostartCommand(),
    onSyncNow: () => runSync({ interactive: true }),
    onLogout: async () => { await Auth.logout(); location.reload(); },
    onInstall: async () => {
      if (!deferredInstallPrompt) return;
      deferredInstallPrompt.prompt();
      await deferredInstallPrompt.userChoice;
      deferredInstallPrompt = null;
      state.canInstall = false;
      renderApp();
    },
    onCopy: async (text) => {
      try {
        await navigator.clipboard.writeText(text);
        Views.showToast('Vágólapra másolva.', 'success');
      } catch (e) {
        Views.showToast('Nem sikerült másolni – jelöld ki kézzel a szövegdobozban.', 'error');
      }
    },
    onBackup: () => {
      const payload = { schemaVersion: 1, exportedAt: new Date().toISOString(), users: state.users, entries: state.entries };
      downloadBlob(
        new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }),
        `jelenleti-iv-mentes-${Models.todayDateStr()}.json`
      );
    },
    onResetLocal: async () => {
      if (!window.confirm('Biztosan törlöd a helyi adatokat ezen az eszközön? A még nem szinkronizált módosítások elvesznek.')) return;
      await DB.resetLocalDatabase();
      location.reload();
    },
    onSaveDeviceName: async (name) => {
      if (!name) return;
      state.deviceName = name;
      await DB.setMeta('deviceName', name);
      Views.showToast('Eszköznév mentve.', 'success');
    },
    onToggleAutoCheckin: async (enabled) => {
      state.autoCheckinEnabled = enabled;
      await DB.setMeta('autoCheckinEnabled', enabled);
    },
  });
}

function exportCsv(list, isAdminView) {
  const userById = Object.fromEntries(state.users.map((u) => [u.id, u.name]));
  const header = isAdminView
    ? ['Felhasználó', 'Dátum', 'Kezdés', 'Vége', 'Bruttó idő (perc)', 'Levonás (perc)', 'Ledolgozott idő (perc)', 'Forrás', 'Megjegyzés']
    : ['Dátum', 'Kezdés', 'Vége', 'Bruttó idő (perc)', 'Levonás (perc)', 'Ledolgozott idő (perc)', 'Forrás', 'Megjegyzés'];
  const rows = list.map((e) => {
    const base = [
      Models.formatDateHu(e.date, { withWeekday: false }),
      e.startTime,
      e.endTime || '',
      String(Models.durationMinutes(e) ?? ''),
      String(Models.entryBreak(e)),
      String(Models.workedMinutes(e) ?? ''),
      Views.sourceLabel(e.source),
      e.note || '',
    ];
    return isAdminView ? [userById[e.userId] || '', ...base] : base;
  });
  const csv = [header, ...rows].map((r) => r.map(csvEscape).join(',')).join('\r\n');
  downloadBlob(
    new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' }),
    `jelenleti-iv-export-${Models.todayDateStr()}.csv`
  );
}

// ---------------------------------------------------------------------------

init().catch((err) => {
  console.error(err);
  root.innerHTML = '';
  const card = document.createElement('div');
  card.className = 'login-screen';
  card.innerHTML = `
    <div class="card login-card">
      <h2>Váratlan hiba történt</h2>
      <p class="text-muted text-sm"></p>
      <button class="btn btn-primary" id="btn-reload">Újratöltés</button>
    </div>`;
  card.querySelector('p').textContent = (err && err.message) || 'Ismeretlen hiba.';
  card.querySelector('#btn-reload').addEventListener('click', () => location.reload());
  root.appendChild(card);
});
