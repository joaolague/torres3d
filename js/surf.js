// Surf index v0: a transparent, uncalibrated heuristic on the same 0-5 scale as the
// field log (Diário do Mar), so the two can be compared directly during calibration.
//
// Inputs are the offshore partitions and the 10 m wind of one forecast hour.
//   breaker height  Komar & Gaughan (1972): Hb = 0.39 g^0.2 (T H0^2)^0.4, with each
//                   partition's energy reduced by cos(angle to the beach normal)
//   size            Hb mapped to a beach-break preference curve
//   period          longer period = more organised, more powerful waves
//   direction       swell angle relative to the beach normal
//   wind            glassy / offshore / cross / onshore, by speed
//   clean           share of energy in the local wind sea
// Score = 5 · size · (0.4 + 0.6·period) · (0.4 + 0.6·direction) · wind · clean.
// The curves are first guesses to be fitted against observations.

const G = 9.81;
const DEG = Math.PI / 180;

// Beach normal (direction the beach faces, i.e. where swell ideally comes FROM).
// One value for the Torres beach breaks until SWAN gives per-peak values.
export const BEACH_NORMAL = 122;

const SIZE = [[0, 0], [0.4, 0], [0.8, 0.6], [1.2, 0.9], [1.6, 1], [2.5, 1], [3.2, 0.7], [4.5, 0.35], [6, 0.2]];
const PERIOD = [[4, 0], [5, 0.1], [7, 0.4], [9, 0.7], [11, 0.9], [13, 1]];
const DIRECTION = [[0, 1], [30, 1], [50, 0.75], [70, 0.45], [90, 0.2], [180, 0]];

export const LABELS = ['Flat', 'Ruim', 'Regular', 'Bom', 'Muito bom', 'Excelente'];

function interp(table, x) {
  if (x <= table[0][0]) return table[0][1];
  for (let i = 1; i < table.length; i++) {
    if (x <= table[i][0]) {
      const [x0, y0] = table[i - 1], [x1, y1] = table[i];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return table[table.length - 1][1];
}

const angDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

function windScore(speed, dirFrom) {
  if (speed < 2.5) return { v: 1, kind: 'liso' };
  // +1 = blowing straight offshore (from land), -1 = straight onshore
  const off = Math.cos(angDiff(dirFrom, BEACH_NORMAL + 180) * DEG);
  if (off > 0.5) return { v: speed < 10 ? 0.95 : speed < 14 ? 0.75 : 0.55, kind: 'terral' };
  if (off > -0.3) return { v: speed < 5 ? 0.7 : speed < 8 ? 0.5 : 0.3, kind: 'lateral' };
  return { v: speed < 4 ? 0.6 : speed < 7 ? 0.35 : 0.12, kind: 'maral' };
}

export function surfIndex(hour) {
  const w = hour.waves;
  const parts = [w.swell1, w.swell2, w.windsea].filter((p) => p && p.hs > 0.05 && p.tp && p.dir != null);
  if (!parts.length && w.total?.hs) parts.push(w.total);
  if (!parts.length) return null;

  // exposure-weighted deep-water height and the period of the most energetic exposed partition
  let h0sq = 0, best = null, bestE = -1;
  for (const p of parts) {
    const expo = Math.max(Math.cos(angDiff(p.dir, BEACH_NORMAL) * DEG), 0);
    const e = p.hs * p.hs * expo;
    h0sq += e;
    if (e * p.tp > bestE) { bestE = e * p.tp; best = p; }
  }
  const h0 = Math.sqrt(h0sq);
  const tp = best.tp;
  const hb = h0 > 0 ? 0.39 * Math.pow(G, 0.2) * Math.pow(tp * h0 * h0, 0.4) : 0;

  const size = interp(SIZE, hb);
  const period = interp(PERIOD, tp);
  const direction = interp(DIRECTION, angDiff(best.dir, BEACH_NORMAL));
  const wind = windScore(hour.wind.center.speed, hour.wind.center.dir);
  const totalE = parts.reduce((s, p) => s + p.hs * p.hs, 0);
  const wsE = w.windsea?.hs ? w.windsea.hs * w.windsea.hs : 0;
  const clean = 1 - 0.4 * Math.min(1, wsE / Math.max(totalE, 1e-6));

  const score = 5 * size * (0.4 + 0.6 * period) * (0.4 + 0.6 * direction) * wind.v * clean;
  const s = Math.round(Math.min(5, Math.max(0, score)) * 10) / 10;
  return {
    score: s,
    label: LABELS[Math.min(5, Math.round(s))],
    hb, tp,
    parts: { size, period, direction, wind: wind.v, clean },
    windKind: wind.kind,
  };
}

// Colour for the 0-5 index (grey -> yellow -> green)
export function surfColor(score) {
  const stops = [[0, [0.45, 0.47, 0.5]], [1.5, [0.75, 0.55, 0.3]], [2.5, [0.88, 0.71, 0.23]], [3.5, [0.45, 0.72, 0.35]], [5, [0.2, 0.6, 0.35]]];
  for (let i = 1; i < stops.length; i++) {
    if (score <= stops[i][0] || i === stops.length - 1) {
      const [a, ca] = stops[i - 1], [b, cb] = stops[i];
      const t = Math.min(1, Math.max(0, (score - a) / (b - a)));
      return `rgb(${ca.map((v, k) => Math.round((v + (cb[k] - v) * t) * 255)).join(',')})`;
    }
  }
  return 'grey';
}
