/* ============================================
   CivicPulse — Bike Sharing Layer
   Real-time bike-share stations (GBFS via CityBikes.org mirror).
   Used by Łódź for Łódzki Rower Publiczny / Nextbike.
   ============================================ */

import maplibregl from 'maplibre-gl';
import { apiUrl } from './cityConfig.js';
import { showNetworkLinks } from './network.js';

const REFRESH_INTERVAL = 90_000; // 90s — matches server cache TTL

let map = null;
let bikeGeoJSON = null;
let visible = true;
let activePopup = null;
let refreshTimer = null;

// --- Initialization ---

export async function initBikeSharing(mapInstance) {
  map = mapInstance;

  try {
    await fetchBikes();
    addBikeLayers();
    setupInteraction();

    refreshTimer = setInterval(async () => {
      if (!visible) return;
      try {
        await fetchBikes();
        map.getSource('bike-sharing')?.setData(bikeGeoJSON);
      } catch { /* silent */ }
    }, REFRESH_INTERVAL);

    const totalBikes = bikeGeoJSON.features.reduce((s, f) => s + (f.properties.freeBikes || 0), 0);
    const online = bikeGeoJSON.features.filter(f => f.properties.online !== false).length;
    console.log(
      `%c[CivicPulse BikeShare] ${bikeGeoJSON.features.length} stations (${online} online, ${totalBikes} bikes available)`,
      'color: #00cc88;'
    );
  } catch (err) {
    console.error('[CivicPulse BikeShare] Init failed:', err);
  }
}

// --- Data ---

async function fetchBikes() {
  const res = await fetch(apiUrl('bike-sharing'));
  const data = await res.json();

  // Enrich: compute availability ratio (bikes / total) so the map
  // can color each station by how stocked it currently is.
  data.features.forEach(f => {
    const p = f.properties;
    const bikes = typeof p.freeBikes === 'number' ? p.freeBikes : 0;
    const slots = typeof p.emptySlots === 'number' ? p.emptySlots : 0;
    const total = bikes + slots;
    p.bikesNum = bikes;
    p.slotsNum = slots;
    p.totalNum = total;
    // availability = share of bikes available (1.0 → fully stocked, 0 → empty)
    p.availability = total > 0 ? bikes / total : 0;
  });

  bikeGeoJSON = data;
}

// --- Map Layers ---

function addBikeLayers() {
  map.addSource('bike-sharing', {
    type: 'geojson',
    data: bikeGeoJSON
  });

  // Glow ring — color tracks availability
  map.addLayer({
    id: 'bike-sharing-glow',
    type: 'circle',
    source: 'bike-sharing',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 8, 16, 22],
      'circle-color': [
        'interpolate', ['linear'],
        ['get', 'availability'],
        0, '#ff4444',      // empty
        0.2, '#ff8833',
        0.5, '#00cc88',    // healthy
        1.0, '#00ffaa'     // full rack
      ],
      'circle-opacity': 0.1,
      'circle-blur': 0.7
    }
  });

  // Main station dot
  map.addLayer({
    id: 'bike-sharing-dot',
    type: 'circle',
    source: 'bike-sharing',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 3.5, 16, 9],
      'circle-color': [
        'interpolate', ['linear'],
        ['get', 'availability'],
        0, '#ff4444',
        0.2, '#ff8833',
        0.5, '#00cc88',
        1.0, '#00ffaa'
      ],
      'circle-stroke-color': '#fff',
      'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 11, 0.3, 16, 1.2],
      'circle-stroke-opacity': 0.35,
      'circle-opacity': 0.88
    }
  });

  // Free-bikes number
  map.addLayer({
    id: 'bike-sharing-count',
    type: 'symbol',
    source: 'bike-sharing',
    minzoom: 13,
    layout: {
      'text-field': ['to-string', ['get', 'bikesNum']],
      'text-font': ['Noto Sans Bold'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 13, 8, 16, 11],
      'text-offset': [0, -1.4],
      'text-anchor': 'bottom',
      'text-allow-overlap': true
    },
    paint: {
      'text-color': [
        'interpolate', ['linear'],
        ['get', 'availability'],
        0, '#ff6666',
        0.2, '#ffaa55',
        0.5, '#00ffaa',
        1.0, '#66ffcc'
      ],
      'text-halo-color': 'rgba(0, 0, 0, 0.85)',
      'text-halo-width': 1.5
    }
  });

  // Station name at higher zoom
  map.addLayer({
    id: 'bike-sharing-labels',
    type: 'symbol',
    source: 'bike-sharing',
    minzoom: 15,
    layout: {
      'text-field': ['get', 'name'],
      'text-font': ['Noto Sans Regular'],
      'text-size': 9,
      'text-offset': [0, 1.6],
      'text-anchor': 'top',
      'text-max-width': 10,
      'text-allow-overlap': false
    },
    paint: {
      'text-color': 'rgba(0, 204, 136, 0.5)',
      'text-halo-color': 'rgba(0, 0, 0, 0.8)',
      'text-halo-width': 1
    }
  });
}

// --- Interaction ---

function setupInteraction() {
  map.on('mouseenter', 'bike-sharing-dot', () => {
    map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', 'bike-sharing-dot', () => {
    map.getCanvas().style.cursor = '';
  });

  map.on('click', 'bike-sharing-dot', (e) => {
    if (!e.features || !e.features[0]) return;
    const f = e.features[0];
    const coords = f.geometry.coordinates.slice();
    const p = f.properties;

    const bikes = parseInt(p.bikesNum) || 0;
    const slots = parseInt(p.slotsNum) || 0;
    const total = parseInt(p.totalNum) || (bikes + slots);
    const availability = parseFloat(p.availability) || 0;
    const ebikes = parseInt(p.ebikes) || 0;
    const online = p.online === true || p.online === 'true' || p.online === undefined || p.online === '';
    const name = p.name || '—';
    const address = p.address || '—';
    const operator = p.operator || '—';
    const stationId = p.stationId || '—';
    const timestamp = p.timestamp || '—';

    // Status classification
    let statusColor, statusLabel;
    if (!online) {
      statusColor = '#666';
      statusLabel = 'OFFLINE';
    } else if (bikes === 0) {
      statusColor = '#ff4444';
      statusLabel = 'EMPTY';
    } else if (availability < 0.2) {
      statusColor = '#ff8833';
      statusLabel = 'LOW';
    } else if (availability > 0.9) {
      statusColor = '#00ffaa';
      statusLabel = 'FULL RACK';
    } else {
      statusColor = '#00cc88';
      statusLabel = 'AVAILABLE';
    }

    // Friendly timestamp
    let timeAgo = timestamp;
    try {
      if (timestamp && timestamp !== '—') {
        const t = new Date(timestamp).getTime();
        const mins = Math.round((Date.now() - t) / 60000);
        if (!isNaN(mins)) {
          if (mins < 1) timeAgo = 'just now';
          else if (mins < 60) timeAgo = mins + ' min ago';
          else timeAgo = Math.floor(mins / 60) + 'h ' + (mins % 60) + 'm ago';
        }
      }
    } catch { /* leave raw */ }

    const bikesPct = total > 0 ? Math.round((bikes / total) * 100) : 0;

    const html = `
      <div class="bike-share-popup">
        <div class="bsp-header">
          <div class="bsp-icon" style="color:${statusColor}">◎</div>
          <div class="bsp-header-info">
            <div class="bsp-title">${name}</div>
            <div class="bsp-op">${operator}</div>
          </div>
        </div>
        <div class="bsp-body">
          <div class="bsp-free-row">
            <span class="bsp-free-count" style="color:${statusColor}">${bikes}</span>
            <span class="bsp-free-label">BIKES AVAILABLE</span>
          </div>
          <div class="bsp-bar-container">
            <div class="bsp-bar-fill" style="width:${bikesPct}%;background:${statusColor}"></div>
          </div>
          <div class="bsp-bar-labels">
            <span>${slots} free slots / ${total} total</span>
            <span style="color:${statusColor}">${statusLabel}</span>
          </div>
          ${ebikes > 0 ? `<div class="bsp-stat-row">
            <span class="bsp-label">E-BIKES</span>
            <span class="bsp-value">${ebikes}</span>
          </div>` : ''}
          <div class="bsp-divider"></div>
          ${address && address !== '—' ? `<div class="bsp-stat-row">
            <span class="bsp-label">ADDRESS</span>
            <span class="bsp-value">${address}</span>
          </div>` : ''}
          <div class="bsp-stat-row">
            <span class="bsp-label">STATION ID</span>
            <span class="bsp-value bsp-dim">${stationId}</span>
          </div>
          <div class="bsp-stat-row">
            <span class="bsp-label">UPDATED</span>
            <span class="bsp-value bsp-dim">${timeAgo}</span>
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

    // Network link animation — chain same-operator stations
    showNetworkLinks(map, f, bikeGeoJSON.features, 'operator', { color: statusColor });
  });
}

// --- Search ---

export function searchFeatures(query) {
  if (!bikeGeoJSON || !query) return [];
  const q = query.toLowerCase();
  const out = [];
  for (const f of bikeGeoJSON.features) {
    const p = f.properties;
    const hay = [p.name, p.address, p.operator].filter(Boolean).join(' ').toLowerCase();
    if (!hay.includes(q)) continue;
    out.push({
      label: p.name || 'Bike-share station',
      sublabel: `Bike sharing${p.operator ? ' · ' + p.operator : ''}${typeof p.bikesNum === 'number' ? ' · ' + p.bikesNum + ' bikes' : ''}`,
      coords: f.geometry.coordinates,
      color: '#00cc88',
      layerName: 'Bike sharing'
    });
    if (out.length >= 5) break;
  }
  return out;
}

// --- Teardown ---

export function destroyBikeSharing() {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  if (activePopup) { activePopup.remove(); activePopup = null; }
  ['bike-sharing-glow', 'bike-sharing-dot', 'bike-sharing-count', 'bike-sharing-labels'].forEach(id => map?.getLayer(id) && map.removeLayer(id));
  if (map?.getSource('bike-sharing')) map.removeSource('bike-sharing');
  bikeGeoJSON = null;
  visible = true;
  map = null;
}

// --- Visibility ---

export function toggleBikeSharing() {
  visible = !visible;
  const vis = visible ? 'visible' : 'none';
  ['bike-sharing-glow', 'bike-sharing-dot', 'bike-sharing-count', 'bike-sharing-labels'].forEach(id => {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis);
  });
  return visible;
}
