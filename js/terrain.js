// Terrain + synthetic bathymetry for the Torres domain.
//
// Elevation source, in order of preference:
//   1. data/terrain.json (built offline by tools/build_terrain.py)
//   2. Open-Meteo Elevation API (Copernicus DEM GLO-90), fetched in the browser and cached
//   3. Procedural approximation built from the landmarks in geo.js
// Bathymetry is synthetic: an equilibrium (Dean) profile h = A * d^(2/3), where d is the
// distance to the nearest non-ocean cell. Replace with GEBCO / DHN nautical charts / survey.

import * as THREE from 'three';
import { DOMAIN, LANDMARKS, lonLatToCoast, coastToLonLat, coastToEN } from './geo.js';

export const GRID_DX = 25; // working grid spacing (m)
export const DEAN_A = 0.10; // Dean parameter (m^1/3), fine-medium sand
const MAX_DEPTH = 35;
const SEA_LEVEL_THRESHOLD = 0.5; // DEM cells at or below this are candidate sea

const DEM_DX = 100; // spacing for in-browser DEM sampling (DEM itself is ~90 m)
const DEM_CACHE_KEY = 'torres3d-dem-v1';

// ---------------------------------------------------------------- helpers

function hash2(i, j) {
  let h = (i * 374761393 + j * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function valueNoise(x, y) {
  const i = Math.floor(x), j = Math.floor(y);
  const fx = x - i, fy = y - j;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash2(i, j), b = hash2(i + 1, j), c = hash2(i, j + 1), d = hash2(i + 1, j + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// Exact Euclidean distance transform (Felzenszwalb & Huttenlocher), returns metres.
function edt(feature, nx, ny, cell) {
  const INF = 1e20;
  const f = new Float64Array(Math.max(nx, ny));
  const d = new Float64Array(Math.max(nx, ny));
  const v = new Int32Array(Math.max(nx, ny));
  const z = new Float64Array(Math.max(nx, ny) + 1);
  const grid = new Float64Array(nx * ny);
  for (let k = 0; k < nx * ny; k++) grid[k] = feature[k] ? 0 : INF;

  const pass = (n) => {
    let k = 0;
    v[0] = 0; z[0] = -INF; z[1] = INF;
    for (let q = 1; q < n; q++) {
      let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) {
        k--;
        s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      }
      k++; v[k] = q; z[k] = s; z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < n; q++) {
      while (z[k + 1] < q) k++;
      d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
    }
  };

  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) f[i] = grid[j * nx + i];
    pass(nx);
    for (let i = 0; i < nx; i++) grid[j * nx + i] = d[i];
  }
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) f[j] = grid[j * nx + i];
    pass(ny);
    for (let j = 0; j < ny; j++) grid[j * nx + i] = d[j];
  }
  const out = new Float32Array(nx * ny);
  for (let k = 0; k < nx * ny; k++) out[k] = Math.sqrt(grid[k]) * cell;
  return out;
}

function bilinear(arr, nx, ny, fi, fj) {
  fi = Math.min(Math.max(fi, 0), nx - 1.0001);
  fj = Math.min(Math.max(fj, 0), ny - 1.0001);
  const i = Math.floor(fi), j = Math.floor(fj);
  const tx = fi - i, ty = fj - j;
  const k = j * nx + i;
  return (arr[k] * (1 - tx) + arr[k + 1] * tx) * (1 - ty) + (arr[k + nx] * (1 - tx) + arr[k + nx + 1] * tx) * ty;
}

// ---------------------------------------------------------------- procedural terrain

function proceduralElevation() {
  const heads = LANDMARKS.filter((l) => l.kind === 'headland').map((l) => {
    const [, y] = lonLatToCoast(l.lon, l.lat);
    return { y, P: l.protrusion, W: l.width, H: l.height };
  });
  const river = LANDMARKS.find((l) => l.kind === 'river');
  const [, yRiver] = lonLatToCoast(river.lon, river.lat);

  const shoreX = (y) => {
    let s = 0;
    for (const h of heads) s += h.P * Math.exp(-(((y - h.y) / h.W) ** 2));
    // gentle embayment of Praia Grande and Itapeva
    s += 25 * Math.sin(y / 900);
    return s;
  };

  return (x, y) => {
    const s = shoreX(y) - x; // distance inland from shoreline
    if (s < 0) return -1;
    let e = Math.min(s * 0.035, 2.2);
    e += 3.5 * smoothstep(40, 140, s) * (1 - 0.6 * smoothstep(300, 700, s)); // foredunes
    e += 2.5 * smoothstep(200, 600, s); // urban plain
    e += 2.0 * (valueNoise(x / 180, y / 180) - 0.5) * smoothstep(80, 250, s);
    for (const h of heads) {
      const gy = (y - h.y) / (h.W * 1.05);
      const gx = (x - (h.P * 0.35)) / (h.W * 1.4);
      const hill = h.H * Math.exp(-(gx * gx + gy * gy) * 1.4);
      e += hill * smoothstep(0, 70, s); // steep basalt cliffs at the sea face
    }
    // Mampituba river channel (meandering inland)
    const yc = yRiver + 140 * Math.sin(-x / 450) - 60;
    if (Math.abs(y - yc) < 38 && x < shoreX(yRiver) + 5) e = -2;
    return e;
  };
}

// ---------------------------------------------------------------- DEM sources

async function loadTerrainJSON() {
  const r = await fetch('data/terrain.json', { cache: 'no-cache' });
  if (!r.ok) throw new Error('no terrain.json');
  const j = await r.json();
  const g = j.grid;
  const elev = Float32Array.from(j.elevation);
  return {
    source: j.source || 'terrain.json',
    sample: (x, y) => bilinear(elev, g.nx, g.ny, (x - g.x0) / g.dx, (y - g.y0) / g.dy),
  };
}

async function fetchOpenMeteoDEM(onProgress) {
  const nx = Math.round((DOMAIN.x1 - DOMAIN.x0) / DEM_DX) + 1;
  const ny = Math.round((DOMAIN.y1 - DOMAIN.y0) / DEM_DX) + 1;

  let cached = null;
  try { cached = JSON.parse(localStorage.getItem(DEM_CACHE_KEY) || 'null'); } catch { /* storage unavailable */ }
  let elev;
  if (cached && cached.nx === nx && cached.ny === ny) {
    elev = Float32Array.from(cached.elevation);
  } else {
    const pts = [];
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const [lon, lat] = coastToLonLat(DOMAIN.x0 + i * DEM_DX, DOMAIN.y0 + j * DEM_DX);
        pts.push([lat.toFixed(5), lon.toFixed(5)]);
      }
    }
    elev = new Float32Array(pts.length);
    const chunks = [];
    for (let k = 0; k < pts.length; k += 100) chunks.push(k);
    let done = 0;
    const worker = async () => {
      while (chunks.length) {
        const k0 = chunks.shift();
        const part = pts.slice(k0, k0 + 100);
        const url = 'https://api.open-meteo.com/v1/elevation?latitude=' + part.map((p) => p[0]).join(',') +
          '&longitude=' + part.map((p) => p[1]).join(',');
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 15000);
        const r = await fetch(url, { signal: ctrl.signal });
        clearTimeout(timer);
        if (!r.ok) throw new Error('elevation API ' + r.status);
        const j = await r.json();
        j.elevation.forEach((v, m) => { elev[k0 + m] = Number.isFinite(v) ? v : 0; });
        done++;
        onProgress?.(done / Math.ceil(pts.length / 100));
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    try {
      localStorage.setItem(DEM_CACHE_KEY, JSON.stringify({ nx, ny, elevation: Array.from(elev, (v) => Math.round(v * 10) / 10) }));
    } catch { /* quota or private mode */ }
  }
  return {
    source: 'Copernicus DEM GLO-90 (via Open-Meteo)',
    sample: (x, y) => bilinear(elev, nx, ny, (x - DOMAIN.x0) / DEM_DX, (y - DOMAIN.y0) / DEM_DX),
  };
}

// ---------------------------------------------------------------- build

// Small features below DEM resolution: Ilha dos Lobos and the Mampituba jetties.
function addSmallFeatures(x, y, e) {
  const isl = LANDMARKS.find((l) => l.kind === 'island');
  const [xi, yi] = lonLatToCoast(isl.lon, isl.lat);
  const dx = (x - xi) / 55, dy = (y - yi) / 110;
  const r2 = dx * dx + dy * dy;
  if (r2 < 1) e = Math.max(e, 9 * (1 - r2) + 0.6);

  const river = LANDMARKS.find((l) => l.kind === 'river');
  const [xr, yr] = lonLatToCoast(river.lon, river.lat);
  for (const off of [-55, 55]) {
    if (Math.abs(y - (yr + off)) < 9 && x > xr - 120 && x < xr + 330) e = Math.max(e, 3.2);
  }
  return e;
}

export async function buildTerrain(onStatus) {
  let src = null;
  try {
    src = await loadTerrainJSON();
  } catch {
    try {
      onStatus?.('Baixando relevo (Copernicus DEM)…');
      src = await fetchOpenMeteoDEM((p) => onStatus?.(`Baixando relevo (Copernicus DEM)… ${Math.round(p * 100)}%`));
    } catch (err) {
      console.warn('DEM unavailable, using procedural terrain:', err);
      const f = proceduralElevation();
      src = { source: 'Procedural (aproximação)', sample: f };
    }
  }
  onStatus?.('Calculando batimetria…');

  const dx = GRID_DX;
  const nx = Math.round((DOMAIN.x1 - DOMAIN.x0) / dx) + 1;
  const ny = Math.round((DOMAIN.y1 - DOMAIN.y0) / dx) + 1;
  const raw = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const x = DOMAIN.x0 + i * dx, y = DOMAIN.y0 + j * dx;
      raw[j * nx + i] = addSmallFeatures(x, y, src.sample(x, y));
    }
  }

  // Ocean = low cells connected to the seaward boundary (excludes lagoons)
  const ocean = new Uint8Array(nx * ny);
  const stack = [];
  for (let j = 0; j < ny; j++) {
    const k = j * nx + nx - 1;
    if (raw[k] <= SEA_LEVEL_THRESHOLD) { ocean[k] = 1; stack.push(k); }
  }
  while (stack.length) {
    const k = stack.pop();
    const i = k % nx, j = (k / nx) | 0;
    const nb = [i > 0 ? k - 1 : -1, i < nx - 1 ? k + 1 : -1, j > 0 ? k - nx : -1, j < ny - 1 ? k + nx : -1];
    for (const q of nb) {
      if (q >= 0 && !ocean[q] && raw[q] <= SEA_LEVEL_THRESHOLD) { ocean[q] = 1; stack.push(q); }
    }
  }

  const land = new Uint8Array(nx * ny);
  for (let k = 0; k < nx * ny; k++) land[k] = ocean[k] ? 0 : 1;
  const distToLand = edt(land, nx, ny, dx);
  const distToOcean = edt(ocean, nx, ny, dx);

  const depth = new Float32Array(nx * ny);
  const elev = new Float32Array(nx * ny);
  for (let k = 0; k < nx * ny; k++) {
    if (ocean[k]) {
      const h = Math.min(MAX_DEPTH, DEAN_A * Math.pow(distToLand[k] + dx * 0.5, 2 / 3));
      depth[k] = h;
      elev[k] = -h;
    } else {
      elev[k] = Math.max(raw[k], 0.3);
    }
  }

  // Representative shoreline position (median over alongshore rows)
  const shoreXs = [];
  for (let j = 0; j < ny; j++) {
    let i = nx - 1;
    while (i > 0 && ocean[j * nx + i - 1]) i--;
    shoreXs.push(DOMAIN.x0 + i * dx);
  }
  shoreXs.sort((a, b) => a - b);
  const xShore = shoreXs[Math.floor(shoreXs.length / 2)];

  const t = {
    source: src.source, nx, ny, dx, x0: DOMAIN.x0, y0: DOMAIN.y0,
    elev, depth, ocean, distToOcean, distToLand, xShore,
    elevAt: (x, y) => bilinear(elev, nx, ny, (x - DOMAIN.x0) / dx, (y - DOMAIN.y0) / dx),
    depthAt: (x, y) => bilinear(depth, nx, ny, (x - DOMAIN.x0) / dx, (y - DOMAIN.y0) / dx),
  };
  return t;
}

// Reference (alongshore-uniform) depth profile used for wave phase integration
export function referenceDepth(x, xShore) {
  const d = Math.max(x - xShore, 0);
  return Math.min(MAX_DEPTH, DEAN_A * Math.pow(d + GRID_DX * 0.5, 2 / 3));
}

// ---------------------------------------------------------------- render objects

export function coastToWorld(x, y, h) {
  const [e, n] = coastToEN(x, y);
  return new THREE.Vector3(e, h, -n);
}

export function createTerrainMesh(t) {
  const { nx, ny, dx } = t;
  const pos = new Float32Array(nx * ny * 3);
  const col = new Float32Array(nx * ny * 3);
  const c = new THREE.Color();
  const sand = new THREE.Color(0xd8c39a), wetSand = new THREE.Color(0xa58f68);
  const grass = new THREE.Color(0x5f7d3e), forest = new THREE.Color(0x3e5a2c);
  const rock = new THREE.Color(0x5a4f45), urban = new THREE.Color(0xa9a39a);
  const seabed = new THREE.Color(0xb59f75), deepBed = new THREE.Color(0x4a5a55);

  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      const x = t.x0 + i * dx, y = t.y0 + j * dx;
      const h = t.elev[k];
      const [e, n] = coastToEN(x, y);
      pos[3 * k] = e; pos[3 * k + 1] = h; pos[3 * k + 2] = -n;

      if (t.ocean[k]) {
        c.copy(seabed).lerp(deepBed, smoothstep(0, 20, t.depth[k]));
      } else {
        const ex = t.elev[Math.min(k + 1, nx * ny - 1)] - t.elev[Math.max(k - 1, 0)];
        const ey = t.elev[Math.min(k + nx, nx * ny - 1)] - t.elev[Math.max(k - nx, 0)];
        const slope = Math.hypot(ex, ey) / (2 * dx);
        const dOcean = t.distToOcean[k];
        const nz = valueNoise(x / 120, y / 120);
        if (dOcean < 90 && h < 5 && slope < 0.15) {
          c.copy(wetSand).lerp(sand, smoothstep(0, 40, dOcean));
        } else if (slope > 0.35) {
          c.copy(rock);
        } else if (h > 15) {
          c.copy(grass).lerp(forest, nz);
        } else {
          c.copy(grass).lerp(urban, 0.55 * smoothstep(0.45, 0.8, nz) * smoothstep(150, 400, dOcean));
        }
      }
      col[3 * k] = c.r; col[3 * k + 1] = c.g; col[3 * k + 2] = c.b;
    }
  }

  const idx = [];
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i, b = a + 1, cc = a + nx, d = cc + 1;
      // counter-clockwise seen from above (coast frame has the same orientation as EN)
      idx.push(a, b, cc, b, d, cc);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'terrain';
  return mesh;
}

export function createDepthTexture(t) {
  const data = new Uint16Array(t.nx * t.ny);
  for (let k = 0; k < data.length; k++) data[k] = THREE.DataUtils.toHalfFloat(t.depth[k]);
  const tex = new THREE.DataTexture(data, t.nx, t.ny, THREE.RedFormat, THREE.HalfFloatType);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}
