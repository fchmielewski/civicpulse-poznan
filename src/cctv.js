/* ============================================
   CivicPulse Poznań — CCTV Cameras Layer
   Surveillance camera locations from OpenStreetMap
   ============================================ */

import maplibregl from 'maplibre-gl';
import { fetchGeoJSON } from './cityConfig.js';

let map = null;
let cctvGeoJSON = null;
let visible = true;
let activePopup = null;

// Single layer color — matches the sidebar legend so every CCTV dot reads
// as "CCTV" at a glance, regardless of OSM zone tag.
const CCTV_COLOR = '#ff3333';

const ZONE_LABELS = {
  traffic: 'TRAFFIC',
  parking: 'PARKING',
  entrance: 'ENTRANCE',
  gate: 'GATE',
  town: 'PUBLIC',
  street: 'STREET',
  building: 'BUILDING',
  outdoor: 'OUTDOOR',
  driveway: 'DRIVEWAY',
  residential: 'RESIDENTIAL',
  unknown: 'SURVEILLANCE'
};

// --- Initialization ---

export async function initCCTV(mapInstance) {
  map = mapInstance;

  try {
    await fetchCCTV();
    addCCTVLayers();
    setupInteraction();

    const zones = {};
    cctvGeoJSON.features.forEach(f => {
      const z = f.properties.zone;
      zones[z] = (zones[z] || 0) + 1;
    });
    const top = Object.entries(zones).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k}:${v}`).join(' ');
    console.log(
      `%c[CivicPulse CCTV] ${cctvGeoJSON.features.length} cameras (${top})`,
      'color: #ff3333;'
    );
  } catch (err) {
    console.error('[CivicPulse CCTV] Init failed:', err);
  }
}

// --- Data ---

async function fetchCCTV() {
  cctvGeoJSON = await fetchGeoJSON('cctv');
}

// --- Map Layers ---

function addCCTVLayers() {
  map.addSource('cctv', {
    type: 'geojson',
    data: cctvGeoJSON
  });

  // Subtle glow
  map.addLayer({
    id: 'cctv-glow',
    type: 'circle',
    source: 'cctv',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 3, 16, 8],
      'circle-color': CCTV_COLOR,
      'circle-opacity': 0.07,
      'circle-blur': 0.5
    }
  });

  // Tiny dot — cameras should feel dense and surveillance-like
  map.addLayer({
    id: 'cctv-dot',
    type: 'circle',
    source: 'cctv',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 1.2, 14, 2, 16, 3.5],
      'circle-color': CCTV_COLOR,
      'circle-stroke-color': '#000',
      'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 11, 0, 14, 0.2],
      'circle-stroke-opacity': 0.4,
      'circle-opacity': 0.75
    }
  });

  // Zone labels at very high zoom
  map.addLayer({
    id: 'cctv-labels',
    type: 'symbol',
    source: 'cctv',
    minzoom: 16,
    layout: {
      'text-field': ['get', 'zone'],
      'text-font': ['Noto Sans Regular'],
      'text-size': 7,
      'text-offset': [0, 1.0],
      'text-anchor': 'top',
      'text-allow-overlap': false,
      'text-transform': 'uppercase'
    },
    paint: {
      'text-color': 'rgba(255, 51, 51, 0.3)',
      'text-halo-color': 'rgba(0, 0, 0, 0.8)',
      'text-halo-width': 1
    }
  });
}

// --- Interaction ---

function setupInteraction() {
  map.on('mouseenter', 'cctv-dot', () => {
    map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', 'cctv-dot', () => {
    map.getCanvas().style.cursor = '';
  });

  map.on('click', 'cctv-dot', (e) => {
    if (!e.features || !e.features[0]) return;
    const f = e.features[0];
    const coords = f.geometry.coordinates.slice();
    const p = f.properties;

    const zone = p.zone || 'unknown';
    const cameraType = p.cameraType || 'unknown';
    const mount = p.mount || 'unknown';
    const surveillance = p.surveillance || 'unknown';
    const direction = p.direction || '';
    const operator = p.operator || '';
    const description = p.description || '';

    const zoneLabel = ZONE_LABELS[zone] || zone.toUpperCase();
    const accentColor = CCTV_COLOR;

    // Format camera type
    const typeLabels = {
      fixed: 'Fixed', panning: 'PTZ', dome: 'Dome', unknown: '—'
    };
    const mountLabels = {
      pole: 'Pole', wall: 'Wall', ceiling: 'Ceiling', building: 'Building', unknown: '—'
    };

    const html = `
      <div class="cctv-popup">
        <div class="cctvp-header">
          <div class="cctvp-icon" style="color:${accentColor}">⦿</div>
          <div class="cctvp-header-info">
            <div class="cctvp-zone" style="color:${accentColor}">${zoneLabel}</div>
            <div class="cctvp-subtitle">Surveillance Camera</div>
          </div>
          <div class="cctvp-badge" style="border-color:${accentColor};color:${accentColor}">${surveillance.toUpperCase()}</div>
        </div>
        <div class="cctvp-body">
          <div class="cctvp-stat-row">
            <span class="cctvp-label">TYPE</span>
            <span class="cctvp-value">${typeLabels[cameraType] || cameraType}</span>
          </div>
          <div class="cctvp-stat-row">
            <span class="cctvp-label">MOUNT</span>
            <span class="cctvp-value">${mountLabels[mount] || mount}</span>
          </div>
          ${direction ? `<div class="cctvp-stat-row">
            <span class="cctvp-label">DIRECTION</span>
            <span class="cctvp-value">${direction}°</span>
          </div>` : ''}
          ${operator ? `<div class="cctvp-stat-row">
            <span class="cctvp-label">OPERATOR</span>
            <span class="cctvp-value cctvp-dim">${operator}</span>
          </div>` : ''}
          ${description ? `<div class="cctvp-stat-row">
            <span class="cctvp-label">NOTE</span>
            <span class="cctvp-value cctvp-dim">${description}</span>
          </div>` : ''}
          <div class="cctvp-stat-row">
            <span class="cctvp-label">COORDS</span>
            <span class="cctvp-value cctvp-dim">${coords[1].toFixed(5)}, ${coords[0].toFixed(5)}</span>
          </div>
        </div>
      </div>
    `;

    if (activePopup) activePopup.remove();

    activePopup = new maplibregl.Popup({
      closeButton: false,
      closeOnClick: true,
      className: 'civicpulse-popup',
      maxWidth: '280px',
      offset: 10
    })
      .setLngLat(coords)
      .setHTML(html)
      .addTo(map);

    activePopup.on('close', () => { activePopup = null; });
  });
}

// --- Teardown ---

export function destroyCCTV() {
  if (activePopup) { activePopup.remove(); activePopup = null; }
  ['cctv-glow', 'cctv-dot', 'cctv-labels'].forEach(id => map?.getLayer(id) && map.removeLayer(id));
  if (map?.getSource('cctv')) map.removeSource('cctv');
  cctvGeoJSON = null;
  visible = true;
  map = null;
}

// --- Visibility ---

export function toggleCCTV() {
  visible = !visible;
  const vis = visible ? 'visible' : 'none';
  ['cctv-glow', 'cctv-dot', 'cctv-labels'].forEach(id => {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis);
  });
  return visible;
}
