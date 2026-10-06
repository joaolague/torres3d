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

export async function fetchForecast(days = 7) {
  const base = `https://marine-api.open-meteo.com/v1/marine?latitude=${MARINE_POINT.lat}&longitude=${MARINE_POINT.lon}` +
    `&timezone=${encodeURIComponent(TZ)}&forecast_days=${days}&hourly=`;
  let marine;
  try {
    marine = await getJSON(base + MARINE_FULL.join(','));
  } catch (err) {
    console.warn('Full marine request failed, retrying with minimal variables', err);
    marine = await getJSON(base + MARINE_MIN.join(','));
  }

  const pts = windGridPoints();
  const wurl = `https://api.open-meteo.com/v1/forecast?latitude=${pts.map((p) => p.lat).join(',')}` +
    `&longitude=${pts.map((p) => p.lon).join(',')}&hourly=wind_speed_10m,wind_direction_10m,wind_gusts_10m` +
    `&wind_speed_unit=ms&timezone=${encodeURIComponent(TZ)}&forecast_days=${days}`;
  let wind = await getJSON(wurl);
  if (!Array.isArray(wind)) wind = [wind];

  const mh = marine.hourly;
  const windIndex = new Map(wind[0].hourly.time.map((t, k) => [t, k]));
  const hours = [];
  mh.time.forEach((t, k) => {
    const wk = windIndex.get(t);
    if (wk == null) return;
    const windsea = { hs: num(mh.wind_wave_height, k), tp: peak(num(mh.wind_wave_peak_period, k), num(mh.wind_wave_period, k)), dir: num(mh.wind_wave_direction, k) };
    const swell1 = { hs: num(mh.swell_wave_height, k), tp: peak(num(mh.swell_wave_peak_period, k), num(mh.swell_wave_period, k)), dir: num(mh.swell_wave_direction, k) };
    const swell2 = { hs: num(mh.secondary_swell_wave_height, k), tp: peak(null, num(mh.secondary_swell_wave_period, k)), dir: num(mh.secondary_swell_wave_direction, k) };
    const total = { hs: num(mh.wave_height, k), tp: peak(num(mh.wave_peak_period, k), num(mh.wave_period, k)), dir: num(mh.wave_direction, k) };
    const grid = pts.map((p, m) => {
      const h = wind[m].hourly;
      return { x: p.x, y: p.y, speed: num(h.wind_speed_10m, wk) ?? 0, dir: num(h.wind_direction_10m, wk) ?? 0, gust: num(h.wind_gusts_10m, wk) };
    });
    hours.push({
      time: t,
      waves: { windsea, swell1, swell2, total },
      tide: num(mh.sea_level_height_msl, k) ?? 0,
      sst: num(mh.sea_surface_temperature, k),
      wind: { grid, center: grid[4] },
    });
  });
  if (!hours.length) throw new Error('empty forecast');
  return { source: 'Open-Meteo (ondas: modelos MeteoFrance/ECMWF/NCEP; vento: best match)', live: true, hours };
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
