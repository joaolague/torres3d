// Spectral synthesis of the sea surface from forecast wave partitions.
//
// Each partition (wind sea, primary swell, secondary swell) is described by Hs, Tp and the
// mean direction it comes FROM. It is discretised into N linear components drawn from a
// JONSWAP frequency spectrum with cos^2s directional spreading. The resulting surface is one
// random realisation consistent with the forecast spectrum, not a deterministic forecast of
// individual waves.
//
// Nearshore transformation (done in the ocean shader) assumes locally straight, parallel depth
// contours: Snell's law for refraction, linear shoaling and a depth-limited breaking cap.
// The phase along the shore-normal is integrated here on a reference depth profile and stored
// in a lookup texture.

import * as THREE from 'three';
import { bearingToCoastVec, DOMAIN } from './geo.js';
import { referenceDepth } from './terrain.js';

export const MAX_COMPONENTS = 64;
const G = 9.81;

export const PARTITION_SETTINGS = {
  windsea: { n: 24, gamma: 2.0, spread: 4, fmin: 0.75, fmax: 2.4 },
  swell1: { n: 24, gamma: 5.0, spread: 24, fmin: 0.82, fmax: 1.5 },
  swell2: { n: 16, gamma: 5.0, spread: 24, fmin: 0.82, fmax: 1.5 },
};

// Deterministic PRNG so the same forecast hour gives the same realisation
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function jonswap(f, fp, gamma) {
  const sigma = f <= fp ? 0.07 : 0.09;
  const r = Math.exp(-((f - fp) ** 2) / (2 * sigma * sigma * fp * fp));
  return Math.pow(f, -5) * Math.exp(-1.25 * Math.pow(fp / f, 4)) * Math.pow(gamma, r);
}

// Sample a directional offset (rad) from D(theta) ∝ cos^2s(theta/2)
function sampleSpread(rand, s) {
  for (let it = 0; it < 100; it++) {
    const th = (rand() * 2 - 1) * Math.PI;
    if (rand() <= Math.pow(Math.cos(th / 2), 2 * s)) return th;
  }
  return 0;
}

// Exact linear dispersion: omega^2 = g k tanh(k h)
export function waveNumber(omega, h) {
  const k0 = (omega * omega) / G;
  if (h <= 0) return k0 * 50;
  let k = k0 / Math.sqrt(Math.tanh(k0 * h)); // Eckart initial guess
  for (let i = 0; i < 20; i++) {
    const th = Math.tanh(k * h);
    const f = G * k * th - omega * omega;
    const df = G * th + G * k * h * (1 - th * th);
    const dk = f / df;
    k -= dk;
    if (Math.abs(dk) < 1e-10 * k) break;
  }
  return k;
}

/**
 * partitions: [{ key: 'swell1'|'swell2'|'windsea', hs, tp, dirFrom }]
 * Returns typed arrays sized MAX_COMPONENTS for shader uniforms.
 */
export function buildComponents(partitions, seed = 1) {
  const rand = mulberry32(seed);
  const amp = new Float32Array(MAX_COMPONENTS);
  const omega = new Float32Array(MAX_COMPONENTS);
  const k0 = new Float32Array(MAX_COMPONENTS);
  const px = new Float32Array(MAX_COMPONENTS);
  const py = new Float32Array(MAX_COMPONENTS);
  const phase0 = new Float32Array(MAX_COMPONENTS);
  let count = 0;

  for (const p of partitions) {
    if (!(p.hs > 0.02) || !(p.tp > 1)) continue;
    const cfg = PARTITION_SETTINGS[p.key];
    const n = Math.min(cfg.n, MAX_COMPONENTS - count);
    if (n <= 0) break;
    const fp = 1 / p.tp;
    const f0 = cfg.fmin * fp, f1 = cfg.fmax * fp;
    const df = (f1 - f0) / n;
    const start = count;
    let energy = 0;
    for (let i = 0; i < n; i++) {
      const f = f0 + (i + rand()) * df;
      const e = jonswap(f, fp, cfg.gamma) * df;
      const dirTo = (p.dirFrom + 180) * Math.PI / 180 + sampleSpread(rand, cfg.spread);
      const [vx, vy] = bearingToCoastVec(dirTo * 180 / Math.PI);
      const w = 2 * Math.PI * f;
      amp[count] = e; // provisional, normalised below
      omega[count] = w;
      k0[count] = (w * w) / G;
      px[count] = vx;
      py[count] = vy;
      phase0[count] = rand() * 2 * Math.PI;
      energy += e;
      count++;
    }
    // Hs = 4 sqrt(m0), m0 = sum(a^2)/2
    const m0 = (p.hs / 4) ** 2;
    for (let i = start; i < count; i++) amp[i] = Math.sqrt((2 * m0 * amp[i]) / energy);
  }
  return { count, amp, omega, k0, px, py, phase0 };
}

// Phase lookup: Phi_i(x) = integral_0^x kx_i(x') dx' on the reference depth profile
export const PHASE_LUT = { x0: DOMAIN.x0, x1: DOMAIN.x1, n: 1024 };

export function buildPhaseTexture(comp, xShore, existing) {
  const { x0, x1, n } = PHASE_LUT;
  const dx = (x1 - x0) / (n - 1);
  const data = existing ? existing.image.data : new Float32Array(n * MAX_COMPONENTS);
  const sub = 4;
  const i0 = Math.round((0 - x0) / dx); // integration origin at x = 0

  for (let c = 0; c < MAX_COMPONENTS; c++) {
    const row = c * n;
    if (c >= comp.count) { data.fill(0, row, row + n); continue; }
    const w = comp.omega[c];
    const ky = comp.k0[c] * comp.py[c];
    const sgn = comp.px[c] >= 0 ? 1 : -1;
    const kx = (x) => {
      const k = waveNumber(w, Math.max(referenceDepth(x, xShore), 0.05));
      return sgn * Math.sqrt(Math.max(k * k - ky * ky, 0));
    };
    data[row + i0] = 0;
    for (let i = i0 + 1; i < n; i++) {
      let acc = 0;
      const xa = x0 + (i - 1) * dx;
      for (let s = 0; s < sub; s++) acc += kx(xa + (s + 0.5) * dx / sub);
      data[row + i] = data[row + i - 1] + acc * dx / sub;
    }
    for (let i = i0 - 1; i >= 0; i--) {
      let acc = 0;
      const xb = x0 + (i + 1) * dx;
      for (let s = 0; s < sub; s++) acc += kx(xb - (s + 0.5) * dx / sub);
      data[row + i] = data[row + i + 1] - acc * dx / sub;
    }
  }

  if (existing) { existing.needsUpdate = true; return existing; }
  const tex = new THREE.DataTexture(data, n, MAX_COMPONENTS, THREE.RedFormat, THREE.FloatType);
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
}
