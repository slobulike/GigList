// ─────────────────────────────────────────────────────────────────────────────
// Gig List — Service Worker
// ─────────────────────────────────────────────────────────────────────────────

const CACHE_NAME = 'gig-list-v4';
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

// ─── Deep-link mailbox (IndexedDB) ─────────────────────────────────────────────
//
// Both iOS (WebKit) and Android have documented bugs where a notificationclick
// handler's openWindow()/navigate()/focus()+postMessage() doesn't reliably
// deliver the deep-link target to the page that actually loads:
//   - WebKit bug 263687: clients.openWindow(url) on an installed Home Screen
//     PWA can open the app to its root URL instead of the URL given.
//   - Android: a backgrounded tab's renderer can be evicted for memory while
//     its WindowClient reference is still matched by matchAll(), so focus()
//     reloads the tab to its *last* URL and any postMessage sent to it is
//     dropped.
//
// IndexedDB is shared between this worker and every page on the same origin
// regardless of which URL loads, so we stash the intent here first as a
// fallback the app checks on every boot — see modules/idb-mailbox.js and
// deep-link.js (PATH C).

const DEEPLINK_DB_NAME = 'giglist-deeplink';
const DEEPLINK_STORE   = 'pending';

function _openDeepLinkDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DEEPLINK_DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(DEEPLINK_STORE)) {
        req.result.createObjectStore(DEEPLINK_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function writePendingDeepLink(intent) {
  const db = await _openDeepLinkDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DEEPLINK_STORE, 'readwrite');
    tx.objectStore(DEEPLINK_STORE).put({ ...intent, ts: Date.now() }, 'pending');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

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
//   1. Always write the intent to the IndexedDB mailbox FIRST, before doing
//      anything else — this is the part that actually survives iOS/Android
//      ignoring the URL or dropping postMessage. See notes above.
//   2. Warm (app already open) → focus existing window + postMessage the
//      intent. deep-link.js's PATH B picks this up when it works; PATH C
//      (mailbox) is the fallback when it doesn't.
//   3. Cold (app closed) → openWindow with the full URL. deep-link.js reads
//      ?open= and ?ww= params on load, or falls back to the mailbox.

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
    writePendingDeepLink({ id: journalId, weezerWednesday: isWW, source })
      .then(() => console.log('[SW] wrote pending deep link to IndexedDB mailbox'))
      .catch((err) => console.warn('[SW] writePendingDeepLink failed', err))
      .then(() => clients.matchAll({ type: 'window', includeUncontrolled: true }))
      .then((windowClients) => {
        console.log('[SW] windowClients found:', windowClients.length);
        windowClients.forEach((c, i) => console.log(`[SW]   client[${i}]:`, c.url));

        const appClient = windowClients.find(c =>
          c.url.includes(self.location.origin + APP_BASE)
        );
        console.log('[SW] appClient matched:', !!appClient, appClient?.url ?? 'none');

        if (appClient) {
          console.log('[SW] warm path — focusing and sending postMessage to client');
          return appClient.focus().then(() => {
            // postMessage to the specific client is more reliable than
            // BroadcastChannel, which requires the listener to already be
            // registered at the moment the message is sent. client.postMessage()
            // is delivered to the window's message queue regardless of whether
            // the navigator.serviceWorker listener is attached yet.
            //
            // NOTE: on mobile this can still silently fail if the client's
            // renderer was evicted while backgrounded — that's exactly what
            // the IndexedDB mailbox write above is a fallback for.
            appClient.postMessage({
              type:            'GIGLIST_DEEP_LINK',
              journalId,
              weezerWednesday: isWW,
              source,
            });
            console.log('[SW] postMessage sent to client');
          });
        }

        // ── Cold: no app window — open one with URL params as fallback ───────
        console.log('[SW] cold path — calling openWindow:', targetUrl);
        return clients.openWindow(targetUrl);
      })
  );
});