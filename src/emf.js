/* ============================================
   CivicPulse Poznań — Electromagnetic Fields Layer
   EMF measurement points from SI2PEM
   ============================================ */

import maplibregl from 'maplibre-gl';
import { apiUrl } from './cityConfig.js';

let map = null;
let emfGeoJSON = null;
let visible = true;
let activePopup = null;

// --- Initialization ---

export async function initEMF(mapInstance) {
  map = mapInstance;

  try {
    await fetchEMF();
    addEMFLayers();
    setupInteraction();

    console.log(
      `%c[CivicPulse EMF] ${emfGeoJSON.features.length} measurement points loaded`,
      'color: #ff3366;'
    );
  } catch (err) {
    console.error('[CivicPulse EMF] Init failed:', err);
  }
}

// --- Data ---

async function fetchEMF() {
  const res = await fetch(apiUrl('emf-measurements'));
  const data = await res.json();

  // Enrich features
  data.features.forEach(f => {
    const p = f.properties;
    // Field strength in V/m — the wm_e property
    p.fieldStrength = typeof p.wm_e === 'number' ? p.wm_e : 0;
    // Normalize intensity for color scale (0-7 V/m typical range)
    p.normalizedIntensity = Math.min(p.fieldStrength / 7, 1);
  });

  emfGeoJSON = data;
}

// --- Map Layers ---

function addEMFLayers() {
  map.addSource('emf-measurements', {
    type: 'geojson',
    data: emfGeoJSON
  });

  // Heat glow (visible at lower zoom)
  map.addLayer({
    id: 'emf-heatmap',
    type: 'heatmap',
    source: 'emf-measurements',
    minzoom: 11,
    maxzoom: 15,
    paint: {
      'heatmap-weight': [
        'interpolate', ['linear'],
        ['get', 'fieldStrength'],
        0, 0.1,
        3, 0.5,
        7, 1
      ],
      'heatmap-intensity': [
        'interpolate', ['linear'], ['zoom'],
        11, 0.5,
        15, 1
      ],
      'heatmap-color': [
        'interpolate', ['linear'], ['heatmap-density'],
        0, 'rgba(255, 51, 102, 0)',
        0.2, 'rgba(255, 51, 102, 0.15)',
        0.4, 'rgba(255, 51, 102, 0.3)',
        0.6, 'rgba(255, 102, 51, 0.45)',
        0.8, 'rgba(255, 153, 0, 0.6)',
        1.0, 'rgba(255, 204, 0, 0.8)'
      ],
      'heatmap-radius': [
        'interpolate', ['linear'], ['zoom'],
        11, 8,
        15, 20
      ],
      'heatmap-opacity': [
        'interpolate', ['linear'], ['zoom'],
        13, 0.7,
        15, 0.3
      ]
    }
  });

  // Individual measurement points — gated to zoom 14+ so the heatmap
  // (11-15) and the points only overlap for one zoom level instead of
  // three. Below zoom 14, 5000 individual circles is roughly 5000 GPU
  // draw calls per frame and the heatmap is more legible anyway.
  map.addLayer({
    id: 'emf-points',
    type: 'circle',
    source: 'emf-measurements',
    minzoom: 14,
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 14, 2, 17, 6],
      'circle-color': [
        'interpolate', ['linear'],
        ['get', 'fieldStrength'],
        0, '#552233',
        1, '#ff3366',
        3, '#ff6633',
        5, '#ff9900',
        7, '#ffcc00'
      ],
      'circle-stroke-color': '#ff3366',
      'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 13, 0, 15, 0.5],
      'circle-stroke-opacity': 0.4,
      'circle-opacity': [
        'interpolate', ['linear'], ['zoom'],
        13, 0.4,
        15, 0.8
      ]
    }
  });
}

// --- Interaction ---

function setupInteraction() {
  map.on('mouseenter', 'emf-points', () => {
    map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', 'emf-points', () => {
    map.getCanvas().style.cursor = '';
  });

  map.on('click', 'emf-points', (e) => {
    if (!e.features || !e.features[0]) return;
    const f = e.features[0];
    const coords = f.geometry.coordinates.slice();
    const p = f.properties;

    const fieldStrength = parseFloat(p.fieldStrength) || 0;
    const date = p.date || '—';
    const lat = parseFloat(p.latitude) || coords[1];
    const lng = parseFloat(p.longitude) || coords[0];
    const source = p.source || '—';
    const belowSensitivity = p.below_sensitivity === true || p.below_sensitivity === 'true';

    // Determine signal level label and color
    let levelLabel, levelColor;
    if (belowSensitivity || fieldStrength < 0.5) {
      levelLabel = 'MINIMAL';
      levelColor = '#666';
    } else if (fieldStrength < 2) {
      levelLabel = 'LOW';
      levelColor = '#ff3366';
    } else if (fieldStrength < 5) {
      levelLabel = 'MODERATE';
      levelColor = '#ff6633';
    } else {
      levelLabel = 'ELEVATED';
      levelColor = '#ffcc00';
    }

    // Format field strength display
    const strengthDisplay = belowSensitivity
      ? `< ${fieldStrength.toFixed(2)}`
      : fieldStrength.toFixed(2);

    const html = `
      <div class="emf-popup">
        <div class="emfp-header">
          <div class="emfp-icon">■</div>
          <div class="emfp-title">EMF MEASUREMENT</div>
        </div>
        <div class="emfp-body">
          <div class="emfp-strength-row">
            <span class="emfp-label">FIELD STRENGTH</span>
            <span class="emfp-strength" style="color:${levelColor}">${strengthDisplay} <small>V/m</small></span>
          </div>
          <div class="emfp-level" style="color:${levelColor}">● ${levelLabel}</div>
          <div class="emfp-divider"></div>
          <div class="emfp-stat-row">
            <span class="emfp-label">DATE</span>
            <span class="emfp-value">${date}</span>
          </div>
          <div class="emfp-stat-row">
            <span class="emfp-label">COORDINATES</span>
            <span class="emfp-value emfp-coords">${lat.toFixed(6)}, ${lng.toFixed(6)}</span>
          </div>
          <div class="emfp-stat-row">
            <span class="emfp-label">SOURCE</span>
            <span class="emfp-value emfp-dim">${source}</span>
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

// --- Teardown ---

export function destroyEMF() {
  if (activePopup) { activePopup.remove(); activePopup = null; }
  ['emf-heatmap', 'emf-points'].forEach(id => map?.getLayer(id) && map.removeLayer(id));
  if (map?.getSource('emf-measurements')) map.removeSource('emf-measurements');
  emfGeoJSON = null;
  visible = true;
  map = null;
}

// --- Visibility ---

export function toggleEMF() {
  visible = !visible;
  const vis = visible ? 'visible' : 'none';
  ['emf-heatmap', 'emf-points'].forEach(id => {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis);
  });
  return visible;
}
