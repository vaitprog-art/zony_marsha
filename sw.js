const CACHE = 'zony-marshruta-v2';
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
  const url = new URL(e.request.url);

  // Кэшируем только собственную статику (тот же источник, тот же домен).
  // Запросы к внешним сервисам — Яндекс.Карты, HTTP Геокодер, Turf.js CDN —
  // всегда идут напрямую в сеть, без перехвата и кэширования.
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;

  e.respondWith(
    caches.match(e.request).then((cached) => {
      const network = fetch(e.request)
        .then((resp) => {
          // Клонируем СРАЗУ и синхронно — до того как resp уйдёт браузеру
          // как основной ответ (return resp ниже) и его тело станет
          // "использованным". Раньше clone() вызывался асинхронно внутри
          // caches.open().then(...), уже после этого момента — отсюда была
          // ошибка "Response body is already used".
          if (resp.ok) {
            const respClone = resp.clone();
            caches.open(CACHE).then((c) => c.put(e.request, respClone));
          }
          return resp;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
