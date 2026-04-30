/* ============================================
   CivicPulse Poznań — ATM Layer
   ATM locations from OpenStreetMap
   ============================================ */

import maplibregl from 'maplibre-gl';
import { showNetworkLinks } from './network.js';
import { fetchGeoJSON } from './cityConfig.js';

let map = null;
let atmGeoJSON = null;
let visible = true;
let activePopup = null;

// Single layer color — every ATM dot renders in this so the layer reads
// as "ATMs" at a glance. Brand identity is preserved in the popup accent
// and the network-link animation, which still use OP_DOT_COLORS below.
const ATM_COLOR = '#33ff99';

// Operator brand-mark colors (used for the popup-header brand swatch).
const OP_COLORS = {
  'Euronet': '#003399',
  'PKO BP': '#003366',
  'Santander': '#cc0000',
  'Planet Cash': '#33cc66',
  'Bank Pekao': '#cc3300',
  'ITCARD S.A.': '#6633cc',
  'Bank Millennium': '#990066',
  'BNP Paribas Bank Polska': '#009933',
  'ING Bank Śląski': '#ff6600',
  'mBank': '#009944',
  'Shitcoins.club': '#ff9900'
};

// Map-friendly variants (lighter, readable on dark bg) for popup accent
// and the same-operator network animation. NOT applied to the dot itself.
const OP_DOT_COLORS = {
  'Euronet': '#4488ff',
  'PKO BP': '#4477cc',
  'Santander': '#ff4444',
  'Planet Cash': '#44cc77',
  'Bank Pekao': '#ff5533',
  'ITCARD S.A.': '#8855ee',
  'Bank Millennium': '#cc44aa',
  'BNP Paribas Bank Polska': '#44bb66',
  'ING Bank Śląski': '#ff8833',
  'mBank': '#44bb77',
  'Shitcoins.club': '#ffaa33'
};

// --- Initialization ---

export async function initATMs(mapInstance) {
  map = mapInstance;

  try {
    await fetchATMs();
    addATMLayers();
    setupInteraction();

    const ops = {};
    atmGeoJSON.features.forEach(f => {
      const o = f.properties.operator || '?';
      ops[o] = (ops[o] || 0) + 1;
    });
    const top = Object.entries(ops).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k}:${v}`).join(' ');
    console.log(
      `%c[CivicPulse ATMs] ${atmGeoJSON.features.length} machines (${top})`,
      'color: #33ff99;'
    );
  } catch (err) {
    console.error('[CivicPulse ATMs] Init failed:', err);
  }
}

// --- Data ---

async function fetchATMs() {
  atmGeoJSON = await fetchGeoJSON('atms');
}

// --- Map Layers ---

function addATMLayers() {
  map.addSource('atms', {
    type: 'geojson',
    data: atmGeoJSON
  });

  // Glow
  map.addLayer({
    id: 'atm-glow',
    type: 'circle',
    source: 'atms',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 3, 16, 8],
      'circle-color': ATM_COLOR,
      'circle-opacity': 0.07,
      'circle-blur': 0.5
    }
  });

  // Diamond-like dot
  map.addLayer({
    id: 'atm-dot',
    type: 'circle',
    source: 'atms',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 1.5, 14, 2.5, 16, 4],
      'circle-color': ATM_COLOR,
      'circle-stroke-color': '#000',
      'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 11, 0, 14, 0.3],
      'circle-stroke-opacity': 0.3,
      'circle-opacity': 0.8
    }
  });

  // Name labels at high zoom
  map.addLayer({
    id: 'atm-labels',
    type: 'symbol',
    source: 'atms',
    minzoom: 15,
    layout: {
      'text-field': ['get', 'operator'],
      'text-font': ['Noto Sans Regular'],
      'text-size': 8,
      'text-offset': [0, 1.2],
      'text-anchor': 'top',
      'text-allow-overlap': false
    },
    paint: {
      'text-color': 'rgba(51, 255, 153, 0.35)',
      'text-halo-color': 'rgba(0, 0, 0, 0.8)',
      'text-halo-width': 1
    }
  });
}

// --- Interaction ---

function setupInteraction() {
  map.on('mouseenter', 'atm-dot', () => {
    map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', 'atm-dot', () => {
    map.getCanvas().style.cursor = '';
  });

  map.on('click', 'atm-dot', (e) => {
    if (!e.features || !e.features[0]) return;
    const f = e.features[0];
    const coords = f.geometry.coordinates.slice();
    const p = f.properties;

    const operator = p.operator || 'Unknown';
    const name = p.name || operator;
    const address = p.address || '—';
    const hours = p.openingHours || '24/7';
    const cashIn = p.cashIn;
    const currency = p.currency || 'PLN';
    const fee = p.fee || '';
    const indoor = p.indoor || '';
    const network = p.network || '';

    const accentColor = OP_DOT_COLORS[operator] || ATM_COLOR;

    // Build feature tags
    const tags = [];
    if (cashIn === 'yes') tags.push('CASH IN');
    if (fee === 'yes') tags.push('FEE');
    else if (fee === 'no') tags.push('FREE');
    if (indoor === 'yes') tags.push('INDOOR');

    const tagsHtml = tags.length
      ? tags.map(t => {
        const c = t === 'FEE' ? '#ff4444' : t === 'CASH IN' ? '#44cc77' : accentColor;
        return `<span class="atmp-tag" style="border-color:${c}40;color:${c}">${t}</span>`;
      }).join('')
      : '';

    const html = `
      <div class="atm-popup">
        <div class="atmp-header">
          <div class="atmp-icon" style="color:${accentColor}">◆</div>
          <div class="atmp-header-info">
            <div class="atmp-operator" style="color:${accentColor}">${operator}</div>
            <div class="atmp-name">${name !== operator ? name : 'ATM'}</div>
          </div>
        </div>
        <div class="atmp-body">
          ${tagsHtml ? `<div class="atmp-tags">${tagsHtml}</div>` : ''}
          <div class="atmp-stat-row">
            <span class="atmp-label">ADDRESS</span>
            <span class="atmp-value">${address}</span>
          </div>
          <div class="atmp-stat-row">
            <span class="atmp-label">HOURS</span>
            <span class="atmp-value atmp-dim">${hours}</span>
          </div>
          <div class="atmp-stat-row">
            <span class="atmp-label">CURRENCY</span>
            <span class="atmp-value">${currency}</span>
          </div>
          ${network ? `<div class="atmp-stat-row">
            <span class="atmp-label">NETWORK</span>
            <span class="atmp-value atmp-dim">${network}</span>
          </div>` : ''}
          <div class="atmp-stat-row">
            <span class="atmp-label">COORDS</span>
            <span class="atmp-value atmp-dim">${coords[1].toFixed(5)}, ${coords[0].toFixed(5)}</span>
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

    // Network animation uses the generic layer color, not the brand accent —
    // the chains read as "ATM network" rather than "this specific bank".
    showNetworkLinks(map, f, atmGeoJSON.features, 'operator', { color: ATM_COLOR });
  });
}

// --- Search ---

export function searchFeatures(query) {
  if (!atmGeoJSON || !query) return [];
  const q = query.toLowerCase();
  const out = [];
  for (const f of atmGeoJSON.features) {
    const p = f.properties;
    const hay = [p.operator, p.name, p.address, p.network].filter(Boolean).join(' ').toLowerCase();
    if (!hay.includes(q)) continue;
    out.push({
      label: p.operator || p.name || 'ATM',
      sublabel: `ATM${p.address ? ' · ' + p.address : ''}`,
      coords: f.geometry.coordinates,
      color: ATM_COLOR,
      layerName: 'ATM'
    });
    if (out.length >= 5) break;
  }
  return out;
}

// --- Teardown ---

export function destroyATMs() {
  if (activePopup) { activePopup.remove(); activePopup = null; }
  ['atm-glow', 'atm-dot', 'atm-labels'].forEach(id => map?.getLayer(id) && map.removeLayer(id));
  if (map?.getSource('atms')) map.removeSource('atms');
  atmGeoJSON = null;
  visible = true;
  map = null;
}

// --- Visibility ---

export function toggleATMs() {
  visible = !visible;
  const vis = visible ? 'visible' : 'none';
  ['atm-glow', 'atm-dot', 'atm-labels'].forEach(id => {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis);
  });
  return visible;
}
