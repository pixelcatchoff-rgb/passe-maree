/* Passe-Marée — fonctionnement hors ligne */
const SHELL = "pm-shell-1.0.0";
const TILES = "pm-tiles-1";
const MAX_TILES = 3000;
const FILES = ["./", "index.html", "app.js", "manifest.webmanifest", "vendor/leaflet.js", "vendor/leaflet.css",
  "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== SHELL && k !== TILES).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

async function trimTiles() {
  const c = await caches.open(TILES), keys = await c.keys();
  for (let i = 0; i < keys.length - MAX_TILES; i++) await c.delete(keys[i]);
}

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;

  // Tuiles de carte : cache d'abord, pour garder les zones déjà vues en mer sans réseau
  if (/tile\.openstreetmap\.org|tiles\.openseamap\.org/.test(url.host)) {
    e.respondWith(caches.open(TILES).then(async c => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      try {
        const r = await fetch(e.request);
        if (r.ok || r.type === "opaque") { c.put(e.request, r.clone()); trimTiles(); }
        return r;
      } catch (err) { return hit || Response.error(); }
    }));
    return;
  }

  // Fichiers de l'appli : réseau d'abord (mises à jour), cache si hors ligne
  if (url.origin === self.location.origin) {
    e.respondWith(fetch(e.request).then(r => {
      if (r.ok) { const cp = r.clone(); caches.open(SHELL).then(c => c.put(e.request, cp)); }
      return r;
    }).catch(() => caches.match(e.request).then(h => h || caches.match("index.html"))));
  }
  // Marée et sondes : réseau direct, l'appli garde sa propre copie
});
