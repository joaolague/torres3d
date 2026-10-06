// 3D wind particles (Windy-style streaks) advected by an interpolated forecast field.
// Vertical structure: log-law profile with sea/land roughness; terrain lift: w = U·grad(z_s),
// decaying with height above ground. A visual approximation, not a CFD solution.

import * as THREE from 'three';
import { DOMAIN, coastToEN, enToCoast } from './geo.js';

const Z0_SEA = 0.0002, Z0_LAND = 0.3;
const TRAIL_SECONDS = 5;

// Windy-like palette (m/s)
const STOPS = [
  [0, [0.38, 0.45, 0.75]], [3, [0.20, 0.60, 0.85]], [6, [0.20, 0.75, 0.55]],
  [9, [0.55, 0.80, 0.25]], [12, [0.95, 0.80, 0.20]], [16, [0.95, 0.45, 0.15]],
  [20, [0.85, 0.15, 0.25]], [26, [0.70, 0.20, 0.70]],
];
export function windColor(s, out = [0, 0, 0]) {
  for (let i = 1; i < STOPS.length; i++) {
    if (s <= STOPS[i][0] || i === STOPS.length - 1) {
      const [s0, c0] = STOPS[i - 1], [s1, c1] = STOPS[i];
      const t = Math.min(1, Math.max(0, (s - s0) / (s1 - s0)));
      for (let k = 0; k < 3; k++) out[k] = c0[k] + (c1[k] - c0[k]) * t;
      return out;
    }
  }
  return out;
}
export const WIND_LEGEND = STOPS.map(([s, c]) => ({ speed: s, color: `rgb(${c.map((v) => Math.round(v * 255)).join(',')})` }));

export class WindField {
  constructor(terrain, count) {
    this.t = terrain;
    this.count = count;
    this.grid = null;               // 3x3 of {u, v} (east, north) at 10 m
    this.speedFactor = 3;
    this.state = new Float32Array(count * 5); // x, y (coast), z (world height), age, life
    this.pos = new Float32Array(count * 6);
    this.col = new Float32Array(count * 8);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    this.lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, depthWrite: false,
    }));
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 3;
    for (let p = 0; p < count; p++) this.spawn(p, true);
  }

  setGrid(gridPts) {
    // gridPts: 9 points ordered i (x) fastest, with speed (m/s) and dir (from, deg)
    this.grid = gridPts.map((g) => {
      const r = (g.dir * Math.PI) / 180;
      return { u: -g.speed * Math.sin(r), v: -g.speed * Math.cos(r) };
    });
  }

  // 10 m wind (east, north) at coast-frame (x, y), bilinear on the 3x3 grid
  wind10(x, y) {
    const g = this.grid;
    const fi = Math.min(1.999, Math.max(0, ((x - DOMAIN.x0) / (DOMAIN.x1 - DOMAIN.x0)) * 2));
    const fj = Math.min(1.999, Math.max(0, ((y - DOMAIN.y0) / (DOMAIN.y1 - DOMAIN.y0)) * 2));
    const i = Math.floor(fi), j = Math.floor(fj), tx = fi - i, ty = fj - j;
    const a = g[j * 3 + i], b = g[j * 3 + i + 1], c = g[(j + 1) * 3 + i], d = g[(j + 1) * 3 + i + 1];
    const u = (a.u * (1 - tx) + b.u * tx) * (1 - ty) + (c.u * (1 - tx) + d.u * tx) * ty;
    const v = (a.v * (1 - tx) + b.v * tx) * (1 - ty) + (c.v * (1 - tx) + d.v * tx) * ty;
    return [u, v];
  }

  // Full 3D velocity in EN + vertical, returns [ve, vn, w]
  velocity(x, y, z) {
    const zs = Math.max(this.t.elevAt(x, y), 0);
    const agl = Math.max(z - zs, 1);
    const onLand = zs > 0.6;
    const z0 = onLand ? Z0_LAND : Z0_SEA;
    const prof = Math.log(Math.max(agl, z0 * 2) / z0) / Math.log(10 / z0);
    const [u10, v10] = this.wind10(x, y);
    const ve = u10 * prof, vn = v10 * prof;
    // terrain slope (in EN) for orographic lift
    const h = 30;
    const [cxE, cyE] = enToCoast(h, 0), [cxN, cyN] = enToCoast(0, h);
    const dzde = (this.t.elevAt(x + cxE, y + cyE) - this.t.elevAt(x - cxE, y - cyE)) / (2 * h);
    const dzdn = (this.t.elevAt(x + cxN, y + cyN) - this.t.elevAt(x - cxN, y - cyN)) / (2 * h);
    const w = (ve * dzde + vn * dzdn) * Math.exp(-agl / 60);
    return [ve, vn, w];
  }

  spawn(p, randomAge) {
    const s = this.state;
    const x = DOMAIN.x0 + Math.random() * (DOMAIN.x1 - DOMAIN.x0);
    const y = DOMAIN.y0 + Math.random() * (DOMAIN.y1 - DOMAIN.y0);
    const zs = Math.max(this.t.elevAt(x, y), 0);
    const r = Math.random();
    s[5 * p] = x; s[5 * p + 1] = y;
    s[5 * p + 2] = zs + 4 + 250 * r * r;
    s[5 * p + 4] = 6 + Math.random() * 10;
    s[5 * p + 3] = randomAge ? Math.random() * s[5 * p + 4] : 0;
  }

  update(dt) {
    if (!this.grid) return;
    const s = this.state, pos = this.pos, col = this.col;
    const c = [0, 0, 0];
    for (let p = 0; p < this.count; p++) {
      let x = s[5 * p], y = s[5 * p + 1], z = s[5 * p + 2];
      const [ve, vn, w] = this.velocity(x, y, z);
      const step = dt * this.speedFactor;
      // EN displacement -> coast frame
      const [dx, dy] = enToCoast(ve * step, vn * step);
      x += dx; y += dy; z += w * step;
      const zs = Math.max(this.t.elevAt(x, y), 0);
      if (z < zs + 2) z = zs + 2;
      s[5 * p] = x; s[5 * p + 1] = y; s[5 * p + 2] = z;
      s[5 * p + 3] += dt;
      const age = s[5 * p + 3], life = s[5 * p + 4];
      if (age > life || x < DOMAIN.x0 || x > DOMAIN.x1 || y < DOMAIN.y0 || y > DOMAIN.y1) {
        this.spawn(p, false);
        continue;
      }
      const speed = Math.hypot(ve, vn);
      const [e, n] = coastToEN(x, y);
      const tl = TRAIL_SECONDS * Math.min(this.speedFactor, 4);
      pos[6 * p] = e; pos[6 * p + 1] = z; pos[6 * p + 2] = -n;
      pos[6 * p + 3] = e - ve * tl; pos[6 * p + 4] = z - w * tl; pos[6 * p + 5] = -(n - vn * tl);
      windColor(speed, c);
      const fade = Math.min(1, age / 1.0, (life - age) / 1.5);
      col[8 * p] = c[0]; col[8 * p + 1] = c[1]; col[8 * p + 2] = c[2]; col[8 * p + 3] = 0.8 * fade;
      col[8 * p + 4] = c[0]; col[8 * p + 5] = c[1]; col[8 * p + 6] = c[2]; col[8 * p + 7] = 0;
    }
    this.lines.geometry.attributes.position.needsUpdate = true;
    this.lines.geometry.attributes.color.needsUpdate = true;
  }
}
