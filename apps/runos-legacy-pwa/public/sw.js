const CACHE_NAME = "runos-legacy-pwa-static-v1";
const STATIC_ASSETS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./sw.js",
  "./icons/icon.svg"
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
      .then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith("runos-legacy-pwa-static-") && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  const scopePath = new URL("./", self.location.href).pathname;
  if (!url.pathname.startsWith(scopePath)) return;

  const relativePath = url.pathname.slice(scopePath.length);
  const isStaticAsset = [
    "",
    "index.html",
    "manifest.webmanifest",
    "sw.js",
    "icons/icon.svg"
  ].includes(relativePath);

  if (!isStaticAsset) return;

  // Cache Storage is only for the static PWA shell.
  // RunOS user data remains in the app's existing localStorage flow.
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
