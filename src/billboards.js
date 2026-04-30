/* ============================================
   CivicPulse — Advertising Billboards Layer
   DIGITAL outdoor advertising only — LED screens
   and animated surfaces sourced from OSM
   (advertising=screen, animated=yes, or
   advertising:type=digital). Static billboards,
   posters, columns, etc. are excluded by design.
   ============================================ */

import maplibregl from 'maplibre-gl';
import { fetchGeoJSON } from './cityConfig.js';
import { showNetworkLinks } from './network.js';

// Magenta-pink — distinct from EMF pink (#ff3366), Tor purple (#b44dff),
// parcel orange (#ff8c1a), and emergency red (#ff0044).
const COLOR_CORE   = '#ff44dd';
const COLOR_DIGITAL = '#ff66ff';
const COLOR_LABEL  = 'rgba(255, 68, 221, 0.55)';

// Symbols by kind — shown in the popup header.
const KIND_ICON = {
  billboard:     '▣',
  board:         '▢',
  column:        '◍',
  poster_box:    '▭',
  screen:        '▦',
  sign:          '◈',
  totem:         '⌗',
  wall_painting: '◐',
  flag:          '⚑',
  tarp:          '▤'
};

let map = null;
let bbGeoJSON = null;
let visible = true;
let activePopup = null;

// --- Initialization ---

export async function initBillboards(mapInstance) {
  map = mapInstance;

  try {
    await fetchBillboards();
    addBillboardLayers();
    setupInteraction();

    const counts = {};
    bbGeoJSON.features.forEach(f => {
      const k = f.properties.kind;
      counts[k] = (counts[k] || 0) + 1;
    });
    const breakdown = Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ');
    console.log(
      `%c[CivicPulse Billboards] ${bbGeoJSON.features.length} digital structures (${breakdown || 'none'})`,
      `color: ${COLOR_CORE};`
    );
  } catch (err) {
    console.error('[CivicPulse Billboards] Init failed:', err);
  }
}

// --- Data ---

async function fetchBillboards() {
  bbGeoJSON = await fetchGeoJSON('billboards');
}

// --- Map Layers ---

function addBillboardLayers() {
  map.addSource('billboards', {
    type: 'geojson',
    data: bbGeoJSON
  });

  // Outer pulse — slightly larger for digital screens (more prominent IRL too).
  // minzoom 13 — see the matching note in electricity.js: blurred halos
  // are imperceptible at city-overview zooms and very expensive in dense
  // cities. Core dot still renders below this.
  map.addLayer({
    id: 'bb-pulse',
    type: 'circle',
    source: 'billboards',
    minzoom: 13,
    paint: {
      'circle-radius': [
        'interpolate', ['linear'], ['zoom'],
        13, ['case', ['get', 'isDigital'], 8, 5],
        16, ['case', ['get', 'isDigital'], 20, 14]
      ],
      'circle-color': [
        'case',
        ['get', 'isDigital'], COLOR_DIGITAL,
        COLOR_CORE
      ],
      'circle-opacity': 0.08,
      'circle-blur': 0.7
    }
  });

  // Inner glow — gated to zoom 12+; below that the dot stands alone.
  map.addLayer({
    id: 'bb-glow',
    type: 'circle',
    source: 'billboards',
    minzoom: 12,
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 3, 16, 9],
      'circle-color': [
        'case',
        ['get', 'isDigital'], COLOR_DIGITAL,
        COLOR_CORE
      ],
      'circle-opacity': 0.22,
      'circle-blur': 0.4
    }
  });

  // Core dot — slightly bigger when illuminated to mirror real-world prominence.
  map.addLayer({
    id: 'bb-dot',
    type: 'circle',
    source: 'billboards',
    paint: {
      'circle-radius': [
        'interpolate', ['linear'], ['zoom'],
        11, ['case', ['get', 'isLit'], 2.0, 1.5],
        16, ['case', ['get', 'isLit'], 5, 4]
      ],
      'circle-color': [
        'case',
        ['get', 'isDigital'], COLOR_DIGITAL,
        COLOR_CORE
      ],
      'circle-stroke-color': '#000',
      'circle-stroke-width': 0.8,
      'circle-stroke-opacity': 0.6,
      'circle-opacity': 0.95
    }
  });

  // Optional name label at high zoom
  map.addLayer({
    id: 'bb-labels',
    type: 'symbol',
    source: 'billboards',
    minzoom: 16,
    filter: ['any', ['has', 'name'], ['has', 'operator']],
    layout: {
      'text-field': ['coalesce', ['get', 'name'], ['get', 'operator']],
      'text-font': ['Noto Sans Regular'],
      'text-size': 9,
      'text-offset': [0, 1.2],
      'text-anchor': 'top',
      'text-allow-overlap': false,
      'text-max-width': 9
    },
    paint: {
      'text-color': COLOR_LABEL,
      'text-halo-color': 'rgba(0, 0, 0, 0.85)',
      'text-halo-width': 1
    }
  });
}

// --- Interaction ---

function setupInteraction() {
  map.on('mouseenter', 'bb-dot', () => {
    map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', 'bb-dot', () => {
    map.getCanvas().style.cursor = '';
  });

  map.on('click', 'bb-dot', (e) => {
    if (!e.features || !e.features[0]) return;
    const f = e.features[0];
    const coords = f.geometry.coordinates.slice();
    const p = f.properties;

    const kind = p.kind || 'billboard';
    const kindLabel = (p.kindLabel || kind.replace(/_/g, ' ')).toUpperCase();
    const icon = KIND_ICON[kind] || '▣';
    const name = p.name || '';
    const operator = p.operator || '';
    const owner = p.owner || '';
    const brand = p.brand || '';
    const ref = p.ref || '';
    const address = p.address || '';
    const height = p.height || '';
    const width = p.width || '';
    const material = p.material || '';
    const structure = p.structure || '';
    const sides = p.sides;
    const isLit = p.isLit === true || p.isLit === 'true';
    const isDigital = p.isDigital === true || p.isDigital === 'true';
    const litMode = p.litMode || '';
    const message = p.message || '';
    const startDate = p.startDate || '';
    const osmId = p.osmId || '';

    const accentColor = isDigital ? COLOR_DIGITAL : COLOR_CORE;
    const title = name || operator || brand || kindLabel;

    let osmHref = '';
    if (osmId) {
      const t = osmId[0] === 'n' ? 'node' : osmId[0] === 'w' ? 'way' : osmId[0] === 'r' ? 'relation' : null;
      if (t) osmHref = `https://www.openstreetmap.org/${t}/${osmId.slice(1)}`;
    }

    // Status badges (digital / illuminated)
    const badges = [];
    if (isDigital) badges.push(`<span class="bb-badge" style="border-color:${COLOR_DIGITAL};color:${COLOR_DIGITAL}">DIGITAL</span>`);
    if (isLit) badges.push(`<span class="bb-badge" style="border-color:${accentColor};color:${accentColor}">LIT</span>`);
    const badgesHtml = badges.length ? `<div class="bb-badges">${badges.join('')}</div>` : '';

    // Combine height x width into a single dimensions row when both are present
    let dimensions = '';
    if (height && width) {
      const h = /\d$/.test(height) ? `${height} m` : height;
      const w = /\d$/.test(width) ? `${width} m` : width;
      dimensions = `${w} × ${h}`;
    } else if (height) {
      dimensions = /\d$/.test(height) ? `${height} m` : height;
    } else if (width) {
      dimensions = /\d$/.test(width) ? `${width} m` : width;
    }

    const rows = [];
    if (operator) rows.push(['OPERATOR', operator]);
    if (owner && owner !== operator) rows.push(['OWNER', owner]);
    if (brand && brand !== operator) rows.push(['BRAND', brand]);
    if (dimensions) rows.push([height && width ? 'SIZE' : (height ? 'HEIGHT' : 'WIDTH'), dimensions]);
    if (sides && sides > 0) rows.push(['SIDES', String(sides)]);
    if (material) rows.push(['MATERIAL', material.replace(/_/g, ' ')]);
    if (structure) rows.push(['SUPPORT', structure.replace(/_/g, ' ')]);
    if (litMode && litMode !== 'no' && litMode !== 'yes') rows.push(['LIGHTING', litMode.toUpperCase()]);
    if (message) rows.push(['MESSAGE', message]);
    if (ref) rows.push(['REF', ref]);
    if (address) rows.push(['ADDRESS', address]);
    if (startDate) rows.push(['INSTALLED', startDate]);
    rows.push([
      'OSM',
      osmHref
        ? `<a href="${osmHref}" target="_blank" rel="noopener" class="bb-link">${osmId}</a>`
        : (osmId || '—')
    ]);

    const rowsHtml = rows.map(([k, v]) => `
      <div class="bb-stat-row">
        <span class="bb-label">${k}</span>
        <span class="bb-value">${v}</span>
      </div>
    `).join('');

    const html = `
      <div class="bb-popup">
        <div class="bb-header" style="border-color:${accentColor}33">
          <div class="bb-icon" style="color:${accentColor}">${icon}</div>
          <div class="bb-header-info">
            <div class="bb-title">${title}</div>
            <div class="bb-type" style="color:${accentColor}">${kindLabel}</div>
          </div>
        </div>
        ${badgesHtml}
        <div class="bb-body">
          ${rowsHtml}
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

    // Same-operator network animation — only fires when the clicked feature
    // has a real operator and at least one peer shares it.
    showNetworkLinks(map, f, bbGeoJSON.features, 'operatorKey', { color: accentColor });
  });
}

// --- Search ---

export function searchFeatures(query) {
  if (!bbGeoJSON || !query) return [];
  const q = query.toLowerCase();
  const out = [];
  for (const f of bbGeoJSON.features) {
    const p = f.properties;
    const hay = [p.name, p.operator, p.owner, p.brand, p.kindLabel, p.address, p.ref, p.message]
      .filter(Boolean).join(' ').toLowerCase();
    if (!hay.includes(q)) continue;
    out.push({
      label: p.name || p.operator || p.brand || p.kindLabel || 'Billboard',
      sublabel: `${p.kindLabel || 'Billboard'}${p.isDigital ? ' · digital' : ''}${p.operator && !p.name ? ' · ' + p.operator : ''}`,
      coords: f.geometry.coordinates,
      color: p.isDigital ? COLOR_DIGITAL : COLOR_CORE,
      layerName: 'Billboard'
    });
    if (out.length >= 5) break;
  }
  return out;
}

// --- Teardown ---

export function destroyBillboards() {
  if (activePopup) { activePopup.remove(); activePopup = null; }
  ['bb-pulse', 'bb-glow', 'bb-dot', 'bb-labels'].forEach(id => map?.getLayer(id) && map.removeLayer(id));
  if (map?.getSource('billboards')) map.removeSource('billboards');
  bbGeoJSON = null;
  visible = true;
  map = null;
}

// --- Visibility ---

export function toggleBillboards() {
  visible = !visible;
  const vis = visible ? 'visible' : 'none';
  ['bb-pulse', 'bb-glow', 'bb-dot', 'bb-labels'].forEach(id => {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis);
  });
  return visible;
}
