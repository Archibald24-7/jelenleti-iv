// ============================================================================
// SERVICE WORKER – az app "vázát" (HTML/CSS/JS) előre letölti és gyorsítótárazza,
// hogy az app internetkapcsolat nélkül is elinduljon. Ez különösen fontos a
// Windows bejelentkezéskor induló automatikus indításnál: ilyenkor a Wi-Fi
// gyakran még nem csatlakozott, az appnak mégis azonnal el kell indulnia.
//
// FRISSÍTÉS: ha módosítasz egy fájlt a projektben, NÖVELD az alábbi CACHE_VERSION
// számát. Így minden eszköz egyszerre, egységesen kapja meg az új verziót.
//
// A Microsoft Graph API / bejelentkezési kéréseket (más domainre irányulókat) EZ A
// WORKER SOSEM fogja el - azok mindig közvetlenül a hálózatra mennek.
// ============================================================================

const CACHE_VERSION = 5;
const CACHE_NAME = `jelenleti-iv-v${CACHE_VERSION}`;

const PRECACHE = [
  './',
  './index.html',
  './manifest.json',
  './css/styles.css',
  './js/app.js',
  './js/db.js',
  './js/models.js',
  './js/auth.js',
  './js/sync.js',
  './js/randomGenerator.js',
  './js/autoCheckin.js',
  './js/views.js',
  './js/datePicker.js',
  './js/vendor/msal-browser.min.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

// A config.js-t hálózat-első módon kezeljük, hogy egy módosítás gyorsan érvényre jusson.
const NETWORK_FIRST = ['/config.js'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // Egyenként töltjük le, hogy egy hiányzó fájl ne buktassa el az egész telepítést.
      Promise.all(PRECACHE.map((url) => cache.add(url).catch(() => null)))
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function fetchWithTimeout(request, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    fetch(request).then(
      (res) => { clearTimeout(t); resolve(res); },
      (err) => { clearTimeout(t); reject(err); }
    );
  });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Csak a saját eredetű kéréseket kezeljük - minden mást (Microsoft bejelentkezés,
  // Graph API, betűtípusok) érintetlenül hagyunk.
  if (url.origin !== self.location.origin) return;

  // 1) Oldalbetöltések (navigáció): MINDIG a gyorsítótárból szolgáljuk ki az index.html-t,
  //    a query-t (pl. ?autostart=1) figyelmen kívül hagyva - így offline is elindul.
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE_NAME);
        const cached =
          (await cache.match('./index.html', { ignoreSearch: true })) ||
          (await cache.match('./', { ignoreSearch: true }));
        // Háttérben frissítjük a gyorsítótárat (ha van hálózat).
        const refresh = fetch(new Request('./index.html', { cache: 'no-cache' }))
          .then((res) => { if (res && res.ok) cache.put('./index.html', res.clone()); return res; })
          .catch(() => null);
        if (cached) { event.waitUntil(refresh); return cached; }
        return (await refresh) || Response.error();
      })()
    );
    return;
  }

  // 2) config.js: hálózat-első, és VALÓBAN megkerüli a böngésző saját HTTP-
  //    gyorsítótárát is (cache: 'reload'), nem csak a Cache Storage-unkat -
  //    enélkül egy sima fetch() még mindig visszaadhatna egy, a böngésző által
  //    korábban (a service workertől teljesen függetlenül) eltárolt, elavult
  //    választ anélkül, hogy ténylegesen hálózatra menne. Rövid időkorláttal,
  //    hiba esetén a saját gyorsítótárunk a tartalék.
  if (NETWORK_FIRST.some((p) => url.pathname.endsWith(p))) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE_NAME);
        try {
          const freshReq = new Request(req, { cache: 'reload' });
          const res = await fetchWithTimeout(freshReq, 3000);
          if (res && res.ok) cache.put(req, res.clone());
          return res;
        } catch (e) {
          return (await cache.match(req, { ignoreSearch: true })) || Response.error();
        }
      })()
    );
    return;
  }

  // 3) Minden más saját fájl: gyorsítótár-első (a verziózott gyorsítótár garantálja az egységességet),
  //    ismeretlen fájlokat futás közben is eltárolunk.
  event.respondWith(
    caches.match(req).then(
      (cached) =>
        cached ||
        fetch(req).then((res) => {
          if (res && res.ok) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(req, clone));
          }
          return res;
        })
    )
  );
});
