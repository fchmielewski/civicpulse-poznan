/* ============================================
   CivicPulse Poznań — Traffic Lights Layer
   Signal locations from OpenStreetMap
   ============================================ */

import maplibregl from 'maplibre-gl';
import { fetchGeoJSON } from './cityConfig.js';

let map = null;
let trafficGeoJSON = null;
let visible = true;
let activePopup = null;

// Signal type labels
const SIGNAL_LABELS = {
  standard: 'Standard',
  signal: 'Signal',
  traffic_lights: 'Traffic Lights',
  pedestrian_crossing: 'Pedestrian',
  emergency: 'Emergency',
  stop_line: 'Stop Line'
};

// --- Initialization ---

export async function initTrafficLights(mapInstance) {
  map = mapInstance;

  try {
    await fetchTrafficLights();
    addTrafficLightLayers();
    setupInteraction();

    console.log(
      `%c[CivicPulse Traffic] ${trafficGeoJSON.features.length} signals loaded`,
      'color: #ffcc00;'
    );
  } catch (err) {
    console.error('[CivicPulse Traffic] Init failed:', err);
  }
}

// --- Data ---

async function fetchTrafficLights() {
  trafficGeoJSON = await fetchGeoJSON('traffic-lights');
}

// --- Map Layers ---

function addTrafficLightLayers() {
  map.addSource('traffic-lights', {
    type: 'geojson',
    data: trafficGeoJSON
  });

  // Amber glow
  map.addLayer({
    id: 'tl-glow',
    type: 'circle',
    source: 'traffic-lights',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 2, 16, 6],
      'circle-color': '#ffcc00',
      'circle-opacity': 0.06,
      'circle-blur': 0.5
    }
  });

  // Dot — tiny amber, dense grid
  map.addLayer({
    id: 'tl-dot',
    type: 'circle',
    source: 'traffic-lights',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 1, 14, 1.8, 16, 3],
      'circle-color': [
        'match', ['get', 'signalType'],
        'pedestrian_crossing', '#44dd88',
        'emergency', '#ff4444',
        '#ffcc00'
      ],
      'circle-stroke-color': '#000',
      'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 11, 0, 15, 0.2],
      'circle-stroke-opacity': 0.3,
      'circle-opacity': 0.7
    }
  });
}

// --- Interaction ---

function setupInteraction() {
  map.on('mouseenter', 'tl-dot', () => {
    map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', 'tl-dot', () => {
    map.getCanvas().style.cursor = '';
  });

  map.on('click', 'tl-dot', (e) => {
    if (!e.features || !e.features[0]) return;
    const f = e.features[0];
    const coords = f.geometry.coordinates.slice();
    const p = f.properties;

    const signalType = p.signalType || 'standard';
    const direction = p.direction || '';
    const crossing = p.crossing || '';
    const buttonOp = p.buttonOperated || '';
    const sound = p.sound || '';
    const radar = p.radar || '';

    const typeLabel = SIGNAL_LABELS[signalType] || signalType;

    // Color by type
    let accentColor = '#ffcc00';
    if (signalType === 'pedestrian_crossing') accentColor = '#44dd88';
    else if (signalType === 'emergency') accentColor = '#ff4444';

    // Build tags
    const tags = [];
    if (direction) tags.push(direction.toUpperCase());
    if (crossing) tags.push('CROSSING');
    if (buttonOp === 'yes') tags.push('BUTTON');
    if (sound === 'yes') tags.push('AUDIO');
    if (radar === 'yes') tags.push('RADAR');

    const tagsHtml = tags.length
      ? tags.map(t => `<span class="tlp-tag" style="border-color:${accentColor}40;color:${accentColor}">${t}</span>`).join('')
      : '';

    const html = `
      <div class="tl-popup">
        <div class="tlp-header">
          <div class="tlp-icon" style="color:${accentColor}">⦿</div>
          <div class="tlp-header-info">
            <div class="tlp-type" style="color:${accentColor}">TRAFFIC SIGNAL</div>
            <div class="tlp-subtype">${typeLabel}</div>
          </div>
        </div>
        <div class="tlp-body">
          ${tagsHtml ? `<div class="tlp-tags">${tagsHtml}</div>` : ''}
          ${direction ? `<div class="tlp-stat-row">
            <span class="tlp-label">DIRECTION</span>
            <span class="tlp-value">${direction}</span>
          </div>` : ''}
          ${crossing ? `<div class="tlp-stat-row">
            <span class="tlp-label">CROSSING</span>
            <span class="tlp-value">${crossing}</span>
          </div>` : ''}
          ${radar === 'yes' ? `<div class="tlp-stat-row">
            <span class="tlp-label">RADAR</span>
            <span class="tlp-value" style="color:#ff4444">Active</span>
          </div>` : ''}
          <div class="tlp-stat-row">
            <span class="tlp-label">COORDS</span>
            <span class="tlp-value tlp-dim">${coords[1].toFixed(5)}, ${coords[0].toFixed(5)}</span>
          </div>
        </div>
      </div>
    `;

    if (activePopup) activePopup.remove();

    activePopup = new maplibregl.Popup({
      closeButton: false,
      closeOnClick: true,
      className: 'civicpulse-popup',
      maxWidth: '260px',
      offset: 10
    })
      .setLngLat(coords)
      .setHTML(html)
      .addTo(map);

    activePopup.on('close', () => { activePopup = null; });
  });
}

// --- Teardown ---

export function destroyTrafficLights() {
  if (activePopup) { activePopup.remove(); activePopup = null; }
  ['tl-glow', 'tl-dot'].forEach(id => map?.getLayer(id) && map.removeLayer(id));
  if (map?.getSource('traffic-lights')) map.removeSource('traffic-lights');
  trafficGeoJSON = null;
  visible = true;
  map = null;
}

// --- Visibility ---

export function toggleTrafficLights() {
  visible = !visible;
  const vis = visible ? 'visible' : 'none';
  ['tl-glow', 'tl-dot'].forEach(id => {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis);
  });
  return visible;
}
