const CACHE_NAME = "hitblow-match-v24";
const STATIC_ASSETS = [
  "/",
  "/index.html",
  "/styles.css",
  "/styles.css?v=22",
  "/app.js",
  "/app.js?v=21",
  "/viewport.js",
  "/viewport.js?v=21",
  "/ghost-setup.js",
  "/ghost-setup.js?v=21",
  "/site.webmanifest",
  "/site.webmanifest?v=22",
  "/assets/ghost-sprites.png",
  "/assets/ghost-game-32.png",
  "/assets/ghost-game-180.png",
  "/assets/ghost-game-192.png",
  "/assets/ghost-game-512.png",
  "/assets/ghost-game-maskable-512.png",
  "/assets/icon-192.png",
  "/assets/icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (request.method !== "GET" || url.origin !== location.origin || url.pathname === "/health" || url.pathname === "/commentator" || url.pathname.startsWith("/commentator/")) {
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put("/index.html", copy));
          return response;
        })
        .catch(() => caches.match("/index.html"))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request))
  );
});
