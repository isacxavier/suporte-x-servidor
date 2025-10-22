// SW minimalista: não cacheia HTML/JS; busca sempre da rede.
// (Se você já tinha SW, este substitui o comportamento.)
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const dest = req.destination; // 'document' | 'script' | 'style' | 'image' | ...
  if (dest === 'document' || dest === 'script') {
    event.respondWith(fetch(req, { cache: 'no-store' }));
    return;
  }
  // default: passa reto (deixa o navegador decidir)
  event.respondWith(fetch(req));
});
