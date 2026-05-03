/* ============================================
   CivicPulse Poznań — Bicycle Counters Layer
   Real-time bicycle counting stations
   ============================================ */

import maplibregl from 'maplibre-gl';
import { fetchGeoJSON, getCityConfig } from './cityConfig.js';

const REFRESH_INTERVAL = 300000; // 5 minutes (data updates ~daily)

let map = null;
let countersGeoJSON = null;
let visible = true;
let activePopup = null;
let refreshTimer = null;

// --- Initialization ---

export async function initBicycleCounters(mapInstance) {
  map = mapInstance;

  try {
    await fetchCounters();
    addCounterLayers();
    setupInteraction();

    // Periodic refresh — `map` may be nulled by destroy() between when the
    // interval fires and when our await resolves; check before touching it.
    refreshTimer = setInterval(async () => {
      await fetchCounters();
      if (!map) return;
      if (map.getSource('bicycle-counters')) {
        map.getSource('bicycle-counters').setData(countersGeoJSON);
      }
    }, REFRESH_INTERVAL);

    console.log(
      `%c[CivicPulse Bicycles] ${countersGeoJSON.features.length} counting stations online`,
      'color: #4dff4d;'
    );
  } catch (err) {
    console.error('[CivicPulse Bicycles] Init failed:', err);
  }
}

// --- Data ---

// Escape literal regex metacharacters in a string so it can be embedded
// inside `new RegExp(...)`. Used for the city-name prefix strip below.
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function fetchCounters() {
  const data = await fetchGeoJSON('bicycle-counters');

  // Enrich features with computed properties
  // Build a regex that strips the *current city's* name prefix so "Łódź - X"
  // becomes "X" when this layer is enabled there in future. Was hardcoded
  // to "Poznań" which silently no-ops for any other city.
  const cityName = getCityConfig()?.name || '';
  const cityPrefix = cityName ? new RegExp(`^${escapeRegex(cityName)}\\s*-\\s*`, 'i') : null;
  data.features.forEach(f => {
    const p = f.properties;
    p.displayName = cityPrefix ? (p.name || '').replace(cityPrefix, '') : (p.name || '');
    // Parse numbers
    p.today = parseInt(p.stats_last_day) || 0;
    p.avgDay = parseInt(p.stats_avg_day) || 0;
    p.total = parseInt(p.stats_total) || 0;
    // Activity ratio: today vs average (for color coding)
    p.activity = p.avgDay > 0 ? p.today / p.avgDay : 0;
  });

  countersGeoJSON = data;
}

// --- Map Layers ---

function addCounterLayers() {
  map.addSource('bicycle-counters', {
    type: 'geojson',
    data: countersGeoJSON
  });

  // Outer glow ring
  map.addLayer({
    id: 'bicycle-counters-glow',
    type: 'circle',
    source: 'bicycle-counters',
    minzoom: 11,
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 6, 16, 18],
      'circle-color': '#4dff4d',
      'circle-opacity': 0.12,
      'circle-blur': 1
    }
  });

  // Main dot
  map.addLayer({
    id: 'bicycle-counters-dot',
    type: 'circle',
    source: 'bicycle-counters',
    minzoom: 11,
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 3, 16, 8],
      'circle-color': [
        'interpolate', ['linear'],
        ['get', 'activity'],
        0, '#334433',     // inactive/no data
        0.5, '#4dff4d',   // below average
        1.0, '#4dff4d',   // average
        1.5, '#aaff44',   // above average
        2.0, '#ffcc00'    // very busy
      ],
      'circle-stroke-color': '#4dff4d',
      'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 11, 0.5, 16, 1.5],
      'circle-stroke-opacity': 0.6,
      'circle-opacity': 0.85
    }
  });

  // Labels
  map.addLayer({
    id: 'bicycle-counters-labels',
    type: 'symbol',
    source: 'bicycle-counters',
    minzoom: 14,
    layout: {
      'text-field': ['get', 'displayName'],
      'text-font': ['Noto Sans Regular'],
      'text-size': 9,
      'text-offset': [0, 1.5],
      'text-anchor': 'top',
      'text-max-width': 10,
      'text-allow-overlap': false
    },
    paint: {
      'text-color': 'rgba(77, 255, 77, 0.6)',
      'text-halo-color': 'rgba(0, 0, 0, 0.8)',
      'text-halo-width': 1
    }
  });
}

// --- Interaction ---

function setupInteraction() {
  // Cursor
  map.on('mouseenter', 'bicycle-counters-dot', () => {
    map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', 'bicycle-counters-dot', () => {
    map.getCanvas().style.cursor = '';
  });

  // Click
  map.on('click', 'bicycle-counters-dot', (e) => {
    if (!e.features || !e.features[0]) return;
    const f = e.features[0];
    const coords = f.geometry.coordinates.slice();
    const p = f.properties;

    // Parse activity for the bar visualization
    const today = parseInt(p.today) || 0;
    const avgDay = parseInt(p.avgDay) || 0;
    const total = parseInt(p.total) || 0;
    const activity = parseFloat(p.activity) || 0;
    const lastUpdate = p.last_update || '—';
    const displayName = p.displayName || p.name || '—';

    // Activity bar width (capped at 100%)
    const barPct = Math.min(activity * 100, 200);
    const activityLabel = activity > 1.2
      ? 'ABOVE AVG'
      : activity > 0.8
        ? 'AVERAGE'
        : activity > 0
          ? 'BELOW AVG'
          : 'NO DATA';
    const activityColor = activity > 1.2
      ? '#ffcc00'
      : activity > 0.8
        ? '#4dff4d'
        : '#666';

    const html = `
      <div class="bike-counter-popup">
        <div class="bcp-header">
          <div class="bcp-icon">●</div>
          <div class="bcp-title">${displayName}</div>
        </div>
        <div class="bcp-body">
          <div class="bcp-stat-row">
            <span class="bcp-label">TODAY</span>
            <span class="bcp-value bcp-today">${today.toLocaleString()}</span>
          </div>
          <div class="bcp-bar-container">
            <div class="bcp-bar" style="width:${barPct}%; background:${activityColor}"></div>
          </div>
          <div class="bcp-stat-row">
            <span class="bcp-label">DAILY AVG</span>
            <span class="bcp-value">${avgDay.toLocaleString()}</span>
          </div>
          <div class="bcp-stat-row">
            <span class="bcp-label">TOTAL</span>
            <span class="bcp-value">${total.toLocaleString()}</span>
          </div>
          <div class="bcp-divider"></div>
          <div class="bcp-stat-row">
            <span class="bcp-label">STATUS</span>
            <span class="bcp-value" style="color:${activityColor}">${activityLabel}</span>
          </div>
          <div class="bcp-stat-row">
            <span class="bcp-label">UPDATED</span>
            <span class="bcp-value bcp-dim">${lastUpdate}</span>
          </div>
        </div>
      </div>
    `;

    if (activePopup) activePopup.remove();

    activePopup = new maplibregl.Popup({
      closeButton: false,
      closeOnClick: true,
      className: 'civicpulse-popup',
      maxWidth: '300px',
      offset: 12
    })
      .setLngLat(coords)
      .setHTML(html)
      .addTo(map);

    activePopup.on('close', () => { activePopup = null; });
  });
}

// --- Search ---

export function searchFeatures(query) {
  if (!countersGeoJSON || !query) return [];
  const q = query.toLowerCase();
  const out = [];
  for (const f of countersGeoJSON.features) {
    const p = f.properties;
    const hay = [p.displayName, p.name].filter(Boolean).join(' ').toLowerCase();
    if (!hay.includes(q)) continue;
    out.push({
      label: p.displayName || p.name || 'Bicycle counter',
      sublabel: 'Bicycle counter' + (typeof p.today === 'number' ? ' · ' + p.today.toLocaleString() + ' today' : ''),
      coords: f.geometry.coordinates,
      color: '#4dff4d',
      layerName: 'Bicycle counter'
    });
    if (out.length >= 5) break;
  }
  return out;
}

// --- Teardown ---

export function destroyBicycleCounters() {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  if (activePopup) { activePopup.remove(); activePopup = null; }
  ['bicycle-counters-glow', 'bicycle-counters-dot', 'bicycle-counters-labels'].forEach(id => map?.getLayer(id) && map.removeLayer(id));
  if (map?.getSource('bicycle-counters')) map.removeSource('bicycle-counters');
  countersGeoJSON = null;
  visible = true;
  map = null;
}

// --- Visibility ---

export function toggleBicycleCounters() {
  visible = !visible;
  const vis = visible ? 'visible' : 'none';
  ['bicycle-counters-glow', 'bicycle-counters-dot', 'bicycle-counters-labels'].forEach(id => {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis);
  });
  return visible;
}
