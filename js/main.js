import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Sky } from 'three/addons/objects/Sky.js';

import { LANDMARKS, CAMERA_PRESETS, lonLatToCoast } from './geo.js';
import { buildTerrain, createTerrainMesh, createDepthTexture, coastToWorld } from './terrain.js';
import { buildComponents, buildPhaseTexture } from './spectrum.js';
import { createOcean, createSurroundings } from './ocean.js';
import { WindField, windColor } from './wind.js';
import { surfIndex, surfColor } from './surf.js';
import { fetchForecast, SCENARIOS, MODEL_SETS, scenarioToHour, hourToPartitions, compassLabel } from './data.js';

const $ = (id) => document.getElementById(id);
const isMobile = matchMedia('(max-width: 800px), (pointer: coarse)').matches;
const quality = new URLSearchParams(location.search).get('q') || (isMobile ? 'media' : 'alta');
const MESH_SPACING = { alta: 8, media: 14, baixa: 22 }[quality] || 14;
const N_PARTICLES = { alta: 3500, media: 2200, baixa: 1200 }[quality] || 2200;
const params = new URLSearchParams(location.search);

const state = {
  mode: 'live',          // 'live' | 'manual'
  forecast: null,
  hourIndex: 0,
  playing: false,
  manual: structuredClone(SCENARIOS['Swell de leste + terral']),
  model: 'consensus',    // 'consensus' or a MODEL_SETS key
  unit: 'kmh',
  layers: { wind: true, hs: false, arrows: true, labels: true },
};

// ------------------------------------------------------------ renderer & scene

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, isMobile ? 1.5 : 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.55;
$('view').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0xb9cfdd, 6000, 30000);

const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 1, 80000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.495;
controls.minDistance = 30;
controls.maxDistance = 20000;

const sunDir = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - 38), THREE.MathUtils.degToRad(200));
const sky = new Sky();
sky.scale.setScalar(70000);
sky.material.uniforms.turbidity.value = 4;
sky.material.uniforms.rayleigh.value = 1.4;
sky.material.uniforms.mieCoefficient.value = 0.004;
sky.material.uniforms.mieDirectionalG.value = 0.8;
sky.material.uniforms.sunPosition.value.copy(sunDir);
scene.add(sky);

scene.add(new THREE.HemisphereLight(0xcfe3ff, 0x4a5a3a, 1.6));
const sun = new THREE.DirectionalLight(0xfff2dd, 2.4);
sun.position.copy(sunDir).multiplyScalar(5000);
scene.add(sun);

// ------------------------------------------------------------ formatting

function setStatus(msg) { $('loading-msg').textContent = msg; }
const fmt = (v, d = 1) => (v == null || !Number.isFinite(v) ? '–' : v.toFixed(d));
const UNITS = { kmh: { label: 'km/h', f: 3.6 }, kt: { label: 'nós', f: 1.944 }, ms: { label: 'm/s', f: 1 } };
const spd = (ms, withUnit = true) => (ms == null ? '–' : `${Math.round(ms * UNITS[state.unit].f)}${withUnit ? ' ' + UNITS[state.unit].label : ''}`);
const PART_COLORS = { swell1: '#2f8cff', swell2: '#9b6bff', windsea: '#ffb02e' };
const CONF_LABEL = { alta: 'Alta', media: 'Média', baixa: 'Baixa', 'n/d': 'n/d' };
const CONF_COLOR = { alta: '#4caf6e', media: '#e0b53a', baixa: '#d9534f' };

// arrow pointing where the wave/wind goes (data are "coming from")
const arrowSvg = (from) => from == null ? '' :
  `<svg class="dir-arrow" viewBox="0 0 24 24" style="transform:rotate(${from + 180}deg)"><path d="M12 20V5M6 11l6-6 6 6"/></svg>`;
const dirTxt = (d) => (d == null ? '–' : `${arrowSvg(d)}${compassLabel(d)} ${Math.round(d)}°`);

function hourDate(iso) { return new Date(iso + ':00'); }
function formatTime(iso) {
  if (!iso) return 'Cenário simulado';
  const d = hourDate(iso);
  const wd = d.toLocaleDateString('pt-BR', { weekday: 'long' });
  return `${wd[0].toUpperCase() + wd.slice(1)}, ${d.getDate()}/${d.getMonth() + 1} · ${iso.slice(11, 16)}`;
}

// Hs palette (matches the ocean shader)
function hsColor(hs) {
  const t = Math.min(Math.max(hs / 3, 0), 1);
  const c = [[0.10, 0.25, 0.65], [0.10, 0.70, 0.85], [0.95, 0.85, 0.20], [0.90, 0.20, 0.15]];
  const seg = t < 0.33 ? 0 : t < 0.66 ? 1 : 2;
  const u = seg === 0 ? t / 0.33 : seg === 1 ? (t - 0.33) / 0.33 : (t - 0.66) / 0.34;
  return c[seg].map((v, k) => Math.round((v + (c[seg + 1][k] - v) * u) * 255));
}

function buildLegend() {
  const bar = $('legend-bar');
  if (state.layers.hs) {
    $('legend-unit').textContent = 'Hs m';
    bar.innerHTML = [0, 0.5, 1, 1.5, 2, 2.5, 3].map((v) =>
      `<span style="background:rgb(${hsColor(v).join(',')})">${v}</span>`).join('');
  } else {
    $('legend-unit').textContent = UNITS[state.unit].label;
    const c = [0, 0, 0];
    bar.innerHTML = [0, 3, 6, 9, 12, 16, 20, 26].map((v) => {
      windColor(v, c);
      return `<span style="background:rgb(${c.map((x) => Math.round(x * 255)).join(',')})">${Math.round(v * UNITS[state.unit].f)}</span>`;
    }).join('');
  }
}

// ------------------------------------------------------------ main

let terrain, ocean, wind, phaseTex, labels = [], swellArrows, surroundings;

async function init() {
  terrain = await buildTerrain(setStatus);
  $('src-terrain').textContent = terrain.source;

  scene.add(createTerrainMesh(terrain));
  const depthTex = createDepthTexture(terrain);
  phaseTex = buildPhaseTexture({ count: 0 }, terrain.xShore);
  ocean = createOcean(terrain, depthTex, phaseTex, MESH_SPACING);
  ocean.uniforms.uSunDir.value.copy(sunDir);
  scene.add(ocean.mesh);
  surroundings = createSurroundings(ocean.mesh.material);
  scene.add(surroundings.group);

  wind = new WindField(terrain, N_PARTICLES);
  scene.add(wind.lines);
  swellArrows = new THREE.Group();
  scene.add(swellArrows);

  createLabels();
  setCamera(CAMERA_PRESETS[params.get('cam')] ? params.get('cam') : 'Vista geral', true);
  bindUI();

  try {
    state.forecast = await fetchForecast(7, setStatus);
    const now = new Date();
    const idx = state.forecast.hours.findIndex((h) => hourDate(h.time) >= now);
    state.hourIndex = Math.max(0, idx < 0 ? 0 : idx - 1);
    $('src-data').textContent = state.forecast.source;
  } catch (err) {
    console.warn('Forecast unavailable:', err);
    state.mode = 'manual';
    $('src-data').textContent = 'Previsão indisponível (Open-Meteo e cópia do servidor inacessíveis); usando o simulador.';
  }
  buildModelPicker();
  buildDays();
  buildLegend();
  syncModeUI();
  applyCurrent();
  $('loading').classList.add('hidden');
  renderer.setAnimationLoop(frame);
}

function liveHour() {
  const h = state.forecast.hours[state.hourIndex];
  return (state.model !== 'consensus' && h.models[state.model]) || h.consensus;
}

function currentHour() {
  return state.mode === 'live' && state.forecast ? liveHour() : scenarioToHour(state.manual);
}

function applyCurrent() {
  const hour = currentHour();
  const parts = hourToPartitions(hour);
  const seed = state.mode === 'live' ? 1000 + state.hourIndex : 7;
  const comp = buildComponents(parts, seed);
  buildPhaseTexture(comp, terrain.xShore, phaseTex);
  ocean.setComponents(comp);
  ocean.uniforms.uTide.value = hour.tide || 0;
  surroundings.uniforms.uTide.value = hour.tide || 0;

  wind.setGrid(hour.wind.grid);
  const c = hour.wind.center;
  const r = (c.dir * Math.PI) / 180;
  ocean.uniforms.uWindVec.value.set(-c.speed * Math.sin(r), c.speed * Math.cos(r)); // world xz
  ocean.uniforms.uWindSpeed.value = c.speed;

  updateSwellArrows(parts);
  updateDetail(hour);
  updateCursor();
}

function updateDetail(h) {
  const w = h.waves;
  $('d-time').textContent = formatTime(h.time);
  const set = MODEL_SETS.find((m) => m.key === state.model);
  $('d-model').textContent = state.mode !== 'live' ? 'Simulador' :
    (set ? set.desc : `Consenso de ${state.forecast.available.length} modelos`) + (state.forecast.live ? '' : ' · cópia do servidor');
  $('d-hs').textContent = fmt(w.total.hs);
  $('d-tp').textContent = fmt(w.total.tp, 0);
  $('d-dir').innerHTML = dirTxt(w.total.dir);
  const row = (key, name, p) => (p?.hs == null || p.hs < 0.05) ? '' :
    `<tr><td><i style="background:${PART_COLORS[key]}"></i>${name}</td><td>${fmt(p.hs)} m</td><td>${fmt(p.tp, 0)} s</td><td>${dirTxt(p.dir)}</td></tr>`;
  const si = surfIndex(h);
  const badge = $('d-surf');
  badge.textContent = si ? si.score.toFixed(1).replace('.', ',') : '–';
  badge.style.background = si ? surfColor(si.score) : '';
  $('d-surf-label').textContent = si ? `Surfe: ${si.label}` : 'Índice de surfe';
  let range = '';
  if (si && state.mode === 'live') {
    const all = Object.values(state.forecast.hours[state.hourIndex].models).map(surfIndex).filter(Boolean).map((x) => x.score);
    if (all.length > 1) range = ` · modelos ${Math.min(...all).toFixed(1)}–${Math.max(...all).toFixed(1)}`.replace(/\./g, ',');
  }
  $('d-surf-sub').textContent = si ? `Quebra ~${fmt(si.hb)} m · vento ${si.windKind}${range} · v0, não calibrado` : '';
  $('d-parts').innerHTML = row('swell1', 'Swell 1', w.swell1) + row('swell2', 'Swell 2', w.swell2) + row('windsea', 'Mar de vento', w.windsea);
  const c = h.wind.center;
  $('d-wind').innerHTML = `${spd(c.speed)} · ${dirTxt(c.dir)}`;
  $('d-gust').textContent = spd(c.gust);
  $('d-tide').textContent = `${fmt(h.tide, 2)} m`;
  $('d-sst').textContent = h.sst != null ? `${fmt(h.sst, 1)} °C` : '–';

  const s = state.mode === 'live' ? state.forecast.hours[state.hourIndex].spread : null;
  const conf = $('d-conf');
  conf.className = 'conf ' + (s ? s.level : '');
  conf.textContent = s ? CONF_LABEL[s.level] : '–';
  $('d-spread').textContent = !s || s.n < 2 ? '' :
    `Entre modelos: Hs ${fmt(s.hs.min)}–${fmt(s.hs.max)} m · vento ${spd(s.wind.min, false)}–${spd(s.wind.max)}` +
    (s.waveDir != null ? ` · direção ±${Math.round(s.waveDir)}°` : '');
}

// Arrows offshore showing incoming partitions (length ~ Hs)
function updateSwellArrows(parts) {
  swellArrows.clear();
  parts.forEach((p, i) => {
    const to = ((p.dirFrom + 180) * Math.PI) / 180;
    const dir = new THREE.Vector3(Math.sin(to), 0, -Math.cos(to));
    const len = 250 + p.hs * 300;
    const origin = coastToWorld(3100, 200 + (i - 1) * 900, 40).sub(dir.clone().multiplyScalar(len / 2));
    swellArrows.add(new THREE.ArrowHelper(dir, origin, len, new THREE.Color(PART_COLORS[p.key]), 120, 70));
  });
}

function createLabels() {
  const host = $('labels');
  for (const l of LANDMARKS) {
    const [x, y] = lonLatToCoast(l.lon, l.lat);
    const h = l.kind === 'headland' ? l.height + 10 : 6;
    const el = document.createElement('div');
    el.className = 'label ' + l.kind;
    el.textContent = l.name;
    host.appendChild(el);
    labels.push({ el, pos: coastToWorld(x, y, h) });
  }
}

const tmpV = new THREE.Vector3();
function updateLabels() {
  for (const l of labels) {
    tmpV.copy(l.pos).project(camera);
    const dist = camera.position.distanceTo(l.pos);
    const vis = state.layers.labels && tmpV.z < 1 && Math.abs(tmpV.x) < 1.1 && Math.abs(tmpV.y) < 1.1 && dist < 9000;
    l.el.style.display = vis ? 'block' : 'none';
    if (vis) {
      l.el.style.transform = `translate(-50%, -100%) translate(${(tmpV.x * 0.5 + 0.5) * innerWidth}px, ${(-tmpV.y * 0.5 + 0.5) * innerHeight}px)`;
      l.el.style.opacity = String(1 - Math.max(0, (dist - 5000) / 4000));
    }
  }
}

// ------------------------------------------------------------ camera

let camAnim = null;
function setCamera(name, instant = false) {
  const p = CAMERA_PRESETS[name];
  const target = coastToWorld(p.target[0], p.target[1], p.target[2]);
  const eye = coastToWorld(p.eye[0], p.eye[1], p.eye[2]);
  if (instant) {
    camera.position.copy(eye); controls.target.copy(target); controls.update();
    return;
  }
  camAnim = { t: 0, fromE: camera.position.clone(), fromT: controls.target.clone(), toE: eye, toT: target };
}

// ------------------------------------------------------------ timeline + meteogram

function buildDays() {
  const host = $('days');
  host.innerHTML = '';
  if (!state.forecast) return;
  const hours = state.forecast.hours;
  const today = new Date().toDateString();
  let start = 0;
  for (let k = 1; k <= hours.length; k++) {
    if (k === hours.length || hours[k].time.slice(0, 10) !== hours[start].time.slice(0, 10)) {
      const d = hourDate(hours[start].time);
      const el = document.createElement('div');
      el.style.width = `${((k - start) / hours.length) * 100}%`;
      const wd = d.toLocaleDateString('pt-BR', { weekday: 'short' }).replace('.', '');
      el.textContent = `${wd[0].toUpperCase() + wd.slice(1)} ${d.getDate()}`;
      if (d.toDateString() === today) el.classList.add('today');
      host.appendChild(el);
      start = k;
    }
  }
  drawMeteogram();
}

function drawMeteogram() {
  const cv = $('meteogram');
  const w = cv.clientWidth, h = cv.clientHeight, dpr = Math.min(devicePixelRatio, 2);
  cv.width = w * dpr; cv.height = h * dpr;
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  if (!state.forecast) return;
  const hours = state.forecast.hours;
  const n = hours.length;
  const X = (i) => ((i + 0.5) / n) * w;
  const top = 14, confH = 4, windH = 4, surfH = 5, plotB = h - confH - windH - surfH - 5;
  const sel = (hr) => (state.model !== 'consensus' && hr.models[state.model]) || hr.consensus;
  const hsMax = Math.max(1, ...hours.map((hr) => hr.spread.hs.max)) * 1.1;
  const Y = (v) => plotB - (v / hsMax) * (plotB - top);

  // gridlines every 1 m
  g.strokeStyle = 'rgba(255,255,255,0.08)'; g.fillStyle = 'rgba(255,255,255,0.45)';
  g.font = '10px system-ui, sans-serif'; g.lineWidth = 1;
  for (let v = 1; v < hsMax; v += 1) {
    g.beginPath(); g.moveTo(0, Y(v)); g.lineTo(w, Y(v)); g.stroke();
    g.fillText(`${v}`, 4, Y(v) - 2);
  }
  g.fillText('Hs (m) · faixa azul: dispersão entre modelos · barras: surfe, vento, confiança', w > 520 ? 40 : 4, 10);

  // model spread band
  g.beginPath();
  hours.forEach((hr, i) => (i ? g.lineTo(X(i), Y(hr.spread.hs.max)) : g.moveTo(X(i), Y(hr.spread.hs.max))));
  for (let i = n - 1; i >= 0; i--) g.lineTo(X(i), Y(hours[i].spread.hs.min));
  g.closePath(); g.fillStyle = 'rgba(120,180,255,0.22)'; g.fill();

  // selected model Hs
  g.beginPath();
  hours.forEach((hr, i) => (i ? g.lineTo(X(i), Y(sel(hr).waves.total.hs)) : g.moveTo(X(i), Y(sel(hr).waves.total.hs))));
  g.strokeStyle = '#ffffff'; g.lineWidth = 1.6; g.stroke();

  // wind strip (selected model) and confidence strip
  const bw = w / n + 0.5, c = [0, 0, 0];
  hours.forEach((hr, i) => {
    const si = surfIndex(sel(hr));
    g.fillStyle = si ? surfColor(si.score) : 'rgba(255,255,255,0.1)';
    g.fillRect((i / n) * w, plotB + 2, bw, surfH);
    windColor(sel(hr).wind.center.speed, c);
    g.fillStyle = `rgb(${c.map((x) => Math.round(x * 255)).join(',')})`;
    g.fillRect((i / n) * w, plotB + 3 + surfH, bw, windH);
    g.fillStyle = CONF_COLOR[hr.spread.level] || 'rgba(255,255,255,0.2)';
    g.fillRect((i / n) * w, plotB + 4 + surfH + windH, bw, confH);
  });
}

function updateCursor() {
  const cur = $('cursor');
  if (!state.forecast || state.mode !== 'live') { cur.style.display = 'none'; return; }
  cur.style.display = 'block';
  const n = state.forecast.hours.length;
  cur.style.left = `${((state.hourIndex + 0.5) / n) * 100}%`;
  $('cursor-label').textContent = formatTime(state.forecast.hours[state.hourIndex].time).split(', ')[1];
}

// ------------------------------------------------------------ UI bindings

function buildModelPicker() {
  const host = $('models');
  const items = [{ key: 'consensus', label: 'Consenso' }, ...MODEL_SETS];
  host.innerHTML = items.map((m) => {
    const ok = m.key === 'consensus' ? !!state.forecast : state.forecast?.available.includes(m.key);
    return `<button data-model="${m.key}" title="${m.desc || 'Média dos modelos disponíveis'}" ${ok ? '' : 'disabled'}>${m.label}</button>`;
  }).join('');
  host.onclick = (e) => {
    const k = e.target.dataset.model;
    if (!k || e.target.disabled) return;
    state.model = k;
    syncModelUI();
    drawMeteogram();
    applyCurrent();
  };
  syncModelUI();
}
function syncModelUI() {
  for (const b of $('models').children) b.classList.toggle('active', b.dataset.model === state.model);
}

function syncModeUI() {
  document.body.classList.toggle('manual', state.mode === 'manual');
  $('m-sim').classList.toggle('active', state.mode === 'manual');
  $('sim-exit').disabled = !state.forecast;
  if (state.mode === 'manual') writeManualInputs();
  updateCursor();
}

const MANUAL_FIELDS = [
  ['m-s1-hs', 'swell1', 'hs'], ['m-s1-tp', 'swell1', 'tp'], ['m-s1-dir', 'swell1', 'dir'],
  ['m-ws-hs', 'windsea', 'hs'], ['m-ws-tp', 'windsea', 'tp'], ['m-ws-dir', 'windsea', 'dir'],
  ['m-w-spd', 'wind', 'speed'], ['m-w-dir', 'wind', 'dir'], ['m-tide', null, 'tide'],
];

function writeManualInputs() {
  for (const [id, grp, key] of MANUAL_FIELDS) {
    const v = grp ? state.manual[grp][key] : state.manual[key];
    $(id).value = v;
    $(id + '-v').textContent = v;
  }
}

function openPop(id) {
  for (const p of ['sim-panel', 'settings-panel', 'info-panel']) {
    $(p).classList.toggle('hidden', p !== id || !$(p).classList.contains('hidden'));
  }
  $('m-settings').classList.toggle('active', !$('settings-panel').classList.contains('hidden'));
  $('m-info').classList.toggle('active', !$('info-panel').classList.contains('hidden'));
}

function setLayer(name, on) {
  state.layers[name] = on;
  document.querySelector(`[data-layer="${name}"]`).classList.toggle('active', on);
  if (name === 'wind') wind.lines.visible = on;
  if (name === 'arrows') swellArrows.visible = on;
  if (name === 'hs') { ocean.uniforms.uShowHs.value = on ? 1 : 0; buildLegend(); }
}

function bindUI() {
  // spot / camera presets
  const spot = $('spot');
  spot.innerHTML = Object.keys(CAMERA_PRESETS).map((k) => `<option>${k}</option>`).join('');
  if (CAMERA_PRESETS[params.get('cam')]) spot.value = params.get('cam');
  spot.onchange = () => setCamera(spot.value);

  // layers
  document.querySelectorAll('[data-layer]').forEach((b) => {
    b.onclick = () => setLayer(b.dataset.layer, !state.layers[b.dataset.layer]);
  });

  // popovers
  $('m-sim').onclick = () => {
    const opening = $('sim-panel').classList.contains('hidden');
    openPop('sim-panel');
    if (opening) { state.mode = 'manual'; state.playing = false; $('play').classList.remove('playing'); }
    else if (state.forecast) state.mode = 'live';
    syncModeUI(); applyCurrent();
  };
  $('sim-exit').onclick = () => {
    if (!state.forecast) return;
    state.mode = 'live'; $('sim-panel').classList.add('hidden'); syncModeUI(); applyCurrent();
  };
  $('m-settings').onclick = () => openPop('settings-panel');
  $('m-info').onclick = () => openPop('info-panel');

  const sel = $('scenario');
  sel.innerHTML = Object.keys(SCENARIOS).map((k) => `<option>${k}</option>`).join('');
  sel.onchange = () => { state.manual = structuredClone(SCENARIOS[sel.value]); writeManualInputs(); applyCurrent(); };
  for (const [id, grp, key] of MANUAL_FIELDS) {
    $(id).oninput = () => {
      const v = parseFloat($(id).value);
      if (grp) state.manual[grp][key] = v; else state.manual[key] = v;
      $(id + '-v').textContent = v;
      applyCurrent();
    };
  }

  // detail card
  $('detail-toggle').onclick = () => $('detail').classList.toggle('collapsed');
  if (isMobile) $('detail').classList.add('collapsed');

  // legend: cycle units like Windy
  $('legend').onclick = () => {
    if (state.layers.hs) return;
    const order = ['kmh', 'kt', 'ms'];
    state.unit = order[(order.indexOf(state.unit) + 1) % order.length];
    buildLegend();
    updateDetail(currentHour());
  };

  // timeline scrubbing
  const track = $('track');
  const scrub = (e) => {
    if (!state.forecast || state.mode !== 'live') return;
    const r = track.getBoundingClientRect();
    const n = state.forecast.hours.length;
    const i = Math.min(n - 1, Math.max(0, Math.floor(((e.clientX - r.left) / r.width) * n)));
    if (i !== state.hourIndex) { state.hourIndex = i; applyCurrent(); }
  };
  track.addEventListener('pointerdown', (e) => { track.setPointerCapture(e.pointerId); scrub(e); });
  track.addEventListener('pointermove', (e) => { if (e.buttons) scrub(e); });
  $('play').onclick = () => {
    if (state.mode !== 'live') return;
    state.playing = !state.playing;
    $('play').classList.toggle('playing', state.playing);
  };
  addEventListener('keydown', (e) => {
    if (!state.forecast || state.mode !== 'live' || e.target.tagName === 'INPUT') return;
    const n = state.forecast.hours.length;
    if (e.key === 'ArrowRight') { state.hourIndex = Math.min(n - 1, state.hourIndex + 1); applyCurrent(); }
    if (e.key === 'ArrowLeft') { state.hourIndex = Math.max(0, state.hourIndex - 1); applyCurrent(); }
  });

  // settings
  $('exag').oninput = () => { ocean.uniforms.uExag.value = +$('exag').value; $('exag-v').textContent = $('exag').value + '×'; };
  $('wind-speed').oninput = () => { wind.speedFactor = +$('wind-speed').value; $('wind-speed-v').textContent = $('wind-speed').value + '×'; };
  $('quality').value = quality;
  $('quality').onchange = () => { const u = new URL(location.href); u.searchParams.set('q', $('quality').value); location.href = u; };

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
    drawMeteogram();
  });
}

// ------------------------------------------------------------ loop

const clock = new THREE.Clock();
let simTime = 0, playAcc = 0;

function frame() {
  const dt = Math.min(clock.getDelta(), 0.1);
  simTime = (simTime + dt) % 3600;
  ocean.uniforms.uTime.value = simTime;
  surroundings.uniforms.uTime.value = simTime;
  if (wind.lines.visible) wind.update(dt);

  if (state.playing && state.mode === 'live') {
    playAcc += dt;
    if (playAcc > 0.5) {
      playAcc = 0;
      state.hourIndex = (state.hourIndex + 1) % state.forecast.hours.length;
      applyCurrent();
    }
  }

  if (camAnim) {
    camAnim.t = Math.min(1, camAnim.t + dt / 1.6);
    const s = camAnim.t * camAnim.t * (3 - 2 * camAnim.t);
    camera.position.lerpVectors(camAnim.fromE, camAnim.toE, s);
    controls.target.lerpVectors(camAnim.fromT, camAnim.toT, s);
    if (camAnim.t >= 1) camAnim = null;
  }
  controls.update();
  updateLabels();
  renderer.render(scene, camera);
}

init().catch((err) => {
  console.error(err);
  setStatus('Erro ao iniciar: ' + err.message);
});
