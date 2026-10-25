// ─────────────────────────────────────────────────────────────────────────────
// Gig List — Service Worker
// ─────────────────────────────────────────────────────────────────────────────

const CACHE_NAME = 'gig-list-v10';
const APP_BASE   = '/GigList/';
const APP_ROOT   = APP_BASE + 'vault.html';

// Notification clicks may only open the app itself or these hosts (on-sale
// pushes link out to the ticket seller). Anything else falls back to the app.
const ALLOWED_EXTERNAL_HOSTS = ['www.ticketmaster.co.uk', 'www.ticketmaster.com', 'ticketmaster.co.uk', 'ticketmaster.com'];

const ASSETS = [
  './',
  './index.html',
  './vault.html',
  './clashfinder.html',
  './css/style.css',
  './js/app.js',
  './js/modules/achievements.js',
  './js/modules/act-picker.js',
  './js/modules/app-cache.js',
  './js/modules/artist-enrichment.js',
  './js/modules/artist-images.js',
  './js/modules/artist-sync.js',
  './js/modules/band-browser.js',
  './js/modules/band-discography.js',
  './js/modules/band.js',
  './js/modules/buddies.js',
  './js/modules/calendar.js',
  './js/modules/capture.js',
  './js/modules/charts.js',
  './js/modules/clashfinder-sync.js',
  './js/modules/collection-charts.js',
  './js/modules/collection-collage.js',
  './js/modules/collection-editor.js',
  './js/modules/collection-import.js',
  './js/modules/collection.js',
  './js/modules/data.js',
  './js/modules/deep-link.js',
  './js/modules/editor.js',
  './js/modules/feed.js',
  './js/modules/filters.js',
  './js/modules/games.js',
  './js/modules/idb-mailbox.js',
  './js/modules/install-prompt.js',
  './js/modules/mix-playlist.js',
  './js/modules/modal-tips.js',
  './js/modules/notifications.js',
  './js/modules/onboarding.js',
  './js/modules/photo-crop.js',
  './js/modules/profile.js',
  './js/modules/push.js',
  './js/modules/puzzle.js',
  './js/modules/quiz.js',
  './js/modules/setlist-sync.js',
  './js/modules/social.js',
  './js/modules/spotify-auth.js',
  './js/modules/spotify.js',
  './js/modules/stats-share.js',
  './js/modules/stats-switcher.js',
  './js/modules/supabase.js',
  './js/modules/switcher.js',
  './js/modules/tip-dots.js',
  './js/modules/tip-nudges.js',
  './js/modules/tips-hub.js',
  './js/modules/tips-registry.js',
  './js/modules/ui.js',
  './js/modules/utils.js',   // imported directly by index.html (escapeHtml)
  './js/modules/weezer-wednesday.js',
  './js/modules/wishlist.js',
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

// Third-party hosts whose static scripts/styles/fonts are cached too, so the UI
// still renders with no signal. TRIM THIS to what vault.html / index.html
// actually load. Never put API hosts here (Supabase, Workers): data must stay live.
const CACHEABLE_CDN_HOSTS = [
  'cdn.tailwindcss.com',
  'cdn.jsdelivr.net',
  'cdnjs.cloudflare.com',
  'unpkg.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
];

// ─── Install ──────────────────────────────────────────────────────────────────
// Each asset is cached independently, so one 404 no longer aborts the whole
// install (cache.addAll is all-or-nothing).

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.allSettled(ASSETS.map((url) => cache.add(url)))
    )
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

// ─── Fetch ────────────────────────────────────────────────────────────────────
//
// Built for gigs and festivals where signal is patchy or absent, without ever
// mixing old and new versions of the app's code in one page load (an old
// module imported by a new app.js can fail to load and blank the whole app):
//
//   - Pages: network first, but give up after NAV_TIMEOUT_MS and use the cached
//     copy. Whichever way it went is remembered for that page (by client id).
//   - Code/data (.js .css .json .csv) for a page that came from the network:
//     network first (longer timeout), cached copy as the offline fallback.
//   - Code/data for a page that came from the cache: cache only (network only
//     for a file that was never cached), and nothing is written back, so the
//     whole load is the one cached version and the cache never ends up half
//     old, half new.
//   - Images, fonts and the CDN hosts: stale-while-revalidate. Mixing versions
//     of these is harmless.
//   - Pages are cached by path (query string dropped), so vault.html?open=123
//     doesn't create a new entry every time and deep links still open offline.
//   - API traffic (Supabase, Workers, etc.) is never touched.

const NAV_TIMEOUT_MS  = 3000;
const CODE_TIMEOUT_MS = 8000;
const CODE_PATH       = /(?:\/|\.(?:html|js|mjs|css|json|csv))$/i;

// Client ids of pages served from the cache. Lost if the browser stops the
// worker mid-load — those requests then just go network-first, as normal.
const _cachedPageClients = new Set();

function _fetchWithTimeout(req, ms) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  // no-cache: revalidate with the server instead of trusting the HTTP cache
  return fetch(req, { cache: 'no-cache', signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

// Network first; on timeout/offline, the cached copy. Returns { res, fromCache }.
async function networkFirst(event, req, cacheKey, timeoutMs) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const res = await _fetchWithTimeout(req, timeoutMs);
    if (res.ok && res.type === 'basic') {
      event.waitUntil(cache.put(cacheKey, res.clone()).catch(() => {}));
    }
    return { res, fromCache: false };
  } catch {
    const cached = await cache.match(cacheKey, { ignoreSearch: req.mode === 'navigate' });
    return { res: cached || Response.error(), fromCache: !!cached };
  }
}

async function handlePage(event, req, url) {
  const cacheKey = url.origin + url.pathname;
  const { res, fromCache } = await networkFirst(event, req, cacheKey, NAV_TIMEOUT_MS);
  const id = event.resultingClientId;
  if (id) {
    if (fromCache) _cachedPageClients.add(id);
    else _cachedPageClients.delete(id);
    // Keep the set small: drop the oldest entries
    while (_cachedPageClients.size > 20) _cachedPageClients.delete(_cachedPageClients.values().next().value);
  }
  return res;
}

async function handleCode(event, req) {
  if (event.clientId && _cachedPageClients.has(event.clientId)) {
    const cached = await caches.match(req, { cacheName: CACHE_NAME });
    if (cached) return cached;
    try { return await fetch(req); } catch { return Response.error(); }
  }
  return (await networkFirst(event, req, req, CODE_TIMEOUT_MS)).res;
}

async function staleWhileRevalidate(event, req, sameOrigin) {
  const cache  = await caches.open(CACHE_NAME);
  const cached = await cache.match(req);

  const refresh = fetch(req, sameOrigin ? { cache: 'no-cache' } : undefined)
    .then((res) => {
      if (res.ok || res.type === 'opaque') {
        cache.put(req, res.clone()).catch(() => {});   // e.g. 206 partial content can't be cached
      }
      return res;
    })
    .catch(() => null);

  if (cached) {
    event.waitUntil(refresh);   // keep the worker alive until the background update finishes
    return cached;
  }

  return (await refresh) || Response.error();
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url        = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  if (!sameOrigin && !CACHEABLE_CDN_HOSTS.includes(url.hostname)) return;

  if (sameOrigin && req.mode === 'navigate') {
    event.respondWith(handlePage(event, req, url));
  } else if (sameOrigin && CODE_PATH.test(url.pathname)) {
    event.respondWith(handleCode(event, req));
  } else {
    event.respondWith(staleWhileRevalidate(event, req, sameOrigin));
  }
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
//   vault.html?buddyShow=<journalKey>&by=<buddyId>  → a buddy's show (read-only view)
//   vault.html?buddyCollection=<buddyId>            → a buddy's Collection tab
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
  let   parsed;
  try { parsed = new URL(data.url ?? APP_ROOT, self.location.origin); }
  catch { parsed = new URL(APP_ROOT, self.location.origin); }
  const isSameOrigin = parsed.origin === self.location.origin;
  const isAllowedExt = parsed.protocol === 'https:' && ALLOWED_EXTERNAL_HOSTS.includes(parsed.hostname);

  // External link (e.g. tickets on sale): open it directly, even when the app
  // is already open — the warm path below only understands in-app intents.
  if (!isSameOrigin && isAllowedExt) {
    event.waitUntil(clients.openWindow(parsed.href));
    return;
  }

  const targetUrl = isSameOrigin ? parsed.href : new URL(APP_ROOT, self.location.origin).href;
  const params    = new URL(targetUrl).searchParams;
  const journalId = params.get('open') ?? null;
  const isWW      = params.get('ww') === '1';
  let   source    = params.get('source') === 'collection' ? 'collection' : 'journal';

  // Buddy deep links. `intentId` is what the page receives as the intent id:
  // the journal id normally, the journal key for a buddy show, or the buddy's
  // id for a buddy collection. `by` is the buddy who owns the show.
  let intentId = journalId;
  let by       = null;
  const buddyShowKey = params.get('buddyShow');
  const buddyColId   = params.get('buddyCollection');
  const buddyId      = params.get('by');
  if (buddyShowKey && buddyId) {
    source = 'buddy-show'; intentId = buddyShowKey; by = buddyId;
  } else if (buddyColId) {
    source = 'buddy-collection'; intentId = buddyColId;
  }

  console.log('[SW] notificationclick fired');
  console.log('[SW] data.url raw:', data.url);
  console.log('[SW] targetUrl:', targetUrl);
  console.log('[SW] intentId:', intentId, '| isWW:', isWW, '| source:', source, '| by:', by);

  event.waitUntil(
    writePendingDeepLink({ id: intentId, weezerWednesday: isWW, source, by })
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
              journalId:       intentId,
              weezerWednesday: isWW,
              source,
              by,
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
