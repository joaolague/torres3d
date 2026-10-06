// Geographic reference for the Torres (RS) domain.
//
// Three coordinate systems are used:
//   lat/lon  - WGS84 degrees
//   EN       - local east/north in metres around ORIGIN (equirectangular, fine for ~10 km)
//   coast    - x = seaward (shore-normal), y = alongshore (towards NNE), metres
// Three.js world: X = east, Y = up, Z = -north.

export const ORIGIN = { lat: -29.347, lon: -49.727 }; // Praia Grande shoreline (approx.)

// Mean coastline bearing (from north, clockwise). The RS/SC coast near Torres runs ~N30E.
export const COAST_BEARING = 32;
const SEAWARD_BEARING = COAST_BEARING + 90;

const DEG = Math.PI / 180;
const M_PER_DEG_LAT = 110850;
const M_PER_DEG_LON = 111320 * Math.cos(ORIGIN.lat * DEG);

// Unit vectors (east, north) of the coast frame axes
export const NHAT = [Math.sin(SEAWARD_BEARING * DEG), Math.cos(SEAWARD_BEARING * DEG)];
export const THAT = [Math.sin(COAST_BEARING * DEG), Math.cos(COAST_BEARING * DEG)];

// Domain extent in the coast frame (metres)
export const DOMAIN = { x0: -1500, x1: 3500, y0: -3200, y1: 4000 };

export function lonLatToEN(lon, lat) {
  return [(lon - ORIGIN.lon) * M_PER_DEG_LON, (lat - ORIGIN.lat) * M_PER_DEG_LAT];
}

export function enToLonLat(e, n) {
  return [ORIGIN.lon + e / M_PER_DEG_LON, ORIGIN.lat + n / M_PER_DEG_LAT];
}

export function enToCoast(e, n) {
  return [e * NHAT[0] + n * NHAT[1], e * THAT[0] + n * THAT[1]];
}

export function coastToEN(x, y) {
  return [x * NHAT[0] + y * THAT[0], x * NHAT[1] + y * THAT[1]];
}

export function coastToLonLat(x, y) {
  const [e, n] = coastToEN(x, y);
  return enToLonLat(e, n);
}

export function lonLatToCoast(lon, lat) {
  const [e, n] = lonLatToEN(lon, lat);
  return enToCoast(e, n);
}

// Bearing (deg, "towards") to a unit vector in the coast frame
export function bearingToCoastVec(bearingTo) {
  const e = Math.sin(bearingTo * DEG);
  const n = Math.cos(bearingTo * DEG);
  return enToCoast(e, n);
}

// Landmarks. Positions from Sentinel-2 (25/09/2026) control points and a georeferenced map;
// headland heights from the Copernicus DEM. Accuracy is roughly ±30-50 m.
// kind: 'headland' feeds the procedural fallback terrain; 'beach'/'lake' are labels only.
export const LANDMARKS = [
  { name: 'Barra do Mampituba', lat: -29.3259, lon: -49.7102, kind: 'river' },
  { name: 'Praia dos Molhes', lat: -29.3285, lon: -49.7140, kind: 'beach' },
  { name: 'Praia Grande', lat: -29.3335, lon: -49.7180, kind: 'beach' },
  { name: 'Prainha', lat: -29.3420, lon: -49.7255, kind: 'beach' },
  { name: 'Lagoa do Violão', lat: -29.3428, lon: -49.7331, kind: 'lake' },
  { name: 'Morro do Farol', lat: -29.3454, lon: -49.7290, kind: 'headland', height: 48, protrusion: 130, width: 140 },
  { name: 'Praia da Cal', lat: -29.3483, lon: -49.7305, kind: 'beach' },
  { name: 'Morro das Furnas', lat: -29.3523, lon: -49.7303, kind: 'headland', height: 39, protrusion: 170, width: 160 },
  { name: 'Guarita', lat: -29.3560, lon: -49.7318, kind: 'headland', height: 40, protrusion: 230, width: 180 },
  { name: 'Torre Sul', lat: -29.3582, lon: -49.7356, kind: 'headland', height: 30, protrusion: 60, width: 60 },
  { name: 'Praia da Guarita', lat: -29.3595, lon: -49.7380, kind: 'beach' },
  { name: 'Praia de Itapeva', lat: -29.3690, lon: -49.7455, kind: 'beach' },
  { name: 'Ilha dos Lobos', lat: -29.3467, lon: -49.7045, kind: 'island' },
];

// Camera presets: target and camera position in coast frame (x, y, height)
export const CAMERA_PRESETS = {
  'Vista geral': { target: [200, 200, 0], eye: [4200, -2800, 1900] },
  'Praia Grande': { target: [-60, 1700, 0], eye: [700, 1000, 170] },
  'Prainha e Farol': { target: [-220, 300, 0], eye: [550, -300, 180] },
  'Guarita': { target: [40, -1000, 0], eye: [700, -1650, 170] },
  'Molhes': { target: [40, 2650, 0], eye: [800, 2050, 180] },
  'Ilha dos Lobos': { target: [1834, 1185, 0], eye: [2550, 600, 250] },
};
