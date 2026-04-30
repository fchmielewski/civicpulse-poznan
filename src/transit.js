/* ============================================
   CivicPulse — Transit Layer
   Real-time tram / bus / metro / SKM rail visualization.
   Metro (route_type=1) and SKM rail (route_type=2) are grouped under the
   "metro" toggle since both are rail-grade mass transit and only Warsaw
   currently has either.
   ============================================ */

import maplibregl from 'maplibre-gl';
import { apiUrl } from './cityConfig.js';

const REFRESH_INTERVAL = 10000; // 10 seconds

// Approximate conversion at ~52°N (both Poznań and Łódź)
const METERS_PER_DEG_LAT = 111320;
const METERS_PER_DEG_LNG = 68560;

// Minimum distance (in degrees) between GPS fixes to count as "moving"
const MOVE_THRESHOLD_DEG = 0.000005; // ~0.5 m

// State
let map = null;
let vehicleData = {}; // id → { prev, current, element, marker, ... }
let routesData = [];
let shapesGeoJSON = null;
let stopsGeoJSON = null;
let animFrameId = null;
let vehicleFetchTimer = null;
let lastFetchTime = 0;
let layerVisibility = { tram: true, bus: true, metro: true };

// --- Initialization ---

export async function initTransit(mapInstance) {
  map = mapInstance;

  try {
    // Fetch static data in parallel
    const [routesRes, shapesRes, stopsRes] = await Promise.all([
      fetch(apiUrl('routes')).then(r => r.json()),
      fetch(apiUrl('shapes')).then(r => r.json()),
      fetch(apiUrl('stops')).then(r => r.json())
    ]);

    routesData = routesRes;
    shapesGeoJSON = shapesRes;
    stopsGeoJSON = stopsRes;

    console.log(`%c[CivicPulse Transit] ${routesData.length} routes, ${shapesGeoJSON.features.length} shapes, ${stopsGeoJSON.features.length} stops`, 'color: #00cfff;');

    addRouteLines();
    addStopsLayer();

    // Start real-time vehicle tracking
    await fetchVehicles();
    startAnimationLoop();

    // Periodic refresh
    vehicleFetchTimer = setInterval(fetchVehicles, REFRESH_INTERVAL);

  } catch (err) {
    console.error('[CivicPulse Transit] Init failed:', err);
  }
}

// --- Route Lines ---

function addRouteLines() {
  // Group shapes by GTFS route_type:
  //   0 → tram, 1 → metro/subway, 2 → rail (SKM), 3 → bus.
  // Metro and rail share the "metro" layer so a single toggle covers all
  // rail-grade mass transit.
  const tramShapes = {
    type: 'FeatureCollection',
    features: shapesGeoJSON.features.filter(f => f.properties.type === 0)
  };
  const metroShapes = {
    type: 'FeatureCollection',
    features: shapesGeoJSON.features.filter(f => f.properties.type === 1 || f.properties.type === 2)
  };
  const busShapes = {
    type: 'FeatureCollection',
    features: shapesGeoJSON.features.filter(f => f.properties.type === 3)
  };

  // Metro / SKM rail — heaviest weight, warm-amber glow so they read above
  // tram red and bus blue. Per-line color (M1/M2/Sx) comes from GTFS.
  map.addSource('metro-routes', { type: 'geojson', data: metroShapes });

  map.addLayer({
    id: 'metro-routes-glow',
    type: 'line',
    source: 'metro-routes',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-color': '#ffaa00',
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 3, 16, 8],
      'line-opacity': 0.18,
      'line-blur': 5
    }
  }, 'buildings-3d');

  map.addLayer({
    id: 'metro-routes-line',
    type: 'line',
    source: 'metro-routes',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-color': ['get', 'color'],
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.5, 16, 4],
      'line-opacity': 0.85
    }
  }, 'buildings-3d');

  // Tram lines — brighter, thicker
  map.addSource('tram-routes', { type: 'geojson', data: tramShapes });

  // Tram glow (outer)
  map.addLayer({
    id: 'tram-routes-glow',
    type: 'line',
    source: 'tram-routes',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-color': '#ff2244',
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 2, 16, 6],
      'line-opacity': 0.15,
      'line-blur': 4
    }
  }, 'buildings-3d');

  // Tram line
  map.addLayer({
    id: 'tram-routes-line',
    type: 'line',
    source: 'tram-routes',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-color': ['get', 'color'],
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1, 16, 3],
      'line-opacity': 0.7
    }
  }, 'buildings-3d');

  // Bus lines — dimmer, thinner
  map.addSource('bus-routes', { type: 'geojson', data: busShapes });

  // Bus glow
  map.addLayer({
    id: 'bus-routes-glow',
    type: 'line',
    source: 'bus-routes',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-color': '#00aaff',
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.5, 16, 4],
      'line-opacity': 0.08,
      'line-blur': 3
    }
  }, 'buildings-3d');

  // Bus line
  map.addLayer({
    id: 'bus-routes-line',
    type: 'line',
    source: 'bus-routes',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-color': ['get', 'color'],
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.5, 16, 1.8],
      'line-opacity': 0.45
    }
  }, 'buildings-3d');
}

// --- Stops Layer ---

function addStopsLayer() {
  map.addSource('transit-stops', { type: 'geojson', data: stopsGeoJSON });

  // Stop dots
  map.addLayer({
    id: 'transit-stops-dots',
    type: 'circle',
    source: 'transit-stops',
    minzoom: 14,
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 14, 1.5, 18, 4],
      'circle-color': 'rgba(0, 207, 255, 0.5)',
      'circle-stroke-color': 'rgba(0, 207, 255, 0.8)',
      'circle-stroke-width': 0.5,
      'circle-opacity': 0.6
    }
  });

  // Stop labels
  map.addLayer({
    id: 'transit-stops-labels',
    type: 'symbol',
    source: 'transit-stops',
    minzoom: 16,
    layout: {
      'text-field': ['get', 'name'],
      'text-font': ['Noto Sans Regular'],
      'text-size': 9,
      'text-offset': [0, 1.2],
      'text-anchor': 'top',
      'text-max-width': 8,
      'text-allow-overlap': false
    },
    paint: {
      'text-color': 'rgba(0, 207, 255, 0.6)',
      'text-halo-color': 'rgba(0, 0, 0, 0.8)',
      'text-halo-width': 1
    }
  });
}

// --- Helpers ---

/**
 * Compute bearing (degrees, clockwise from north) from point A to point B.
 */
function computeBearing(latA, lngA, latB, lngB) {
  const dLng = lngB - lngA;
  const dLat = latB - latA;
  // atan2(east, north) gives clockwise-from-north
  const rad = Math.atan2(dLng * METERS_PER_DEG_LNG, dLat * METERS_PER_DEG_LAT);
  return ((rad * 180) / Math.PI + 360) % 360;
}

/**
 * Compute distance in degrees (cheap, no sqrt needed for threshold comparison).
 */
function degDistance(latA, lngA, latB, lngB) {
  const dLat = latB - latA;
  const dLng = lngB - lngA;
  return Math.sqrt(dLat * dLat + dLng * dLng);
}

/** Normalize a bearing difference to [-180, 180] */
function shortestBearingDiff(from, to) {
  let diff = to - from;
  if (diff > 180) diff -= 360;
  if (diff < -180) diff += 360;
  return diff;
}

// --- Real-Time Vehicles ---

async function fetchVehicles() {
  try {
    const res = await fetch(apiUrl('vehicles'));
    const data = await res.json();
    const now = performance.now();
    const fetchDt = (now - lastFetchTime) / 1000; // seconds since last fetch
    lastFetchTime = now;

    const currentIds = new Set();

    data.vehicles.forEach(v => {
      currentIds.add(v.id);

      if (vehicleData[v.id]) {
        // Existing vehicle — blend from current display position to new GPS target
        const vd = vehicleData[v.id];

        // Previous raw GPS for bearing computation
        const prevGpsLat = vd.current.lat;
        const prevGpsLng = vd.current.lng;

        // Set prev to current *display* position for seamless blending
        vd.prev = {
          lat: vd.displayLat,
          lng: vd.displayLng,
          bearing: vd.displayBearing
        };
        vd.current = v;
        vd.animStart = now;

        // Compute travel bearing from raw GPS delta
        const dist = degDistance(prevGpsLat, prevGpsLng, v.lat, v.lng);
        if (dist > MOVE_THRESHOLD_DEG) {
          vd.computedBearing = computeBearing(prevGpsLat, prevGpsLng, v.lat, v.lng);
          vd.isMoving = true;
        } else {
          vd.isMoving = false;
        }

      } else {
        // New vehicle — place immediately, no animation
        vehicleData[v.id] = {
          prev: { lat: v.lat, lng: v.lng, bearing: 0 },
          current: v,
          displayLat: v.lat,
          displayLng: v.lng,
          displayBearing: 0,
          animStart: now,
          computedBearing: 0,
          isMoving: false,
          marker: null,
          element: null
        };
        createVehicleMarker(v.id);
      }
    });

    // Remove vehicles no longer in feed
    Object.keys(vehicleData).forEach(id => {
      if (!currentIds.has(id)) {
        if (vehicleData[id].marker) {
          vehicleData[id].marker.remove();
        }
        delete vehicleData[id];
      }
    });

  } catch (err) {
    console.error('[CivicPulse Transit] Vehicle fetch error:', err.message);
  }
}

function createVehicleMarker(id) {
  const vd = vehicleData[id];
  const v = vd.current;
  const isTram  = v.routeType === 0;
  const isMetro = v.routeType === 1 || v.routeType === 2;

  // Create DOM element
  const el = document.createElement('div');
  el.className = `vehicle-marker ${isTram ? 'tram' : isMetro ? 'metro' : 'bus'}`;
  el.setAttribute('data-vehicle-id', id);
  el.style.setProperty('--route-color', v.routeColor);

  // Inner label
  const label = document.createElement('span');
  label.className = 'vehicle-label';
  label.textContent = v.routeShortName;
  el.appendChild(label);

  // Create MapLibre marker
  const marker = new maplibregl.Marker({
    element: el,
    anchor: 'center',
    rotationAlignment: 'viewport'
  })
    .setLngLat([v.lng, v.lat])
    .addTo(map);

  // Click handler
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    showVehiclePopup(id);
  });

  vd.marker = marker;
  vd.element = el;
}



// --- Animation Loop ---

function startAnimationLoop() {
  function animate() {
    const now = performance.now();

    Object.values(vehicleData).forEach(vd => {
      if (!vd.marker) return;

      const elapsed = now - vd.animStart;

      let lat, lng, bearing;

      // Linear interpolation over the refresh interval — constant speed,
      // no acceleration/deceleration pulses, no overshoot.
      const t = Math.min(elapsed / REFRESH_INTERVAL, 1);

      lat = vd.prev.lat + (vd.current.lat - vd.prev.lat) * t;
      lng = vd.prev.lng + (vd.current.lng - vd.prev.lng) * t;

      // Bearing: blend toward computed bearing (from travel direction)
      if (vd.isMoving) {
        const bDiff = shortestBearingDiff(vd.prev.bearing, vd.computedBearing);
        bearing = vd.prev.bearing + bDiff * t;
      } else {
        bearing = vd.prev.bearing;
      }

      vd.displayLat = lat;
      vd.displayLng = lng;
      vd.displayBearing = bearing;

      vd.marker.setLngLat([lng, lat]);

      // Keep popup following the vehicle
      if (activePopup && activePopupVehicleId === vd.current.id) {
        activePopup.setLngLat([lng, lat]);
      }

      // Update visibility based on type
      const rt = vd.current.routeType;
      const isTram  = rt === 0;
      const isMetro = rt === 1 || rt === 2;
      const visible = isTram ? layerVisibility.tram
                    : isMetro ? layerVisibility.metro
                    : layerVisibility.bus;
      if (vd.element) {
        vd.element.style.display = visible ? '' : 'none';
      }
    });

    animFrameId = requestAnimationFrame(animate);
  }

  animate();
}

// --- Vehicle Popup ---

let activePopup = null;
let activePopupVehicleId = null;

function showVehiclePopup(id) {
  const vd = vehicleData[id];
  if (!vd) return;
  const v = vd.current;

  // Remove existing popup
  if (activePopup) {
    activePopup.remove();
    activePopup = null;
    activePopupVehicleId = null;
  }

  const isTram  = v.routeType === 0;
  const isMetro = v.routeType === 1;
  const isRail  = v.routeType === 2;
  const typeLabel = isTram ? 'TRAM'
                  : isMetro ? 'METRO'
                  : isRail ? 'RAIL'
                  : 'BUS';

  // Calculate arrival time. `nextStopArrival` is a bare "HH:MM:SS" from
  // GTFS stop_times.txt and per the spec it can exceed 24:00:00 — e.g.
  // a trip that starts at 23:30 and reaches its terminus at 01:30 the
  // next day encodes that last stop as "25:30:00", anchored to the
  // service date the trip *started*.
  //
  // JS's `setHours(25, 30, 0, 0)` rolls forward correctly when the local
  // clock is still on that same calendar day. But once the local clock
  // crosses midnight, the rollover lands one day too late and the
  // computed diff comes out exactly 24h off — that's the "next vehicle
  // in 1438 min" bug seen around midnight. We mirror the existing
  // backward-wrap branch with a forward-wrap branch so both directions
  // self-correct.
  let arrivalText = '—';
  if (v.nextStopArrival) {
    const [h, m, s] = v.nextStopArrival.split(':').map(Number);
    const scheduled = new Date();
    scheduled.setHours(h, m, s, 0);
    const now = new Date();
    let diffMs = scheduled.getTime() - now.getTime();

    const ONE_HOUR  = 60 * 60 * 1000;
    const TWO_HOURS = 2 * ONE_HOUR;
    const PLAUSIBLE_LO = -ONE_HOUR;   // arrival was up to 1 h ago → "Now"
    const PLAUSIBLE_HI = TWO_HOURS;   // arrival within 2 h → minutes display

    // Backward wrap: scheduled time appears to have already passed because
    // it landed on today (e.g. now=00:05, arrival="23:55" from yesterday's
    // service-day overlap). Adding 24 h brings it to the plausible window.
    if (diffMs < PLAUSIBLE_LO) {
      const wrapped = diffMs + 24 * ONE_HOUR;
      if (wrapped >= PLAUSIBLE_LO && wrapped <= PLAUSIBLE_HI) diffMs = wrapped;
    }
    // Forward wrap: GTFS sent hour ≥ 24 (e.g. "25:30") and the local
    // clock has *already* crossed midnight, so JS setHours rolled to
    // "tomorrow + h-24" instead of "today + h-24". Subtracting 24 h
    // brings it back to the plausible window.
    else if (diffMs > PLAUSIBLE_HI) {
      const wrapped = diffMs - 24 * ONE_HOUR;
      if (wrapped >= PLAUSIBLE_LO && wrapped <= PLAUSIBLE_HI) diffMs = wrapped;
    }

    if (diffMs > 0 && diffMs < PLAUSIBLE_HI) {
      const mins = Math.floor(diffMs / 60000);
      arrivalText = mins < 1 ? '< 1 min' : `${mins} min`;
    } else if (diffMs >= PLAUSIBLE_LO && diffMs <= 0) {
      arrivalText = 'Now';
    } else {
      arrivalText = '—'; // stale or implausibly far data
    }
  }

  const freqText = v.frequency ? `~${v.frequency}/h` : '—';

  const html = `
    <div class="vehicle-popup">
      <div class="vp-header">
        <div class="vp-line" style="background:${v.routeColor}; color:${v.routeType === 3 ? '#000' : '#fff'}">
          ${v.routeShortName}
        </div>
        <div class="vp-type">${typeLabel} LINE</div>
        <button class="vp-close" onclick="this.closest('.maplibregl-popup').remove()">✕</button>
      </div>
      <div class="vp-body">
        <div class="vp-row">
          <span class="vp-label">Frequency</span>
          <span class="vp-value">${freqText}</span>
        </div>
        <div class="vp-row">
          <span class="vp-label">From</span>
          <span class="vp-value">${v.from || '—'}</span>
        </div>
        <div class="vp-row">
          <span class="vp-label">To</span>
          <span class="vp-value">${v.to || '—'}</span>
        </div>
        <div class="vp-divider"></div>
        <div class="vp-row vp-arrival">
          <span class="vp-label">Arriving in</span>
          <span class="vp-value vp-arrival-value">${arrivalText}</span>
        </div>
        ${v.nextStop ? `<div class="vp-next-stop">→ ${v.nextStop}</div>` : ''}
      </div>
      <div class="vp-footer">
        <span class="vp-headsign">⬥ ${v.headsign || '—'}</span>
      </div>
    </div>
  `;

  activePopup = new maplibregl.Popup({
    closeButton: false,
    closeOnClick: true,
    className: 'civicpulse-popup',
    maxWidth: '320px',
    offset: 15
  })
    .setLngLat([vd.displayLng, vd.displayLat])
    .setHTML(html)
    .addTo(map);

  activePopupVehicleId = id;

  activePopup.on('close', () => {
    activePopup = null;
    activePopupVehicleId = null;
  });
}

// --- Layer Visibility ---

export function setLayerVisibility(type, visible) {
  layerVisibility[type] = visible;

  if (type === 'tram') {
    const vis = visible ? 'visible' : 'none';
    ['tram-routes-glow', 'tram-routes-line'].forEach(layerId => {
      if (map.getLayer(layerId)) map.setLayoutProperty(layerId, 'visibility', vis);
    });
  } else if (type === 'bus') {
    const vis = visible ? 'visible' : 'none';
    ['bus-routes-glow', 'bus-routes-line'].forEach(layerId => {
      if (map.getLayer(layerId)) map.setLayoutProperty(layerId, 'visibility', vis);
    });
  } else if (type === 'metro') {
    const vis = visible ? 'visible' : 'none';
    ['metro-routes-glow', 'metro-routes-line'].forEach(layerId => {
      if (map.getLayer(layerId)) map.setLayoutProperty(layerId, 'visibility', vis);
    });
  }
}

export function toggleLayer(type) {
  setLayerVisibility(type, !layerVisibility[type]);
  return layerVisibility[type];
}

// --- Search ---
// Search transit stops by name. Routes by number are too ambiguous (many
// vehicles per route, no single coord) so we skip them.

export function searchFeatures(query) {
  if (!stopsGeoJSON || !query) return [];
  const q = query.toLowerCase();
  const out = [];
  for (const f of stopsGeoJSON.features) {
    const p = f.properties;
    const name = p.name || '';
    if (!name.toLowerCase().includes(q)) continue;
    out.push({
      label: name,
      sublabel: 'Transit stop' + (p.id ? ' · ' + p.id : ''),
      coords: f.geometry.coordinates,
      color: '#00cfff',
      layerName: 'Stop'
    });
    if (out.length >= 5) break;
  }
  return out;
}

// --- Teardown ---

export function destroyTransit() {
  // Stop the animation loop and the vehicle-poll interval
  if (animFrameId) { cancelAnimationFrame(animFrameId); animFrameId = null; }
  if (vehicleFetchTimer) { clearInterval(vehicleFetchTimer); vehicleFetchTimer = null; }
  // Close any open vehicle popup
  if (activePopup) { activePopup.remove(); activePopup = null; }
  activePopupVehicleId = null;
  // Detach every vehicle marker (they're MapLibre Markers attached to the map)
  Object.values(vehicleData).forEach(vd => { if (vd.marker) vd.marker.remove(); });
  vehicleData = {};
  // Remove route + stop layers and sources
  ['tram-routes-glow', 'tram-routes-line',
   'bus-routes-glow', 'bus-routes-line',
   'metro-routes-glow', 'metro-routes-line',
   'transit-stops-dots', 'transit-stops-labels'].forEach(id => map?.getLayer(id) && map.removeLayer(id));
  ['tram-routes', 'bus-routes', 'metro-routes', 'transit-stops']
    .forEach(id => map?.getSource(id) && map.removeSource(id));
  routesData = [];
  shapesGeoJSON = null;
  stopsGeoJSON = null;
  layerVisibility = { tram: true, bus: true, metro: true };
  lastFetchTime = 0;
  map = null;
}
