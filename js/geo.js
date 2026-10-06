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

// Landmarks. Hill and river-mouth positions were checked against the Copernicus DEM 30 m
// (peaks and the Mampituba channel); beach label positions and Ilha dos Lobos are approximate.
// kind: 'headland' feeds the procedural fallback terrain; 'beach' is label only.
export const LANDMARKS = [
  { name: 'Barra do Mampituba (Molhes)', lat: -29.3258, lon: -49.7160, kind: 'river' },
  { name: 'Praia dos Molhes', lat: -29.3300, lon: -49.7165, kind: 'beach' },
  { name: 'Morro do Farol', lat: -29.3400, lon: -49.7262, kind: 'headland', height: 34, protrusion: 150, width: 160 },
  { name: 'Morro das Furnas', lat: -29.3452, lon: -49.7290, kind: 'headland', height: 48, protrusion: 140, width: 150 },
  { name: 'Praia Grande', lat: -29.3495, lon: -49.7310, kind: 'beach' },
  { name: 'Guarita (Torre Sul)', lat: -29.3540, lon: -49.7315, kind: 'headland', height: 40, protrusion: 190, width: 180 },
  { name: 'Praia de Itapeva', lat: -29.3680, lon: -49.7445, kind: 'beach' },
  { name: 'Ilha dos Lobos', lat: -29.3445, lon: -49.7010, kind: 'island' },
];

// Camera presets: target and camera position in coast frame (x, y, height)
export const CAMERA_PRESETS = {
  'Vista geral': { target: [300, 0, 0], eye: [4200, -2800, 1900] },
  'Praia Grande': { target: [-80, -420, 0], eye: [700, -1150, 160] },
  'Farol e Furnas': { target: [-280, 380, 0], eye: [550, -250, 180] },
  'Guarita': { target: [40, -900, 0], eye: [650, -1550, 140] },
  'Molhes': { target: [-320, 2560, 0], eye: [450, 1900, 170] },
  'Ilha dos Lobos': { target: [1950, 1550, 0], eye: [2700, 900, 250] },
};
