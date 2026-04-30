/* ============================================
   CivicPulse — Tor Relays Layer
   Tor network relays in Poland (Onionoo + GeoIP).
   Country-wide, not city-specific — same data set
   regardless of which city you've selected.
   ============================================ */

import maplibregl from 'maplibre-gl';
import { apiUrl } from './cityConfig.js';

let map = null;
let torGeoJSON = null;
let visible = true;
let activePopup = null;

// --- Initialization ---

export async function initTor(mapInstance) {
  map = mapInstance;

  try {
    await fetchTor();
    addTorLayers();
    setupInteraction();

    const exits = torGeoJSON.features.filter(f => f.properties.isExit).length;
    const guards = torGeoJSON.features.filter(f => f.properties.isGuard).length;
    console.log(
      `%c[CivicPulse Tor] ${torGeoJSON.features.length} relays (${exits} exit, ${guards} guard)`,
      'color: #b44dff;'
    );
  } catch (err) {
    console.error('[CivicPulse Tor] Init failed:', err);
  }
}

// --- Data ---

async function fetchTor() {
  const res = await fetch(apiUrl('tor'));
  torGeoJSON = await res.json();
}

// --- Map Layers ---

function addTorLayers() {
  map.addSource('tor-relays', {
    type: 'geojson',
    data: torGeoJSON
  });

  // Outer pulse glow
  map.addLayer({
    id: 'tor-glow',
    type: 'circle',
    source: 'tor-relays',
    paint: {
      'circle-radius': [
        'interpolate', ['linear'], ['zoom'],
        5, ['interpolate', ['linear'], ['get', 'bandwidthMB'], 0, 3, 20, 8],
        14, ['interpolate', ['linear'], ['get', 'bandwidthMB'], 0, 8, 20, 20]
      ],
      'circle-color': [
        'case',
        ['get', 'isExit'], '#b44dff',
        ['get', 'isGuard'], '#7744ff',
        '#5533aa'
      ],
      'circle-opacity': 0.12,
      'circle-blur': 0.8
    }
  });

  // Main relay dot
  map.addLayer({
    id: 'tor-dot',
    type: 'circle',
    source: 'tor-relays',
    paint: {
      'circle-radius': [
        'interpolate', ['linear'], ['zoom'],
        5, ['interpolate', ['linear'], ['get', 'bandwidthMB'], 0, 1.5, 20, 4],
        14, ['interpolate', ['linear'], ['get', 'bandwidthMB'], 0, 4, 20, 9]
      ],
      'circle-color': [
        'case',
        ['get', 'isExit'], '#cc66ff',
        ['get', 'isGuard'], '#9966ff',
        '#7744cc'
      ],
      'circle-stroke-color': [
        'case',
        ['get', 'isExit'], '#cc66ff',
        '#9966ff'
      ],
      'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 5, 0, 12, 0.5],
      'circle-stroke-opacity': 0.4,
      'circle-opacity': 0.85
    }
  });

  // Nickname labels (high zoom)
  map.addLayer({
    id: 'tor-labels',
    type: 'symbol',
    source: 'tor-relays',
    minzoom: 12,
    layout: {
      'text-field': ['get', 'nickname'],
      'text-font': ['Noto Sans Regular'],
      'text-size': 9,
      'text-offset': [0, 1.3],
      'text-anchor': 'top',
      'text-allow-overlap': false
    },
    paint: {
      'text-color': 'rgba(180, 77, 255, 0.45)',
      'text-halo-color': 'rgba(0, 0, 0, 0.8)',
      'text-halo-width': 1
    }
  });
}

// --- Interaction ---

function setupInteraction() {
  map.on('mouseenter', 'tor-dot', () => {
    map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', 'tor-dot', () => {
    map.getCanvas().style.cursor = '';
  });

  map.on('click', 'tor-dot', (e) => {
    if (!e.features || !e.features[0]) return;
    const f = e.features[0];
    const coords = f.geometry.coordinates.slice();
    const p = f.properties;

    const nickname = p.nickname || '—';
    const fingerprint = p.fingerprint || '—';
    const ip = p.ip || '—';
    const city = p.city || '—';
    const bwMB = parseFloat(p.bandwidthMB) || 0;
    const asName = p.asName || '—';
    const version = p.version || '—';
    const firstSeen = p.firstSeen || '—';
    const isExit = p.isExit === true || p.isExit === 'true';
    const isGuard = p.isGuard === true || p.isGuard === 'true';

    // Parse flags
    let flags;
    try {
      flags = typeof p.flags === 'string' ? JSON.parse(p.flags) : (p.flags || []);
    } catch { flags = []; }

    // Build flag badges
    const flagColors = {
      'Exit': '#cc66ff',
      'Guard': '#9966ff',
      'Fast': '#4dff4d',
      'Stable': '#00aaff',
      'HSDir': '#ffaa00',
      'V2Dir': '#888',
      'Running': '#4dff4d',
      'Valid': '#888'
    };
    const importantFlags = ['Exit', 'Guard', 'Fast', 'Stable', 'HSDir'];
    const badges = flags
      .filter(f => importantFlags.includes(f))
      .map(f => `<span class="relay-badge" style="border-color:${flagColors[f] || '#666'};color:${flagColors[f] || '#666'}">${f}</span>`)
      .join('');

    const accentColor = isExit ? '#cc66ff' : '#9966ff';
    const typeLabel = isExit ? 'EXIT RELAY' : isGuard ? 'GUARD RELAY' : 'RELAY';

    // Format bandwidth
    const bwDisplay = bwMB >= 1 ? `${bwMB} MB/s` : `${Math.round(bwMB * 1024)} KB/s`;

    const html = `
      <div class="relay-popup">
        <div class="rlp-header">
          <div class="rlp-icon" style="color:${accentColor}">⬡</div>
          <div class="rlp-header-info">
            <div class="rlp-title">${nickname}</div>
            <div class="rlp-type" style="color:${accentColor}">${typeLabel}</div>
          </div>
        </div>
        <div class="rlp-body">
          <div class="rlp-badges">${badges || '<span class="rlp-dim">No flags</span>'}</div>
          <div class="rlp-divider"></div>
          <div class="rlp-stat-row">
            <span class="rlp-label">BANDWIDTH</span>
            <span class="rlp-value">${bwDisplay}</span>
          </div>
          <div class="rlp-stat-row">
            <span class="rlp-label">IP</span>
            <span class="rlp-value rlp-mono">${ip}</span>
          </div>
          <div class="rlp-stat-row">
            <span class="rlp-label">FINGERPRINT</span>
            <span class="rlp-value rlp-mono">${fingerprint}…</span>
          </div>
          <div class="rlp-stat-row">
            <span class="rlp-label">NETWORK</span>
            <span class="rlp-value rlp-dim">${asName}</span>
          </div>
          <div class="rlp-stat-row">
            <span class="rlp-label">LOCATION</span>
            <span class="rlp-value">${city}</span>
          </div>
          <div class="rlp-stat-row">
            <span class="rlp-label">VERSION</span>
            <span class="rlp-value rlp-dim">${version}</span>
          </div>
          <div class="rlp-stat-row">
            <span class="rlp-label">FIRST SEEN</span>
            <span class="rlp-value rlp-dim">${firstSeen}</span>
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
  if (!torGeoJSON || !query) return [];
  const q = query.toLowerCase();
  const out = [];
  for (const f of torGeoJSON.features) {
    const p = f.properties;
    const hay = [p.nickname, p.asName, p.city, p.ip].filter(Boolean).join(' ').toLowerCase();
    if (!hay.includes(q)) continue;
    out.push({
      label: p.nickname || 'Tor relay',
      sublabel: `Tor relay${p.city ? ' · ' + p.city : ''}${p.isExit ? ' · EXIT' : (p.isGuard ? ' · GUARD' : '')}`,
      coords: f.geometry.coordinates,
      color: '#b44dff',
      layerName: 'Tor'
    });
    if (out.length >= 5) break;
  }
  return out;
}

// --- Teardown ---

export function destroyTor() {
  if (activePopup) { activePopup.remove(); activePopup = null; }
  ['tor-glow', 'tor-dot', 'tor-labels'].forEach(id => map?.getLayer(id) && map.removeLayer(id));
  if (map?.getSource('tor-relays')) map.removeSource('tor-relays');
  torGeoJSON = null;
  visible = true;
  map = null;
}

// --- Visibility ---

export function toggleTor() {
  visible = !visible;
  const vis = visible ? 'visible' : 'none';
  ['tor-glow', 'tor-dot', 'tor-labels'].forEach(id => {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis);
  });
  return visible;
}
