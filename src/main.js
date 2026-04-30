/* ============================================
   CivicPulse — Main Application
   Multi-city shell (Poznań, Łódź, Warszawa)
   ============================================ */
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import maplibregl from 'maplibre-gl';
import { CITIES, setCurrentCity, getCurrentCity, getCityConfig } from './cityConfig.js';
import { clearNetworkLinks } from './network.js';

// Layer modules are intentionally NOT imported eagerly — each one carries
// its own popup/animation/fetch logic and would bloat the initial JS
// payload by ~200 KB unminified. Instead the LAYER_REGISTRY below holds
// dynamic-import factories, and a layer module is fetched only when the
// active city actually needs it. Vite emits one chunk per module, all
// shareable across cities (e.g. WiFi.js loads once for Poznań and is
// served from cache when the user switches to Warszawa).

// --- Loading screen ---
const loadingBar = document.querySelector('.loading-bar');
const loadingStatus = document.querySelector('.loading-status');
const loadingScreen = document.getElementById('loading-screen');

let loadProgress = 0;
let loadInterval = null;
let statusInterval = null;

const statusMessages = [
  'INITIALIZING CITY GRID...',
  'LOADING BUILDING GEOMETRIES...',
  'MAPPING ROAD NETWORK...',
  'RENDERING 3D STRUCTURES...',
  'ESTABLISHING UPLINK...',
  'CONNECTING TO CivicPulse...',
  'SYSTEM READY.'
];

function startLoadingAnimation() {
  // Clear any in-flight loaders — switch flow may call this while the
  // initial-load intervals are still running.
  if (loadInterval) clearInterval(loadInterval);
  if (statusInterval) clearInterval(statusInterval);
  loadProgress = 0;
  loadingBar.style.width = '0%';

  loadInterval = setInterval(() => {
    loadProgress = Math.min(loadProgress + Math.random() * 15, 95);
    loadingBar.style.width = loadProgress + '%';
  }, 200);

  let statusIdx = 0;
  statusInterval = setInterval(() => {
    statusIdx = (statusIdx + 1) % statusMessages.length;
    loadingStatus.textContent = statusMessages[statusIdx];
  }, 800);
}

// --- City selection screen ---
const citySelectScreen = document.getElementById('city-select-screen');
const citySelectBtn = document.getElementById('city-select-btn');
const cityOptions = document.querySelectorAll('.city-option');
const cityNodes = document.querySelectorAll('.city-node');
let selectedCity = null;
let mapInitialized = false;

function selectCity(cityId) {
  if (!CITIES[cityId]) return;
  selectedCity = cityId;
  cityOptions.forEach(opt => opt.classList.toggle('selected', opt.dataset.city === cityId));
  cityNodes.forEach(node => node.classList.toggle('selected', node.dataset.city === cityId));
  citySelectBtn.disabled = false;
  citySelectBtn.querySelector('.btn-arrow').textContent = '›';
}

cityOptions.forEach(option => {
  if (option.classList.contains('city-option-available')) {
    option.addEventListener('click', () => selectCity(option.dataset.city));
  }
});

cityNodes.forEach(node => {
  if (node.classList.contains('city-available')) {
    node.addEventListener('click', () => selectCity(node.dataset.city));
  }
});

citySelectBtn.addEventListener('click', () => {
  if (!selectedCity) return;
  enterCity();
});

function enterCity() {
  const previousCity = mapInitialized ? getCurrentCity() : null;
  const isSwitching = mapInitialized && previousCity !== selectedCity;
  const isReopen   = mapInitialized && previousCity === selectedCity;

  // Re-opening the city-select for the same city → just dismiss, no work.
  if (isReopen) {
    citySelectScreen.classList.add('hidden');
    return;
  }

  setCurrentCity(selectedCity);
  applyCityBranding();
  citySelectScreen.classList.add('hidden');

  // First-ever load → spin up the map and let its 'load' event drive everything.
  if (!mapInitialized) {
    mapInitialized = true;
    loadingScreen.classList.remove('pending');
    startLoadingAnimation();
    initMap();
    return;
  }

  // In-place city switch — same map instance, swap layers and fly to the new
  // city. Show the loading screen while we do the network round-trips.
  if (isSwitching) {
    loadingScreen.classList.remove('hidden', 'pending');
    startLoadingAnimation();
    destroyAllLayers();
    const cfg = getCityConfig();
    cameraDefaults = { center: cfg.center, zoom: cfg.zoom, pitch: cfg.pitch, bearing: cfg.bearing };
    // Lift maxBounds for the duration of the inter-city flyTo; otherwise the
    // old city's bounds would constrain the camera and the animation would
    // get clipped en route to the new city.
    map.setMaxBounds(null);
    map.flyTo({
      center: cfg.center, zoom: cfg.zoom, pitch: cfg.pitch, bearing: cfg.bearing,
      duration: 1400, essential: true
    });
    // Wait for the camera to settle before dismissing the loader, re-applying
    // the new city's bounds, and re-loading the layers.
    setTimeout(() => {
      map.setMaxBounds(cfg.bounds);
      finishLoading();
      loadAllLayersForCurrentCity();
    }, 1500);
  }
}

// Called by the sidebar's "switch city" affordance — re-opens the city-select
// screen without touching the map. The actual swap happens when the user
// confirms a (different) city via enterCity().
function switchCity() {
  // Search results from the previous city would point to stale coordinates
  // once teardown runs — clear the input/dropdown before re-opening select.
  if (searchInput) searchInput.value = '';
  hideSearchResults();
  // Drop the old "you are here" pin — the user can re-locate after switching,
  // and the bounds-check will run fresh against the new city.
  clearUserMarker();
  // Reset selection state so the user actively re-picks
  selectedCity = null;
  cityOptions.forEach(opt => opt.classList.remove('selected'));
  cityNodes.forEach(node => node.classList.remove('selected'));
  citySelectBtn.disabled = true;
  // Pre-highlight whatever city is currently active, so it's obvious where you are
  selectCity(getCurrentCity());
  citySelectScreen.classList.remove('hidden');
}

function applyCityBranding() {
  const cfg = getCityConfig();
  const upper = cfg.name.toUpperCase();

  // Browser tab title
  document.title = `CivicPulse — ${cfg.name}`;

  // Sidebar header
  document.querySelectorAll('.sidebar-city-name').forEach(el => {
    el.textContent = cfg.name;
  });

  // Bottom bar label
  document.querySelectorAll('.bottom-city-name').forEach(el => {
    el.textContent = upper;
  });

  // Loading screen city label
  document.querySelectorAll('.loading-city-name').forEach(el => {
    el.textContent = upper;
  });

  // Hydro label — river name (skip when the city has no river to display)
  if (cfg.riverName) {
    document.querySelectorAll('.hydro-label').forEach(el => {
      el.textContent = cfg.riverName.toUpperCase();
    });
  }

  // Hide sidebar items for layers not supported in this city
  document.querySelectorAll('#sidebar .item[data-layer]').forEach(item => {
    const layerKey = item.dataset.layer;
    const enabled = cfg.layers && cfg.layers[layerKey] === true;
    item.style.display = enabled ? '' : 'none';
  });

  // Hide section headers (e.g. "HYDROLOGY /") when every item under them is
  // hidden — otherwise an empty section header dangles for cities that have
  // no items in that category.
  document.querySelectorAll('#sidebar .sidebar-section').forEach(section => {
    const items = section.querySelectorAll('.section-items > .item');
    if (items.length === 0) return;
    const anyVisible = Array.from(items).some(it => it.style.display !== 'none');
    section.style.display = anyVisible ? '' : 'none';
  });
}

// Preselect Poznań by default
selectCity('poznan');

// --- Custom dark map style using OpenFreeMap ---
const mapStyle = {
  version: 8,
  name: 'CivicPulse Dark',
  glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
  sources: {
    'openmaptiles': {
      type: 'vector',
      url: 'https://tiles.openfreemap.org/planet'
    }
  },
  layers: [
    {
      id: 'background',
      type: 'background',
      paint: { 'background-color': '#000000' }
    },
    {
      id: 'water',
      type: 'fill',
      source: 'openmaptiles',
      'source-layer': 'water',
      paint: { 'fill-color': '#040410', 'fill-opacity': 0.9 }
    },
    {
      id: 'landuse-park',
      type: 'fill',
      source: 'openmaptiles',
      'source-layer': 'landuse',
      filter: ['==', 'class', 'park'],
      paint: { 'fill-color': '#050a08', 'fill-opacity': 0.6 }
    },
    {
      id: 'landcover',
      type: 'fill',
      source: 'openmaptiles',
      'source-layer': 'landcover',
      paint: { 'fill-color': '#060d0a', 'fill-opacity': 0.4 }
    },
    {
      id: 'road-casing',
      type: 'line',
      source: 'openmaptiles',
      'source-layer': 'transportation',
      filter: ['all', ['!in', 'class', 'path', 'track', 'rail', 'transit', 'ferry']],
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': '#0a0a12',
        'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 10, 1, 14, 4, 18, 20],
        'line-opacity': 0.5
      }
    },
    {
      id: 'road-main',
      type: 'line',
      source: 'openmaptiles',
      'source-layer': 'transportation',
      filter: ['all', ['!in', 'class', 'path', 'track', 'rail', 'transit', 'ferry']],
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': [
          'match', ['get', 'class'],
          'motorway', '#00b8e6',
          'trunk', '#00b0d9',
          'primary', '#00a8cc',
          'secondary', '#009abf',
          'tertiary', '#008ab2',
          'minor', '#0078a6',
          'service', '#005577',
          '#006699'
        ],
        'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 10, 0.3, 14, 1.2, 18, 6],
        'line-opacity': ['interpolate', ['linear'], ['zoom'], 10, 0.4, 14, 0.7, 18, 0.85]
      }
    },
    {
      id: 'road-glow',
      type: 'line',
      source: 'openmaptiles',
      'source-layer': 'transportation',
      filter: ['in', 'class', 'motorway', 'trunk', 'primary', 'secondary'],
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': '#00cfff',
        'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 10, 0.1, 14, 0.5, 18, 2],
        'line-opacity': 0.4,
        'line-blur': 3
      }
    },
    {
      id: 'road-path',
      type: 'line',
      source: 'openmaptiles',
      'source-layer': 'transportation',
      filter: ['in', 'class', 'path', 'track'],
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': '#1a3040',
        'line-width': ['interpolate', ['linear'], ['zoom'], 14, 0.3, 18, 1.5],
        'line-opacity': 0.5,
        'line-dasharray': [2, 2]
      }
    },
    {
      id: 'rail',
      type: 'line',
      source: 'openmaptiles',
      'source-layer': 'transportation',
      filter: ['in', 'class', 'rail', 'transit'],
      paint: {
        'line-color': '#1a2a33',
        'line-width': 1.5,
        'line-opacity': 0.5,
        'line-dasharray': [4, 4]
      }
    },
    {
      id: 'buildings-3d',
      type: 'fill-extrusion',
      source: 'openmaptiles',
      'source-layer': 'building',
      // Bumped from 13 → 14 because Warsaw lands at zoom 14.2 and the
      // extra zoom 13–14 frames covered tens of thousands of buildings —
      // most of them invisible specks. Extrusion now ramps in over
      // 14 → 14.8 instead of 13 → 14.5, so the 3D effect still appears
      // as the user zooms in but a wider initial frame stays flat-shaded.
      minzoom: 14,
      paint: {
        'fill-extrusion-color': [
          'interpolate', ['linear'],
          ['coalesce', ['get', 'render_height'], 10],
          0, '#0c0c14',
          30, '#141420',
          80, '#1a1a2a'
        ],
        'fill-extrusion-height': [
          'interpolate', ['linear'], ['zoom'],
          14, 0,
          14.8, ['coalesce', ['get', 'render_height'], 10]
        ],
        'fill-extrusion-base': [
          'interpolate', ['linear'], ['zoom'],
          14, 0,
          14.8, ['coalesce', ['get', 'render_min_height'], 0]
        ],
        'fill-extrusion-opacity': 0.75,
        // Disabled: per-fragment vertical-gradient shading is the single
        // most expensive bit of the extrusion shader. Visual difference
        // at 0.75 opacity over a black ground is barely perceptible,
        // perf gain on dense city centres (Warsaw especially) is large.
        'fill-extrusion-vertical-gradient': false
      }
    },
    {
      id: 'building-outlines',
      type: 'line',
      source: 'openmaptiles',
      'source-layer': 'building',
      minzoom: 14,
      paint: {
        'line-color': 'rgba(0, 180, 255, 0.12)',
        'line-width': ['interpolate', ['linear'], ['zoom'], 14, 0.3, 18, 1],
        'line-opacity': ['interpolate', ['linear'], ['zoom'], 14, 0.2, 17, 0.5]
      }
    },
    {
      id: 'road-labels',
      type: 'symbol',
      source: 'openmaptiles',
      'source-layer': 'transportation_name',
      minzoom: 14,
      layout: {
        'text-field': ['coalesce', ['get', 'name:latin'], ['get', 'name']],
        'text-font': ['Noto Sans Regular'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 14, 9, 18, 13],
        'symbol-placement': 'line',
        'text-rotation-alignment': 'map',
        'text-max-angle': 30,
        'text-padding': 10,
        'text-letter-spacing': 0.05
      },
      paint: {
        'text-color': 'rgba(200, 220, 230, 0.5)',
        'text-halo-color': 'rgba(0, 0, 0, 0.8)',
        'text-halo-width': 1.5,
        'text-halo-blur': 1
      }
    },
    {
      id: 'place-labels',
      type: 'symbol',
      source: 'openmaptiles',
      'source-layer': 'place',
      layout: {
        'text-field': ['coalesce', ['get', 'name:latin'], ['get', 'name']],
        'text-font': ['Noto Sans Bold'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 10, 10, 15, 16],
        'text-transform': 'uppercase',
        'text-letter-spacing': 0.15,
        'text-max-width': 10
      },
      paint: {
        'text-color': 'rgba(220, 230, 240, 0.55)',
        'text-halo-color': 'rgba(0, 0, 0, 0.9)',
        'text-halo-width': 2,
        'text-halo-blur': 1
      }
    },
    {
      id: 'poi-labels',
      type: 'symbol',
      source: 'openmaptiles',
      'source-layer': 'poi',
      minzoom: 16,
      layout: {
        'text-field': ['coalesce', ['get', 'name:latin'], ['get', 'name']],
        'text-font': ['Noto Sans Regular'],
        'text-size': 10,
        'text-max-width': 8,
        'text-anchor': 'top',
        'text-offset': [0, 0.5]
      },
      paint: {
        'text-color': 'rgba(160, 180, 200, 0.4)',
        'text-halo-color': 'rgba(0, 0, 0, 0.7)',
        'text-halo-width': 1
      }
    }
  ]
};

// --- Initialize Map ---
let map = null;
let cameraDefaults = null;

function initMap() {
  const cfg = getCityConfig();
  cameraDefaults = {
    center: cfg.center,
    zoom: cfg.zoom,
    pitch: cfg.pitch,
    bearing: cfg.bearing
  };

  // Hard-cap the rendered DPR. On a 3x retina screen the GPU draws 9× the
  // pixel count of a 1x screen — for Warsaw at zoom 14.2 that's tens of
  // millions of fragment-shader invocations every frame. 1.5× keeps the
  // map crisp without paying the 4-9× cost. Standalone variable so we
  // can also pass it to setPixelRatio after style swaps if needed.
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);

  map = new maplibregl.Map({
    container: 'map',
    style: mapStyle,
    center: cfg.center,
    zoom: cfg.zoom,
    pitch: cfg.pitch,
    bearing: cfg.bearing,
    // antialias: false saves GPU budget — at our zoom levels and the
    // dark cyberpunk palette, MSAA is unnoticeable. Was true.
    antialias: false,
    pixelRatio,
    // Lowered from 72° → 60°. The last 12° of pitch put the camera
    // nearly horizontal, which forces MapLibre to load the whole horizon
    // out to the maxBounds. 60° still gives a strong 3D feel.
    maxPitch: 60,
    minZoom: 10,
    maxZoom: 19,
    maxBounds: cfg.bounds,
    // Don't block the main thread waiting for fonts; render the map
    // tiles immediately and let labels paint as glyphs arrive.
    localIdeographFontFamily: false,
    // Skip the 'flymode' that double-renders every transition.
    fadeDuration: 200
  });

  // Allow more parallel tile fetches than the default 16 — Warsaw's larger
  // bbox means a city-wide flyTo crosses many tile boundaries, and the
  // browser can keep more sockets open over HTTP/2 to a CDN like
  // tiles.openfreemap.org without breaking a sweat.
  if (maplibregl.config && typeof maplibregl.config === 'object') {
    maplibregl.config.MAX_PARALLEL_IMAGE_REQUESTS = 24;
  }

  map.on('move', () => {
    const center = map.getCenter();
    coordsLat.textContent = center.lat.toFixed(6);
    coordsLng.textContent = center.lng.toFixed(6);
  });

  map.on('load', () => {
    finishLoading();
    loadAllLayersForCurrentCity();
  });
}

// --- Layer registry (lazy) ---
// One entry per layer module. `keys` are the cityConfig flag(s) — if any
// are true for the current city, the layer is enabled. `load()` is the
// dynamic-import factory; the resolved module is cached on the entry as
// `module` so subsequent toggles, searches, and destroy calls hit the
// same instance without re-fetching.
//
// Function-name fields are strings (not direct refs) because the module
// hasn't been loaded yet at registry-construction time.
//
// `multiKey: true` marks layers whose toggle takes the cityConfig key as
// an argument — currently only transit (tram/bus/metro share toggleLayer).
//
// `priority`: how early to init this layer.
//   0 = critical (tram/bus/metro/traffic — what the user's eye lands on
//       first when the map fades in)
//   1 = standard (most layers)
//   2 = deferred (heavy Overpass-backed OSM scrapes — billboards,
//       electricity, parcels, etc. — wait for the next idle window so
//       they don't compete with the first map paint)
// In Warsaw the priority-2 layers are the costliest because the bbox is
// 2× the area of Poznań/Łódź, returning many more features per query.
const LAYER_REGISTRY = [
  { keys: ['tram', 'bus', 'metro'], load: () => import('./transit.js'),
    initFn: 'initTransit', destroyFn: 'destroyTransit', toggleFn: 'toggleLayer', searchFn: 'searchFeatures',
    multiKey: true, priority: 0,
    name: 'Transit systems',        color: '#00cfff' },
  { keys: ['carTraffic'],          load: () => import('./traffic.js'),
    initFn: 'initTraffic', destroyFn: 'destroyTraffic', toggleFn: 'toggleTraffic',
    priority: 0,
    name: 'Car traffic flow',       color: '#ff5544' },
  { keys: ['hydro'],               load: () => import('./hydro.js'),
    initFn: 'initHydro', destroyFn: 'destroyHydro', toggleFn: 'toggleHydro', searchFn: 'searchFeatures',
    priority: 0,
    name: 'River hydro gauge',      color: '#00bbff' },

  { keys: ['bicycleCounters'],     load: () => import('./bicycles.js'),
    initFn: 'initBicycleCounters', destroyFn: 'destroyBicycleCounters', toggleFn: 'toggleBicycleCounters', searchFn: 'searchFeatures',
    priority: 1,
    name: 'Bicycle counters',       color: '#4dff4d' },
  { keys: ['bikeSharing'],         load: () => import('./bikesharing.js'),
    initFn: 'initBikeSharing', destroyFn: 'destroyBikeSharing', toggleFn: 'toggleBikeSharing', searchFn: 'searchFeatures',
    priority: 1,
    name: 'Bike sharing',           color: '#00cc88' },
  { keys: ['mobile'],              load: () => import('./mobile.js'),
    initFn: 'initMobile', destroyFn: 'destroyMobile', toggleFn: 'toggleMobile', searchFn: 'searchFeatures',
    priority: 1,
    name: 'Mobile network',         color: '#ff6633' },
  { keys: ['parking'],             load: () => import('./parking.js'),
    initFn: 'initParking', destroyFn: 'destroyParking', toggleFn: 'toggleParking', searchFn: 'searchFeatures',
    priority: 1,
    name: 'Parking grid',           color: '#00aaff' },
  { keys: ['environment'],         load: () => import('./environment.js'),
    initFn: 'initEnvironment', destroyFn: 'destroyEnvironment', toggleFn: 'toggleEnvironment', searchFn: 'searchFeatures',
    priority: 1,
    name: 'Environmental grid',     color: '#7ee03a' },
  { keys: ['emergency'],           load: () => import('./emergency.js'),
    initFn: 'initEmergency', destroyFn: 'destroyEmergency', toggleFn: 'toggleEmergency', searchFn: 'searchFeatures',
    priority: 1,
    name: 'Emergency grid',         color: '#ff4422' },
  { keys: ['cctv'],                load: () => import('./cctv.js'),
    initFn: 'initCCTV', destroyFn: 'destroyCCTV', toggleFn: 'toggleCCTV',
    priority: 1,
    name: 'CCTV grid',              color: '#ff3333' },
  { keys: ['trafficLights'],       load: () => import('./trafficLights.js'),
    initFn: 'initTrafficLights', destroyFn: 'destroyTrafficLights', toggleFn: 'toggleTrafficLights',
    priority: 1,
    name: 'Traffic signal grid',    color: '#ffcc00' },

  // Priority 2 — heavy OSM Overpass scrapes. Defer their init to the
  // first idle window so they don't fight the map's first paint.
  { keys: ['emf'],                 load: () => import('./emf.js'),
    initFn: 'initEMF', destroyFn: 'destroyEMF', toggleFn: 'toggleEMF',
    priority: 2,
    name: 'EMF grid',               color: '#ff3366' },
  { keys: ['tor'],                 load: () => import('./tor.js'),
    initFn: 'initTor', destroyFn: 'destroyTor', toggleFn: 'toggleTor', searchFn: 'searchFeatures',
    priority: 2,
    name: 'Tor relay network',      color: '#b44dff' },
  { keys: ['connectionPoints'],    load: () => import('./connectionPoints.js'),
    initFn: 'initConnectionPoints', destroyFn: 'destroyConnectionPoints', toggleFn: 'toggleConnectionPoints', searchFn: 'searchFeatures',
    priority: 2,
    name: 'Connection-point grid',  color: '#00e5d0' },
  { keys: ['wifi'],                load: () => import('./wifi.js'),
    initFn: 'initWifi', destroyFn: 'destroyWifi', toggleFn: 'toggleWifi', searchFn: 'searchFeatures',
    priority: 2,
    name: 'WiFi grid',              color: '#44ddaa' },
  { keys: ['electricity'],         load: () => import('./electricity.js'),
    initFn: 'initElectricity', destroyFn: 'destroyElectricity', toggleFn: 'toggleElectricity', searchFn: 'searchFeatures',
    priority: 2,
    name: 'Electricity grid',       color: '#ffe935' },
  { keys: ['parcels'],             load: () => import('./parcels.js'),
    initFn: 'initParcels', destroyFn: 'destroyParcels', toggleFn: 'toggleParcels', searchFn: 'searchFeatures',
    priority: 2,
    name: 'Parcel grid',            color: '#ff8c1a' },
  { keys: ['atms'],                load: () => import('./atms.js'),
    initFn: 'initATMs', destroyFn: 'destroyATMs', toggleFn: 'toggleATMs', searchFn: 'searchFeatures',
    priority: 2,
    name: 'ATM grid',               color: '#33ff99' },
  { keys: ['billboards'],          load: () => import('./billboards.js'),
    initFn: 'initBillboards', destroyFn: 'destroyBillboards', toggleFn: 'toggleBillboards', searchFn: 'searchFeatures',
    priority: 2,
    name: 'Advertising grid',       color: '#ff44dd' }
];

// Tracks which layer entries currently have data on the map, so we know what
// to tear down when switching cities.
const initializedLayers = new Set();

function isLayerEnabled(entry, cfg) {
  return entry.keys.some(k => cfg.layers && cfg.layers[k] === true);
}

// Locate the registry entry that owns a sidebar `data-layer` key.
function findEntryByKey(key) {
  return LAYER_REGISTRY.find(e => e.keys.includes(key)) || null;
}

// requestIdleCallback isn't in Safari yet — fall back to a setTimeout
// queue that mimics "after the next paint settles" behavior.
const idleCb = window.requestIdleCallback
  || ((fn) => setTimeout(fn, 50));

function initLayer(entry) {
  return entry.load().then(mod => {
    entry.module = mod;
    return mod[entry.initFn](map);
  }).then(() => {
    console.log(`%c[CivicPulse] ${entry.name} online`, `color: ${entry.color};`);
  }).catch(err => {
    console.error(`[CivicPulse] ${entry.name} failed to load:`, err);
  });
}

function loadAllLayersForCurrentCity() {
  const cfg = getCityConfig();
  // Every layer module starts with `visible = true` after init/destroy, so the
  // sidebar must reflect that — otherwise stale .active/.off classes from the
  // previous city would desync from the freshly-initialized layers.
  resetSidebarItemStates();

  // Bucket enabled layers by priority. Priority 0 (transit, traffic, hydro)
  // kicks off immediately so the user sees moving vehicles + the river
  // gauge as soon as the map paints. Priority 1 (most layers) starts on
  // the next animation frame — out of the critical path but still soon.
  // Priority 2 (Overpass-backed scrapes) waits for the first idle window
  // so the heavy GeoJSON parsing doesn't fight the map's first interaction.
  const buckets = [[], [], []];
  for (const entry of LAYER_REGISTRY) {
    if (!isLayerEnabled(entry, cfg)) continue;
    initializedLayers.add(entry);
    const p = entry.priority ?? 1;
    buckets[Math.min(Math.max(p, 0), 2)].push(entry);
  }

  // Priority 0 — fire now, in parallel.
  buckets[0].forEach(initLayer);
  // Priority 1 — fire on the next animation frame.
  if (buckets[1].length) {
    requestAnimationFrame(() => buckets[1].forEach(initLayer));
  }
  // Priority 2 — fire when the browser reports idle (or after 50 ms on
  // browsers without requestIdleCallback). Each call also yields between
  // layers so we don't burn the whole idle slice on one Overpass JSON parse.
  if (buckets[2].length) {
    let i = 0;
    const drainOne = () => {
      if (i >= buckets[2].length) return;
      initLayer(buckets[2][i++]);
      idleCb(drainOne, { timeout: 2000 });
    };
    idleCb(drainOne, { timeout: 2000 });
  }
}

function resetSidebarItemStates() {
  document.querySelectorAll('#sidebar .item').forEach(item => {
    item.classList.add('active');
    item.classList.remove('off');
  });
}

function destroyAllLayers() {
  // Cancel any in-flight network-link animation overlay
  clearNetworkLinks(map);
  for (const entry of initializedLayers) {
    if (!entry.module) continue; // module never finished loading — nothing to tear down
    try { entry.module[entry.destroyFn](); }
    catch (e) { console.error(`[CivicPulse] destroy ${entry.name}:`, e); }
  }
  initializedLayers.clear();
}

function finishLoading() {
  clearInterval(loadInterval);
  clearInterval(statusInterval);
  loadProgress = 0;
  loadingBar.style.width = '100%';
  loadingStatus.textContent = 'SYSTEM READY.';
  setTimeout(() => { loadingScreen.classList.add('hidden'); }, 600);
}

// Coordinates display elements (used inside initMap's move handler)
const coordsLat = document.getElementById('coords-lat');
const coordsLng = document.getElementById('coords-lng');

// --- Custom nav controls (guard against map not yet initialized) ---
document.getElementById('nav-zoom-in').addEventListener('click', () => {
  if (map) map.zoomIn({ duration: 300 });
});

document.getElementById('nav-zoom-out').addEventListener('click', () => {
  if (map) map.zoomOut({ duration: 300 });
});

document.getElementById('nav-compass').addEventListener('click', () => {
  if (map && cameraDefaults) map.easeTo({ bearing: cameraDefaults.bearing, duration: 500 });
});

document.getElementById('nav-pitch').addEventListener('click', () => {
  if (map && cameraDefaults) map.easeTo({ pitch: cameraDefaults.pitch, duration: 500 });
});

// --- Mouse glow tracker ---
document.addEventListener('mousemove', (e) => {
  document.body.style.setProperty('--mouse-x', e.clientX + 'px');
  document.body.style.setProperty('--mouse-y', e.clientY + 'px');
});

// --- Keyboard shortcuts ---
document.addEventListener('keydown', (e) => {
  if ((e.key === 'r' || e.key === 'R') && map && cameraDefaults) {
    map.easeTo({
      center: cameraDefaults.center,
      zoom: cameraDefaults.zoom,
      pitch: cameraDefaults.pitch,
      bearing: cameraDefaults.bearing,
      duration: 1000
    });
  }
});

// --- Sidebar toggles ---
// --- Sidebar toggles (event-delegated) ---
// Every sidebar item carries `data-layer="<key>"`; we resolve the key to
// a registry entry, then call its toggle on the lazily-loaded module.
// One bound listener instead of 20+ — and the toggle stays a no-op until
// the underlying module finishes its first dynamic-import, which is fine
// for a click that lands in the same animation frame as init.
document.querySelectorAll('#sidebar .item[data-layer]').forEach(item => {
  item.classList.remove('disabled');
  item.classList.add('active');
});

const sidebarEl = document.getElementById('sidebar');
sidebarEl?.addEventListener('click', (e) => {
  const item = e.target.closest('.item[data-layer]');
  if (!item || !sidebarEl.contains(item)) return;
  const key = item.dataset.layer;
  const entry = findEntryByKey(key);
  if (!entry || !entry.module) return; // module not loaded yet — ignore the click
  const fn = entry.module[entry.toggleFn];
  if (typeof fn !== 'function') return;
  // transit.toggleLayer takes the cityConfig key (tram/bus/metro);
  // every other layer's toggle is parameter-less.
  const visible = entry.multiKey ? fn(key) : fn();
  item.classList.toggle('active', !!visible);
  item.classList.toggle('off', !visible);
});

// --- Switch-city affordance (sidebar header) ---
const switchCityBtn = document.getElementById('sidebar-switch-city');
if (switchCityBtn) switchCityBtn.addEventListener('click', switchCity);

// --- Toast (transient on-screen messages) ---
const toastEl = document.getElementById('toast');
let toastTimer = null;
function showToast(msg, { error = false, duration = 3200 } = {}) {
  if (!toastEl) return;
  toastEl.textContent = msg;
  toastEl.classList.toggle('error', !!error);
  toastEl.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), duration);
}

// --- Geolocation ("locate me") ---
// One-shot lookup via getCurrentPosition — keeps the GPS off between requests
// so we don't drain mobile batteries. User can click again to refresh.
let userLocationMarker = null;
let isLocating = false;

function isInCityBounds(coords) {
  const bounds = getCityConfig()?.bounds;
  if (!bounds) return true;
  const [[minLng, minLat], [maxLng, maxLat]] = bounds;
  const [lng, lat] = coords;
  return lng >= minLng && lng <= maxLng && lat >= minLat && lat <= maxLat;
}

function placeUserMarker(coords) {
  if (userLocationMarker) {
    userLocationMarker.setLngLat(coords);
    return;
  }
  const el = document.createElement('div');
  el.className = 'user-location-marker';
  userLocationMarker = new maplibregl.Marker({ element: el })
    .setLngLat(coords)
    .addTo(map);
}

function clearUserMarker() {
  if (userLocationMarker) { userLocationMarker.remove(); userLocationMarker = null; }
  document.getElementById('nav-locate')?.classList.remove('active');
}

function locateMe() {
  if (isLocating) return;
  if (!map) { showToast('Map not ready'); return; }
  if (!('geolocation' in navigator)) {
    showToast('Geolocation unsupported', { error: true });
    return;
  }
  const btn = document.getElementById('nav-locate');
  btn?.classList.add('locating');
  btn?.classList.remove('active');
  isLocating = true;

  navigator.geolocation.getCurrentPosition(
    pos => {
      btn?.classList.remove('locating');
      isLocating = false;
      const coords = [pos.coords.longitude, pos.coords.latitude];
      const cityName = getCityConfig()?.name || 'this city';
      if (!isInCityBounds(coords)) {
        clearUserMarker();
        showToast(`You're outside ${cityName}`);
        return;
      }
      placeUserMarker(coords);
      map.flyTo({ center: coords, zoom: 17, duration: 1200, essential: true });
      btn?.classList.add('active');
    },
    err => {
      btn?.classList.remove('locating');
      isLocating = false;
      let msg = 'Location unavailable';
      if (err.code === err.PERMISSION_DENIED) msg = 'Location permission denied';
      else if (err.code === err.TIMEOUT)      msg = 'Location request timed out';
      else if (err.code === err.POSITION_UNAVAILABLE) msg = 'Location unavailable';
      showToast(msg, { error: true });
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
  );
}

document.getElementById('nav-locate')?.addEventListener('click', locateMe);

// --- Search ("Find a data") ---
// Each layer module exports its own `searchFeatures(query)` that returns up
// to 5 matches in a uniform shape. We aggregate across all currently-loaded
// layers, debounce, render a dropdown, and fly to the result on click.
// Search providers come from the lazy-loaded layer modules — we walk the
// registry and call each entry's `searchFeatures` if its module has been
// loaded and exposes one. A layer that's still loading or doesn't ship
// search just contributes nothing this round. No eager imports needed.
const MAX_RESULTS = 12;

function getActiveSearchProviders() {
  const providers = [];
  for (const entry of LAYER_REGISTRY) {
    if (!entry.module || !entry.searchFn) continue;
    const fn = entry.module[entry.searchFn];
    if (typeof fn === 'function') providers.push(fn);
  }
  return providers;
}

const searchInput   = document.getElementById('search-input');
const searchResults = document.getElementById('search-results');
const searchBar     = document.getElementById('search-bar');
let searchDebounceId = null;

function runSearch(query) {
  if (!searchResults) return;
  const q = (query || '').trim();
  if (!q) { hideSearchResults(); return; }
  const all = [];
  for (const provider of getActiveSearchProviders()) {
    try {
      const hits = provider(q) || [];
      for (const h of hits) all.push(h);
    } catch (e) { /* a layer not yet loaded — fine, skip */ }
  }
  // Drop any hit whose coordinates fall outside the current city's bounds
  // (chiefly Tor relays — they're nationwide, not city-scoped).
  const inBounds = filterByCityBounds(all);
  renderSearchResults(inBounds.slice(0, MAX_RESULTS));
}

function filterByCityBounds(hits) {
  const bounds = getCityConfig()?.bounds;
  if (!bounds) return hits;
  const [[minLng, minLat], [maxLng, maxLat]] = bounds;
  return hits.filter(h => {
    const c = h.coords;
    if (!Array.isArray(c) || c.length < 2) return false;
    const [lng, lat] = c;
    return lng >= minLng && lng <= maxLng && lat >= minLat && lat <= maxLat;
  });
}

function renderSearchResults(items) {
  if (!searchResults) return;
  if (!items.length) {
    searchResults.innerHTML = '<div class="search-empty">No matches</div>';
    searchResults.classList.add('open');
    return;
  }
  searchResults.innerHTML = items.map((it, i) => `
    <button type="button" class="search-result" data-idx="${i}">
      <span class="search-result-dot" style="background:${it.color}"></span>
      <span class="search-result-text">
        <span class="search-result-label">${escapeHtml(it.label)}</span>
        <span class="search-result-sub">${escapeHtml(it.sublabel || '')}</span>
      </span>
      <span class="search-result-tag" style="color:${it.color};border-color:${it.color}55">${escapeHtml(it.layerName)}</span>
    </button>
  `).join('');
  searchResults.classList.add('open');
  // Wire each result row
  searchResults.querySelectorAll('.search-result').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.idx, 10);
      const it = items[idx];
      if (it && map) {
        map.flyTo({ center: it.coords, zoom: 16.5, duration: 1200, essential: true });
      }
      searchInput.value = '';
      hideSearchResults();
      searchInput.blur();
    });
  });
}

function hideSearchResults() {
  if (!searchResults) return;
  searchResults.classList.remove('open');
  searchResults.innerHTML = '';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]
  ));
}

if (searchInput) {
  // Re-enable the input — was disabled in markup as a "coming soon" placeholder.
  searchInput.disabled = false;
  searchInput.placeholder = 'Find a data /';
  searchInput.addEventListener('input', e => {
    if (searchDebounceId) clearTimeout(searchDebounceId);
    searchDebounceId = setTimeout(() => runSearch(e.target.value), 120);
  });
  searchInput.addEventListener('focus', () => {
    if (searchInput.value.trim()) runSearch(searchInput.value);
  });
  searchInput.addEventListener('keydown', e => {
    if (e.key === 'Escape') { searchInput.value = ''; hideSearchResults(); searchInput.blur(); }
  });
}
// Click anywhere outside the search bar → close results
document.addEventListener('click', e => {
  if (searchBar && !searchBar.contains(e.target)) hideSearchResults();
});

// Log ready
console.log('%c[CivicPulse] CivicPulse — System Online', 'color: #00cfff; font-weight: bold;');
console.log('%c[CivicPulse] Press R to reset camera view', 'color: #666;');

// --- Mobile menu toggle ---
const mobileMenuBtn = document.getElementById('mobile-menu-btn');
const sidebar = document.getElementById('sidebar');
const sidebarBackdrop = document.getElementById('sidebar-backdrop');

function openMobileMenu() {
  sidebar.classList.add('mobile-open');
  mobileMenuBtn.classList.add('open');
  sidebarBackdrop.classList.add('visible');
  document.body.style.overflow = 'hidden';
}

function closeMobileMenu() {
  sidebar.classList.remove('mobile-open');
  mobileMenuBtn.classList.remove('open');
  sidebarBackdrop.classList.remove('visible');
  document.body.style.overflow = '';
}

function toggleMobileMenu() {
  if (sidebar.classList.contains('mobile-open')) {
    closeMobileMenu();
  } else {
    openMobileMenu();
  }
}

mobileMenuBtn.addEventListener('click', toggleMobileMenu);
sidebarBackdrop.addEventListener('click', closeMobileMenu);

sidebar.querySelectorAll('.item').forEach(item => {
  item.addEventListener('click', () => {
    if (window.innerWidth <= 640) {
      setTimeout(closeMobileMenu, 150);
    }
  });
});

window.addEventListener('resize', () => {
  if (window.innerWidth > 1024) {
    closeMobileMenu();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && sidebar.classList.contains('mobile-open')) {
    closeMobileMenu();
  }
});
