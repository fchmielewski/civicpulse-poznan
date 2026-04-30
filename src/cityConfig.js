/* ============================================
   CivicPulse — City Configuration
   Central registry of supported cities and a
   shared API URL helper used by every layer.
   ============================================ */

export const CITIES = {
  poznan: {
    id: 'poznan',
    name: 'Poznań',
    country: 'PL',
    center: [16.9252, 52.4064],
    zoom: 15.5,
    pitch: 60,
    bearing: -17.6,
    // MapLibre LngLatBounds → [[minLng, minLat], [maxLng, maxLat]]. Used for
    // map.setMaxBounds() and to filter out-of-bounds search results.
    bounds: [[16.80, 52.35], [17.05, 52.47]],
    riverName: 'Warta',
    hydroWarningCm: 400,
    hydroAlarmCm: 500,
    layers: {
      tram: true,
      bus: true,
      metro: false,            // no metro in Poznań
      carTraffic: true,
      bicycleCounters: true,
      parking: true,
      bikeSharing: false,
      emf: true,
      mobile: true,
      tor: true,
      connectionPoints: true,
      wifi: true,
      electricity: true,
      atms: true,
      trafficLights: true,
      cctv: true,
      environment: true,
      parcels: true,
      emergency: true,
      billboards: true,
      hydro: true
    }
  },
  lodz: {
    id: 'lodz',
    name: 'Łódź',
    country: 'PL',
    center: [19.4560, 51.7592],
    zoom: 15.5,
    pitch: 60,
    bearing: 0,
    bounds: [[19.35, 51.68], [19.58, 51.82]],
    // No major river runs through Łódź — the Ner is south/west of the city.
    // The closest IMGW gauge (Poddębice) is ~50 km away, so we don't claim it.
    riverName: null,
    hydroWarningCm: null,
    hydroAlarmCm: null,
    layers: {
      tram: true,
      bus: true,
      metro: false,            // no metro in Łódź
      carTraffic: true,
      bicycleCounters: false,
      parking: false,
      bikeSharing: false, // Łódzki Rower Publiczny discontinued; no open real-time feed
      emf: true,
      mobile: true,
      tor: true,
      connectionPoints: true,
      wifi: true,
      electricity: true,
      atms: true,
      trafficLights: true,
      cctv: true,
      environment: true,
      parcels: true,
      emergency: true,
      billboards: true,
      hydro: false  // Ner river is not in Łódź; no honest gauge to display
    }
  },
  warszawa: {
    id: 'warszawa',
    name: 'Warszawa',
    country: 'PL',
    // Pałac Kultury i Nauki — the unmistakable city-centre landmark.
    center: [21.0067, 52.2319],
    // Warsaw is roughly 2× the diameter of Poznań/Łódź, so we open one
    // zoom-step further out so the whole inner city is visible at landing.
    zoom: 14.2,
    pitch: 60,
    bearing: 0,
    bounds: [[20.85, 52.10], [21.28, 52.37]],
    riverName: 'Wisła',
    // Official IMGW thresholds for Warszawa-Bulwary gauge.
    hydroWarningCm: 600,
    hydroAlarmCm: 650,
    layers: {
      tram: true,             // 30 tram routes
      bus: true,              // 295 bus routes
      metro: true,            // M1 + M2 (route_type=1) + SKM rail S1–S40 (route_type=2)
      carTraffic: true,
      bicycleCounters: false, // api.um.warszawa.pl needs an apikey we don't have
      parking: false,         // no key-less SPPN occupancy feed
      bikeSharing: true,      // Veturilo 3.0 (344 stations) via CityBikes mirror
      emf: true,
      mobile: true,
      tor: true,
      connectionPoints: true,
      wifi: true,
      electricity: true,
      atms: true,
      trafficLights: true,
      cctv: true,
      environment: true,
      parcels: true,
      emergency: true,
      billboards: true,
      hydro: true             // Wisła @ Warszawa-Bulwary
    }
  }
};

// In production, the Express server serves both the API and the static files
// on the same origin, so we use a relative URL. In local dev (Vite on :5173),
// we need to point at the Express server on :3001 explicitly.
const isLocalDev = typeof window !== 'undefined' &&
  window.location.hostname === 'localhost' &&
  window.location.port !== '';
const API_BASE = isLocalDev ? 'http://localhost:3001/api' : '/api';
const DEFAULT_CITY = 'poznan';

let currentCityId = DEFAULT_CITY;

export function getCurrentCity() {
  return currentCityId;
}

export function setCurrentCity(cityId) {
  if (!CITIES[cityId]) {
    throw new Error(`[cityConfig] Unknown city: ${cityId}`);
  }
  currentCityId = cityId;
}

export function getCityConfig() {
  return CITIES[currentCityId];
}

export function apiUrl(endpoint) {
  const e = endpoint.startsWith('/') ? endpoint.slice(1) : endpoint;
  const sep = e.includes('?') ? '&' : '?';
  return `${API_BASE}/${e}${sep}city=${currentCityId}`;
}

// Fetch a GeoJSON FeatureCollection endpoint and degrade gracefully when
// the upstream returned an error envelope (e.g. Warsaw's larger Overpass
// bbox occasionally times out, and the server responds with `{error,
// message}` instead of GeoJSON). Layer modules can call this and rely on
// always getting `{type:'FeatureCollection', features:[]}` at worst —
// they then init an empty source/layer rather than crashing on
// `data.features.forEach`.
const EMPTY_FC = Object.freeze({ type: 'FeatureCollection', features: [] });

export async function fetchGeoJSON(endpoint) {
  try {
    const res = await fetch(apiUrl(endpoint));
    if (!res.ok) return { ...EMPTY_FC };
    const data = await res.json();
    if (data && Array.isArray(data.features)) return data;
    return { ...EMPTY_FC };
  } catch (_) {
    return { ...EMPTY_FC };
  }
}

export function layerEnabled(layerName) {
  const cfg = CITIES[currentCityId];
  return cfg && cfg.layers && cfg.layers[layerName] === true;
}
