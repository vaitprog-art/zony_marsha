const CACHE = 'zony-marshruta-v1';
const ASSETS = [
  './index.html',
  './app.js',
  './boundaries.js',
  './manifest.webmanifest',
  './icon.png',
  './zones.html',
  './zones.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  // Роутинг (OSRM) всегда идёт в сеть, статику отдаём из кэша с фоновым обновлением
  if (e.request.method !== 'GET' || e.request.url.includes('router.project-osrm.org')) return;
  e.respondWith(
    caches.match(e.request).then((cached) => {
      const network = fetch(e.request)
        .then((resp) => {
          caches.open(CACHE).then((c) => c.put(e.request, resp.clone()));
          return resp;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
