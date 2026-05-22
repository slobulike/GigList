// ─────────────────────────────────────────────────────────────────────────────
// Gig List — Service Worker
// ─────────────────────────────────────────────────────────────────────────────

const CACHE_NAME = 'gig-list-v1';
const APP_BASE   = '/GigList/';
const APP_ROOT   = APP_BASE + 'vault.html';

const ASSETS = [
  './',
  './index.html',
  './vault.html',
  './css/style.css',
  './js/app.js',
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
  event.waitUntil(clients.claim());
});

// ─── Fetch: network-first, cache fallback ─────────────────────────────────────

self.addEventListener('fetch', (event) => {
  event.respondWith(
    fetch(event.request)
      .then((response) => response)
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
//   Warm (app already open) → focus existing window + postMessage the intent.
//     deep-link.js picks this up and calls openGigModal() at the right moment.
//   Cold (app closed)       → openWindow with the full URL.
//     deep-link.js reads ?open= and ?ww= params on load instead.

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const data       = event.notification.data ?? {};
  const targetUrl  = new URL(data.url ?? APP_ROOT, self.location.origin).href;
  const params     = new URL(targetUrl).searchParams;
  const journalId  = params.get('open') ?? null;
  const isWW       = params.get('ww') === '1';

  event.waitUntil(
    clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((windowClients) => {

        // ── Warm: existing app window found ──────────────────────────────────
        const appClient = windowClients.find(c =>
          c.url.includes(self.location.origin + APP_BASE)
        );

        if (appClient) {
          return appClient.focus().then((focused) => {
            // Tell deep-link.js what to open — no reload needed
            focused.postMessage({
              type:            'GIGLIST_DEEP_LINK',
              journalId,
              weezerWednesday: isWW,
            });
          });
        }

        // ── Cold: no app window — open one with URL params as fallback ───────
        return clients.openWindow(targetUrl);
      })
  );
});