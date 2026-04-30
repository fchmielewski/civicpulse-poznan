/* ============================================
   CivicPulse — Electricity Layer
   Power infrastructure from OpenStreetMap:
   substations, transformers, generators,
   power plants, transmission towers,
   switchgear, and overhead-line portals.
   ============================================ */

import maplibregl from 'maplibre-gl';
import { fetchGeoJSON } from './cityConfig.js';
import { showNetworkLinks } from './network.js';

// Electric-yellow palette — distinct from traffic-lights amber (#ffcc00),
// metro orange (#ffaa00), and bicycle-counter green (#4dff4d).
const COLOR_CORE  = '#ffe935';
const COLOR_LABEL = 'rgba(255, 233, 53, 0.55)';

// Symbols by kind — shown in the popup header.
const KIND_ICON = {
  substation:  '⚡',
  transformer: '◉',
  generator:   '⌬',
  plant:       '⬢',
  tower:       '⌇',
  switch:      '◇',
  portal:      '⌶'
};

// Friendly source labels for generators (raw OSM values are snake_case).
const SOURCE_LABELS = {
  solar:    'Solar',
  wind:     'Wind',
  hydro:    'Hydro',
  gas:      'Natural Gas',
  coal:     'Coal',
  diesel:   'Diesel',
  biomass:  'Biomass',
  biogas:   'Biogas',
  nuclear:  'Nuclear',
  oil:      'Oil',
  geothermal: 'Geothermal',
  battery:  'Battery'
};

let map = null;
let elGeoJSON = null;
let visible = true;
let activePopup = null;

// --- Initialization ---

export async function initElectricity(mapInstance) {
  map = mapInstance;

  try {
    await fetchElectricity();
    addElectricityLayers();
    setupInteraction();

    const counts = {};
    elGeoJSON.features.forEach(f => {
      const k = f.properties.kind;
      counts[k] = (counts[k] || 0) + 1;
    });
    const breakdown = Object.entries(counts)
      .map(([k, n]) => `${n} ${k}`)
      .join(', ');
    console.log(
      `%c[CivicPulse Electricity] ${elGeoJSON.features.length} nodes (${breakdown || 'none'})`,
      `color: ${COLOR_CORE};`
    );
  } catch (err) {
    console.error('[CivicPulse Electricity] Init failed:', err);
  }
}

// --- Data ---

async function fetchElectricity() {
  elGeoJSON = await fetchGeoJSON('electricity');
}

// --- Map Layers ---

function addElectricityLayers() {
  map.addSource('electricity', {
    type: 'geojson',
    data: elGeoJSON
  });

  // Outer pulse — bigger for higher-voltage assets so transmission-grade
  // substations visually pop against pole-mounted distribution gear.
  // minzoom: 13 — at lower zoom the pulse haloes overlap into illegible
  // smudges across thousands of nodes (Warsaw bbox returns 3000+); the
  // bare core dot renders fine at city-overview zoom and the GPU saves
  // several thousand blurred fragments per frame.
  map.addLayer({
    id: 'el-pulse',
    type: 'circle',
    source: 'electricity',
    minzoom: 13,
    paint: {
      'circle-radius': [
        'interpolate', ['linear'], ['zoom'],
        13, ['case', ['>=', ['coalesce', ['get', 'voltageKv'], 0], 110], 9, 5],
        16, ['case', ['>=', ['coalesce', ['get', 'voltageKv'], 0], 110], 22, 14]
      ],
      'circle-color': COLOR_CORE,
      'circle-opacity': 0.08,
      'circle-blur': 0.7
    }
  });

  // Inner glow — also gated to zoom 12+ for the same reason.
  map.addLayer({
    id: 'el-glow',
    type: 'circle',
    source: 'electricity',
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
    id: 'el-dot',
    type: 'circle',
    source: 'electricity',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 1.6, 16, 4],
      'circle-color': COLOR_CORE,
      'circle-stroke-color': '#000',
      'circle-stroke-width': 0.8,
      'circle-stroke-opacity': 0.6,
      'circle-opacity': 0.95
    }
  });

  // Optional label at high zoom — name or voltage
  map.addLayer({
    id: 'el-labels',
    type: 'symbol',
    source: 'electricity',
    minzoom: 16,
    filter: ['any', ['has', 'name'], ['has', 'voltageKv']],
    layout: {
      'text-field': [
        'case',
        ['has', 'name'], ['get', 'name'],
        ['has', 'voltageKv'], ['concat', ['to-string', ['get', 'voltageKv']], ' kV'],
        ''
      ],
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
  map.on('mouseenter', 'el-dot', () => {
    map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', 'el-dot', () => {
    map.getCanvas().style.cursor = '';
  });

  map.on('click', 'el-dot', (e) => {
    if (!e.features || !e.features[0]) return;
    const f = e.features[0];
    const coords = f.geometry.coordinates.slice();
    const p = f.properties;

    const kind = p.kind || 'substation';
    const kindLabel = (p.kindLabel || kind.replace(/_/g, ' ')).toUpperCase();
    const icon = KIND_ICON[kind] || '⚡';
    const name = p.name || '';
    const operator = p.operator || '';
    const owner = p.owner || '';
    const ref = p.ref || '';
    const address = p.address || '';
    const voltage = p.voltage || '';
    const voltageKv = p.voltageKv;
    const source = p.source || '';
    const method = p.method || '';
    const output = p.output || '';
    const substation = p.substation || '';
    const frequency = p.frequency || '';
    const height = p.height || '';
    const structure = p.structure || '';
    const osmId = p.osmId || '';

    const title = name || operator || kindLabel;

    let osmHref = '';
    if (osmId) {
      const t = osmId[0] === 'n' ? 'node' : osmId[0] === 'w' ? 'way' : osmId[0] === 'r' ? 'relation' : null;
      if (t) osmHref = `https://www.openstreetmap.org/${t}/${osmId.slice(1)}`;
    }

    // Format voltage nicely — show raw "110000/15000 V" as "110/15 kV"
    let voltageDisplay = '';
    if (voltage) {
      const parts = voltage.split(/[\/;,]/).map(s => parseInt(s, 10)).filter(Number.isFinite);
      if (parts.length) {
        voltageDisplay = parts.map(v => Math.round(v / 1000)).join(' / ') + ' kV';
      } else {
        voltageDisplay = voltage;
      }
    } else if (Number.isFinite(voltageKv)) {
      voltageDisplay = `${voltageKv} kV`;
    }

    const sourceLabel = source ? (SOURCE_LABELS[source] || source.replace(/_/g, ' ')) : '';

    // Optional rows — only render if data is present
    const rows = [];
    if (voltageDisplay) rows.push(['VOLTAGE', voltageDisplay]);
    if (substation) rows.push(['SUBSTATION', substation.toUpperCase()]);
    if (frequency) rows.push(['FREQUENCY', `${frequency} Hz`]);
    if (sourceLabel) rows.push(['SOURCE', sourceLabel]);
    if (method) rows.push(['METHOD', method.replace(/_/g, ' ')]);
    if (output) rows.push(['OUTPUT', output]);
    if (operator) rows.push(['OPERATOR', operator]);
    if (owner && owner !== operator) rows.push(['OWNER', owner]);
    if (height) rows.push(['HEIGHT', `${height}${/\d$/.test(height) ? ' m' : ''}`]);
    if (structure) rows.push(['STRUCTURE', structure.replace(/_/g, ' ')]);
    if (ref) rows.push(['REF', ref]);
    if (address) rows.push(['ADDRESS', address]);
    rows.push([
      'OSM',
      osmHref
        ? `<a href="${osmHref}" target="_blank" rel="noopener" class="el-link">${osmId}</a>`
        : (osmId || '—')
    ]);

    const rowsHtml = rows.map(([k, v]) => `
      <div class="el-stat-row">
        <span class="el-label">${k}</span>
        <span class="el-value">${v}</span>
      </div>
    `).join('');

    const html = `
      <div class="el-popup">
        <div class="el-header">
          <div class="el-icon" style="color:${COLOR_CORE}">${icon}</div>
          <div class="el-header-info">
            <div class="el-title">${title}</div>
            <div class="el-type" style="color:${COLOR_CORE}">${kindLabel}</div>
          </div>
        </div>
        <div class="el-body">
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

    // Same-operator network animation — server-side normalized key.
    showNetworkLinks(map, f, elGeoJSON.features, 'operatorKey', { color: COLOR_CORE });
  });
}

// --- Search ---

export function searchFeatures(query) {
  if (!elGeoJSON || !query) return [];
  const q = query.toLowerCase();
  const out = [];
  for (const f of elGeoJSON.features) {
    const p = f.properties;
    const hay = [p.name, p.operator, p.owner, p.kindLabel, p.address, p.ref, p.source]
      .filter(Boolean).join(' ').toLowerCase();
    if (!hay.includes(q)) continue;
    out.push({
      label: p.name || p.operator || p.kindLabel || 'Power node',
      sublabel: `${p.kindLabel || 'Power node'}${p.voltageKv ? ' · ' + p.voltageKv + ' kV' : ''}`,
      coords: f.geometry.coordinates,
      color: COLOR_CORE,
      layerName: 'Electricity'
    });
    if (out.length >= 5) break;
  }
  return out;
}

// --- Teardown ---

export function destroyElectricity() {
  if (activePopup) { activePopup.remove(); activePopup = null; }
  ['el-pulse', 'el-glow', 'el-dot', 'el-labels'].forEach(id => map?.getLayer(id) && map.removeLayer(id));
  if (map?.getSource('electricity')) map.removeSource('electricity');
  elGeoJSON = null;
  visible = true;
  map = null;
}

// --- Visibility ---

export function toggleElectricity() {
  visible = !visible;
  const vis = visible ? 'visible' : 'none';
  ['el-pulse', 'el-glow', 'el-dot', 'el-labels'].forEach(id => {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis);
  });
  return visible;
}
