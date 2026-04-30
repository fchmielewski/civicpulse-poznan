/* ============================================
   CivicPulse Poznań — Wi-Fi Hotspots Layer
   Data from OpenStreetMap via Overpass API
   ============================================ */

import maplibregl from 'maplibre-gl';
import { showNetworkLinks } from './network.js';
import { fetchGeoJSON } from './cityConfig.js';

let map = null;
let wifiGeoJSON = null;
let visible = true;
let activePopup = null;

// Venue type to human labels
const VENUE_LABELS = {
  restaurant: 'Restaurant',
  cafe: 'Café',
  fast_food: 'Fast Food',
  bar: 'Bar',
  pub: 'Pub',
  hotel: 'Hotel',
  hostel: 'Hostel',
  guest_house: 'Guest House',
  fuel: 'Gas Station',
  library: 'Library',
  community_centre: 'Community Centre',
  bank: 'Bank',
  bureau_de_change: 'Exchange',
  hospital: 'Hospital',
  clinic: 'Clinic',
  pharmacy: 'Pharmacy',
  supermarket: 'Supermarket',
  convenience: 'Convenience Store',
  mall: 'Shopping Mall',
  clothes: 'Clothes Shop',
  electronics: 'Electronics',
  coworking_space: 'Co-working Space',
  fitness_centre: 'Fitness Centre',
  park: 'Park',
  other: 'Wi-Fi Spot'
};

// --- Initialization ---

export async function initWifi(mapInstance) {
  map = mapInstance;

  try {
    await fetchWifi();
    addWifiLayers();
    setupInteraction();

    const free = wifiGeoJSON.features.filter(f => f.properties.isFree).length;
    console.log(
      `%c[CivicPulse WiFi] ${wifiGeoJSON.features.length} hotspots (${free} free)`,
      'color: #44ddaa;'
    );
  } catch (err) {
    console.error('[CivicPulse WiFi] Init failed:', err);
  }
}

// --- Data ---

async function fetchWifi() {
  wifiGeoJSON = await fetchGeoJSON('wifi');
}

// --- Map Layers ---

function addWifiLayers() {
  map.addSource('wifi', {
    type: 'geojson',
    data: wifiGeoJSON
  });

  // Glow ring
  map.addLayer({
    id: 'wifi-glow',
    type: 'circle',
    source: 'wifi',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 6, 16, 16],
      'circle-color': [
        'case',
        ['get', 'isFree'], '#44ddaa',
        '#ddaa44'
      ],
      'circle-opacity': 0.1,
      'circle-blur': 0.7
    }
  });

  // Main dot
  map.addLayer({
    id: 'wifi-dot',
    type: 'circle',
    source: 'wifi',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 2.5, 16, 6],
      'circle-color': [
        'case',
        ['get', 'isFree'], '#44ddaa',
        '#ddaa44'
      ],
      'circle-stroke-color': '#fff',
      'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 11, 0, 14, 0.5],
      'circle-stroke-opacity': 0.3,
      'circle-opacity': 0.85
    }
  });

  // SSID labels
  map.addLayer({
    id: 'wifi-labels',
    type: 'symbol',
    source: 'wifi',
    minzoom: 14,
    layout: {
      'text-field': ['get', 'name'],
      'text-font': ['Noto Sans Regular'],
      'text-size': 9,
      'text-offset': [0, 1.3],
      'text-anchor': 'top',
      'text-allow-overlap': false
    },
    paint: {
      'text-color': 'rgba(68, 221, 170, 0.4)',
      'text-halo-color': 'rgba(0, 0, 0, 0.8)',
      'text-halo-width': 1
    }
  });
}

// --- Interaction ---

function setupInteraction() {
  map.on('mouseenter', 'wifi-dot', () => {
    map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', 'wifi-dot', () => {
    map.getCanvas().style.cursor = '';
  });

  map.on('click', 'wifi-dot', (e) => {
    if (!e.features || !e.features[0]) return;
    const f = e.features[0];
    const coords = f.geometry.coordinates.slice();
    const p = f.properties;

    const name = p.name || 'Unknown';
    const ssid = p.ssid || '—';
    const isFree = p.isFree === true || p.isFree === 'true';
    const fee = p.fee || 'unknown';
    const venueType = p.venueType || 'other';
    const operator = p.operator || '—';
    const address = p.address || '—';
    const website = p.website || '—';
    const hours = p.openingHours || '—';

    const venueLabel = VENUE_LABELS[venueType] || venueType.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    const accentColor = isFree ? '#44ddaa' : '#ddaa44';
    const feeLabel = isFree ? 'FREE' : fee === 'customers' ? 'CUSTOMERS ONLY' : fee.toUpperCase();

    const websiteHtml = website !== '—'
      ? `<a href="${website}" target="_blank" style="color:${accentColor};text-decoration:none;font-size:10px;">${website.replace(/^https?:\/\/(www\.)?/, '').split('/')[0]}</a>`
      : '—';

    const html = `
      <div class="wifi-popup">
        <div class="wfp-header">
          <div class="wfp-icon" style="color:${accentColor}">⦿</div>
          <div class="wfp-header-info">
            <div class="wfp-title">${name}</div>
            <div class="wfp-type">${venueLabel}</div>
          </div>
        </div>
        <div class="wfp-body">
          <div class="wfp-ssid-row">
            <span class="wfp-ssid-icon" style="color:${accentColor}">◉</span>
            <span class="wfp-ssid">${ssid}</span>
            <span class="wfp-fee-badge" style="border-color:${accentColor};color:${accentColor}">${feeLabel}</span>
          </div>
          <div class="wfp-divider"></div>
          <div class="wfp-stat-row">
            <span class="wfp-label">OPERATOR</span>
            <span class="wfp-value">${operator}</span>
          </div>
          <div class="wfp-stat-row">
            <span class="wfp-label">ADDRESS</span>
            <span class="wfp-value">${address}</span>
          </div>
          <div class="wfp-stat-row">
            <span class="wfp-label">HOURS</span>
            <span class="wfp-value wfp-dim">${hours}</span>
          </div>
          <div class="wfp-stat-row">
            <span class="wfp-label">WEBSITE</span>
            <span class="wfp-value">${websiteHtml}</span>
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

    showNetworkLinks(map, f, wifiGeoJSON.features, 'operator', { color: accentColor });
  });
}

// --- Search ---

export function searchFeatures(query) {
  if (!wifiGeoJSON || !query) return [];
  const q = query.toLowerCase();
  const out = [];
  for (const f of wifiGeoJSON.features) {
    const p = f.properties;
    const hay = [p.name, p.operator, p.venue, p.address].filter(Boolean).join(' ').toLowerCase();
    if (!hay.includes(q)) continue;
    out.push({
      label: p.name || p.operator || 'Wi-Fi hotspot',
      sublabel: `Wi-Fi${p.venue ? ' · ' + (VENUE_LABELS[p.venue] || p.venue) : ''}`,
      coords: f.geometry.coordinates,
      color: '#44ddaa',
      layerName: 'Wi-Fi'
    });
    if (out.length >= 5) break;
  }
  return out;
}

// --- Teardown ---

export function destroyWifi() {
  if (activePopup) { activePopup.remove(); activePopup = null; }
  ['wifi-glow', 'wifi-dot', 'wifi-labels'].forEach(id => map?.getLayer(id) && map.removeLayer(id));
  if (map?.getSource('wifi')) map.removeSource('wifi');
  wifiGeoJSON = null;
  visible = true;
  map = null;
}

// --- Visibility ---

export function toggleWifi() {
  visible = !visible;
  const vis = visible ? 'visible' : 'none';
  ['wifi-glow', 'wifi-dot', 'wifi-labels'].forEach(id => {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis);
  });
  return visible;
}
