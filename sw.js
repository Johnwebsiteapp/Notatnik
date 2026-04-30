// Service Worker — wsparcie offline dla PWA.
//
// Strategia:
//   • App-shell (HTML/CSS/JS/ikony/supabase-js z CDN) — pre-cache w install,
//     plus runtime cache-first dla cross-origin (supabase-js).
//   • Same-origin GET → network-first, cache fallback (świeże wersje po sieci,
//     offline z ostatniej kopii).
//   • Cross-origin GET (CDN supabase-js) → cache-first (CDN się prawie nie
//     zmienia i musi działać offline — bez niego appka w ogóle nie startuje).
//   • POST/PATCH do Supabase — nie dotykamy, niech przeglądarka zwróci błąd
//     sieciowy; app.js ma własną logikę "pending" + retry po online.

const CACHE = 'notatnik-v48';

const SUPABASE_CDN = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';

const ASSETS = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/manifest.json',
  '/favicon.png',
  '/favicon-32.png',
  '/apple-touch-icon.png',
  '/icon-192.png',
  '/icon-512.png',
  SUPABASE_CDN
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.all(
        ASSETS.map((url) => c.add(url).catch((err) => {
          console.warn('SW precache miss:', url, err);
        }))
      ))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const isSameOrigin = url.origin === self.location.origin;
  const isSupabaseCdn = url.href.startsWith('https://cdn.jsdelivr.net/');

  // Nie cache'uj zapytań do Supabase API (db/auth) — muszą iść na żywo,
  // a offline i tak obsługujemy w app.js przez localStorage + pending.
  if (url.hostname.endsWith('.supabase.co')) return;

  if (isSupabaseCdn) {
    // Cache-first dla biblioteki supabase-js — bez niej nic nie wystartuje offline.
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req).then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        });
      })
    );
    return;
  }

  if (!isSameOrigin) return;

  // Nawigacja (otwarcie appki) — cache-first, żeby PWA odpalała natychmiast
  // nawet gdy WiFi jest podłączone ale bez netu (fetch wtedy wisi długo).
  // Sieć dogania w tle i aktualizuje cache na następne uruchomienie.
  if (req.mode === 'navigate') {
    event.respondWith(
      caches.match(req).then((cached) => {
        const fetchAndUpdate = fetch(req).then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        }).catch(() => cached || caches.match('/index.html'));
        return cached || fetchAndUpdate;
      })
    );
    return;
  }

  // Same-origin (assety): network-first z timeoutem 2.5s, fallback do cache.
  // Bez timeoutu wiszący fetch (sieć "jest" ale bez netu) blokuje appkę.
  event.respondWith(
    new Promise((resolve) => {
      let settled = false;
      const done = (r) => { if (!settled) { settled = true; resolve(r); } };
      const timer = setTimeout(() => {
        caches.match(req).then((cached) => { if (cached) done(cached); });
      }, 2500);
      fetch(req).then((res) => {
        clearTimeout(timer);
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        done(res);
      }).catch(() => {
        clearTimeout(timer);
        caches.match(req).then((cached) => done(cached || caches.match('/index.html')));
      });
    })
  );
});
