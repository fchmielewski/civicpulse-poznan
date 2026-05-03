/* ============================================
   CivicPulse Poznań — Mobile Base Stations Layer
   Cell towers from SI2PEM
   ============================================ */

import maplibregl from 'maplibre-gl';
import { showNetworkLinks } from './network.js';
import { fetchGeoJSON } from './cityConfig.js';

let map = null;
let stationsGeoJSON = null;
let visible = true;
let activePopup = null;

// --- Initialization ---

export async function initMobile(mapInstance) {
  map = mapInstance;

  try {
    await fetchStations();
    addStationLayers();
    setupInteraction();

    const active = stationsGeoJSON.features.filter(f => f.properties.is_active).length;
    const with5G = stationsGeoJSON.features.filter(f => f.properties.has5G).length;
    console.log(
      `%c[CivicPulse Mobile] ${stationsGeoJSON.features.length} base stations (${active} active, ${with5G} with 5G)`,
      'color: #ff6633;'
    );
  } catch (err) {
    console.error('[CivicPulse Mobile] Init failed:', err);
  }
}

// --- Data ---

async function fetchStations() {
  stationsGeoJSON = await fetchGeoJSON('base-stations');
}

// --- Map Layers ---

function addStationLayers() {
  map.addSource('base-stations', {
    type: 'geojson',
    data: stationsGeoJSON
  });

  // Outer glow — minzoom 13 (was 12). circle-blur:1 is the maximum-blur
  // setting and runs an expensive fragment shader; the dot stands fine
  // alone at 12. Cuts roughly half the stations' GPU cost during the
  // most-zoomed-out frame Warsaw shows by default.
  map.addLayer({
    id: 'base-stations-glow',
    type: 'circle',
    source: 'base-stations',
    minzoom: 13,
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 13, 4, 17, 14],
      'circle-color': [
        'case',
        ['get', 'has5G'], '#ff6633',
        ['get', 'hasLTE'], '#ff8844',
        '#995533'
      ],
      'circle-opacity': 0.1,
      'circle-blur': 1
    }
  });

  // Main dot — 5G stations are brighter/bigger
  map.addLayer({
    id: 'base-stations-dot',
    type: 'circle',
    source: 'base-stations',
    minzoom: 12,
    paint: {
      'circle-radius': [
        'interpolate', ['linear'], ['zoom'],
        12, ['case', ['get', 'has5G'], 3, 2],
        17, ['case', ['get', 'has5G'], 7, 5]
      ],
      'circle-color': [
        'case',
        ['get', 'has5G'], '#ff6633',
        ['get', 'hasLTE'], '#ff8844',
        '#996644'
      ],
      'circle-stroke-color': [
        'case',
        ['get', 'has5G'], '#ff6633',
        '#ff8844'
      ],
      'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 12, 0.3, 16, 1],
      'circle-stroke-opacity': 0.5,
      'circle-opacity': [
        'case',
        ['get', 'is_active'], 0.8,
        0.25
      ]
    }
  });

  // Labels at high zoom
  map.addLayer({
    id: 'base-stations-labels',
    type: 'symbol',
    source: 'base-stations',
    minzoom: 15,
    layout: {
      'text-field': ['get', 'standardsDisplay'],
      'text-font': ['Noto Sans Regular'],
      'text-size': 8,
      'text-offset': [0, 1.4],
      'text-anchor': 'top',
      'text-allow-overlap': false
    },
    paint: {
      'text-color': 'rgba(255, 102, 51, 0.5)',
      'text-halo-color': 'rgba(0, 0, 0, 0.8)',
      'text-halo-width': 1
    }
  });
}

// --- Interaction ---

function setupInteraction() {
  map.on('mouseenter', 'base-stations-dot', () => {
    map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', 'base-stations-dot', () => {
    map.getCanvas().style.cursor = '';
  });

  map.on('click', 'base-stations-dot', (e) => {
    if (!e.features || !e.features[0]) return;
    const f = e.features[0];
    const coords = f.geometry.coordinates.slice();
    const p = f.properties;

    const name = p.name || '—';
    const operator = p.operator_name || '—';
    const address = p.address || '—';
    const stationId = p.identity_name || '—';
    const isActive = p.is_active === true || p.is_active === 'true';
    const isShared = p.is_shared === true || p.is_shared === 'true';

    // Parse standards — may come as string from GeoJSON properties
    let standards;
    try {
      standards = typeof p.standards === 'string' ? JSON.parse(p.standards) : (p.standards || []);
    } catch { standards = []; }
    const standardsDisplay = p.standardsDisplay || '—';

    // Build technology badges
    const badgeColors = {
      '5G NR': '#ff4400',
      'LTE': '#ff8844',
      'UMTS': '#bb7744',
      'GSM': '#886644'
    };
    const badges = standards.map(s => {
      const color = badgeColors[s] || '#888';
      return `<span class="bts-badge" style="background:${color}">${s}</span>`;
    }).join('');

    const statusColor = isActive ? '#4dff4d' : '#666';
    const statusLabel = isActive ? 'ACTIVE' : 'INACTIVE';

    const html = `
      <div class="bts-popup">
        <div class="btsp-header">
          <div class="btsp-icon">●</div>
          <div class="btsp-title">${stationId}</div>
          <div class="btsp-status" style="color:${statusColor}">● ${statusLabel}</div>
        </div>
        <div class="btsp-body">
          <div class="btsp-badges">${badges || '<span class="btsp-dim">No data</span>'}</div>
          <div class="btsp-divider"></div>
          <div class="btsp-stat-row">
            <span class="btsp-label">OPERATOR</span>
            <span class="btsp-value">${operator}</span>
          </div>
          <div class="btsp-stat-row">
            <span class="btsp-label">SITE NAME</span>
            <span class="btsp-value btsp-dim">${name}</span>
          </div>
          <div class="btsp-stat-row">
            <span class="btsp-label">ADDRESS</span>
            <span class="btsp-value btsp-dim">${address}</span>
          </div>
          ${isShared ? '<div class="btsp-shared">⬥ SHARED INFRASTRUCTURE</div>' : ''}
        </div>
      </div>
    `;

    if (activePopup) activePopup.remove();

    activePopup = new maplibregl.Popup({
      closeButton: false,
      closeOnClick: true,
      className: 'civicpulse-popup',
      maxWidth: '320px',
      offset: 12
    })
      .setLngLat(coords)
      .setHTML(html)
      .addTo(map);

    activePopup.on('close', () => { activePopup = null; });

    showNetworkLinks(map, f, stationsGeoJSON.features, 'operator_name', { color: '#ff8844' });
  });
}

// --- Search ---

export function searchFeatures(query) {
  if (!stationsGeoJSON || !query) return [];
  const q = query.toLowerCase();
  const out = [];
  for (const f of stationsGeoJSON.features) {
    const p = f.properties;
    const hay = [p.operator_name, p.operator, p.station_id, p.address].filter(Boolean).join(' ').toLowerCase();
    if (!hay.includes(q)) continue;
    out.push({
      label: p.operator_name || p.operator || 'Base station',
      sublabel: `Mobile${p.has5G ? ' · 5G' : ''}${p.station_id ? ' · ' + p.station_id : ''}`,
      coords: f.geometry.coordinates,
      color: '#ff6633',
      layerName: 'Mobile'
    });
    if (out.length >= 5) break;
  }
  return out;
}

// --- Teardown ---

export function destroyMobile() {
  if (activePopup) { activePopup.remove(); activePopup = null; }
  ['base-stations-glow', 'base-stations-dot', 'base-stations-labels'].forEach(id => map?.getLayer(id) && map.removeLayer(id));
  if (map?.getSource('base-stations')) map.removeSource('base-stations');
  stationsGeoJSON = null;
  visible = true;
  map = null;
}

// --- Visibility ---

export function toggleMobile() {
  visible = !visible;
  const vis = visible ? 'visible' : 'none';
  ['base-stations-glow', 'base-stations-dot', 'base-stations-labels'].forEach(id => {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis);
  });
  return visible;
}
