/* ============================================
   CivicPulse Poznań — Parking Layer
   Real-time parking availability from ZTM
   ============================================ */

import maplibregl from 'maplibre-gl';
import { apiUrl } from './cityConfig.js';

const REFRESH_INTERVAL = 120_000; // 2 minutes

let map = null;
let parkingGeoJSON = null;
let visible = true;
let activePopup = null;
let refreshTimer = null;

// --- Initialization ---

export async function initParking(mapInstance) {
  map = mapInstance;

  try {
    await fetchParking();
    addParkingLayers();
    setupInteraction();

    // Auto-refresh
    refreshTimer = setInterval(async () => {
      if (!visible) return;
      try {
        await fetchParking();
        map.getSource('parking')?.setData(parkingGeoJSON);
      } catch (e) { /* silent */ }
    }, REFRESH_INTERVAL);

    console.log(
      `%c[CivicPulse Parking] ${parkingGeoJSON.features.length} parkings loaded`,
      'color: #00aaff;'
    );
  } catch (err) {
    console.error('[CivicPulse Parking] Init failed:', err);
  }
}

// --- Data ---

async function fetchParking() {
  const res = await fetch(apiUrl('parking'));
  parkingGeoJSON = await res.json();
}

// --- Map Layers ---

function addParkingLayers() {
  map.addSource('parking', {
    type: 'geojson',
    data: parkingGeoJSON
  });

  // Outer glow ring — occupancy-dependent color
  map.addLayer({
    id: 'parking-glow',
    type: 'circle',
    source: 'parking',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 10, 16, 24],
      'circle-color': [
        'interpolate', ['linear'],
        ['get', 'occupancy'],
        0, '#00aaff',
        0.5, '#ffaa00',
        0.85, '#ff4444',
        1.0, '#ff0000'
      ],
      'circle-opacity': 0.12,
      'circle-blur': 0.8
    }
  });

  // Main parking dot
  map.addLayer({
    id: 'parking-dot',
    type: 'circle',
    source: 'parking',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 5, 16, 10],
      'circle-color': [
        'interpolate', ['linear'],
        ['get', 'occupancy'],
        0, '#00aaff',
        0.5, '#ffaa00',
        0.85, '#ff4444',
        1.0, '#ff0000'
      ],
      'circle-stroke-color': '#fff',
      'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 11, 0.5, 16, 1.5],
      'circle-stroke-opacity': 0.4,
      'circle-opacity': 0.9
    }
  });

  // Free spots count label
  map.addLayer({
    id: 'parking-labels',
    type: 'symbol',
    source: 'parking',
    minzoom: 12,
    layout: {
      'text-field': ['concat', ['to-string', ['get', 'freeSpots']], ' FREE'],
      'text-font': ['Noto Sans Bold'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 12, 8, 16, 11],
      'text-offset': [0, -1.6],
      'text-anchor': 'bottom',
      'text-allow-overlap': true
    },
    paint: {
      'text-color': [
        'interpolate', ['linear'],
        ['get', 'occupancy'],
        0, '#00ccff',
        0.5, '#ffcc00',
        0.85, '#ff6666',
        1.0, '#ff3333'
      ],
      'text-halo-color': 'rgba(0, 0, 0, 0.85)',
      'text-halo-width': 1.5
    }
  });

  // Parking name at higher zoom
  map.addLayer({
    id: 'parking-name-labels',
    type: 'symbol',
    source: 'parking',
    minzoom: 14,
    layout: {
      'text-field': ['get', 'name'],
      'text-font': ['Noto Sans Regular'],
      'text-size': 9,
      'text-offset': [0, 1.6],
      'text-anchor': 'top',
      'text-allow-overlap': false
    },
    paint: {
      'text-color': 'rgba(0, 170, 255, 0.4)',
      'text-halo-color': 'rgba(0, 0, 0, 0.7)',
      'text-halo-width': 1
    }
  });
}

// --- Interaction ---

function setupInteraction() {
  map.on('mouseenter', 'parking-dot', () => {
    map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', 'parking-dot', () => {
    map.getCanvas().style.cursor = '';
  });

  map.on('click', 'parking-dot', (e) => {
    if (!e.features || !e.features[0]) return;
    const f = e.features[0];
    const coords = f.geometry.coordinates.slice();
    const p = f.properties;

    const freeSpots = parseInt(p.freeSpots) || 0;
    const totalSpots = parseInt(p.totalSpots) || 0;
    const occupancy = parseFloat(p.occupancy) || 0;
    const occupied = totalSpots - freeSpots;
    const pct = Math.round(occupancy * 100);
    const name = p.name || '—';
    const address = p.address || '—';
    const parkingType = p.parkingType || '—';
    const timestamp = p.timestamp || '—';

    // Color based on occupancy
    let statusColor, statusLabel;
    if (occupancy < 0.5) {
      statusColor = '#00aaff';
      statusLabel = 'AVAILABLE';
    } else if (occupancy < 0.85) {
      statusColor = '#ffaa00';
      statusLabel = 'FILLING UP';
    } else if (freeSpots > 0) {
      statusColor = '#ff4444';
      statusLabel = 'ALMOST FULL';
    } else {
      statusColor = '#ff0000';
      statusLabel = 'FULL';
    }

    // Build occupancy bar
    const barWidth = Math.round(pct);
    const typeLabel = parkingType === 'P&R' ? 'PARK & RIDE' : 'BUFFER';

    const html = `
      <div class="parking-popup">
        <div class="pkp-header">
          <div class="pkp-icon" style="color:${statusColor}">P</div>
          <div class="pkp-header-info">
            <div class="pkp-title">${name}</div>
            <div class="pkp-type">${typeLabel}</div>
          </div>
        </div>
        <div class="pkp-body">
          <div class="pkp-free-row">
            <span class="pkp-free-count" style="color:${statusColor}">${freeSpots}</span>
            <span class="pkp-free-label">FREE SPOTS</span>
          </div>
          <div class="pkp-bar-container">
            <div class="pkp-bar-fill" style="width:${barWidth}%; background:${statusColor}"></div>
          </div>
          <div class="pkp-bar-labels">
            <span>${occupied} / ${totalSpots} occupied</span>
            <span style="color:${statusColor}">${statusLabel}</span>
          </div>
          <div class="pkp-divider"></div>
          <div class="pkp-stat-row">
            <span class="pkp-label">ADDRESS</span>
            <span class="pkp-value">${address}</span>
          </div>
          <div class="pkp-stat-row">
            <span class="pkp-label">UPDATED</span>
            <span class="pkp-value pkp-dim">${timestamp}</span>
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
      offset: 14
    })
      .setLngLat(coords)
      .setHTML(html)
      .addTo(map);

    activePopup.on('close', () => { activePopup = null; });
  });
}

// --- Search ---

export function searchFeatures(query) {
  if (!parkingGeoJSON || !query) return [];
  const q = query.toLowerCase();
  const out = [];
  for (const f of parkingGeoJSON.features) {
    const p = f.properties;
    const hay = [p.name, p.address, p.parkingType].filter(Boolean).join(' ').toLowerCase();
    if (!hay.includes(q)) continue;
    const free = typeof p.freeSpots === 'number' ? p.freeSpots : null;
    const total = typeof p.totalSpots === 'number' ? p.totalSpots : null;
    const occ = (free !== null && total !== null) ? ` · ${free}/${total} free` : '';
    out.push({
      label: p.name || 'Parking',
      sublabel: `Parking${p.parkingType ? ' · ' + p.parkingType : ''}${occ}`,
      coords: f.geometry.coordinates,
      color: '#00aaff',
      layerName: 'Parking'
    });
    if (out.length >= 5) break;
  }
  return out;
}

// --- Teardown ---

export function destroyParking() {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  if (activePopup) { activePopup.remove(); activePopup = null; }
  ['parking-glow', 'parking-dot', 'parking-labels', 'parking-name-labels'].forEach(id => map?.getLayer(id) && map.removeLayer(id));
  if (map?.getSource('parking')) map.removeSource('parking');
  parkingGeoJSON = null;
  visible = true;
  map = null;
}

// --- Visibility ---

export function toggleParking() {
  visible = !visible;
  const vis = visible ? 'visible' : 'none';
  ['parking-glow', 'parking-dot', 'parking-labels', 'parking-name-labels'].forEach(id => {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis);
  });
  return visible;
}
