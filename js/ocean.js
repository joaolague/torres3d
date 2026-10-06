// Ocean surface: GPU evaluation of the spectral components with nearshore transformation.

import * as THREE from 'three';
import { MAX_COMPONENTS, PHASE_LUT } from './spectrum.js';
import { DOMAIN, NHAT, THAT, coastToEN } from './geo.js';
import { DEAN_A, GRID_DX } from './terrain.js';

const vertexShader = /* glsl */ `
#define MAXC ${MAX_COMPONENTS}
#include <common>
#include <fog_pars_vertex>

uniform float uTime;
uniform int uCount;
uniform vec4 uCompA[MAXC];   // amplitude, omega, k0, phase0
uniform vec4 uCompB[MAXC];   // px, py (unit propagation vector in coast frame)
uniform sampler2D uPhaseTex;
uniform vec3 uLut;           // x0, dx, n
uniform sampler2D uDepthTex;
uniform vec4 uDomain;        // x0, y0, width, height (coast frame)
uniform vec2 uNhat;
uniform vec2 uThat;
uniform float uXShore;
uniform float uDeanA;
uniform float uKmax;
uniform float uExag;
uniform float uTide;
uniform float uGammaB;
uniform float uChop;

varying vec3 vWorld;
varying vec3 vNormalW;
varying float vDepth;
varying float vBreak;
varying float vHs;
varying float vEtaN;

float kDisp(float k0, float h) {
  // Fenton & McKee explicit approximation of the linear dispersion relation
  float a = pow(max(k0 * h, 1e-4), 0.75);
  return k0 / pow(tanh(a), 0.6666667);
}

float lutPhase(int c, float x) {
  float fx = clamp((x - uLut.x) / uLut.y, 0.0, uLut.z - 1.001);
  int i0 = int(floor(fx));
  float t = fx - float(i0);
  float a = texelFetch(uPhaseTex, ivec2(i0, c), 0).r;
  float b = texelFetch(uPhaseTex, ivec2(i0 + 1, c), 0).r;
  return mix(a, b, t);
}

void main() {
  vec3 p = position;                     // world: x = east, z = -north
  vec2 en = vec2(p.x, -p.z);
  float cx = dot(en, uNhat);
  float cy = dot(en, uThat);

  vec2 uv = vec2((cx - uDomain.x) / uDomain.z, (cy - uDomain.y) / uDomain.w);
  float depth = texture(uDepthTex, uv).r;
  float h = max(depth + uTide, 0.0);
  float hRef = uDeanA * pow(max(cx - uXShore, 0.0) + ${(GRID_DX * 0.5).toFixed(1)}, 0.6666667);
  hRef = max(hRef, 0.05);
  float wet = smoothstep(0.05, 0.6, h);

  float eta = 0.0;
  vec2 grad = vec2(0.0);     // d(eta)/d(coast x, coast y)
  vec2 disp = vec2(0.0);     // horizontal displacement (coast frame)
  float sumA2 = 0.0;

  for (int i = 0; i < MAXC; i++) {
    if (i >= uCount) break;
    vec4 A = uCompA[i];
    vec2 dir = uCompB[i].xy;
    float w = A.y;
    float k0 = A.z;
    float ky = k0 * dir.y;

    float kl = kDisp(k0, max(h, 0.05));
    float kh = clamp(kl * h, 1e-3, 15.0);
    float n = 0.5 * (1.0 + 2.0 * kh / sinh(2.0 * kh));
    float Ks = sqrt((9.81 / (2.0 * w)) / (n * w / kl));
    float s = clamp(ky / kl, -0.999, 0.999);
    float Kr = sqrt(max(abs(dir.x), 0.05) / sqrt(1.0 - s * s));
    float a = A.x * Ks * Kr;
    sumA2 += a * a;

    float kr = kDisp(k0, hRef);
    float kxRef = sign(dir.x + 1e-6) * sqrt(max(kr * kr - ky * ky, 0.0));
    float phase = ky * cy + lutPhase(i, cx) - w * uTime + A.w;

    float fade = 1.0 - smoothstep(0.5 * uKmax, uKmax, kl);   // grid can't resolve shorter waves
    float af = a * fade;
    float cp = cos(phase);
    float sp = sin(phase);
    eta += af * cp;
    grad += -af * sp * vec2(kxRef, ky);
    vec2 kv = vec2(kxRef, ky);
    disp += -uChop * af * sp * kv / max(length(kv), 1e-4);
  }

  float hm0 = 4.0 * sqrt(0.5 * sumA2);
  float hb = uGammaB * max(h, 0.01);
  float cap = min(1.0, hb / max(hm0, 1e-3));
  eta *= cap * wet;
  grad *= cap * wet;
  disp *= cap * wet;

  vBreak = hm0 / hb * wet;
  vHs = min(hm0, hb) * wet;
  vEtaN = eta / max(0.25 * vHs, 0.02);
  vDepth = h;

  vec2 gradEN = grad.x * uNhat + grad.y * uThat;
  vec2 dispEN = disp.x * uNhat + disp.y * uThat;
  p.x += dispEN.x * uExag;
  p.z -= dispEN.y * uExag;
  p.y = uTide + eta * uExag;

  // world normal: eta(x=e, z=-n)
  vNormalW = normalize(vec3(-gradEN.x * uExag, 1.0, gradEN.y * uExag));
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vWorld = wp.xyz;
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const fragmentShader = /* glsl */ `
#include <common>
#include <fog_pars_fragment>

uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uSkyTop;
uniform vec3 uSkyHorizon;
uniform vec2 uWindVec;      // m/s, world xz
uniform float uWindSpeed;
uniform float uFoam;
uniform int uShowHs;

varying vec3 vWorld;
varying vec3 vNormalW;
varying float vDepth;
varying float vBreak;
varying float vHs;
varying float vEtaN;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; }
  return v;
}

vec3 hsPalette(float hs) {
  float t = clamp(hs / 3.0, 0.0, 1.0);
  vec3 c0 = vec3(0.10, 0.25, 0.65), c1 = vec3(0.10, 0.70, 0.85), c2 = vec3(0.95, 0.85, 0.20), c3 = vec3(0.90, 0.20, 0.15);
  return t < 0.33 ? mix(c0, c1, t / 0.33) : (t < 0.66 ? mix(c1, c2, (t - 0.33) / 0.33) : mix(c2, c3, (t - 0.66) / 0.34));
}

void main() {
  vec3 V = normalize(cameraPosition - vWorld);
  vec3 N = normalize(vNormalW);

  // small-scale ripples drifting with the wind (unresolved by the mesh)
  vec2 q = vWorld.xz * 0.22 - uWindVec * uTime * 0.15;
  float e = 0.15;
  float n0 = fbm(q);
  vec2 dn = vec2(fbm(q + vec2(e, 0.0)) - n0, fbm(q + vec2(0.0, e)) - n0) / e;
  float ripple = 0.05 + 0.12 * smoothstep(1.0, 10.0, uWindSpeed);
  float distFade = 1.0 - smoothstep(150.0, 1500.0, length(cameraPosition - vWorld));
  N = normalize(N + vec3(dn.x, 0.0, dn.y) * ripple * distFade);

  float ndv = max(dot(N, V), 0.0);
  float fres = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
  vec3 R = reflect(-V, N);
  vec3 sky = mix(uSkyHorizon, uSkyTop, clamp(R.y * 1.6, 0.0, 1.0));

  vec3 deep = vec3(0.015, 0.09, 0.13);
  vec3 shallow = vec3(0.10, 0.34, 0.30);
  vec3 water = mix(shallow, deep, smoothstep(0.5, 14.0, vDepth));
  water *= 0.55 + 0.45 * max(dot(N, uSunDir), 0.0);
  // light scattering through crests
  water += vec3(0.02, 0.10, 0.08) * clamp(vEtaN, 0.0, 2.0) * 0.5;

  vec3 col = mix(water, sky, fres);
  float spec = pow(max(dot(R, uSunDir), 0.0), 180.0);
  col += vec3(1.0, 0.95, 0.85) * spec * 1.6;

  // foam: depth-induced breaking, surf zone, swash and wind whitecaps
  float fn = fbm(vWorld.xz * 0.09 + vec2(uTime * 0.05));
  float breaking = smoothstep(0.75, 1.0, vBreak) * smoothstep(-0.5, 0.8, vEtaN);
  float surfZone = smoothstep(0.92, 1.0, vBreak) * 0.45;
  float swash = 1.0 - smoothstep(0.05, 0.45, vDepth);
  float whitecap = smoothstep(7.0, 15.0, uWindSpeed) * smoothstep(1.2, 2.2, vEtaN);
  float foam = (breaking * 0.9 + surfZone + whitecap * 0.8) * smoothstep(0.25, 0.75, fn + 0.25) + swash * 0.6;
  foam = clamp(foam * uFoam, 0.0, 1.0);
  col = mix(col, vec3(0.93, 0.95, 0.95), foam);

  if (uShowHs == 1) col = mix(col, hsPalette(vHs), 0.7);

  float alpha = mix(0.45, 0.96, smoothstep(0.0, 5.0, vDepth));
  alpha = max(alpha, foam);
  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

export function createOcean(terrain, depthTex, phaseTex, spacing) {
  const xa = -400, xb = DOMAIN.x1, ya = DOMAIN.y0, yb = DOMAIN.y1;
  const nx = Math.round((xb - xa) / spacing) + 1;
  const ny = Math.round((yb - ya) / spacing) + 1;
  const pos = new Float32Array(nx * ny * 3);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const [e, n] = coastToEN(xa + (i * (xb - xa)) / (nx - 1), ya + (j * (yb - ya)) / (ny - 1));
      const k = 3 * (j * nx + i);
      pos[k] = e; pos[k + 1] = 0; pos[k + 2] = -n;
    }
  }
  const idx = new Uint32Array((nx - 1) * (ny - 1) * 6);
  let m = 0;
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
      idx[m++] = a; idx[m++] = b; idx[m++] = c;
      idx[m++] = b; idx[m++] = d; idx[m++] = c;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);

  const compA = Array.from({ length: MAX_COMPONENTS }, () => new THREE.Vector4());
  const compB = Array.from({ length: MAX_COMPONENTS }, () => new THREE.Vector4());

  const uniforms = THREE.UniformsUtils.merge([
    THREE.UniformsLib.fog,
    {
      uTime: { value: 0 },
      uCount: { value: 0 },
      uPhaseTex: { value: null },
      uLut: { value: new THREE.Vector3(PHASE_LUT.x0, (PHASE_LUT.x1 - PHASE_LUT.x0) / (PHASE_LUT.n - 1), PHASE_LUT.n) },
      uDepthTex: { value: null },
      uDomain: { value: new THREE.Vector4(DOMAIN.x0, DOMAIN.y0, DOMAIN.x1 - DOMAIN.x0, DOMAIN.y1 - DOMAIN.y0) },
      uNhat: { value: new THREE.Vector2(NHAT[0], NHAT[1]) },
      uThat: { value: new THREE.Vector2(THAT[0], THAT[1]) },
      uXShore: { value: terrain.xShore },
      uDeanA: { value: DEAN_A },
      uKmax: { value: Math.PI / (2 * spacing) },
      uExag: { value: 1.5 },
      uTide: { value: 0 },
      uGammaB: { value: 0.55 },
      uChop: { value: 0.6 },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSkyTop: { value: new THREE.Color(0x3d6fa8) },
      uSkyHorizon: { value: new THREE.Color(0xc9dbe8) },
      uWindVec: { value: new THREE.Vector2() },
      uWindSpeed: { value: 0 },
      uFoam: { value: 1 },
      uShowHs: { value: 0 },
    },
  ]);
  // UniformsUtils.merge clones values: assign shared objects after merging
  uniforms.uCompA = { value: compA };
  uniforms.uCompB = { value: compB };
  uniforms.uPhaseTex.value = phaseTex;
  uniforms.uDepthTex.value = depthTex;

  const mat = new THREE.ShaderMaterial({
    uniforms, vertexShader, fragmentShader,
    transparent: true, fog: true, depthWrite: true,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'ocean';
  mesh.frustumCulled = false;
  mesh.renderOrder = 2;

  function setComponents(comp) {
    for (let i = 0; i < MAX_COMPONENTS; i++) {
      compA[i].set(comp.amp[i], comp.omega[i], comp.k0[i], comp.phase0[i]);
      compB[i].set(comp.px[i], comp.py[i], 0, 0);
    }
    uniforms.uCount.value = comp.count;
  }

  return { mesh, uniforms, setComponents };
}

// Flat water and land outside the modelled domain (continues the scene to the horizon).
// The water reuses the ocean shader with no wave components so shading matches at the seam.
export function createSurroundings(oceanMaterial) {
  const group = new THREE.Group();
  const water = oceanMaterial.clone();
  water.uniforms.uCount.value = 0;
  water.uniforms.uDepthTex.value = oceanMaterial.uniforms.uDepthTex.value;
  water.uniforms.uPhaseTex.value = oceanMaterial.uniforms.uPhaseTex.value;
  const land = new THREE.MeshLambertMaterial({ color: 0x5f7a45 });
  const FAR = 60000;
  const quad = (xa, xb, ya, yb, h, mat) => {
    const c = [[xa, ya], [xb, ya], [xb, yb], [xa, yb]].map(([x, y]) => coastToEN(x, y));
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(c.flatMap(([e, n]) => [e, h, -n]), 3));
    g.setIndex([0, 1, 3, 1, 2, 3]);
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, mat);
    m.frustumCulled = false;
    group.add(m);
  };
  const { x0, x1, y0, y1 } = DOMAIN;
  quad(0, FAR, y1, FAR, 0, water);
  quad(0, FAR, -FAR, y0, 0, water);
  quad(x1, FAR, y0, y1, 0, water);
  quad(-FAR, 0, y1, FAR, 2, land);
  quad(-FAR, 0, -FAR, y0, 2, land);
  quad(-FAR, x0, y0, y1, 2, land);
  return { group, uniforms: water.uniforms };
}
