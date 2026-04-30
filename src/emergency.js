/* ============================================
   CivicPulse Poznań — Emergency Services Layer
   Fire stations, police, hospitals, ambulance
   from OpenStreetMap
   ============================================ */

import maplibregl from 'maplibre-gl';
import { fetchGeoJSON } from './cityConfig.js';

let map = null;
let emergencyGeoJSON = null;
let visible = true;
let activePopup = null;

// Service type config — single-letter typographic codes (F/P/H/A/!) keep
// the popup headers consistent with the rest of the CivicPulse palette (P for
// parking, ⬡ for tor, ◆ for atm, etc.). The service color does the rest
// of the work to differentiate the type.
const SERVICE_CONFIG = {
  fire: {
    color: '#ff4422',
    glowColor: 'rgba(255, 68, 34, 0.15)',
    icon: 'F',
    label: 'FIRE STATION',
    emergencyNum: '998 / 112'
  },
  police: {
    color: '#4488ff',
    glowColor: 'rgba(68, 136, 255, 0.15)',
    icon: 'P',
    label: 'POLICE',
    emergencyNum: '997 / 112'
  },
  hospital: {
    color: '#44dd88',
    glowColor: 'rgba(68, 221, 136, 0.15)',
    icon: 'H',
    label: 'HOSPITAL',
    emergencyNum: '999 / 112'
  },
  ambulance: {
    color: '#ffaa22',
    glowColor: 'rgba(255, 170, 34, 0.15)',
    icon: 'A',
    label: 'AMBULANCE',
    emergencyNum: '999 / 112'
  },
  other: {
    color: '#888888',
    glowColor: 'rgba(136, 136, 136, 0.15)',
    icon: '!',
    label: 'EMERGENCY',
    emergencyNum: '112'
  }
};

// --- Initialization ---

export async function initEmergency(mapInstance) {
  map = mapInstance;

  try {
    await fetchEmergency();
    addEmergencyLayers();
    setupInteraction();

    const counts = {};
    emergencyGeoJSON.features.forEach(f => {
      const t = f.properties.serviceType;
      counts[t] = (counts[t] || 0) + 1;
    });
    const summary = Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(' ');
    console.log(
      `%c[CivicPulse Emergency] ${emergencyGeoJSON.features.length} services (${summary})`,
      'color: #ff4422;'
    );
  } catch (err) {
    console.error('[CivicPulse Emergency] Init failed:', err);
  }
}

// --- Data ---

async function fetchEmergency() {
  emergencyGeoJSON = await fetchGeoJSON('emergency');
}

// --- Map Layers ---

function addEmergencyLayers() {
  map.addSource('emergency', {
    type: 'geojson',
    data: emergencyGeoJSON
  });

  // Color expression based on serviceType
  const colorExpr = [
    'match', ['get', 'serviceType'],
    'fire', '#ff4422',
    'police', '#4488ff',
    'hospital', '#44dd88',
    'ambulance', '#ffaa22',
    '#888888'
  ];

  // Size by type — hospitals larger
  const sizeExpr = [
    'match', ['get', 'serviceType'],
    'hospital', 1.3,
    'fire', 1.2,
    'ambulance', 1.1,
    1.0
  ];

  // Outer glow — minzoom 12 to cull blurred halos at city-overview zoom.
  map.addLayer({
    id: 'emergency-glow',
    type: 'circle',
    source: 'emergency',
    minzoom: 12,
    paint: {
      'circle-radius': [
        'interpolate', ['linear'], ['zoom'],
        12, ['*', 8, sizeExpr],
        16, ['*', 18, sizeExpr]
      ],
      'circle-color': colorExpr,
      'circle-opacity': 0.1,
      'circle-blur': 0.5
    }
  });

  // Inner ring
  map.addLayer({
    id: 'emergency-ring',
    type: 'circle',
    source: 'emergency',
    paint: {
      'circle-radius': [
        'interpolate', ['linear'], ['zoom'],
        10, ['*', 4, sizeExpr],
        16, ['*', 8, sizeExpr]
      ],
      'circle-color': 'transparent',
      'circle-stroke-color': colorExpr,
      'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 10, 0.8, 16, 1.5],
      'circle-stroke-opacity': 0.5
    }
  });

  // Center dot
  map.addLayer({
    id: 'emergency-dot',
    type: 'circle',
    source: 'emergency',
    paint: {
      'circle-radius': [
        'interpolate', ['linear'], ['zoom'],
        10, ['*', 2.5, sizeExpr],
        16, ['*', 5, sizeExpr]
      ],
      'circle-color': colorExpr,
      'circle-stroke-color': '#fff',
      'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 10, 0.3, 16, 1],
      'circle-stroke-opacity': 0.3,
      'circle-opacity': 0.9
    }
  });

  // Name labels
  map.addLayer({
    id: 'emergency-labels',
    type: 'symbol',
    source: 'emergency',
    minzoom: 13,
    layout: {
      'text-field': ['get', 'name'],
      'text-font': ['Noto Sans Regular'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 13, 8, 16, 10],
      'text-offset': [0, 1.6],
      'text-anchor': 'top',
      'text-allow-overlap': false,
      'text-max-width': 12
    },
    paint: {
      'text-color': [
        'match', ['get', 'serviceType'],
        'fire', 'rgba(255, 68, 34, 0.45)',
        'police', 'rgba(68, 136, 255, 0.45)',
        'hospital', 'rgba(68, 221, 136, 0.45)',
        'ambulance', 'rgba(255, 170, 34, 0.45)',
        'rgba(136, 136, 136, 0.45)'
      ],
      'text-halo-color': 'rgba(0, 0, 0, 0.8)',
      'text-halo-width': 1
    }
  });
}

// --- Interaction ---

function setupInteraction() {
  map.on('mouseenter', 'emergency-dot', () => {
    map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', 'emergency-dot', () => {
    map.getCanvas().style.cursor = '';
  });

  map.on('click', 'emergency-dot', (e) => {
    if (!e.features || !e.features[0]) return;
    const f = e.features[0];
    const coords = f.geometry.coordinates.slice();
    const p = f.properties;

    const serviceType = p.serviceType || 'other';
    const config = SERVICE_CONFIG[serviceType] || SERVICE_CONFIG.other;
    const name = p.name || config.label;
    const address = p.address || '—';
    const phone = p.phone || '—';
    const website = p.website || '';
    const hours = p.openingHours || '';
    const operator = p.operator || '';

    const websiteHtml = website
      ? `<a href="${website}" target="_blank" style="color:${config.color};text-decoration:none;font-size:10px;">${website.replace(/^https?:\/\/(www\.)?/, '').split('/')[0]}</a>`
      : '—';

    // Phone formatting — may have semicolons for multiple numbers
    const phoneHtml = phone !== '—'
      ? phone.split(';').map(p => p.trim()).filter(Boolean).map(p =>
        `<span style="color:#fff;font-family:var(--font-mono);font-size:10px">${p}</span>`
      ).join('<br>')
      : '<span style="color:rgba(255,255,255,0.3)">—</span>';

    const html = `
      <div class="emg-popup">
        <div class="emgp-header" style="border-bottom-color:${config.color}22">
          <div class="emgp-icon">${config.icon}</div>
          <div class="emgp-header-info">
            <div class="emgp-type" style="color:${config.color}">${config.label}</div>
            <div class="emgp-name">${name}</div>
          </div>
        </div>
        <div class="emgp-body">
          <div class="emgp-emergency-row" style="border-color:${config.color}">
            <span class="emgp-112">${config.emergencyNum}</span>
          </div>
          <div class="emgp-stat-row">
            <span class="emgp-label">ADDRESS</span>
            <span class="emgp-value">${address}</span>
          </div>
          <div class="emgp-stat-row">
            <span class="emgp-label">PHONE</span>
            <span class="emgp-value">${phoneHtml}</span>
          </div>
          ${operator ? `<div class="emgp-stat-row">
            <span class="emgp-label">OPERATOR</span>
            <span class="emgp-value emgp-dim">${operator}</span>
          </div>` : ''}
          ${hours ? `<div class="emgp-stat-row">
            <span class="emgp-label">HOURS</span>
            <span class="emgp-value emgp-dim">${hours}</span>
          </div>` : ''}
          <div class="emgp-stat-row">
            <span class="emgp-label">WEBSITE</span>
            <span class="emgp-value">${websiteHtml}</span>
          </div>
          <div class="emgp-stat-row">
            <span class="emgp-label">COORDS</span>
            <span class="emgp-value emgp-dim">${coords[1].toFixed(5)}, ${coords[0].toFixed(5)}</span>
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
  if (!emergencyGeoJSON || !query) return [];
  const q = query.toLowerCase();
  const out = [];
  for (const f of emergencyGeoJSON.features) {
    const p = f.properties;
    const hay = [p.name, p.address, p.operator, p.serviceType].filter(Boolean).join(' ').toLowerCase();
    if (!hay.includes(q)) continue;
    const cfg = SERVICE_CONFIG[p.serviceType] || SERVICE_CONFIG.other;
    out.push({
      label: p.name || cfg.label,
      sublabel: `${cfg.label}${p.address ? ' · ' + p.address : ''}`,
      coords: f.geometry.coordinates,
      color: cfg.color,
      layerName: 'Emergency'
    });
    if (out.length >= 5) break;
  }
  return out;
}

// --- Teardown ---

export function destroyEmergency() {
  if (activePopup) { activePopup.remove(); activePopup = null; }
  ['emergency-glow', 'emergency-ring', 'emergency-dot', 'emergency-labels'].forEach(id => map?.getLayer(id) && map.removeLayer(id));
  if (map?.getSource('emergency')) map.removeSource('emergency');
  emergencyGeoJSON = null;
  visible = true;
  map = null;
}

// --- Visibility ---

export function toggleEmergency() {
  visible = !visible;
  const vis = visible ? 'visible' : 'none';
  ['emergency-glow', 'emergency-ring', 'emergency-dot', 'emergency-labels'].forEach(id => {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis);
  });
  return visible;
}
