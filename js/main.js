import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Sky } from 'three/addons/objects/Sky.js';

import { LANDMARKS, CAMERA_PRESETS, lonLatToCoast } from './geo.js';
import { buildTerrain, createTerrainMesh, createDepthTexture, coastToWorld } from './terrain.js';
import { buildComponents, buildPhaseTexture } from './spectrum.js';
import { createOcean, createSurroundings } from './ocean.js';
import { WindField, WIND_LEGEND } from './wind.js';
import { fetchForecast, SCENARIOS, scenarioToHour, hourToPartitions, compassLabel } from './data.js';

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
  current: null,
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

// ------------------------------------------------------------ UI helpers

function setStatus(msg) { $('loading-msg').textContent = msg; }
const fmt = (v, d = 1) => (v == null || !Number.isFinite(v) ? '–' : v.toFixed(d));
const dirTxt = (d) => (d == null ? '–' : `${Math.round(d)}° ${compassLabel(d)}`);

function formatTime(iso) {
  if (!iso) return 'Cenário manual';
  const d = new Date(iso + ':00');
  const wd = d.toLocaleDateString('pt-BR', { weekday: 'short' });
  return `${wd} ${d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })} ${iso.slice(11, 16)}`;
}

function buildLegend() {
  const el = $('wind-legend');
  el.innerHTML = '<span class="lg-title">Vento (m/s)</span>' + WIND_LEGEND.map((s) =>
    `<span class="lg-item"><i style="background:${s.color}"></i>${s.speed}</span>`).join('');
}

// ------------------------------------------------------------ main

let terrain, ocean, wind, phaseTex, labels = [], swellArrows, surroundings;

async function init() {
  buildLegend();
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

  setStatus('Baixando previsão (Open-Meteo)…');
  try {
    state.forecast = await fetchForecast(7);
    state.mode = 'live';
    const now = new Date();
    const idx = state.forecast.hours.findIndex((h) => new Date(h.time + ':00') >= now);
    state.hourIndex = Math.max(0, idx - 1);
    $('time-slider').max = state.forecast.hours.length - 1;
    $('time-slider').value = state.hourIndex;
    $('src-data').textContent = state.forecast.source;
  } catch (err) {
    console.warn('Forecast unavailable:', err);
    state.mode = 'manual';
    $('mode-live').disabled = true;
    $('src-data').textContent = 'Previsão indisponível (sem conexão com a Open-Meteo) – usando cenário manual';
  }
  syncModeUI();
  applyCurrent();
  $('loading').classList.add('hidden');
  renderer.setAnimationLoop(frame);
}

function currentHour() {
  if (state.mode === 'live' && state.forecast) return state.forecast.hours[state.hourIndex];
  return scenarioToHour(state.manual);
}

function applyCurrent() {
  const hour = currentHour();
  state.current = hour;
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
  updateReadout(hour);
}

function updateReadout(h) {
  const w = h.waves;
  $('time-label').textContent = formatTime(h.time);
  const row = (name, p) => `<tr><td>${name}</td><td>${fmt(p?.hs)} m</td><td>${fmt(p?.tp, 0)} s</td><td>${dirTxt(p?.dir)}</td></tr>`;
  $('waves-table').innerHTML =
    '<tr><th></th><th>Hs</th><th>Tp</th><th>Direção</th></tr>' +
    row('Total', w.total) + row('Swell 1', w.swell1) + row('Swell 2', w.swell2) + row('Mar de vento', w.windsea);
  const c = h.wind.center;
  $('wind-readout').innerHTML =
    `<b>${fmt(c.speed * 3.6, 0)} km/h</b> (${fmt(c.speed * 1.944, 0)} nós) de ${dirTxt(c.dir)}` +
    (c.gust != null ? ` · rajadas ${fmt(c.gust * 3.6, 0)} km/h` : '');
  $('extra-readout').textContent =
    `Nível do mar (maré + meteorológica): ${fmt(h.tide, 2)} m` + (h.sst != null ? ` · Temp. da água ${fmt(h.sst, 1)} °C` : '');
}

// Arrows offshore showing incoming partitions (length ~ Hs)
function updateSwellArrows(parts) {
  swellArrows.clear();
  const colors = { swell1: 0x2f8cff, swell2: 0x9b6bff, windsea: 0xffb02e };
  parts.forEach((p, i) => {
    const to = ((p.dirFrom + 180) * Math.PI) / 180;
    const dir = new THREE.Vector3(Math.sin(to), 0, -Math.cos(to));
    const len = 250 + p.hs * 300;
    const origin = coastToWorld(3100, 200 + (i - 1) * 900, 40).sub(dir.clone().multiplyScalar(len / 2));
    const arrow = new THREE.ArrowHelper(dir, origin, len, colors[p.key], 120, 70);
    swellArrows.add(arrow);
  });
}

function createLabels() {
  const host = $('labels');
  for (const l of LANDMARKS) {
    const [x, y] = lonLatToCoast(l.lon, l.lat);
    const h = l.kind === 'headland' ? l.height + 15 : 12;
    const el = document.createElement('div');
    el.className = 'label ' + l.kind;
    el.textContent = l.name;
    host.appendChild(el);
    labels.push({ el, pos: coastToWorld(x, y, h) });
  }
}

const tmpV = new THREE.Vector3();
function updateLabels() {
  const show = $('layer-labels').checked;
  for (const l of labels) {
    tmpV.copy(l.pos).project(camera);
    const dist = camera.position.distanceTo(l.pos);
    const vis = show && tmpV.z < 1 && Math.abs(tmpV.x) < 1.1 && Math.abs(tmpV.y) < 1.1 && dist < 9000;
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

// ------------------------------------------------------------ UI bindings

function syncModeUI() {
  $('mode-live').classList.toggle('active', state.mode === 'live');
  $('mode-manual').classList.toggle('active', state.mode === 'manual');
  $('timeline').classList.toggle('hidden', state.mode !== 'live');
  $('manual-panel').classList.toggle('hidden', state.mode !== 'manual');
  if (state.mode === 'manual') writeManualInputs();
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

function bindUI() {
  $('mode-live').onclick = () => { if (state.forecast) { state.mode = 'live'; syncModeUI(); applyCurrent(); } };
  $('mode-manual').onclick = () => { state.mode = 'manual'; state.playing = false; syncModeUI(); applyCurrent(); };

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

  $('time-slider').oninput = () => { state.hourIndex = +$('time-slider').value; applyCurrent(); };
  $('play').onclick = () => {
    state.playing = !state.playing;
    $('play').textContent = state.playing ? '❚❚' : '▶';
  };

  const cams = $('cameras');
  cams.innerHTML = Object.keys(CAMERA_PRESETS).map((k) => `<button data-cam="${k}">${k}</button>`).join('');
  cams.onclick = (e) => { const k = e.target.dataset.cam; if (k) setCamera(k); };

  $('layer-wind').onchange = () => { wind.lines.visible = $('layer-wind').checked; };
  $('layer-hs').onchange = () => { ocean.uniforms.uShowHs.value = $('layer-hs').checked ? 1 : 0; $('hs-legend').classList.toggle('hidden', !$('layer-hs').checked); };
  $('layer-arrows').onchange = () => { swellArrows.visible = $('layer-arrows').checked; };
  $('exag').oninput = () => { ocean.uniforms.uExag.value = +$('exag').value; $('exag-v').textContent = $('exag').value + '×'; };
  $('wind-speed').oninput = () => { wind.speedFactor = +$('wind-speed').value; $('wind-speed-v').textContent = $('wind-speed').value + '×'; };

  $('panel-toggle').onclick = () => $('panel').classList.toggle('collapsed');
  if (isMobile) $('panel').classList.add('collapsed');
  $('quality').value = quality;
  $('quality').onchange = () => { const u = new URL(location.href); u.searchParams.set('q', $('quality').value); location.href = u; };

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
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
    if (playAcc > 0.6) {
      playAcc = 0;
      state.hourIndex = (state.hourIndex + 1) % state.forecast.hours.length;
      $('time-slider').value = state.hourIndex;
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
