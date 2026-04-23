const CACHE_NAME = 'gig-list-v1';
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
  './assets/badge-72.png'
];


// Install Service Worker
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS);
    })
  );
});


// Fetch logic: Try network, fall back to cache
self.addEventListener('fetch', (event) => {
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        return response;
      })
      .catch(() => {
        return caches.match(event.request);
      })
  );
});

// ─── Push Notifications ───────────────────────────────────────────────────────

self.addEventListener('push', (event) => {
  if (!event.data) return;

  const data = event.data.json();
  const { title, body, url, tag, icon } = data;

  // Quiet hours: 10pm–8am local time
  const hour = new Date().getHours();
  if (hour >= 22 || hour < 8) return;

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag: tag || 'giglist',
      icon: icon || '/GigList/assets/icon-192.png',
      badge: '/GigList/assets/badge-72.png',
      data: { url: url || '/GigList/' },
      vibrate: [100, 50, 100],
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const url = event.notification.data?.url || '/GigList/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          client.focus();
          return client.navigate(url);
        }
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});