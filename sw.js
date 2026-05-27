// ─────────────────────────────────────────────────────────────────────────────
// Gig List — Service Worker
// ─────────────────────────────────────────────────────────────────────────────

const CACHE_NAME = 'gig-list-v2';
const APP_BASE   = '/GigList/';
const APP_ROOT   = APP_BASE + 'vault.html';

const ASSETS = [
  './',
  './index.html',
  './vault.html',
  './clashfinder.html',
  './css/style.css',
  './js/app.js',
  './js/modules/clashfinder-sync.js',
  './js/modules/supabase.js',
  './manifest.json',
  './data/users.csv',
  './data/venues.csv',
  './data/performances.csv',
  './assets/icon-192.png',
  './assets/icon-512.png',
  './assets/badge-72.png',
];

// ─── Install ──────────────────────────────────────────────────────────────────

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

// ─── Activate ─────────────────────────────────────────────────────────────────

self.addEventListener('activate', (event) => {
  // Purge old cache versions so stale assets don't linger
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      )
    ).then(() => clients.claim())
  );
});

// ─── Fetch: network-first, cache fallback ─────────────────────────────────────
//
// Strategy:
//   - Always try the network first.
//   - On failure (offline), serve from cache if available.
//   - Cross-origin requests (CDN, Supabase API) are never cached — let them
//     fail naturally so the app's offline fallback logic can handle it.

self.addEventListener('fetch', (event) => {
  // Only handle same-origin GET requests
  if (event.request.method !== 'GET') return;
  if (!event.request.url.startsWith(self.location.origin)) return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Opportunistically update the cache for precached assets
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

// ─── Push display ─────────────────────────────────────────────────────────────

self.addEventListener('push', (event) => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    // DevTools "Test push" sends a plain string — handle gracefully
    payload = { title: 'Gig List', body: event.data.text() };
  }

  // Quiet hours disabled for development — re-enable before shipping:
  // const hour = new Date().getHours();
  // if (hour >= 22 || hour < 8) return;

  const { title = 'Gig List', body = 'New update available', icon, badge, tag, data = {} } = payload;

  // Normalise the deep-link URL:
  // If the push supplies data.url directly, use it.
  // If it only supplies data.journalId (legacy fallback), build the url here.
  // If neither, default to the app root.
  if (!data.url && data.journalId) {
    data.url = `${APP_ROOT}?open=${encodeURIComponent(data.journalId)}`;
  }
  if (!data.url) {
    data.url = APP_ROOT;
  }

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag:    tag    ?? 'giglist',
      icon:   icon   ?? './assets/icon-192.png',
      badge:  badge  ?? './assets/badge-72.png',
      data,
      vibrate: [100, 50, 100],
    })
  );
});

// ─── Notification click — deep-link routing ───────────────────────────────────
//
// URL convention for data.url (set by giglist-push Cloudflare Worker):
//   vault.html                           → open / focus the app
//   vault.html?open=<journalId>          → open a specific gig modal
//   vault.html?open=<journalId>&ww=1     → open gig + Weezer Wednesday canvas
//
// Strategy:
//   Warm (app already open) → focus existing window + BroadcastChannel the intent.
//     deep-link.js picks this up and calls openGigModal() at the right moment.
//   Cold (app closed)       → openWindow with the full URL.
//     deep-link.js reads ?open= and ?ww= params on load instead.

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const data      = event.notification.data ?? {};
  const targetUrl = new URL(data.url ?? APP_ROOT, self.location.origin).href;
  const params    = new URL(targetUrl).searchParams;
  const journalId = params.get('open') ?? null;
  const isWW      = params.get('ww') === '1';
  const source    = params.get('source') === 'collection' ? 'collection' : 'journal';

  console.log('[SW] notificationclick fired');
  console.log('[SW] data.url raw:', data.url);
  console.log('[SW] targetUrl:', targetUrl);
  console.log('[SW] journalId:', journalId, '| isWW:', isWW, '| source:', source);

  event.waitUntil(
    clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((windowClients) => {
        console.log('[SW] windowClients found:', windowClients.length);
        windowClients.forEach((c, i) => console.log(`[SW]   client[${i}]:`, c.url));

        const appClient = windowClients.find(c =>
          c.url.includes(self.location.origin + APP_BASE)
        );
        console.log('[SW] appClient matched:', !!appClient, appClient?.url ?? 'none');

        if (appClient) {
          console.log('[SW] warm path — focusing and sending BroadcastChannel message');
          return appClient.focus().then(() => {
            const bc = new BroadcastChannel('giglist-deep-link');
            bc.postMessage({
              type:            'GIGLIST_DEEP_LINK',
              journalId,
              weezerWednesday: isWW,
              source,
            });
            bc.close();
            console.log('[SW] BroadcastChannel message sent');
          });
        }

        // ── Cold: no app window — open one with URL params as fallback ───────
        console.log('[SW] cold path — calling openWindow:', targetUrl);
        return clients.openWindow(targetUrl);
      })
  );
});