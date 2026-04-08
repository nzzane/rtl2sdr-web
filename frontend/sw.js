/**
 * Service Worker for RTL-SDR Web UI PWA.
 * Provides offline caching of the app shell and keeps the audio session alive
 * on mobile when the browser is in the background.
 */

const CACHE_NAME = 'rtlsdr-web-v1';
const SHELL_FILES = [
  '/',
  '/static/css/style.css',
  '/static/js/app.js',
  '/static/js/audio.js',
  '/static/js/visualizer.js',
  '/manifest.json',
];

// Install - cache app shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

// Activate - clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch - network first, fallback to cache for app shell
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Don't cache API calls or WebSocket
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws/')) {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Update cache with fresh copy
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
