// Forecast data: Open-Meteo Marine (waves, tide) + Open-Meteo Forecast (wind), plus manual scenarios.
// Open-Meteo is free for non-commercial use; a commercial product needs their paid API plan
// or a self-hosted pipeline (GFS-Wave / ECMWF / Copernicus Marine), see README.

import { DOMAIN, coastToLonLat } from './geo.js';

export const MARINE_POINT = { lat: -29.37, lon: -49.67 }; // ~5 km offshore of Praia Grande
const TZ = 'America/Sao_Paulo';

const MARINE_FULL = [
  'wave_height', 'wave_direction', 'wave_period', 'wave_peak_period',
  'wind_wave_height', 'wind_wave_direction', 'wind_wave_period', 'wind_wave_peak_period',
  'swell_wave_height', 'swell_wave_direction', 'swell_wave_period', 'swell_wave_peak_period',
  'secondary_swell_wave_height', 'secondary_swell_wave_direction', 'secondary_swell_wave_period',
  'sea_level_height_msl', 'sea_surface_temperature',
];
const MARINE_MIN = [
  'wave_height', 'wave_direction', 'wave_period',
  'wind_wave_height', 'wind_wave_direction', 'wind_wave_period',
  'swell_wave_height', 'swell_wave_direction', 'swell_wave_period',
];

async function getJSON(url, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

// 3 x 3 grid of wind points covering the domain (in lon/lat)
export function windGridPoints() {
  const pts = [];
  for (let j = 0; j < 3; j++) {
    for (let i = 0; i < 3; i++) {
      const x = DOMAIN.x0 + (i * (DOMAIN.x1 - DOMAIN.x0)) / 2;
      const y = DOMAIN.y0 + (j * (DOMAIN.y1 - DOMAIN.y0)) / 2;
      const [lon, lat] = coastToLonLat(x, y);
      pts.push({ i, j, x, y, lat: +lat.toFixed(4), lon: +lon.toFixed(4) });
    }
  }
  return pts;
}

const num = (a, k) => (a && Number.isFinite(a[k]) ? a[k] : null);
// When only the mean period is available, approximate the peak period (JONSWAP: Tp ~ 1.2 Tm01)
const peak = (tp, tm) => (tp ?? (tm != null ? tm * 1.2 : null));

// Fill interior gaps (e.g. 3-hourly models) by linear interpolation; directions on the circle
function fillGaps(arr, circular = false) {
  if (!arr) return arr;
  const out = arr.slice();
  let last = -1;
  for (let k = 0; k < out.length; k++) {
    if (!Number.isFinite(out[k])) continue;
    if (last >= 0 && k - last > 1) {
      let d = out[k] - out[last];
      if (circular) d = ((d + 540) % 360) - 180;
      for (let m = last + 1; m < k; m++) {
        let v = out[last] + (d * (m - last)) / (k - last);
        if (circular) v = (v + 360) % 360;
        out[m] = v;
      }
    }
    last = k;
  }
  return out;
}

// Model sets: a wave model paired with an atmospheric model from the same family
export const MODEL_SETS = [
  { key: 'ecmwf', label: 'ECMWF', wave: 'ecmwf_wam025', wind: 'ecmwf_ifs025', desc: 'ECMWF WAM + IFS' },
  { key: 'gfs', label: 'GFS', wave: 'ncep_gfswave025', wind: 'gfs_seamless', desc: 'NOAA GFS-Wave + GFS' },
  { key: 'mf', label: 'MF/ICON', wave: 'meteofrance_wave', wind: 'icon_seamless', desc: 'Météo-France MFWAM + DWD ICON' },
];

async function fetchMarine(model, days) {
  const base = `https://marine-api.open-meteo.com/v1/marine?latitude=${MARINE_POINT.lat}&longitude=${MARINE_POINT.lon}` +
    `&timezone=${encodeURIComponent(TZ)}&forecast_days=${days}` + (model ? `&models=${model}` : '') + '&hourly=';
  try {
    return await getJSON(base + MARINE_FULL.join(','));
  } catch (err) {
    console.warn(`Marine ${model || 'best_match'}: full request failed, retrying minimal`, err);
    return getJSON(base + MARINE_MIN.join(','));
  }
}

async function fetchWind(model, pts, days) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${pts.map((p) => p.lat).join(',')}` +
    `&longitude=${pts.map((p) => p.lon).join(',')}&hourly=wind_speed_10m,wind_direction_10m,wind_gusts_10m` +
    `&wind_speed_unit=ms&timezone=${encodeURIComponent(TZ)}&forecast_days=${days}` + (model ? `&models=${model}` : '');
  const w = await getJSON(url);
  return Array.isArray(w) ? w : [w];
}

function buildHours(times, marine, wind, pts) {
  const mh = marine.hourly;
  const g = {};
  for (const k of Object.keys(mh)) if (k !== 'time') g[k] = fillGaps(mh[k], k.endsWith('direction'));
  const mIndex = new Map(mh.time.map((t, k) => [t, k]));
  const wIndex = new Map(wind[0].hourly.time.map((t, k) => [t, k]));
  const wfill = wind.map((w) => ({
    s: fillGaps(w.hourly.wind_speed_10m), d: fillGaps(w.hourly.wind_direction_10m, true), g: fillGaps(w.hourly.wind_gusts_10m),
  }));
  return times.map((t) => {
    const k = mIndex.get(t), wk = wIndex.get(t);
    if (k == null || wk == null) return null;
    const windsea = { hs: num(g.wind_wave_height, k), tp: peak(num(g.wind_wave_peak_period, k), num(g.wind_wave_period, k)), dir: num(g.wind_wave_direction, k) };
    const swell1 = { hs: num(g.swell_wave_height, k), tp: peak(num(g.swell_wave_peak_period, k), num(g.swell_wave_period, k)), dir: num(g.swell_wave_direction, k) };
    const swell2 = { hs: num(g.secondary_swell_wave_height, k), tp: peak(null, num(g.secondary_swell_wave_period, k)), dir: num(g.secondary_swell_wave_direction, k) };
    const total = { hs: num(g.wave_height, k), tp: peak(num(g.wave_peak_period, k), num(g.wave_period, k)), dir: num(g.wave_direction, k) };
    const grid = pts.map((p, m) => ({ x: p.x, y: p.y, speed: num(wfill[m].s, wk), dir: num(wfill[m].d, wk), gust: num(wfill[m].g, wk) }));
    if (total.hs == null || grid.some((q) => q.speed == null || q.dir == null)) return null;
    return { time: t, waves: { windsea, swell1, swell2, total }, wind: { grid, center: grid[4] } };
  });
}

// ---- consensus and spread across model sets

const DEG = Math.PI / 180;
function circMean(dirs, weights) {
  let sx = 0, sy = 0;
  dirs.forEach((d, i) => { const w = weights ? weights[i] : 1; sx += w * Math.sin(d * DEG); sy += w * Math.cos(d * DEG); });
  return (Math.atan2(sx, sy) / DEG + 360) % 360;
}
const angDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;

function meanPartition(list) {
  const ok = list.filter((p) => p && p.hs != null && p.tp != null && p.dir != null);
  if (!ok.length) return { hs: null, tp: null, dir: null };
  return { hs: mean(ok.map((p) => p.hs)), tp: mean(ok.map((p) => p.tp)), dir: circMean(ok.map((p) => p.dir), ok.map((p) => p.hs)) };
}

function consensusHour(hours) {
  const w = (key) => meanPartition(hours.map((h) => h.waves[key]));
  const grid = hours[0].wind.grid.map((p, m) => {
    let u = 0, v = 0, gust = 0, ng = 0;
    for (const h of hours) {
      const q = h.wind.grid[m];
      u += -q.speed * Math.sin(q.dir * DEG); v += -q.speed * Math.cos(q.dir * DEG);
      if (q.gust != null) { gust += q.gust; ng++; }
    }
    u /= hours.length; v /= hours.length;
    return { x: p.x, y: p.y, speed: Math.hypot(u, v), dir: (Math.atan2(-u, -v) / DEG + 360) % 360, gust: ng ? gust / ng : null };
  });
  return {
    time: hours[0].time,
    waves: { windsea: w('windsea'), swell1: w('swell1'), swell2: w('swell2'), total: w('total') },
    wind: { grid, center: grid[4] },
  };
}

// Agreement between models -> 0 (high confidence) .. 1 (low confidence)
function spreadOf(hours) {
  const hs = hours.map((h) => h.waves.total.hs);
  const tp = hours.map((h) => h.waves.total.tp).filter((v) => v != null);
  const wdir = hours.map((h) => h.waves.total.dir).filter((v) => v != null);
  const ws = hours.map((h) => h.wind.center.speed);
  const wd = hours.map((h) => h.wind.center.dir);
  const hsMean = mean(hs), wsMean = mean(ws);
  const wdirMean = wdir.length ? circMean(wdir) : null;
  const wdMean = circMean(wd, ws);
  const s = {
    n: hours.length,
    hs: { min: Math.min(...hs), max: Math.max(...hs), mean: hsMean },
    tp: tp.length ? { min: Math.min(...tp), max: Math.max(...tp) } : null,
    waveDir: wdirMean == null ? null : Math.max(...wdir.map((d) => angDiff(d, wdirMean))),
    wind: { min: Math.min(...ws), max: Math.max(...ws), mean: wsMean },
    windDir: Math.max(...wd.map((d) => angDiff(d, wdMean))),
  };
  if (s.n < 2) { s.score = null; s.level = 'n/d'; return s; }
  const uHs = (s.hs.max - s.hs.min) / Math.max(hsMean, 0.5);
  const uWdir = (s.waveDir ?? 0) / 60;
  const uWs = (s.wind.max - s.wind.min) / Math.max(wsMean, 3);
  const uWd = (s.windDir / 90) * Math.min(1, wsMean / 5); // direction matters little in light wind
  s.score = Math.min(1, 0.35 * uHs + 0.15 * uWdir + 0.3 * uWs + 0.2 * uWd);
  s.level = s.score < 0.2 ? 'alta' : s.score < 0.4 ? 'media' : 'baixa';
  return s;
}

export async function fetchForecast(days = 7, onStatus) {
  const pts = windGridPoints();
  onStatus?.('Baixando previsões (ECMWF, GFS, Météo-France, ICON)…');
  const settled = await Promise.allSettled([
    fetchMarine(null, days).catch(() => null), // best match: tide and SST
    ...MODEL_SETS.map((m) => Promise.all([fetchMarine(m.wave, days), fetchWind(m.wind, pts, days)])),
  ]);
  const base = settled[0].status === 'fulfilled' ? settled[0].value : null;

  const sets = {};
  let times = null;
  MODEL_SETS.forEach((m, i) => {
    const r = settled[i + 1];
    if (r.status !== 'fulfilled') { console.warn(`Model set ${m.key} unavailable`, r.reason); return; }
    const [marine, wind] = r.value;
    times ??= marine.hourly.time;
    const hours = buildHours(times, marine, wind, pts);
    if (hours.filter(Boolean).length < hours.length * 0.5) { console.warn(`Model set ${m.key}: too many gaps`); return; }
    sets[m.key] = hours;
  });
  const keys = Object.keys(sets);
  if (!keys.length) throw new Error('no forecast model available');

  const tide = base ? fillGaps(base.hourly.sea_level_height_msl) : null;
  const sst = base ? fillGaps(base.hourly.sea_surface_temperature) : null;
  const tIndex = base ? new Map(base.hourly.time.map((t, k) => [t, k])) : new Map();

  const hours = [];
  times.forEach((t, k) => {
    const per = {};
    for (const key of keys) if (sets[key][k]) per[key] = sets[key][k];
    const avail = Object.values(per);
    if (!avail.length) return;
    const tk = tIndex.get(t);
    const extra = { tide: tk != null ? num(tide, tk) ?? 0 : 0, sst: tk != null ? num(sst, tk) : null };
    for (const h of avail) Object.assign(h, extra);
    const cons = Object.assign(consensusHour(avail), extra);
    hours.push({ time: t, models: per, consensus: cons, spread: spreadOf(avail) });
  });
  if (!hours.length) throw new Error('empty forecast');
  return { source: 'Open-Meteo: ' + keys.map((k) => MODEL_SETS.find((m) => m.key === k).desc).join(' · '), live: true, available: keys, hours };
}

// ------------------------------------------------------------ manual scenarios

export const SCENARIOS = {
  'Swell de leste + terral': {
    swell1: { hs: 1.5, tp: 11, dir: 110 }, swell2: { hs: 0.5, tp: 8, dir: 150 },
    windsea: { hs: 0.2, tp: 3.5, dir: 290 }, wind: { speed: 4, dir: 290 }, tide: 0.2,
  },
  'Ressaca de sul (frente fria)': {
    swell1: { hs: 2.8, tp: 13, dir: 165 }, swell2: { hs: 0.8, tp: 9, dir: 120 },
    windsea: { hs: 1.3, tp: 7, dir: 205 }, wind: { speed: 14, dir: 210 }, tide: 0.5,
  },
  'Nordestão de verão': {
    swell1: { hs: 0.6, tp: 9, dir: 100 }, swell2: { hs: 0, tp: 8, dir: 150 },
    windsea: { hs: 1.4, tp: 6, dir: 45 }, wind: { speed: 10, dir: 45 }, tide: 0,
  },
  'Mar calmo': {
    swell1: { hs: 0.6, tp: 10, dir: 120 }, swell2: { hs: 0, tp: 8, dir: 150 },
    windsea: { hs: 0.15, tp: 3, dir: 90 }, wind: { speed: 2.5, dir: 90 }, tide: 0,
  },
};

export function scenarioToHour(s) {
  const grid = windGridPoints().map((p) => ({ x: p.x, y: p.y, speed: s.wind.speed, dir: s.wind.dir, gust: s.wind.speed * 1.35 }));
  const parts = [s.swell1, s.swell2, s.windsea].filter((p) => p.hs > 0);
  const hsTot = Math.sqrt(parts.reduce((a, p) => a + p.hs * p.hs, 0));
  const dom = parts.reduce((a, p) => (p.hs * p.hs * p.tp > a.hs * a.hs * a.tp ? p : a), parts[0] || s.swell1);
  return {
    time: null,
    waves: {
      swell1: { ...s.swell1 }, swell2: { ...s.swell2 }, windsea: { ...s.windsea },
      total: { hs: hsTot, tp: dom.tp, dir: dom.dir },
    },
    tide: s.tide ?? 0,
    sst: null,
    wind: { grid, center: grid[4] },
  };
}

export function hourToPartitions(hour) {
  const w = hour.waves;
  const out = [];
  const add = (key, p) => {
    if (p && p.hs != null && p.tp != null && p.dir != null && p.hs > 0.02) out.push({ key, hs: p.hs, tp: p.tp, dirFrom: p.dir });
  };
  add('swell1', w.swell1);
  add('swell2', w.swell2);
  add('windsea', w.windsea);
  // Model gave only the total sea state: treat it as a single swell partition
  if (!out.length && w.total?.hs) out.push({ key: 'swell1', hs: w.total.hs, tp: w.total.tp ?? 8, dirFrom: w.total.dir ?? 120 });
  return out;
}

export function compassLabel(deg) {
  if (deg == null) return '–';
  const names = ['N', 'NNE', 'NE', 'ENE', 'L', 'ESE', 'SE', 'SSE', 'S', 'SSO', 'SO', 'OSO', 'O', 'ONO', 'NO', 'NNO'];
  return names[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}
