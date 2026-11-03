/* Passe-Marée — analyse et prédiction harmonique de la marée
   À partir d'une série de hauteurs (une année idéalement), on calcule les composantes
   (M2, S2, K1, O1…) avec leurs corrections nodales, puis on prédit la marée à n'importe quelle date. */
(function (root) {
"use strict";
const RAD = Math.PI / 180;
const norm = x => ((x % 360) + 360) % 360;
// vitesses (°/h) des arguments de Doodson : tau, s, h, p, N', p'
const RATE = [14.4920521, 0.5490165, 0.0410686, 0.0046418, 0.0022064, 0.0000020];

// nom, nombres de Doodson [tau,s,h,p,N',p'], phase (°), type de correction nodale
const CONS = [
  ["M2", [2, 0, 0, 0, 0, 0], 0, "M2"],
  ["S2", [2, 2, -2, 0, 0, 0], 0, ""],
  ["K1", [1, 1, 0, 0, 0, 0], 90, "K1"],
  ["O1", [1, -1, 0, 0, 0, 0], -90, "O1"],
  ["N2", [2, -1, 0, 1, 0, 0], 0, "M2"],
  ["M4", [4, 0, 0, 0, 0, 0], 0, "M2^2"],
  ["MS4", [4, 2, -2, 0, 0, 0], 0, "M2"],
  ["K2", [2, 2, 0, 0, 0, 0], 0, "K2"],
  ["P1", [1, 1, -2, 0, 0, 0], -90, ""],
  ["Q1", [1, -2, 0, 1, 0, 0], -90, "O1"],
  ["MN4", [4, -1, 0, 1, 0, 0], 0, "M2^2"],
  ["L2", [2, 1, 0, -1, 0, 0], 180, "M2"],
  ["MU2", [2, -2, 2, 0, 0, 0], 0, "M2"],
  ["2N2", [2, -2, 0, 2, 0, 0], 0, "M2"],
  ["NU2", [2, -1, 2, -1, 0, 0], 0, "M2"],
  ["T2", [2, 2, -3, 0, 0, 1], 0, ""],
  ["M6", [6, 0, 0, 0, 0, 0], 0, "M2^3"],
  ["2MS6", [6, 2, -2, 0, 0, 0], 0, "M2^2"],
  ["MSN6", [6, 1, 0, 1, 0, 0], 0, "M2^2"],
  ["Ssa", [0, 0, 2, 0, 0, 0], 0, ""],
  ["Sa", [0, 0, 1, 0, 0, 0], 0, ""]
];
// composantes déduites quand la série est trop courte pour les séparer (rapport d'amplitude, même phase)
const INFER = { K2: ["S2", 0.27], P1: ["K1", 0.33], T2: ["S2", 0.06], NU2: ["N2", 0.19], "2N2": ["N2", 0.13], MU2: ["N2", 0.15] };
const speed = d => d.reduce((t, k, i) => t + k * RATE[i], 0); // °/h

function astro(ms) {
  const D = (ms - Date.UTC(2000, 0, 1, 12)) / 864e5, T = D / 36525;
  const s = 218.3164477 + 481267.88123421 * T, h = 280.46646 + 36000.76983 * T, p = 83.3532465 + 4069.0137287 * T;
  const N = 125.04452 - 1934.136261 * T, p1 = 282.94 + 1.7192 * T;
  const ut = ((ms % 864e5) + 864e5) % 864e5 / 3600e3;
  const tau = 180 + 15 * ut + h - s;
  return { arg: [tau, s, h, p, -N, p1], N: norm(N) * RAD };
}
function nodal(kind, N) {
  const c1 = Math.cos(N), c2 = Math.cos(2 * N), c3 = Math.cos(3 * N), s1 = Math.sin(N), s2 = Math.sin(2 * N), s3 = Math.sin(3 * N);
  const M2 = [1.0004 - 0.0373 * c1 + 0.0002 * c2, -2.14 * s1];
  switch (kind) {
    case "M2": return M2;
    case "M2^2": return [M2[0] ** 2, 2 * M2[1]];
    case "M2^3": return [M2[0] ** 3, 3 * M2[1]];
    case "K1": return [1.006 + 0.115 * c1 - 0.0088 * c2 + 0.0006 * c3, -8.86 * s1 + 0.68 * s2 - 0.07 * s3];
    case "O1": return [1.0089 + 0.1871 * c1 - 0.0147 * c2 + 0.0014 * c3, 10.8 * s1 - 1.34 * s2 + 0.19 * s3];
    case "K2": return [1.0241 + 0.2863 * c1 + 0.0083 * c2 - 0.0015 * c3, -17.74 * s1 + 0.68 * s2 - 0.04 * s3];
    default: return [1, 0];
  }
}
// terme (f·cos(V+u), f·sin(V+u)) d'une composante à un instant
function term(c, A) {
  let V = c[2]; for (let i = 0; i < 6; i++) V += c[1][i] * A.arg[i];
  const [f, u] = nodal(c[3], A.N);
  const x = (V + u) * RAD;
  return [f * Math.cos(x), f * Math.sin(x)];
}
const byName = n => CONS.find(c => c[0] === n);

/* choix des composantes séparables avec la durée disponible (critère de Rayleigh) */
function choose(days) {
  const kept = [];
  for (const c of CONS) {
    const w = speed(c[1]) * 24 / 360; // cycles par jour
    if (c[0] === "Sa" && days < 360) continue;
    if (c[0] === "Ssa" && days < 180) continue;
    if (kept.every(k => Math.abs(w - speed(k[1]) * 24 / 360) * days >= 1)) kept.push(c);
  }
  return kept;
}

/* moindres carrés : z0 + Σ (a·fcos + b·fsin) */
function fit(times, heights) {
  const days = (times[times.length - 1] - times[0]) / 864e5;
  const kept = choose(days), names = kept.map(c => c[0]);
  const inferred = Object.keys(INFER).filter(n => !names.includes(n) && names.includes(INFER[n][0]));
  const nU = 1 + 2 * kept.length, ATA = Array.from({ length: nU }, () => new Float64Array(nU)), ATy = new Float64Array(nU);
  const row = new Float64Array(nU);
  for (let k = 0; k < times.length; k++) {
    const A = astro(times[k]); row.fill(0); row[0] = 1;
    kept.forEach((c, i) => { const [x, y] = term(c, A); row[1 + 2 * i] = x; row[2 + 2 * i] = y; });
    for (const n of inferred) { const [ref, r] = INFER[n], i = names.indexOf(ref), [x, y] = term(byName(n), A); row[1 + 2 * i] += r * x; row[2 + 2 * i] += r * y; }
    const yk = heights[k];
    for (let i = 0; i < nU; i++) { if (!row[i]) continue; ATy[i] += row[i] * yk; for (let j = i; j < nU; j++) ATA[i][j] += row[i] * row[j]; }
  }
  for (let i = 0; i < nU; i++) for (let j = 0; j < i; j++) ATA[i][j] = ATA[j][i];
  const x = solve(ATA, ATy);
  const res = { z0: x[0], days: Math.round(days), cons: kept.map((c, i) => [c[0], x[1 + 2 * i], x[2 + 2 * i]]), inferred };
  // écart-type résiduel
  let ss = 0; const step = Math.max(1, Math.floor(times.length / 2000)), P = predictor(res); let n = 0;
  for (let k = 0; k < times.length; k += step) { const d = heights[k] - P(times[k]); ss += d * d; n++; }
  res.rms = Math.sqrt(ss / n);
  return res;
}
function solve(M, b) {
  const n = b.length, A = M.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    const d = A[c][c] || 1e-12;
    for (let r = 0; r < n; r++) { if (r === c) continue; const k = A[r][c] / d; if (!k) continue; for (let j = c; j <= n; j++) A[r][j] -= k * A[c][j]; }
  }
  return A.map((r, i) => r[n] / (r[i] || 1e-12));
}

/* fonction de prédiction : temps UTC (ms) → niveau par rapport au niveau moyen (m) */
function predictor(F) {
  const list = F.cons.map(([n, a, b]) => [byName(n), a, b]);
  for (const n of F.inferred || []) { const [ref, r] = INFER[n], c = F.cons.find(q => q[0] === ref); if (c) list.push([byName(n), r * c[1], r * c[2]]); }
  return ms => { const A = astro(ms); let h = F.z0; for (const [c, a, b] of list) { const [x, y] = term(c, A); h += a * x + b * y; } return h; };
}
const amplitudes = F => F.cons.map(([n, a, b]) => [n, Math.hypot(a, b)]).sort((p, q) => q[1] - p[1]);

root.Harmo = { fit, predictor, amplitudes, astro, CONS };
})(typeof window !== "undefined" ? window : globalThis);
