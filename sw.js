// Network first, so a new plan shows as soon as there's signal; the last copy is used offline.
const CACHE = "helloclaude-v37";
const SHELL = ["./", "index.html", "app.js", "style.css", "manifest.webmanifest?v=fullscreen", "icon-192.png?v=orange", "icon-512.png?v=orange"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  // the app's own files skip the browser cache (Pages serves them with a 10-minute max-age)
  const own = new URL(e.request.url).origin === self.location.origin;
  e.respondWith((own ? fetch(e.request.url, { cache: "no-cache" }) : fetch(e.request)).then(res => {
    if (res.ok || res.type === "opaque") { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
    return res;
  }).catch(() => caches.match(e.request).then(r => r || Promise.reject(new Error("offline")))));
});
