/* ============================================
   CivicPulse Poznań — Environmental Sensors Layer
   Air quality data from GIOŚ (Chief Inspectorate
   of Environmental Protection)
   ============================================ */

import maplibregl from 'maplibre-gl';
import { apiUrl } from './cityConfig.js';

const REFRESH_INTERVAL = 30 * 60_000; // 30 min

let map = null;
let envGeoJSON = null;
let visible = true;
let activePopup = null;
let refreshTimer = null;

// AQ level to color
const QUALITY_COLORS = {
  0: '#7ee03a',  // Very Good
  1: '#99cc33',  // Good
  2: '#ffcc00',  // Moderate
  3: '#ff9900',  // Sufficient
  4: '#ff4444',  // Bad
  5: '#990033',  // Very Bad
  '-1': '#888888' // No index
};

const QUALITY_LABELS = {
  0: 'VERY GOOD',
  1: 'GOOD',
  2: 'MODERATE',
  3: 'SUFFICIENT',
  4: 'BAD',
  5: 'VERY BAD',
  '-1': 'NO INDEX'
};

// --- Initialization ---

export async function initEnvironment(mapInstance) {
  map = mapInstance;

  try {
    await fetchEnvironment();
    addEnvironmentLayers();
    setupInteraction();

    refreshTimer = setInterval(async () => {
      if (!visible) return;
      try {
        await fetchEnvironment();
        map.getSource('environment')?.setData(envGeoJSON);
      } catch (e) { /* silent */ }
    }, REFRESH_INTERVAL);

    console.log(
      `%c[CivicPulse Env] ${envGeoJSON.features.length} stations loaded`,
      'color: #7ee03a;'
    );
  } catch (err) {
    console.error('[CivicPulse Env] Init failed:', err);
  }
}

// --- Data ---

async function fetchEnvironment() {
  const res = await fetch(apiUrl('environment'));
  envGeoJSON = await res.json();
}

// --- Map Layers ---

function addEnvironmentLayers() {
  map.addSource('environment', {
    type: 'geojson',
    data: envGeoJSON
  });

  // Outer pulsing glow — color = AQ level
  map.addLayer({
    id: 'env-glow',
    type: 'circle',
    source: 'environment',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 14, 16, 30],
      'circle-color': [
        'match', ['get', 'qualityLevel'],
        0, '#7ee03a',
        1, '#99cc33',
        2, '#ffcc00',
        3, '#ff9900',
        4, '#ff4444',
        5, '#990033',
        '#888888'
      ],
      'circle-opacity': 0.12,
      'circle-blur': 0.6
    }
  });

  // Main station dot
  map.addLayer({
    id: 'env-dot',
    type: 'circle',
    source: 'environment',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 6, 16, 12],
      'circle-color': [
        'match', ['get', 'qualityLevel'],
        0, '#7ee03a',
        1, '#99cc33',
        2, '#ffcc00',
        3, '#ff9900',
        4, '#ff4444',
        5, '#990033',
        '#888888'
      ],
      'circle-stroke-color': '#fff',
      'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 10, 0.5, 16, 1.5],
      'circle-stroke-opacity': 0.4,
      'circle-opacity': 0.9
    }
  });

  // Station name labels
  map.addLayer({
    id: 'env-labels',
    type: 'symbol',
    source: 'environment',
    minzoom: 11,
    layout: {
      'text-field': ['get', 'address'],
      'text-font': ['Noto Sans Regular'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 11, 8, 16, 10],
      'text-offset': [0, 1.8],
      'text-anchor': 'top',
      'text-allow-overlap': true
    },
    paint: {
      'text-color': 'rgba(68, 204, 68, 0.45)',
      'text-halo-color': 'rgba(0, 0, 0, 0.8)',
      'text-halo-width': 1
    }
  });
}

// --- Interaction ---

function setupInteraction() {
  map.on('mouseenter', 'env-dot', () => {
    map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', 'env-dot', () => {
    map.getCanvas().style.cursor = '';
  });

  map.on('click', 'env-dot', (e) => {
    if (!e.features || !e.features[0]) return;
    const f = e.features[0];
    const coords = f.geometry.coordinates.slice();
    const p = f.properties;

    const name = p.name || '—';
    const address = p.address || '—';
    const qualityLevel = parseInt(p.qualityLevel) ?? -1;
    const accentColor = QUALITY_COLORS[qualityLevel] || '#888';
    const qualityLabel = QUALITY_LABELS[qualityLevel] || 'UNKNOWN';

    // Parse readings (may be stringified JSON)
    let readings, aqIndex;
    try {
      readings = typeof p.readings === 'string' ? JSON.parse(p.readings) : (p.readings || {});
    } catch { readings = {}; }
    try {
      aqIndex = typeof p.aqIndex === 'string' ? JSON.parse(p.aqIndex) : (p.aqIndex || null);
    } catch { aqIndex = null; }

    // Build readings rows
    const pollutantOrder = ['PM2.5', 'PM10', 'NO2', 'O3', 'SO2', 'CO', 'C6H6'];
    const pollutantLabels = {
      'PM2.5': 'PM2.5',
      'PM10': 'PM10',
      'NO2': 'NO₂',
      'O3': 'O₃',
      'SO2': 'SO₂',
      'CO': 'CO',
      'C6H6': 'C₆H₆'
    };

    // WHO guidelines for comparison bars (µg/m³, 24h)
    const limits = {
      'PM2.5': 25, 'PM10': 50, 'NO2': 40, 'O3': 120,
      'SO2': 40, 'CO': 10, 'C6H6': 5
    };

    let readingsHtml = '';
    for (const code of pollutantOrder) {
      const r = readings[code];
      if (!r) continue;
      const val = parseFloat(r.value);
      const limit = limits[code] || 50;
      const pct = Math.min(100, Math.round((val / limit) * 100));
      let barColor = '#7ee03a';
      if (pct > 80) barColor = '#ff4444';
      else if (pct > 50) barColor = '#ffcc00';

      readingsHtml += `
        <div class="env-reading">
          <span class="env-pollutant">${pollutantLabels[code]}</span>
          <div class="env-bar-wrap">
            <div class="env-bar" style="width:${pct}%;background:${barColor}"></div>
          </div>
          <span class="env-val">${val.toFixed(1)}</span>
          <span class="env-unit">${r.unit}</span>
        </div>
      `;
    }

    if (!readingsHtml) {
      readingsHtml = '<div class="env-dim" style="padding:6px 0">No current readings</div>';
    }

    // Measurement time
    const firstReading = Object.values(readings)[0];
    const measureTime = firstReading?.date || '—';

    const html = `
      <div class="env-popup">
        <div class="envp-header">
          <div class="envp-quality-dot" style="background:${accentColor}"></div>
          <div class="envp-header-info">
            <div class="envp-title">${name}</div>
            <div class="envp-address">${address}</div>
          </div>
        </div>
        <div class="envp-quality-banner" style="border-color:${accentColor}">
          <span class="envp-quality-label" style="color:${accentColor}">${qualityLabel}</span>
          <span class="envp-quality-source">GIOŚ Air Quality Index</span>
        </div>
        <div class="envp-body">
          ${readingsHtml}
          <div class="envp-divider"></div>
          <div class="envp-stat-row">
            <span class="envp-label">MEASURED</span>
            <span class="envp-value env-dim">${measureTime}</span>
          </div>
        </div>
      </div>
    `;

    if (activePopup) activePopup.remove();

    activePopup = new maplibregl.Popup({
      closeButton: false,
      closeOnClick: true,
      className: 'civicpulse-popup',
      maxWidth: '320px',
      offset: 14
    })
      .setLngLat(coords)
      .setHTML(html)
      .addTo(map);

    activePopup.on('close', () => { activePopup = null; });
  });
}

// --- Search ---

export function searchFeatures(query) {
  if (!envGeoJSON || !query) return [];
  const q = query.toLowerCase();
  const out = [];
  for (const f of envGeoJSON.features) {
    const p = f.properties;
    const hay = [p.name, p.address].filter(Boolean).join(' ').toLowerCase();
    if (!hay.includes(q)) continue;
    const aq = p.aqIndex && p.aqIndex.category ? ' · AQI ' + p.aqIndex.category : '';
    out.push({
      label: p.name || 'Air quality station',
      sublabel: 'Environment' + aq,
      coords: f.geometry.coordinates,
      color: '#7ee03a',
      layerName: 'Environment'
    });
    if (out.length >= 5) break;
  }
  return out;
}

// --- Teardown ---

export function destroyEnvironment() {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  if (activePopup) { activePopup.remove(); activePopup = null; }
  ['env-glow', 'env-dot', 'env-labels'].forEach(id => map?.getLayer(id) && map.removeLayer(id));
  if (map?.getSource('environment')) map.removeSource('environment');
  envGeoJSON = null;
  visible = true;
  map = null;
}

// --- Visibility ---

export function toggleEnvironment() {
  visible = !visible;
  const vis = visible ? 'visible' : 'none';
  ['env-glow', 'env-dot', 'env-labels'].forEach(id => {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis);
  });
  return visible;
}
