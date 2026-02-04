const CACHE_NAME = 'gig-list-v1';
// Add every file you want to work offline
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
  './assets/icon-512.png'
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
    fetch(event.request).catch(() => {
      return caches.match(event.request);
    })
  );
});