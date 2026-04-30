/* ============================================
   CivicPulse Poznań — Parcel Lockers Layer
   Data from OpenStreetMap (InPost, DPD, UPS,
   Orlen, DHL, Poczta Polska, Allegro…)
   ============================================ */

import maplibregl from 'maplibre-gl';
import { showNetworkLinks } from './network.js';
import { fetchGeoJSON } from './cityConfig.js';

let map = null;
let parcelGeoJSON = null;
let visible = true;
let activePopup = null;

// Single layer color — every locker dot renders in this so the layer reads
// as "parcel lockers" at a glance. Brand identity is preserved in the popup
// brand badge and the network-link animation, which still use the maps below.
const PARCEL_COLOR = '#ff8c1a';

// Brand-mark colors (used for the popup-header brand swatch).
const BRAND_COLORS = {
  'InPost': '#FFCC00',
  'DPD': '#DC0032',
  'UPS': '#351C15',
  'Orlen': '#E30613',
  'DHL': '#FFCC00',
  'Poczta Polska': '#0055A4',
  'Allegro': '#FF5A00',
  'Castorama': '#0066CC',
  'Spar': '#00A651'
};

// Fallback accent for unknown brands in the popup.
const DEFAULT_ACCENT = '#aa88ff';

// Map-friendly variants for popup accent and the same-brand network
// animation. NOT applied to the dot itself.
const BRAND_DOT_COLORS = {
  'InPost': '#ffdd44',
  'DPD': '#ff4466',
  'UPS': '#cc8844',
  'Orlen': '#ff4444',
  'DHL': '#ffdd44',
  'Poczta Polska': '#4488ff',
  'Allegro': '#ff7733',
  'Castorama': '#4488ff',
  'Spar': '#44cc66'
};

// --- Initialization ---

export async function initParcels(mapInstance) {
  map = mapInstance;

  try {
    await fetchParcels();
    addParcelLayers();
    setupInteraction();

    // Count by brand
    const brands = {};
    parcelGeoJSON.features.forEach(f => {
      const b = f.properties.brand || '?';
      brands[b] = (brands[b] || 0) + 1;
    });
    const top = Object.entries(brands).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k}:${v}`).join(' ');
    console.log(
      `%c[CivicPulse Parcels] ${parcelGeoJSON.features.length} lockers (${top})`,
      'color: #ff8c1a;'
    );
  } catch (err) {
    console.error('[CivicPulse Parcels] Init failed:', err);
  }
}

// --- Data ---

async function fetchParcels() {
  parcelGeoJSON = await fetchGeoJSON('parcels');
}

// --- Map Layers ---

function addParcelLayers() {
  map.addSource('parcels', {
    type: 'geojson',
    data: parcelGeoJSON
  });

  // Glow layer
  map.addLayer({
    id: 'parcels-glow',
    type: 'circle',
    source: 'parcels',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 4, 16, 10],
      'circle-color': PARCEL_COLOR,
      'circle-opacity': 0.08,
      'circle-blur': 0.6
    }
  });

  // Square icon — matches the ▣ glyph in the sidebar legend so the layer
  // reads as parcel lockers at a glance. Symbol layer (text glyph) rather
  // than a circle; the click handler is attached to this layer ID and
  // works on symbol layers transparently.
  map.addLayer({
    id: 'parcels-dot',
    type: 'symbol',
    source: 'parcels',
    layout: {
      'text-field': '▣',
      'text-font': ['Noto Sans Regular'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 11, 8, 14, 11, 16, 15],
      'text-allow-overlap': true,
      'text-ignore-placement': true
    },
    paint: {
      'text-color': PARCEL_COLOR,
      'text-halo-color': 'rgba(0, 0, 0, 0.85)',
      'text-halo-width': 1,
      'text-halo-blur': 0.5,
      'text-opacity': 0.95
    }
  });

  // Brand labels at high zoom — tinted with layer color, not brand yellow,
  // so the labels read as parcel-locker labels rather than InPost-only.
  map.addLayer({
    id: 'parcels-labels',
    type: 'symbol',
    source: 'parcels',
    minzoom: 15,
    layout: {
      'text-field': ['get', 'brand'],
      'text-font': ['Noto Sans Regular'],
      'text-size': 8,
      'text-offset': [0, 1.2],
      'text-anchor': 'top',
      'text-allow-overlap': false
    },
    paint: {
      'text-color': 'rgba(255, 140, 26, 0.35)',
      'text-halo-color': 'rgba(0, 0, 0, 0.8)',
      'text-halo-width': 1
    }
  });
}

// --- Interaction ---

function setupInteraction() {
  map.on('mouseenter', 'parcels-dot', () => {
    map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', 'parcels-dot', () => {
    map.getCanvas().style.cursor = '';
  });

  map.on('click', 'parcels-dot', (e) => {
    if (!e.features || !e.features[0]) return;
    const f = e.features[0];
    const coords = f.geometry.coordinates.slice();
    const p = f.properties;

    const name = p.name || p.brand || 'Parcel Locker';
    const brand = p.brand || 'Unknown';
    const ref = p.ref || '';
    const address = p.address || '—';
    const hours = p.openingHours || '24/7';
    const website = p.website || '';

    const accentColor = BRAND_DOT_COLORS[brand] || DEFAULT_ACCENT;
    const bgColor = BRAND_COLORS[brand] || '#666';

    const websiteHtml = website
      ? `<a href="${website}" target="_blank" style="color:${accentColor};text-decoration:none;font-size:10px;">${website.replace(/^https?:\/\/(www\.)?/, '').split('/')[0]}</a>`
      : '—';

    const html = `
      <div class="parcel-popup">
        <div class="pclp-header">
          <div class="pclp-brand-badge" style="background:${bgColor}">${brand.charAt(0)}</div>
          <div class="pclp-header-info">
            <div class="pclp-brand" style="color:${accentColor}">${brand}</div>
            <div class="pclp-name">${name}${ref ? ` <span class="pclp-ref">${ref}</span>` : ''}</div>
          </div>
        </div>
        <div class="pclp-body">
          <div class="pclp-stat-row">
            <span class="pclp-label">ADDRESS</span>
            <span class="pclp-value">${address}</span>
          </div>
          <div class="pclp-stat-row">
            <span class="pclp-label">HOURS</span>
            <span class="pclp-value pclp-dim">${hours}</span>
          </div>
          <div class="pclp-stat-row">
            <span class="pclp-label">WEBSITE</span>
            <span class="pclp-value">${websiteHtml}</span>
          </div>
          <div class="pclp-stat-row">
            <span class="pclp-label">COORDS</span>
            <span class="pclp-value pclp-dim">${coords[1].toFixed(5)}, ${coords[0].toFixed(5)}</span>
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
      offset: 10
    })
      .setLngLat(coords)
      .setHTML(html)
      .addTo(map);

    activePopup.on('close', () => { activePopup = null; });

    // Network animation uses the generic layer color, not the brand accent —
    // the chains read as "parcel-locker network" rather than "InPost only".
    showNetworkLinks(map, f, parcelGeoJSON.features, 'operator', { color: PARCEL_COLOR });
  });
}

// --- Search ---

export function searchFeatures(query) {
  if (!parcelGeoJSON || !query) return [];
  const q = query.toLowerCase();
  const out = [];
  for (const f of parcelGeoJSON.features) {
    const p = f.properties;
    const hay = [p.brand, p.name, p.ref, p.address].filter(Boolean).join(' ').toLowerCase();
    if (!hay.includes(q)) continue;
    out.push({
      label: p.brand || p.name || 'Parcel locker',
      sublabel: `Parcel locker${p.ref ? ' · ' + p.ref : ''}${p.address ? ' · ' + p.address : ''}`,
      coords: f.geometry.coordinates,
      color: PARCEL_COLOR,
      layerName: 'Parcel'
    });
    if (out.length >= 5) break;
  }
  return out;
}

// --- Teardown ---

export function destroyParcels() {
  if (activePopup) { activePopup.remove(); activePopup = null; }
  ['parcels-glow', 'parcels-dot', 'parcels-labels'].forEach(id => map?.getLayer(id) && map.removeLayer(id));
  if (map?.getSource('parcels')) map.removeSource('parcels');
  parcelGeoJSON = null;
  visible = true;
  map = null;
}

// --- Visibility ---

export function toggleParcels() {
  visible = !visible;
  const vis = visible ? 'visible' : 'none';
  ['parcels-glow', 'parcels-dot', 'parcels-labels'].forEach(id => {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis);
  });
  return visible;
}
