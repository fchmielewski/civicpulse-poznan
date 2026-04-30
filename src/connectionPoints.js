/* ============================================
   CivicPulse — Connection Points Layer
   Physical telecom street infrastructure from
   OpenStreetMap: connection points, exchanges,
   street cabinets, distribution points,
   data centers, and communication towers.
   ============================================ */

import maplibregl from 'maplibre-gl';
import { fetchGeoJSON } from './cityConfig.js';
import { showNetworkLinks } from './network.js';

// Aqua-teal palette — distinct from Tor purple, mobile orange,
// road-glow sky-blue, and WiFi green.
const COLOR_CORE   = '#00e5d0';
const COLOR_GLOW   = 'rgba(0, 229, 208, 0.18)';
const COLOR_LABEL  = 'rgba(0, 229, 208, 0.55)';

// Symbols by kind — keeps the dot, distinguishes via popup icon.
const KIND_ICON = {
  connection_point:    '◈',
  exchange:            '⬢',
  data_center:         '▢',
  service_device:      '◆',
  distribution_point:  '◇',
  street_cabinet:      '▭',
  communication_tower: '⌬'
};

let map = null;
let cpGeoJSON = null;
let visible = true;
let activePopup = null;

// --- Initialization ---

export async function initConnectionPoints(mapInstance) {
  map = mapInstance;

  try {
    await fetchConnectionPoints();
    addConnectionPointLayers();
    setupInteraction();

    // Tally by kind for the boot log
    const counts = {};
    cpGeoJSON.features.forEach(f => {
      const k = f.properties.kind;
      counts[k] = (counts[k] || 0) + 1;
    });
    const breakdown = Object.entries(counts)
      .map(([k, n]) => `${n} ${k.replace(/_/g, '-')}`)
      .join(', ');
    console.log(
      `%c[CivicPulse Connection] ${cpGeoJSON.features.length} nodes (${breakdown || 'none'})`,
      `color: ${COLOR_CORE};`
    );
  } catch (err) {
    console.error('[CivicPulse Connection] Init failed:', err);
  }
}

// --- Data ---

async function fetchConnectionPoints() {
  cpGeoJSON = await fetchGeoJSON('connection-points');
}

// --- Map Layers ---

function addConnectionPointLayers() {
  map.addSource('connection-points', {
    type: 'geojson',
    data: cpGeoJSON
  });

  // Outer pulse — minzoom 13 to cull blurred halos at city-overview zoom
  // (see electricity.js for the rationale).
  map.addLayer({
    id: 'cp-pulse',
    type: 'circle',
    source: 'connection-points',
    minzoom: 13,
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 13, 6, 16, 18],
      'circle-color': COLOR_CORE,
      'circle-opacity': 0.08,
      'circle-blur': 0.7
    }
  });

  // Inner glow — gated to zoom 12+.
  map.addLayer({
    id: 'cp-glow',
    type: 'circle',
    source: 'connection-points',
    minzoom: 12,
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 3, 16, 9],
      'circle-color': COLOR_CORE,
      'circle-opacity': 0.22,
      'circle-blur': 0.4
    }
  });

  // Core dot
  map.addLayer({
    id: 'cp-dot',
    type: 'circle',
    source: 'connection-points',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 1.6, 16, 4],
      'circle-color': COLOR_CORE,
      'circle-stroke-color': '#000',
      'circle-stroke-width': 0.8,
      'circle-stroke-opacity': 0.6,
      'circle-opacity': 0.95
    }
  });

  // Optional name label at high zoom
  map.addLayer({
    id: 'cp-labels',
    type: 'symbol',
    source: 'connection-points',
    minzoom: 16,
    filter: ['any', ['has', 'name'], ['has', 'ref']],
    layout: {
      'text-field': ['coalesce', ['get', 'name'], ['get', 'ref']],
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
  map.on('mouseenter', 'cp-dot', () => {
    map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', 'cp-dot', () => {
    map.getCanvas().style.cursor = '';
  });

  map.on('click', 'cp-dot', (e) => {
    if (!e.features || !e.features[0]) return;
    const f = e.features[0];
    const coords = f.geometry.coordinates.slice();
    const p = f.properties;

    const kind = p.kind || 'connection_point';
    const kindLabel = (p.kindLabel || kind.replace(/_/g, ' ')).toUpperCase();
    const icon = KIND_ICON[kind] || '◈';
    const name = p.name || '—';
    const operator = p.operator || '';
    const owner = p.owner || '';
    const address = p.address || '';
    const ref = p.ref || '';
    const note = p.note || '';
    const height = p.height || '';
    const medium = p.medium || '';
    const osmId = p.osmId || '';

    // Title: name if present, else operator, else friendly kind label
    const title = name && name !== '—' ? name : (operator || kindLabel);

    // OSM permalink (n/w/r prefix → node/way/relation)
    let osmHref = '';
    if (osmId) {
      const t = osmId[0] === 'n' ? 'node' : osmId[0] === 'w' ? 'way' : osmId[0] === 'r' ? 'relation' : null;
      if (t) osmHref = `https://www.openstreetmap.org/${t}/${osmId.slice(1)}`;
    }

    // Optional rows — only render if data is present
    const rows = [];
    if (operator) rows.push(['OPERATOR', operator]);
    if (owner && owner !== operator) rows.push(['OWNER', owner]);
    if (medium) rows.push(['MEDIUM', medium.toUpperCase()]);
    if (height) rows.push(['HEIGHT', `${height}${/\d$/.test(height) ? ' m' : ''}`]);
    if (ref) rows.push(['REF', ref]);
    if (address) rows.push(['ADDRESS', address]);
    if (note) rows.push(['NOTE', note]);
    rows.push([
      'OSM',
      osmHref
        ? `<a href="${osmHref}" target="_blank" rel="noopener" class="cp-link">${osmId}</a>`
        : (osmId || '—')
    ]);

    const rowsHtml = rows.map(([k, v]) => `
      <div class="cp-stat-row">
        <span class="cp-label">${k}</span>
        <span class="cp-value">${v}</span>
      </div>
    `).join('');

    const html = `
      <div class="cp-popup">
        <div class="cp-header">
          <div class="cp-icon" style="color:${COLOR_CORE}">${icon}</div>
          <div class="cp-header-info">
            <div class="cp-title">${title}</div>
            <div class="cp-type" style="color:${COLOR_CORE}">${kindLabel}</div>
          </div>
        </div>
        <div class="cp-body">
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

    // Same-operator network animation. `operatorKey` is the server-side
    // normalized (lowercase + trimmed) form so e.g. "Netia"/"netia" match.
    // The helper bails out silently if the clicked feature has no operator
    // or no peer shares it — no fake links get drawn.
    showNetworkLinks(map, f, cpGeoJSON.features, 'operatorKey', { color: COLOR_CORE });
  });
}

// --- Search ---

export function searchFeatures(query) {
  if (!cpGeoJSON || !query) return [];
  const q = query.toLowerCase();
  const out = [];
  for (const f of cpGeoJSON.features) {
    const p = f.properties;
    const hay = [p.name, p.operator, p.owner, p.kindLabel, p.address, p.ref].filter(Boolean).join(' ').toLowerCase();
    if (!hay.includes(q)) continue;
    out.push({
      label: p.name || p.operator || p.kindLabel || 'Connection point',
      sublabel: `${p.kindLabel || 'Connection point'}${p.operator ? ' · ' + p.operator : ''}`,
      coords: f.geometry.coordinates,
      color: COLOR_CORE,
      layerName: 'Connection'
    });
    if (out.length >= 5) break;
  }
  return out;
}

// --- Teardown ---

export function destroyConnectionPoints() {
  if (activePopup) { activePopup.remove(); activePopup = null; }
  ['cp-pulse', 'cp-glow', 'cp-dot', 'cp-labels'].forEach(id => map?.getLayer(id) && map.removeLayer(id));
  if (map?.getSource('connection-points')) map.removeSource('connection-points');
  cpGeoJSON = null;
  visible = true;
  map = null;
}

// --- Visibility ---

export function toggleConnectionPoints() {
  visible = !visible;
  const vis = visible ? 'visible' : 'none';
  ['cp-pulse', 'cp-glow', 'cp-dot', 'cp-labels'].forEach(id => {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis);
  });
  return visible;
}
