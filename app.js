/* Passe-Marée — calcul des créneaux de passage selon la marée */
(function () {
"use strict";

/* ---------- réglages de zone ---------- */
const ZONE = {
  port: "Roscoff",
  tideLat: 48.73, tideLon: -3.98,   // point en mer devant Roscoff pour le modèle de marée
  nm: 5.25,                          // niveau moyen au-dessus du zéro hydrographique à Roscoff
  // recalage intégré pour tous : niveau moyen, amplitude et décalage horaire du modèle par rapport au SHOM
  // valeurs calculées le 03/11/2026 sur 7 jours de PM/BM SHOM (coef. 47 à 84)
  cal: { nm: 5.683, scale: 1.0507, shift: 41 },
  center: [48.70, -3.95], zoom: 12
};
const VERSION = "1.9.0";

/* ---------- utilitaires ---------- */
const $ = s => document.querySelector(s);
const pad = n => String(n).padStart(2, "0");
const fmt = (n, d = 2) => (Math.round(n * 10 ** d) / 10 ** d).toFixed(d).replace(".", ",");
const hm = m => { m = Math.round(m); m = ((m % 1440) + 1440) % 1440; return pad(Math.floor(m / 60)) + "h" + pad(m % 60); };
const toMin = s => { const [h, m] = String(s).split(":").map(Number); return h * 60 + m; };
const todayStr = () => { const d = new Date(); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); };
const nowMin = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
const num = v => { const x = parseFloat(String(v).replace(",", ".")); return isFinite(x) ? x : NaN; };
const uid = () => Math.random().toString(36).slice(2, 10);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const dayStart = day => { const [y, m, d] = day.split("-").map(Number); return Date.UTC(y, m - 1, d) / 60000; };
const parseLocal = s => { const [d, t] = s.split("T"); const [y, mo, da] = d.split("-").map(Number); const [h, mi] = t.split(":").map(Number); return Date.UTC(y, mo - 1, da, h, mi) / 60000; };
const dur = m => { m = Math.round(m); return m < 60 ? m + " min" : Math.floor(m / 60) + " h " + pad(m % 60); };

/* ---------- état ---------- */
const KEY = "passemaree.v1", HKEY = "passemaree.harm.v1";
function load(k) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } }
function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { toast("Mémoire du téléphone pleine"); } }
const DEF = { boat: { name: "Mon bateau", draft: 0.9, keel: 0.5 }, points: [], manual: {}, cal: null, layers: { seamark: true, depth: false, iso: true }, view: null };
let S = Object.assign({}, DEF, load(KEY) || {});
S.layers = Object.assign({}, DEF.layers, S.layers || {});
// anciennes versions : réglage stocké à plat ; on ne le garde que s'il a été modifié par l'utilisateur
if ("nm" in S || "scale" in S || "shift" in S) {
  const o = { nm: S.nm ?? 5.25, scale: S.scale ?? 1, shift: S.shift ?? 0 };
  if (!S.cal && (Math.abs(o.nm - 5.25) > 1e-3 || Math.abs(o.scale - 1) > 1e-4 || o.shift)) S.cal = o;
  delete S.nm; delete S.scale; delete S.shift;
}
const C = () => S.cal || ZONE.cal;
// un réglage personnel identique au réglage intégré n'a plus lieu d'être
if (S.cal && Math.abs(S.cal.nm - ZONE.cal.nm) < 0.005 && Math.abs(S.cal.scale - ZONE.cal.scale) < 0.0005 && S.cal.shift === ZONE.cal.shift) S.cal = null;
const persist = () => save(KEY, S);

let day = todayStr(), cur = nowMin(), selId = S.points[0] && S.points[0].id;
let harm = load(HKEY);            // {fittedAt, F}  composantes harmoniques calculées
let P = harm ? Harmo.predictor(harm.F) : null;
let tideState = "idle";           // idle | loading | ok | error

/* ---------- marée automatique : série Open-Meteo -> analyse harmonique -> prédiction sur des mois ---------- */
const ymd = d => d.toISOString().slice(0, 10);
async function fetchTide(force) {
  if (!force && harm && Date.now() - harm.fittedAt < 30 * 864e5) return;
  tideState = "loading"; render();
  const base = "https://marine-api.open-meteo.com/v1/marine?latitude=" + ZONE.tideLat + "&longitude=" + ZONE.tideLon + "&timezone=GMT&hourly=sea_level_height_msl";
  const now = new Date(), back = n => ymd(new Date(now.getTime() - n * 864e5));
  const tries = [
    base + "&start_date=" + back(366) + "&end_date=" + back(1),
    base + "&start_date=" + back(183) + "&end_date=" + back(1),
    base + "&past_days=92&forecast_days=8"
  ];
  for (const url of tries) {
    try {
      const r = await fetch(url);
      if (!r.ok) continue;
      const j = await r.json(), blk = j.hourly;
      if (!blk || !blk.time) continue;
      const t = [], h = [];
      blk.time.forEach((x, i) => { const v = blk.sea_level_height_msl[i]; if (v !== null && isFinite(v)) { t.push(Date.parse(x + ":00Z")); h.push(v); } });
      if (t.length < 14 * 24) continue;
      await new Promise(res => setTimeout(res, 30)); // laisse l'écran se rafraîchir avant le calcul
      const F = Harmo.fit(t, h);
      harm = { fittedAt: Date.now(), F }; P = Harmo.predictor(F); dayCache = {};
      save(HKEY, harm); tideState = "ok"; render(); return;
    } catch (e) { /* réseau indisponible : essai suivant */ }
  }
  tideState = harm ? "ok" : "error"; render();
}
/* niveau prédit (par rapport au niveau moyen) pour un jour local, échantillonné toutes les 5 min de -60 à +1500 min */
let dayCache = {};
function mslDay(d, noShift) {
  if (!P) return null;
  const sh = noShift ? 0 : C().shift, key = d + "|" + sh;
  if (dayCache[key]) return dayCache[key];
  const [y, mo, da] = d.split("-").map(Number), t0 = new Date(y, mo - 1, da, 0, 0, 0).getTime();
  const arr = new Float64Array(313);
  for (let i = 0; i < 313; i++) arr[i] = P(t0 + (i * 5 - 60 - sh) * 60000);
  const keys = Object.keys(dayCache); if (keys.length > 60) delete dayCache[keys[0]];
  return (dayCache[key] = arr);
}
function mslAtDay(arr, m) { const x = (m + 60) / 5, i = Math.max(0, Math.min(311, Math.floor(x))), f = x - i; return arr[i] + (arr[i + 1] - arr[i]) * f; }

/* ---------- marée saisie (SHOM) ---------- */
function manualModel(d) {
  const raw = (S.manual[d] || []).map(e => ({ m: toMin(e.t), h: Number(e.h), k: e.k })).sort((a, b) => a.m - b.m);
  if (raw.length < 2) return null;
  const ex = raw.slice();
  while (ex[0].m > -60) { const a = ex[0], b = ex[1]; ex.unshift({ m: a.m - (b.m - a.m), h: b.h, k: b.k }); }
  while (ex[ex.length - 1].m < 1500) { const y = ex[ex.length - 1], z = ex[ex.length - 2]; ex.push({ m: y.m + (y.m - z.m), h: z.h, k: z.k }); }
  return { raw, fn: m => { for (let i = 0; i < ex.length - 1; i++) { const a = ex[i], b = ex[i + 1]; if (m >= a.m && m <= b.m) { const f = (m - a.m) / (b.m - a.m); return a.h + (b.h - a.h) * (1 - Math.cos(Math.PI * f)) / 2; } } return NaN; } };
}

/* modèle du jour : SHOM saisi en priorité, sinon modèle automatique */
function model(d) {
  const man = manualModel(d);
  if (man) return { src: "shom", fn: man.fn, raw: man.raw, extrapFrom: man.raw[0].m, extrapTo: man.raw[man.raw.length - 1].m };
  const arr = mslDay(d);
  if (arr) {
    const k = C().scale, z = C().nm, fn = m => mslAtDay(arr, m) * k + z, raw = [];
    let prev = fn(-15), c = fn(0);
    for (let m = 0; m <= 1440; m += 5) { const n = fn(m + 5); if (c >= prev && c > n) raw.push({ m, h: c, k: "PM" }); if (c <= prev && c < n) raw.push({ m, h: c, k: "BM" }); prev = c; c = n; }
    return { src: "auto", fn, raw, extrapFrom: 0, extrapTo: 1440 };
  }
  return null;
}
/* compare le modèle aux PM/BM SHOM saisies (tous les jours saisis) :
   décalage horaire moyen, puis amplitude et niveau moyen qui collent le mieux */
function modelExtremes(arr) {
  const out = [];
  for (let i = 1; i < 312; i++) {
    const a = arr[i - 1], b = arr[i], c = arr[i + 1];
    if ((b > a && b >= c) || (b < a && b <= c)) {
      const den = a - 2 * b + c, off = den ? 0.5 * (a - c) / den : 0; // sommet affiné par parabole
      out.push({ m: (i + off) * 5 - 60, k: b > a ? "PM" : "BM" });
    }
  }
  return out;
}
function calibration(d) {
  if (!P || !manualModel(d)) return null;
  const days = Object.keys(S.manual).filter(k => manualModel(k));
  const dts = [], dayDt = [];
  for (const k of days) {
    const ex = modelExtremes(mslDay(k, true));
    for (const e of manualModel(k).raw) {
      let best = null; for (const q of ex) if (q.k === e.k && (!best || Math.abs(q.m - e.m) < Math.abs(best.m - e.m))) best = q;
      if (best && Math.abs(best.m - e.m) <= 180) { dts.push(e.m - best.m); if (k === d) dayDt.push(e.m - best.m); }
    }
  }
  const shift = dts.length ? Math.round(dts.reduce((t, x) => t + x, 0) / dts.length) : C().shift;
  const pts = [];
  for (const k of days) { const a0 = mslDay(k, true); for (const e of manualModel(k).raw) pts.push([mslAtDay(a0, e.m - shift), e.h, e.k]); }
  const n = pts.length, mx = pts.reduce((t, q) => t + q[0], 0) / n, my = pts.reduce((t, q) => t + q[1], 0) / n;
  let sxx = 0, sxy = 0; for (const [x, y] of pts) { sxx += (x - mx) ** 2; sxy += (x - mx) * (y - my); }
  let scale = C().scale;
  if (pts.some(q => q[2] === "PM") && pts.some(q => q[2] === "BM") && sxx > 0.5) scale = Math.min(1.6, Math.max(0.6, sxy / sxx));
  // écart actuel, pour le jour affiché
  const cur0 = mslDay(d); let err = 0;
  for (const e of manualModel(d).raw) err = Math.max(err, Math.abs(e.h - (mslAtDay(cur0, e.m) * C().scale + C().nm)));
  const dt = dayDt.length ? Math.round(dayDt.reduce((t, x) => t + x, 0) / dayDt.length) - C().shift : 0;
  return { err, dt, shift, scale: +scale.toFixed(4), nm: +(my - scale * mx).toFixed(3), days: days.length };
}

/* ---------- calcul de passage ---------- */
const depthOf = p => p.type === "decouvrant" ? -Math.abs(p.value) : Number(p.value);
const need = p => S.boat.draft + S.boat.keel - depthOf(p);
function windows(M, p) {
  const req = need(p), out = []; let st = null;
  for (let m = 0; m <= 1440; m++) { const ok = M.fn(m) >= req; if (ok && st === null) st = m; if (!ok && st !== null) { out.push([st, m]); st = null; } }
  if (st !== null) out.push([st, 1440]);
  return out;
}
function status(M, p) {
  if (!M) return { cls: "warn", txt: "Marée ?", color: "#8a96a0" };
  const margin = M.fn(cur) + depthOf(p) - S.boat.draft - S.boat.keel;
  if (margin >= 0.3) return { cls: "go", txt: "Passe · +" + fmt(margin, 1) + " m", color: "#1d9a56", margin };
  if (margin >= 0) return { cls: "warn", txt: "Juste · +" + fmt(margin, 1) + " m", color: "#d08a12", margin };
  return { cls: "nogo", txt: "Ne passe pas · " + fmt(margin, 1) + " m", color: "#c9402f", margin };
}

/* ---------- carte ---------- */
const map = L.map("map", { zoomControl: false, attributionControl: true, tap: true })
  .setView(S.view ? [S.view.lat, S.view.lon] : ZONE.center, S.view ? S.view.z : ZONE.zoom);
map.attributionControl.setPrefix(false);
map.attributionControl.setPosition("topright");
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(map);
const seamark = L.tileLayer("https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png", { maxZoom: 18, attribution: "© OpenSeaMap" });
const depthLayer = L.tileLayer.wms("https://ows.emodnet-bathymetry.eu/wms", { layers: "emodnet:mean_atlas_land", format: "image/png", transparent: true, opacity: 0.55, attribution: "EMODnet Bathymétrie" });
/* isobathes calculées d'après la grille EMODnet (fichier data/isobathes.geojson, généré sur GitHub) */
let isoLayer = null, isoLabels = L.layerGroup(), isoData = null, isoLbl = [];
const ISO = { 0: ["#2f7d32", 1.6, "5 4"], 2: ["#1565c0", 1.8, ""], 5: ["#1e88e5", 1.4, ""], 10: ["#42a5f5", 1.1, ""], 20: ["#64b5f6", 0.9, ""], 50: ["#90caf9", 0.8, ""] };
async function loadIso() {
  if (isoData) return isoData;
  const r = await fetch("data/isobathes.geojson?v=1"); if (!r.ok) throw new Error("isobathes " + r.status);
  isoData = await r.json();
  for (const f of isoData.features) {
    const g = f.geometry, lines = g.type === "MultiLineString" ? g.coordinates : [g.coordinates];
    for (const l of lines) if (l.length >= 6) for (let i = Math.min(5, l.length >> 1); i < l.length; i += 18) isoLbl.push([l[i][1], l[i][0], Math.abs(f.properties.alt)]);
  }
  return isoData;
}
function updateIsoLabels() {
  isoLabels.clearLayers();
  if (!isoLayer || !map.hasLayer(isoLayer) || map.getZoom() < 13) return;
  const b = map.getBounds(), taken = new Set(); let n = 0;
  for (const [la, lo, d] of isoLbl) {
    if (!b.contains([la, lo])) continue;
    const pt = map.latLngToContainerPoint([la, lo]), cell = Math.floor(pt.x / 70) + ":" + Math.floor(pt.y / 70);
    if (taken.has(cell)) continue; taken.add(cell);
    L.marker([la, lo], { interactive: false, keyboard: false, icon: L.divIcon({ className: "iso-lbl", html: d === 0 ? "0" : String(d), iconSize: [22, 14], iconAnchor: [11, 7] }) }).addTo(isoLabels);
    if (++n >= 80) break;
  }
}
map.on("moveend zoomend", updateIsoLabels);
isoLabels.addTo(map);
let shomLayer = null;
const shomUrl = key => "https://services.data.shom.fr/" + encodeURIComponent(key) + "/wmts?layer=RASTER_MARINE_3857_WMTS&style=normal&tilematrixset=3857&Service=WMTS&Request=GetTile&Version=1.0.0&Format=image%2Fpng&TileMatrix={z}&TileCol={x}&TileRow={y}";
let shomWarned = false;
function shomError() { if (!shomWarned) { shomWarned = true; toast("Carte Shom refusée : vérifie ta clé d'accès"); } }
function applyLayers() {
  if (S.layers.iso) loadIso().then(d => {
    if (!isoLayer) isoLayer = L.geoJSON(d, { interactive: false, renderer: L.canvas({ padding: 0.3 }), attribution: "Isobathes d'après EMODnet Bathymétrie",
      style: f => { const s = ISO[Math.abs(f.properties.alt)] || ISO[50]; return { color: s[0], weight: s[1], dashArray: s[2] || null, opacity: 0.9 }; } });
    if (S.layers.iso) { isoLayer.addTo(map); updateIsoLabels(); }
  }).catch(() => toast("Isobathes indisponibles hors ligne pour l'instant"));
  else if (isoLayer) { map.removeLayer(isoLayer); updateIsoLabels(); }
  if (shomLayer) { map.removeLayer(shomLayer); shomLayer = null; }
  if (S.layers.shom && S.shomKey) { shomLayer = L.tileLayer(shomUrl(S.shomKey), { maxZoom: 18, attribution: "© Shom" }); shomLayer.on("tileerror", shomError); shomLayer.addTo(map); }
  S.layers.seamark ? seamark.addTo(map) : map.removeLayer(seamark);
  S.layers.depth ? depthLayer.addTo(map) : map.removeLayer(depthLayer);
}
applyLayers();
map.on("moveend", () => { const c = map.getCenter(); S.view = { lat: +c.lat.toFixed(5), lon: +c.lng.toFixed(5), z: map.getZoom() }; persist(); });

let tempMarker = null, meMarker = null, probe = null, probeMarker = null;
const markers = {};

/* ---------- consultation d'un point (toucher la carte) ---------- */
let quietUntil = 0; // iOS : le toucher qui ferme une fiche ne doit pas rouvrir un point sur la carte
const quiet = () => { quietUntil = Date.now() + 600; };
map.on("click", e => { if (Date.now() < quietUntil || $(".sheet")) return; showProbe(e.latlng); });
function showProbe(ll) {
  openDrawer(false);
  const id = uid();
  probe = { id, lat: ll.lat, lon: ll.lng, state: "loading" };
  if (probeMarker) map.removeLayer(probeMarker);
  probeMarker = L.circleMarker(ll, { radius: 10, color: "#ffffff", weight: 3, fillColor: "#0d5c7d", fillOpacity: 0.9 }).addTo(map);
  renderProbe();
  lookupDepth(ll.lat, ll.lng).then(d => {
    if (!probe || probe.id !== id) return;
    Object.assign(probe, { state: "ok", depth: d, type: d.shallow >= 0 ? "sonde" : "decouvrant", value: +Math.abs(d.shallow).toFixed(1) });
    renderProbe();
  }).catch(() => { if (probe && probe.id === id) { probe.state = "err"; renderProbe(); } });
}
function closeProbe() { quiet(); probe = null; if (probeMarker) { map.removeLayer(probeMarker); probeMarker = null; } renderProbe(); }
function renderProbe() {
  const el = $("#probe");
  if (!probe || !$("#drawer").classList.contains("closed")) { el.hidden = true; return; }
  el.hidden = false;
  const M = model(day);
  let body = "";
  if (probe.state === "loading") body = '<div class="meta">Recherche de la sonde…</div>';
  else if (probe.state === "err") body = '<div class="meta">Sonde automatique indisponible (pas de réseau ou serveur EMODnet).</div><div class="actions"><button class="btn ghost small" id="pbRetry">Réessayer</button><button class="btn primary small" id="pbManual">Saisir la sonde</button></div>';
  else {
    const st = status(M, probe);
    const sonde = probe.type === "decouvrant" ? "Découvrant estimé " + fmt(probe.value, 1) + " m" : "Sonde estimée " + fmt(probe.value, 1) + " m";
    let wt = "", tr = "";
    if (M) {
      const ws = windows(M, probe);
      wt = !ws.length ? "Aucun créneau ce jour avec ton bateau." : (ws.length === 1 && ws[0][0] === 0 && ws[0][1] === 1440) ? "<strong>Passe toute la journée</strong>" :
        ws.map(w => '<strong class="num">' + (w[0] === 0 ? "00h00" : hm(w[0])) + " → " + (w[1] === 1440 ? "24h00" : hm(w[1])) + "</strong>").join(" · ");
      tr = '<div class="track">' + ws.map(w => '<span style="left:' + (w[0] / 14.4) + "%;width:" + ((w[1] - w[0]) / 14.4) + '%"></span>').join("") + '<b style="left:calc(' + (cur / 14.4) + '% - 1px)"></b></div>';
    }
    body = '<div class="card-top"><div class="t"><div class="meta num">' + sonde + ' · EMODnet</div></div><span class="pill ' + st.cls + '">' + st.txt + "</span></div>" +
      '<div class="wins">' + wt + "</div>" + tr +
      '<div class="actions"><button class="btn ghost small" id="pbFix">Corriger la sonde</button><button class="btn primary small" id="pbSave">Enregistrer</button></div>';
  }
  $("#pbWhere").textContent = dms(probe.lat, "N", "S") + " · " + dms(probe.lon, "E", "W") + " · à " + hm(cur);
  $("#pbBody").innerHTML = body;
}
/* un seul écouteur, posé une fois : les boutons de la fiche marchent même quand son contenu est redessiné */
(function () {
  const el = $("#probe");
  let handled = 0;
  const act = e => {
    const t = e.target.closest("button"); if (!t || !probe) return;
    if (e.type === "touchend") { e.preventDefault(); handled = Date.now(); } else if (Date.now() - handled < 700) return;
    e.stopPropagation();
    const ll = { lat: probe.lat, lng: probe.lon };
    if (t.id === "pbClose") closeProbe();
    else if (t.id === "pbRetry") showProbe(ll);
    else if (t.id === "pbManual") pointSheet(null, ll, null);
    else if (t.id === "pbFix" || t.id === "pbSave") pointSheet(null, ll, probe);
  };
  el.addEventListener("touchend", act, { passive: false });
  el.addEventListener("click", act);
  // glisser la fiche vers le bas la ferme aussi
  let y0 = null;
  el.addEventListener("touchstart", e => { y0 = e.target.closest("button") ? null : e.touches[0].clientY; }, { passive: true });
  el.addEventListener("touchmove", e => { if (y0 !== null && e.touches[0].clientY - y0 > 50) { y0 = null; closeProbe(); } }, { passive: true });
})();

function drawMarkers(M) {
  const seen = {};
  for (const p of S.points) {
    if (p.lat == null) continue;
    seen[p.id] = 1;
    const st = status(M, p), sel = p.id === selId;
    const icon = L.divIcon({ className: "", html: '<div class="pm-marker' + (sel ? " sel" : "") + '" style="background:' + st.color + '"></div>', iconSize: sel ? [28, 28] : [22, 22], iconAnchor: sel ? [14, 14] : [11, 11] });
    if (!markers[p.id]) {
      markers[p.id] = L.marker([p.lat, p.lon], { icon, keyboard: true, title: p.name }).addTo(map)
        .bindTooltip(esc(p.name), { permanent: true, direction: "right", offset: [12, 0], className: "pm-label" })
        .on("click", () => { selId = p.id; openDrawer(true); render(); const c = document.querySelector('[data-id="' + p.id + '"]'); c && c.scrollIntoView({ block: "nearest", behavior: "smooth" }); });
    } else {
      markers[p.id].setLatLng([p.lat, p.lon]).setIcon(icon);
      markers[p.id].setTooltipContent(esc(p.name));
    }
  }
  for (const id in markers) if (!seen[id]) { map.removeLayer(markers[id]); delete markers[id]; }
}

$("#locate").onclick = () => {
  if (!navigator.geolocation) { toast("Localisation indisponible"); return; }
  navigator.geolocation.getCurrentPosition(pos => {
    const ll = [pos.coords.latitude, pos.coords.longitude];
    if (meMarker) map.removeLayer(meMarker);
    meMarker = L.circleMarker(ll, { radius: 8, color: "#fff", weight: 3, fillColor: "#2a7fff", fillOpacity: 1 }).addTo(map);
    map.setView(ll, Math.max(map.getZoom(), 14));
  }, () => toast("Position refusée ou introuvable"), { enableHighAccuracy: true, timeout: 15000 });
};

/* ---------- sonde EMODnet ---------- */
async function lookupDepth(lat, lon) {
  const url = "https://rest.emodnet-bathymetry.eu/depth_sample?geom=" + encodeURIComponent("POINT(" + lon.toFixed(5) + " " + lat.toFixed(5) + ")");
  const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 12000);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) throw new Error("http " + r.status);
    const j = await r.json();
    // EMODnet renvoie une altitude : négative sous le zéro (eau), positive au-dessus (découvrant ou terre)
    const avg = j.avg, hi = j.max;
    if (avg == null || !isFinite(avg)) throw new Error("vide");
    const safe = (hi != null && isFinite(hi)) ? Math.max(hi, avg) : avg;
    return { avg: -avg, shallow: -safe, hasMax: hi != null && isFinite(hi) };
  } finally { clearTimeout(to); }
}

/* ---------- rendu ---------- */
function render() {
  const M = model(day);
  $("#slider").value = cur; $("#clock").textContent = hm(cur); $("#day").value = day;
  $("#nowBtn").classList.toggle("on", day === todayStr() && Math.abs(cur - nowMin()) < 5);
  $("#boatLine").textContent = (S.boat.name || "Mon bateau") + " · TE " + fmt(S.boat.draft, 2) + " m · pied " + fmt(S.boat.keel, 2) + " m";
  if (M) {
    const h = M.fn(cur), h2 = M.fn(cur + 10);
    $("#hNow").textContent = fmt(h, 2) + " m";
    $("#trend").textContent = h2 > h ? "↑ montante" : "↓ descendante";
  } else { $("#hNow").textContent = "–"; $("#trend").textContent = ""; }
  const tag = $("#srcTag");
  if (M && M.src === "shom") tag.textContent = "SHOM saisi";
  else if (M) tag.textContent = "Prédiction · " + ZONE.port;
  else tag.textContent = tideState === "loading" ? "Calcul de la marée…" : "Pas de marée";
  // bandeau
  let b = "";
  const cal = calibration(day);
  if (!M && tideState === "loading") b = '<div class="banner">Première analyse de la marée en cours (une année de données à télécharger)…</div>';
  else if (!M) b = '<div class="banner">Marée automatique indisponible (pas de réseau ?). Saisis les PM/BM du SHOM pour ce jour, ou réessaie plus tard.</div>';
  else if (cal !== null) {
    const same = Math.abs(cal.nm - C().nm) < 0.02 && Math.abs(cal.scale - C().scale) < 0.01 && Math.abs(cal.shift - C().shift) < 3;
    const gap = (Math.abs(cal.dt) >= 5 ? "<b>" + (cal.dt > 0 ? "+" : "−") + Math.abs(cal.dt) + " min</b> " : "") + (cal.err >= 0.08 ? (Math.abs(cal.dt) >= 5 ? "et " : "") + "<b>" + fmt(cal.err, 2) + " m</b> " : "");
    if (gap && !same) b = '<div class="banner">Le modèle est décalé de ' + gap + 'par rapport aux PM/BM SHOM saisies. <button class="link" id="recal">Recaler le modèle</button></div>';
    else if (gap) b = '<div class="banner">Après recalage, il reste ' + gap + 'd\'écart ce jour-là. Pour ce jour, ce sont tes PM/BM SHOM qui sont utilisées.</div>';
  }
  $("#tideBanner").innerHTML = b;
  const rc = $("#recal"); if (rc) rc.onclick = () => { S.cal = { nm: cal.nm, scale: cal.scale, shift: cal.shift }; dayCache = {}; persist(); render(); toast("Modèle recalé sur le SHOM (" + cal.days + " jour" + (cal.days > 1 ? "s" : "") + " saisi" + (cal.days > 1 ? "s" : "") + ")"); };
  drawCurve(M); drawCards(M); drawMarkers(M); renderProbe();
}

function drawCurve(M) {
  const svg = $("#svg"), W = 360, H = 180, L0 = 28, R = 6, T = 10, B = 22, pw = W - L0 - R, ph = H - T - B;
  if (!M) { svg.innerHTML = '<text x="180" y="90" text-anchor="middle" font-size="13" fill="var(--muted)">Aucune marée pour ce jour</text>'; svg._m = null; return; }
  const sel = S.points.find(p => p.id === selId);
  let top = 0, lo = 0; for (let m = 0; m <= 1440; m += 10) top = Math.max(top, M.fn(m));
  const req = sel ? need(sel) : null; if (req !== null) { top = Math.max(top, req); lo = Math.min(0, Math.floor(req)); }
  top = Math.ceil(top + 0.5);
  const x = m => L0 + pw * m / 1440, y = h => T + ph * (1 - (h - lo) / (top - lo));
  let g = "";
  for (let v = lo; v <= top; v += 2) g += '<line x1="' + L0 + '" x2="' + (W - R) + '" y1="' + y(v) + '" y2="' + y(v) + '" stroke="var(--line)"/><text x="' + (L0 - 4) + '" y="' + (y(v) + 4) + '" text-anchor="end" font-size="10" fill="var(--muted)">' + v + '</text>';
  for (let hh = 0; hh <= 24; hh += 3) g += '<line x1="' + x(hh * 60) + '" x2="' + x(hh * 60) + '" y1="' + T + '" y2="' + (H - B) + '" stroke="var(--line)" stroke-width="' + (hh % 6 ? .5 : 1) + '"/><text x="' + x(hh * 60) + '" y="' + (H - 7) + '" text-anchor="' + (hh === 24 ? "end" : hh === 0 ? "start" : "middle") + '" font-size="10" fill="var(--muted)">' + hh + 'h</text>';
  if (sel) for (const [a, b] of windows(M, sel)) g += '<rect x="' + x(a) + '" y="' + T + '" width="' + (x(b) - x(a)) + '" height="' + ph + '" fill="var(--go)" opacity=".14"/>';
  let area = "M" + x(0) + "," + y(lo), line = "";
  for (let m = 0; m <= 1440; m += 5) { const p = x(m).toFixed(1) + "," + y(M.fn(m)).toFixed(1); area += " L" + p; line += (line ? " L" : "M") + p; }
  area += " L" + x(1440) + "," + y(lo) + " Z";
  g += '<path d="' + area + '" fill="var(--water)" opacity=".45"/><path d="' + line + '" fill="none" stroke="var(--accent)" stroke-width="2.4"' + (M.src === "shom" ? "" : "") + '/>';
  if (sel) g += '<line x1="' + L0 + '" x2="' + (W - R) + '" y1="' + y(req) + '" y2="' + y(req) + '" stroke="var(--warn)" stroke-width="2" stroke-dasharray="6 3"/>';
  const anc = xx => xx > W - 34 ? "end" : xx < L0 + 30 ? "start" : "middle";
  for (const e of M.raw) { const ly = e.k === "PM" ? y(e.h) - 6 : y(e.h) + 14; g += '<text x="' + x(e.m) + '" y="' + ly + '" text-anchor="' + anc(x(e.m)) + '" font-size="10" font-weight="700" fill="var(--ink)">' + e.k + " " + hm(e.m) + '</text>'; }
  const hc = M.fn(cur);
  g += '<line x1="' + x(cur) + '" x2="' + x(cur) + '" y1="' + T + '" y2="' + (H - B) + '" stroke="var(--ink)" stroke-width="1.5"/><circle cx="' + x(cur) + '" cy="' + y(hc) + '" r="5" fill="var(--surface)" stroke="var(--ink)" stroke-width="2"/>';
  svg.innerHTML = g; svg._m = { L0, pw };
}

function drawCards(M) {
  const c = $("#cards");
  if (!S.points.length) { c.innerHTML = '<div class="empty">Aucun passage enregistré. Touche un endroit de la carte : la sonde est récupérée et tu vois tout de suite si ça passe. Tu peux ensuite l\'enregistrer.</div>'; return; }
  let html = "";
  for (const p of S.points) {
    const st = status(M, p);
    const sonde = p.type === "decouvrant" ? "Découvrant " + fmt(Math.abs(p.value), 1) + " m" : "Sonde " + fmt(p.value, 1) + " m";
    let wt = '<span class="meta">Marée inconnue pour ce jour.</span>', tr = "";
    if (M) {
      const ws = windows(M, p);
      if (!ws.length) wt = "Aucun créneau ce jour avec ce bateau.";
      else if (ws.length === 1 && ws[0][0] === 0 && ws[0][1] === 1440) wt = "<strong>Passe toute la journée</strong>";
      else wt = ws.map(w => '<strong class="num">' + (w[0] === 0 ? "00h00" : hm(w[0])) + " → " + (w[1] === 1440 ? "24h00" : hm(w[1])) + "</strong>").join(" · ");
      if (st.margin < 0) { const nx = ws.find(w => w[0] > cur); if (nx) wt += '<div class="meta">Prochain créneau dans ' + dur(nx[0] - cur) + "</div>"; }
      else { const iw = ws.find(w => w[0] <= cur && w[1] >= cur); if (iw && iw[1] < 1440) wt += '<div class="meta">Il te reste ' + dur(iw[1] - cur) + " pour passer</div>"; }
      tr = '<div class="track">' + ws.map(w => '<span style="left:' + (w[0] / 14.4) + "%;width:" + ((w[1] - w[0]) / 14.4) + '%"></span>').join("") + '<b style="left:calc(' + (cur / 14.4) + '% - 1px)"></b></div>';
    }
    html += '<article class="card' + (p.id === selId ? " sel" : "") + '" data-id="' + p.id + '"><div class="card-top"><div class="t"><h3>' + esc(p.name) + '</h3><div class="meta num">' + sonde + (p.src === "emodnet" ? " · EMODnet" : " · carte") + (p.note ? " · " + esc(p.note) : "") + '</div></div><span class="pill ' + st.cls + '">' + st.txt + '</span></div><div class="wins">' + wt + "</div>" + tr +
      '<div class="row-actions">' + (p.lat != null ? '<button class="btn ghost small" data-go="' + p.id + '">Voir</button>' : "") + '<button class="btn ghost small" data-edit="' + p.id + '">Modifier</button></div></article>';
  }
  c.innerHTML = html;
}

/* ---------- tiroir ---------- */
function openDrawer(open) { $("#drawer").classList.toggle("closed", !open); if (!open) $(".more").scrollTop = 0; renderProbe(); }
/* glisser le tiroir vers le bas pour le fermer, vers le haut pour l'ouvrir */
(function () {
  const dr = $("#drawer"), more = $(".more");
  let y0 = null, dy = 0, active = false;
  dr.addEventListener("touchstart", e => {
    y0 = null; dy = 0; active = false;
    if (e.target.closest('input[type=range], svg, input, select, .probe')) return;
    if (e.target.closest(".more") && more.scrollTop > 0) return;
    y0 = e.touches[0].clientY;
  }, { passive: true });
  dr.addEventListener("touchmove", e => {
    if (y0 === null) return;
    dy = e.touches[0].clientY - y0;
    const closed = dr.classList.contains("closed");
    if (!closed && dy > 8 && (!e.target.closest(".more") || more.scrollTop <= 0)) {
      active = true; e.preventDefault(); dr.style.transition = "none"; dr.style.transform = "translateY(" + dy + "px)";
    } else if (closed && dy < -8) active = true;
  }, { passive: false });
  const end = () => {
    if (y0 === null) return;
    dr.style.transition = ""; dr.style.transform = "";
    const closed = dr.classList.contains("closed");
    if (active && !closed && dy > 60) openDrawer(false);
    else if (active && closed && dy < -30) openDrawer(true);
    y0 = null; active = false;
  };
  dr.addEventListener("touchend", end); dr.addEventListener("touchcancel", end);
})();
$("#handle").onclick = () => openDrawer($("#drawer").classList.contains("closed"));
$("#slider").addEventListener("input", e => { cur = +e.target.value; render(); });
$("#nowBtn").onclick = () => { day = todayStr(); cur = nowMin(); render(); };
$("#day").addEventListener("change", e => { if (e.target.value) { day = e.target.value; render(); } });
const shiftDay = n => { const [y, m, d] = day.split("-").map(Number), x = new Date(y, m - 1, d + n); day = x.getFullYear() + "-" + pad(x.getMonth() + 1) + "-" + pad(x.getDate()); render(); };
$("#prevDay").onclick = () => shiftDay(-1); $("#nextDay").onclick = () => shiftDay(1);
$("#addBtn2").onclick = () => { openDrawer(false); toast("Touche la carte à l'endroit du passage"); };
$("#tideBtn").onclick = tideSheet;
$("#settings").onclick = settingsSheet;
$("#layers").onclick = layersSheet;
$("#cards").addEventListener("click", e => {
  const ed = e.target.closest("[data-edit]"); if (ed) { pointSheet(S.points.find(p => p.id === ed.dataset.edit)); return; }
  const go = e.target.closest("[data-go]"); if (go) { const p = S.points.find(q => q.id === go.dataset.go); selId = p.id; openDrawer(false); map.setView([p.lat, p.lon], Math.max(map.getZoom(), 15)); render(); return; }
  const c = e.target.closest(".card"); if (c) { selId = c.dataset.id; render(); }
});
(function () {
  const svg = $("#svg"); let down = false;
  const mv = e => { const m = svg._m; if (!m) return; const r = svg.getBoundingClientRect(); const px = (e.clientX - r.left) * 360 / r.width; cur = Math.max(0, Math.min(1439, Math.round((px - m.L0) / m.pw * 1440 / 5) * 5)); render(); };
  svg.addEventListener("pointerdown", e => { down = true; svg.setPointerCapture(e.pointerId); mv(e); });
  svg.addEventListener("pointermove", e => { if (down) mv(e); });
  svg.addEventListener("pointerup", () => down = false); svg.addEventListener("pointercancel", () => down = false);
})();

/* ---------- feuilles ---------- */
function openSheet(html, mount) {
  $("#layer").innerHTML = '<div class="scrim" id="scrim"></div><div class="sheet" role="dialog" aria-modal="true">' + html + "</div>";
  $("#scrim").onclick = closeSheet; mount && mount($(".sheet"));
}
function closeSheet() { quiet(); $("#layer").innerHTML = ""; if (tempMarker) { map.removeLayer(tempMarker); tempMarker = null; } }

function pointSheet(p, latlng, preset) {
  const isNew = !p;
  p = p ? Object.assign({}, p) : { id: uid(), name: "", type: preset ? preset.type : "sonde", value: preset ? preset.value : "", note: "", lat: latlng.lat, lon: latlng.lng, src: preset ? "emodnet" : "manuel" };
  openSheet('<h2>' + (isNew ? "Nouveau passage" : "Modifier le passage") + '</h2>' +
    (p.lat != null ? '<div class="meta num">' + dms(p.lat, "N", "S") + " · " + dms(p.lon, "E", "W") + "</div>" : "") +
    '<div class="depthbox" id="dbox"></div>' +
    '<label class="f">Nom<input class="in" id="pName" maxlength="60" value="' + esc(p.name) + '" placeholder="Ex. passe de la Penzé"></label>' +
    '<div class="seg"><button data-t="sonde">Sonde (sous le zéro)</button><button data-t="decouvrant">Découvrant</button></div>' +
    '<label class="f"><span id="vLab"></span><input class="in num" id="pVal" inputmode="decimal" value="' + (p.value === "" ? "" : fmt(p.value, 1)) + '"><span class="h">Tu peux corriger avec la valeur lue sur ta carte.</span></label>' +
    '<label class="f">Note <span class="h">facultatif</span><input class="in" id="pNote" maxlength="80" value="' + esc(p.note || "") + '"></label>' +
    '<div class="err" id="pErr" hidden></div>' +
    '<div class="actions"><button class="btn ghost" id="pCancel">Annuler</button><button class="btn primary" id="pSave">Enregistrer</button></div>' +
    (isNew ? "" : '<div id="delZone"><button class="btn danger" id="pDel" style="width:100%">Supprimer ce passage</button></div>'),
  sh => {
    let type = p.type;
    const setT = t => { type = t; sh.querySelectorAll(".seg button").forEach(b => b.classList.toggle("on", b.dataset.t === t)); $("#vLab").textContent = t === "sonde" ? "Sonde (m)" : "Hauteur du découvrant (m)"; };
    sh.querySelectorAll(".seg button").forEach(b => b.onclick = () => setT(b.dataset.t)); setT(type);
    const box = $("#dbox");
    const runLookup = () => {
      if (p.lat == null) { box.hidden = true; return; }
      box.innerHTML = "Recherche de la sonde EMODnet…";
      lookupDepth(p.lat, p.lon).then(d => {
        const v = d.shallow;
        box.innerHTML = (v >= 0 ? "Sonde estimée <b>" + fmt(v, 1) + " m</b>" : "Découvrant estimé <b>" + fmt(-v, 1) + " m</b>") +
          '<div class="meta">EMODnet, maille d\'environ 115 m. ' + (d.hasMax ? "Profondeur moyenne " + fmt(d.avg, 1) + " m ; on retient le point le plus haut de la maille, par sécurité." : "Profondeur moyenne de la maille.") + " Vérifie avec ta carte près des roches.</div>" +
          (isNew ? "" : '<button class="link" id="useD">Utiliser cette valeur</button>');
        const apply = () => { setT(v >= 0 ? "sonde" : "decouvrant"); $("#pVal").value = fmt(Math.abs(v), 1); p.src = "emodnet"; };
        if (isNew) apply(); else { const u = $("#useD"); if (u) u.onclick = apply; }
      }).catch(() => { box.innerHTML = 'Sonde automatique indisponible (pas de réseau ou serveur EMODnet). Saisis la sonde lue sur ta carte. <button class="link" id="retry">Réessayer</button>'; $("#retry").onclick = runLookup; });
    };
    if (preset && preset.depth) { const d = preset.depth; box.innerHTML = (d.shallow >= 0 ? "Sonde estimée <b>" + fmt(d.shallow, 1) + " m</b>" : "Découvrant estimé <b>" + fmt(-d.shallow, 1) + " m</b>") + '<div class="meta">EMODnet, maille d\'environ 115 m. Corrige avec ta carte si besoin.</div>'; }
    else if (preset === null) box.innerHTML = "Saisis la sonde lue sur ta carte.";
    else runLookup();
    $("#pVal").addEventListener("input", () => { p.src = "manuel"; });
    $("#pCancel").onclick = closeSheet;
    $("#pSave").onclick = () => {
      const name = $("#pName").value.trim() || "Passage " + (S.points.length + 1), v = num($("#pVal").value), er = $("#pErr");
      if (!isFinite(v) || v < 0 || v > 300) { er.textContent = "Entre la sonde en mètres, par exemple 1,2."; er.hidden = false; return; }
      const np = { id: p.id, name, type, value: v, note: $("#pNote").value.trim(), lat: p.lat, lon: p.lon, src: p.src };
      const i = S.points.findIndex(x => x.id === p.id); if (i >= 0) S.points[i] = np; else S.points.push(np);
      selId = np.id; persist(); if (probe) closeProbe(); closeSheet(); openDrawer(true); render(); toast(isNew ? "Passage enregistré" : "Passage modifié");
    };
    const del = $("#pDel");
    if (del) del.onclick = () => {
      $("#delZone").innerHTML = '<p class="note">Supprimer « ' + esc(p.name) + ' » ?</p><div class="actions"><button class="btn ghost" id="dNo">Garder</button><button class="btn danger" id="dYes">Supprimer</button></div>';
      $("#dNo").onclick = closeSheet; $("#dYes").onclick = () => { S.points = S.points.filter(x => x.id !== p.id); persist(); closeSheet(); render(); toast("Passage supprimé"); };
    };
  });
}
function dms(v, pos, neg) { const s = v >= 0 ? pos : neg; v = Math.abs(v); const d = Math.floor(v), m = (v - d) * 60; return d + "°" + fmt(m, 3).padStart(6, "0") + "′" + s; }

function tideSheet() {
  let rows = (S.manual[day] || []).map(e => Object.assign({}, e));
  if (!rows.length) rows = [{ k: "BM", t: "", h: "" }, { k: "PM", t: "", h: "" }, { k: "BM", t: "", h: "" }, { k: "PM", t: "", h: "" }];
  const dl = new Date(day + "T12:00:00").toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
  openSheet('<h2>Marées SHOM du ' + dl + '</h2><p class="note">Port : ' + ZONE.port + ". Recopie heures et hauteurs depuis maree.shom.fr. Elles remplacent le modèle automatique pour ce jour et servent à le recaler.</p>" +
    '<div id="tRows" style="display:flex;flex-direction:column;gap:6px"></div><button class="btn ghost" id="tAdd">+ Ajouter une marée</button><button class="link" id="tPaste" style="align-self:flex-start">Coller plusieurs jours d\'un coup…</button><div class="err" id="tErr" hidden></div>' +
    '<div class="actions"><button class="btn ghost" id="tCancel">Annuler</button><button class="btn primary" id="tSave">Enregistrer</button></div>' +
    (S.manual[day] ? '<button class="link" id="tClear" style="color:var(--nogo);align-self:flex-start">Effacer et revenir au modèle automatique</button>' : ""),
  () => {
    const draw = () => { $("#tRows").innerHTML = rows.map((r, i) => '<div class="tiderow"><select class="in" data-i="' + i + '" data-f="k" aria-label="Type"><option' + (r.k === "PM" ? " selected" : "") + '>PM</option><option' + (r.k === "BM" ? " selected" : "") + '>BM</option></select><input class="in num" type="time" data-i="' + i + '" data-f="t" value="' + (r.t || "") + '" aria-label="Heure"><input class="in num" inputmode="decimal" data-i="' + i + '" data-f="h" value="' + (r.h === "" ? "" : fmt(r.h, 2)) + '" placeholder="m" aria-label="Hauteur"><button class="x" data-del="' + i + '" aria-label="Retirer">×</button></div>').join(""); };
    draw();
    const upd = e => { const i = e.target.dataset.i; if (i !== undefined) rows[i][e.target.dataset.f] = e.target.value; };
    $("#tRows").addEventListener("input", upd); $("#tRows").addEventListener("change", upd);
    $("#tRows").addEventListener("click", e => { const i = e.target.dataset.del; if (i !== undefined) { rows.splice(+i, 1); draw(); } });
    $("#tPaste").onclick = pasteSheet;
    $("#tAdd").onclick = () => { const l = rows[rows.length - 1]; rows.push({ k: l && l.k === "PM" ? "BM" : "PM", t: "", h: "" }); draw(); };
    $("#tCancel").onclick = closeSheet;
    const clr = $("#tClear"); if (clr) clr.onclick = () => { delete S.manual[day]; persist(); closeSheet(); render(); toast("Retour au modèle automatique"); };
    $("#tSave").onclick = () => {
      const er = $("#tErr"), clean = rows.filter(r => r.t || r.h !== "").map(r => ({ k: r.k, t: r.t, h: num(r.h) })).sort((a, b) => toMin(a.t) - toMin(b.t));
      const fail = m => { er.textContent = m; er.hidden = false; };
      if (clean.length < 2) return fail("Il faut au moins une PM et une BM.");
      const bad = clean.find(r => !/^\d\d:\d\d$/.test(r.t) || !isFinite(r.h) || r.h < -2 || r.h > 16);
      if (bad) return fail(!/^\d\d:\d\d$/.test(bad.t) ? "Il manque l'heure d'une " + bad.k + "." : "Il manque la hauteur (en mètres) de la " + bad.k + " de " + bad.t.replace(":", "h") + ". Complète-la ou retire la ligne avec ×.");
      for (let i = 1; i < clean.length; i++) {
        if (clean[i].k === clean[i - 1].k) return fail("Les PM et BM doivent alterner (ligne de " + clean[i].t.replace(":", "h") + ").");
        if ((clean[i].k === "PM") !== (clean[i].h > clean[i - 1].h)) return fail("Une PM doit être plus haute que la BM voisine (ligne de " + clean[i].t.replace(":", "h") + ").");
      }
      S.manual[day] = clean;
      const lim = new Date(); lim.setDate(lim.getDate() - 60);
      for (const k of Object.keys(S.manual)) if (new Date(k) < lim) delete S.manual[k];
      persist(); closeSheet(); render(); toast("Marées enregistrées");
    };
  });
}

/* coller plusieurs jours : une marée par ligne, ex. « 2026-11-03 PM 12:55 7,30 » */
function parseTides(txt) {
  const days = {}, bad = [];
  for (const line of txt.split(/\n/)) {
    const l = line.trim(); if (!l) continue;
    const m = l.match(/(\d{4})-(\d{2})-(\d{2})\D+(PM|BM)\D+(\d{1,2})[:h](\d{2})\D+(\d{1,2}[.,]\d{1,2})/i);
    if (!m) { bad.push(l); continue; }
    const d = m[1] + "-" + m[2] + "-" + m[3];
    (days[d] = days[d] || []).push({ k: m[4].toUpperCase(), t: pad(+m[5]) + ":" + m[6], h: num(m[7]) });
  }
  for (const d in days) days[d].sort((a, b) => toMin(a.t) - toMin(b.t));
  return { days, bad };
}
function pasteSheet() {
  openSheet('<h2>Coller des marées SHOM</h2><p class="note">Une marée par ligne : date, PM ou BM, heure, hauteur. Exemple : <span class="num">2026-11-03 PM 12:55 7,30</span></p>' +
    '<textarea class="in num" id="pTxt" rows="10" style="font-size:15px;min-height:200px" placeholder="2026-11-03 PM 00:26 7,02"></textarea>' +
    '<div class="err" id="pErr2" hidden></div><div class="actions"><button class="btn ghost" id="pCan">Annuler</button><button class="btn primary" id="pOk">Importer et recaler</button></div>', () => {
      $("#pCan").onclick = closeSheet;
      $("#pOk").onclick = () => {
        const { days, bad } = parseTides($("#pTxt").value), er = $("#pErr2"), list = Object.keys(days).sort();
        const fail = m => { er.textContent = m; er.hidden = false; };
        if (bad.length) return fail("Ligne non comprise : « " + bad[0] + " »");
        if (!list.length) return fail("Aucune marée trouvée.");
        for (const d of list) { const r = days[d]; for (let i = 1; i < r.length; i++) if (r[i].k === r[i - 1].k) return fail("Le " + d + ", les PM et BM ne se suivent pas (" + r[i].t + ")."); }
        for (const d of list) S.manual[d] = days[d];
        let msg = list.length + " jour" + (list.length > 1 ? "s" : "") + " importé" + (list.length > 1 ? "s" : "");
        const cal = calibration(list[0]);
        if (cal) { S.cal = { nm: cal.nm, scale: cal.scale, shift: cal.shift }; dayCache = {}; msg += ", modèle recalé (" + (cal.shift >= 0 ? "+" : "−") + Math.abs(cal.shift) + " min)"; }
        else msg += ". Recalage dès que la prédiction sera calculée";
        persist(); closeSheet(); render(); toast(msg);
      };
    });
}

function layersSheet() {
  openSheet('<h2>Couches de la carte</h2>' +
    '<label class="f" style="flex-direction:row;align-items:center;gap:10px"><input type="checkbox" id="lSea"' + (S.layers.seamark ? " checked" : "") + ' style="width:22px;height:22px"> Balisage OpenSeaMap <span class="h">bouées, feux, épaves, roches</span></label>' +
    '<label class="f" style="flex-direction:row;align-items:center;gap:10px"><input type="checkbox" id="lIso"' + (S.layers.iso ? " checked" : "") + ' style="width:22px;height:22px"> Lignes de profondeur <span class="h">0, 2, 5, 10, 20 et 50 m sous le zéro des cartes</span></label>' +
    '<div class="note" style="display:flex;flex-wrap:wrap;gap:4px 12px"><span><i style="display:inline-block;width:18px;border-top:2px dashed #2f7d32;vertical-align:middle"></i> 0 m (limite qui découvre)</span><span><i style="display:inline-block;width:18px;border-top:2px solid #1565c0;vertical-align:middle"></i> 2 m</span><span><i style="display:inline-block;width:18px;border-top:2px solid #1e88e5;vertical-align:middle"></i> 5 m</span><span><i style="display:inline-block;width:18px;border-top:2px solid #64b5f6;vertical-align:middle"></i> 10 à 50 m</span></div>' +
    '<p class="note">Calculées d\'après la grille EMODnet (maille d\'environ 115 m) : tracé lissé, une tête de roche isolée peut ne pas apparaître.</p>' +
    '<label class="f" style="flex-direction:row;align-items:center;gap:10px"><input type="checkbox" id="lDep"' + (S.layers.depth ? " checked" : "") + ' style="width:22px;height:22px"> Teinte des profondeurs EMODnet <span class="h">plus foncé = plus profond</span></label>' +
    '<label class="f" style="flex-direction:row;align-items:center;gap:10px"><input type="checkbox" id="lShom"' + (S.layers.shom ? " checked" : "") + (S.shomKey ? "" : " disabled") + ' style="width:22px;height:22px"> Carte marine Shom <span class="h">' + (S.shomKey ? "avec ta clé d\'accès Shom" : "nécessite une clé d\'accès Shom, à saisir dans ⚙ Réglages") + '</span></label>' +
    '<p class="note">Le fond OpenStreetMap n\'est pas une carte marine officielle : garde ta carte SHOM pour la navigation.</p>' +
    '<button class="btn primary" id="lOk">Fermer</button>', () => {
      $("#lSea").onchange = e => { S.layers.seamark = e.target.checked; applyLayers(); persist(); };
      $("#lDep").onchange = e => { S.layers.depth = e.target.checked; applyLayers(); persist(); };
      $("#lIso").onchange = e => { S.layers.iso = e.target.checked; applyLayers(); persist(); };
      $("#lShom").onchange = e => { S.layers.shom = e.target.checked; shomWarned = false; applyLayers(); persist(); };
      $("#lOk").onclick = closeSheet;
    });
}

function settingsSheet() {
  const b = S.boat;
  openSheet('<h2>Réglages <span class="meta">v' + VERSION + '</span></h2>' +
    '<label class="f">Nom du bateau<input class="in" id="bName" maxlength="50" value="' + esc(b.name) + '"></label>' +
    '<div class="row2"><label class="f">Tirant d\'eau (m)<input class="in num" id="bDraft" inputmode="decimal" value="' + fmt(b.draft, 2) + '"></label><label class="f">Pied de pilote (m)<input class="in num" id="bKeel" inputmode="decimal" value="' + fmt(b.keel, 2) + '"></label></div>' +
    '<p class="note">Tirant d\'eau : fiche constructeur, ou mesure du point le plus bas (quille, embase moteur baissée) sous la flottaison, bateau chargé. Pied de pilote : 0,3 m sur sable par mer calme, 0,5 à 1 m sur roches ou avec houle.</p>' +
    '<label class="f">Niveau moyen à ' + ZONE.port + ' (m) <span class="h">Hauteur du niveau moyen au-dessus du zéro des cartes. Réglé d\'origine dans l\'appli ; « Recaler le modèle » l\'affine avec tes PM/BM SHOM.</span><input class="in num" id="bNm" inputmode="decimal" value="' + fmt(C().nm, 2) + '"></label>' +
    '<p class="note num">Recalage ' + (S.cal ? "personnel" : "intégré") + ' : niveau ' + C().nm.toFixed(3) + ' m, amplitude ×' + C().scale.toFixed(4) + ', décalage ' + (C().shift >= 0 ? "+" : "−") + Math.abs(C().shift) + ' min.' + (S.cal ? ' <button class="link" id="calReset">Revenir au réglage intégré</button>' : "") + '</p>' +
    '<p class="note">' + (harm ? "Prédiction calculée sur " + harm.F.days + " jours de données (" + harm.F.cons.length + " composantes, écart résiduel " + Math.round(harm.F.rms * 100) + " cm), mise à jour le " + new Date(harm.fittedAt).toLocaleDateString("fr-FR") + "." : "Prédiction pas encore calculée.") + '</p>' +
    '<label class="f">Clé d\'accès Shom <span class="h">Facultatif. Pour afficher les cartes marines raster du Shom, il faut une clé délivrée par le Shom pour ce site.</span><input class="in" id="bShom" autocomplete="off" autocapitalize="off" spellcheck="false" value="' + esc(S.shomKey || "") + '"></label>' +
    '<div class="err" id="bErr" hidden></div>' +
    '<div class="actions"><button class="btn ghost" id="bCancel">Annuler</button><button class="btn primary" id="bSave">Enregistrer</button></div>' +
    '<hr style="border:0;border-top:1px solid var(--line);width:100%">' +
    '<div class="actions"><button class="btn ghost small" id="reTide">Recharger les marées</button><button class="btn ghost small" id="exp">Sauvegarder mes données</button><label class="btn ghost small" style="display:grid;place-items:center">Restaurer<input type="file" id="imp" accept="application/json,.json" hidden></label></div>' +
    '<p class="note">Version ' + VERSION + '. Données : marée Open-Meteo (modèle), sondes EMODnet Bathymétrie, fond © OpenStreetMap, balisage © OpenSeaMap. Tes points restent sur ce téléphone.</p>',
  () => {
    $("#bCancel").onclick = closeSheet;
    $("#bSave").onclick = () => {
      const d = num($("#bDraft").value), k = num($("#bKeel").value), nm = num($("#bNm").value);
      if (!(d > 0 && d < 10) || !(k >= 0 && k < 5) || !(nm > 0 && nm < 10)) { $("#bErr").textContent = "Vérifie les valeurs, en mètres (ex. 0,9 et 0,5)."; $("#bErr").hidden = false; return; }
      S.boat = { name: $("#bName").value.trim() || "Mon bateau", draft: d, keel: k };
      if (Math.abs(nm - C().nm) >= 0.005) { S.cal = Object.assign({}, C(), { nm }); dayCache = {}; }
      const key = $("#bShom").value.trim(); if (key !== (S.shomKey || "")) { S.shomKey = key; S.layers.shom = !!key; shomWarned = false; applyLayers(); } persist(); closeSheet(); render(); toast("Réglages enregistrés");
    };
    const cr = $("#calReset"); if (cr) cr.onclick = () => { S.cal = null; dayCache = {}; persist(); closeSheet(); render(); toast("Réglage intégré rétabli"); };
    $("#reTide").onclick = () => { closeSheet(); fetchTide(true); };
    $("#exp").onclick = () => {
      const blob = new Blob([JSON.stringify(S, null, 1)], { type: "application/json" });
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "passe-maree-" + todayStr() + ".json";
      document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    };
    $("#imp").onchange = e => {
      const f = e.target.files[0]; if (!f) return;
      f.text().then(t => { const v = JSON.parse(t); if (!v || !Array.isArray(v.points) || !v.boat) throw 0; S = Object.assign({}, DEF, v); persist(); closeSheet(); render(); toast("Données restaurées"); })
        .catch(() => toast("Fichier non reconnu"));
    };
  });
}

let tt; function toast(m) { clearTimeout(tt); let t = $(".toast"); if (!t) { t = document.createElement("div"); t.className = "toast"; t.setAttribute("role", "status"); document.body.appendChild(t); } t.textContent = m; tt = setTimeout(() => t.remove(), 2000); }

/* ---------- erreurs visibles (pour les signaler) ---------- */
function showError(msg) {
  let b = $("#errBar");
  if (!b) { b = document.createElement("div"); b.id = "errBar"; b.className = "errbar"; document.body.appendChild(b); b.onclick = () => b.remove(); }
  b.textContent = "Erreur v" + VERSION + " : " + msg + " (touche pour fermer)";
}
window.addEventListener("error", e => showError((e.message || "inconnue") + (e.lineno ? " l." + e.lineno : "")));
window.addEventListener("unhandledrejection", e => showError(String(e.reason && e.reason.message || e.reason)));

/* ---------- démarrage ---------- */
render();
fetchTide(false);
if (!S.points.length) openDrawer(true);
setInterval(() => { if ($("#nowBtn").classList.contains("on") && !$(".sheet")) { cur = nowMin(); render(); } }, 60000);
window.addEventListener("resize", () => renderProbe());
document.addEventListener("visibilitychange", () => { if (!document.hidden) fetchTide(false); });
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
})();
