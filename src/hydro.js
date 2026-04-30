/* ============================================
   CivicPulse — River Hydro Layer
   Real-time water level from IMGW (per-city)
   ============================================ */

import maplibregl from 'maplibre-gl';
import { apiUrl, getCityConfig } from './cityConfig.js';

const REFRESH_INTERVAL = 5 * 60 * 1000; // 5 min

let map = null;
let hydroData = null;
let visible = true;
let activePopup = null;
let refreshTimer = null;

// --- Water level status ---

/**
 * Classify a water level against per-station thresholds.
 * Falls back to city-config defaults; if those are null (e.g. no
 * official threshold for the Ner), just shows NORMAL/ELEVATED bands
 * based on absolute value.
 */
function getLevelStatus(cm, warnCm, alarmCm) {
  if (cm === null || cm === undefined) return { label: 'NO DATA', color: '#666', glow: 'transparent' };
  if (alarmCm && cm >= alarmCm) return { label: 'ALARM', color: '#ff2222', glow: 'rgba(255, 34, 34, 0.3)' };
  if (warnCm && cm >= warnCm) return { label: 'WARNING', color: '#ff8800', glow: 'rgba(255, 136, 0, 0.2)' };
  if (cm >= 250) return { label: 'ELEVATED', color: '#ffcc00', glow: 'rgba(255, 204, 0, 0.15)' };
  return { label: 'NORMAL', color: '#00bbff', glow: 'rgba(0, 187, 255, 0.1)' };
}

function getLevelPercent(cm, alarmCm) {
  if (!cm) return 0;
  // Use alarm threshold as gauge max, fallback to 500cm
  const max = alarmCm || 500;
  return Math.min(100, Math.max(0, (cm / max) * 100));
}

function getStationThresholds(station) {
  const cfg = getCityConfig();
  return {
    warn: (typeof station.warningLevel === 'number' ? station.warningLevel : null) ?? cfg?.hydroWarningCm ?? null,
    alarm: (typeof station.alarmLevel === 'number' ? station.alarmLevel : null) ?? cfg?.hydroAlarmCm ?? null
  };
}

// --- Initialization ---

export async function initHydro(mapInstance) {
  map = mapInstance;

  try {
    await fetchHydro();
    addHydroLayers();
    setupInteraction();

    // Auto-refresh
    refreshTimer = setInterval(async () => {
      await fetchHydro();
      updateHydroSource();
    }, REFRESH_INTERVAL);

    const p = hydroData?.primary;
    if (p) {
      const river = p.river || getCityConfig()?.riverName || 'River';
      const flow = p.flow !== null && p.flow !== undefined ? p.flow + 'm³/s' : 'n/a';
      console.log(
        '%c[CivicPulse Hydro] ' + river + ' @ ' + p.name + ': ' + p.waterLevel + 'cm, ' + flow,
        'color: #00bbff;'
      );
    }
  } catch (err) {
    console.error('[CivicPulse Hydro] Init failed:', err);
  }
}

// --- Data ---

async function fetchHydro() {
  const res = await fetch(apiUrl('hydro'));
  hydroData = await res.json();
}

function buildGeoJSON() {
  if (!hydroData || !hydroData.stations) {
    return { type: 'FeatureCollection', features: [] };
  }

  return {
    type: 'FeatureCollection',
    features: hydroData.stations.map(s => {
      const { warn, alarm } = getStationThresholds(s);
      const st = getLevelStatus(s.waterLevel, warn, alarm);
      return {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
        properties: {
          name: s.name,
          river: s.river,
          waterLevel: s.waterLevel,
          waterLevelTime: s.waterLevelTime,
          flow: s.flow,
          flowTime: s.flowTime,
          waterTemp: s.waterTemp,
          warningLevel: warn,
          alarmLevel: alarm,
          status: st.label,
          statusColor: st.color
        }
      };
    })
  };
}

function updateHydroSource() {
  if (map.getSource('hydro-stations')) {
    map.getSource('hydro-stations').setData(buildGeoJSON());
  }
  // Update popup if open
  if (activePopup && hydroData?.primary) {
    // Popup auto-updates on next click
  }
}

// --- Map Layers ---

function addHydroLayers() {
  const geojson = buildGeoJSON();

  map.addSource('hydro-stations', {
    type: 'geojson',
    data: geojson
  });

  // Pulse ring — animated feel
  map.addLayer({
    id: 'hydro-pulse',
    type: 'circle',
    source: 'hydro-stations',
    paint: {
      'circle-radius': 18,
      'circle-color': ['get', 'statusColor'],
      'circle-opacity': 0.08,
      'circle-blur': 0.6
    }
  });

  // Outer glow
  map.addLayer({
    id: 'hydro-glow',
    type: 'circle',
    source: 'hydro-stations',
    paint: {
      'circle-radius': 10,
      'circle-color': ['get', 'statusColor'],
      'circle-opacity': 0.15,
      'circle-blur': 0.4
    }
  });

  // Center dot
  map.addLayer({
    id: 'hydro-dot',
    type: 'circle',
    source: 'hydro-stations',
    paint: {
      'circle-radius': 5,
      'circle-color': ['get', 'statusColor'],
      'circle-stroke-color': '#000',
      'circle-stroke-width': 1.5,
      'circle-stroke-opacity': 0.5,
      'circle-opacity': 0.9
    }
  });

  // Label
  map.addLayer({
    id: 'hydro-label',
    type: 'symbol',
    source: 'hydro-stations',
    layout: {
      'text-field': ['concat', ['get', 'river'], ' ', ['to-string', ['get', 'waterLevel']], 'cm'],
      'text-font': ['Noto Sans Regular'],
      'text-size': 9,
      'text-offset': [0, 2],
      'text-anchor': 'top',
      'text-allow-overlap': true
    },
    paint: {
      'text-color': ['get', 'statusColor'],
      'text-halo-color': 'rgba(0, 0, 0, 0.9)',
      'text-halo-width': 1.5
    }
  });
}

// --- Interaction ---

function setupInteraction() {
  map.on('mouseenter', 'hydro-dot', () => {
    map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', 'hydro-dot', () => {
    map.getCanvas().style.cursor = '';
  });

  map.on('click', 'hydro-dot', (e) => {
    if (!e.features || !e.features[0]) return;
    const f = e.features[0];
    const coords = f.geometry.coordinates.slice();
    const p = f.properties;

    const level = p.waterLevel;
    // Coerce stringified values from popup features back to numbers
    const warning = p.warningLevel !== null && p.warningLevel !== undefined && p.warningLevel !== ''
      ? parseFloat(p.warningLevel) : null;
    const alarm = p.alarmLevel !== null && p.alarmLevel !== undefined && p.alarmLevel !== ''
      ? parseFloat(p.alarmLevel) : null;
    const status = getLevelStatus(level, warning, alarm);
    // IMGW returns null for missing flow/temp; MapLibre's click-event property
    // round-trip can deliver those as `undefined`, which slips past `!== null`
    // and renders "undefined m³/s" / "undefined°C". Coerce + finite-check.
    const flow = Number.isFinite(parseFloat(p.flow)) ? parseFloat(p.flow) : null;
    const temp = Number.isFinite(parseFloat(p.waterTemp)) ? parseFloat(p.waterTemp) : null;

    // Gauge: use alarm as max if available, else ~500cm fallback
    const gaugeMax = alarm || 500;
    const warningPct = warning ? (warning / gaugeMax) * 100 : null;
    const levelPct = Math.min(100, (level / gaugeMax) * 100);

    // Time ago
    let timeAgo = '—';
    if (p.waterLevelTime) {
      const measured = new Date(p.waterLevelTime.replace(' ', 'T') + '+02:00');
      const mins = Math.round((Date.now() - measured.getTime()) / 60000);
      if (mins < 60) timeAgo = mins + ' min ago';
      else timeAgo = Math.floor(mins / 60) + 'h ' + (mins % 60) + 'm ago';
    }

    const html = `
      <div class="hydro-popup">
        <div class="hydp-header" style="border-bottom-color: ${status.color}20">
          <div class="hydp-icon" style="color:${status.color}">≋</div>
          <div class="hydp-header-info">
            <div class="hydp-river" style="color:${status.color}">${p.river}</div>
            <div class="hydp-station">${p.name}</div>
          </div>
          <div class="hydp-badge" style="background:${status.color}18;color:${status.color};border-color:${status.color}40">${status.label}</div>
        </div>
        <div class="hydp-body">
          <div class="hydp-level-display">
            <span class="hydp-level-value" style="color:${status.color}">${level !== null ? level : '—'}</span>
            <span class="hydp-level-unit">cm</span>
          </div>
          <div class="hydp-gauge">
            <div class="hydp-gauge-bar" style="width:${levelPct}%;background:${status.color}"></div>
            ${warningPct !== null ? `<div class="hydp-gauge-warn" style="left:${warningPct}%"></div>` : ''}
          </div>
          <div class="hydp-gauge-labels">
            <span>0</span>
            ${warning ? `<span style="color:#ff8800">${warning}</span>` : '<span class="hydp-dim">—</span>'}
            <span style="color:${alarm ? '#ff2222' : '#666'}">${alarm ? alarm + 'cm' : 'no alarm'}</span>
          </div>
          <div class="hydp-stats">
            ${flow !== null ? `<div class="hydp-stat-row">
              <span class="hydp-label">FLOW</span>
              <span class="hydp-value">${flow} m³/s</span>
            </div>` : ''}
            ${temp !== null ? `<div class="hydp-stat-row">
              <span class="hydp-label">WATER TEMP</span>
              <span class="hydp-value">${temp}°C</span>
            </div>` : ''}
            <div class="hydp-stat-row">
              <span class="hydp-label">MEASURED</span>
              <span class="hydp-value hydp-dim">${timeAgo}</span>
            </div>
            <div class="hydp-stat-row">
              <span class="hydp-label">SOURCE</span>
              <span class="hydp-value hydp-dim">IMGW-PIB</span>
            </div>
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
  if (!hydroData || !hydroData.stations || !query) return [];
  const q = query.toLowerCase();
  const out = [];
  for (const s of hydroData.stations) {
    const hay = [s.name, s.river].filter(Boolean).join(' ').toLowerCase();
    if (!hay.includes(q)) continue;
    out.push({
      label: s.name || s.river || 'Hydro station',
      sublabel: `River level${s.river ? ' · ' + s.river : ''}${typeof s.waterLevel === 'number' ? ' · ' + s.waterLevel + 'cm' : ''}`,
      coords: [s.lon, s.lat],
      color: '#00bbff',
      layerName: 'Hydro'
    });
    if (out.length >= 5) break;
  }
  return out;
}

// --- Teardown ---

export function destroyHydro() {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  if (activePopup) { activePopup.remove(); activePopup = null; }
  ['hydro-pulse', 'hydro-glow', 'hydro-dot', 'hydro-label'].forEach(id => map?.getLayer(id) && map.removeLayer(id));
  if (map?.getSource('hydro-stations')) map.removeSource('hydro-stations');
  hydroData = null;
  visible = true;
  map = null;
}

// --- Visibility ---

export function toggleHydro() {
  visible = !visible;
  const vis = visible ? 'visible' : 'none';
  ['hydro-pulse', 'hydro-glow', 'hydro-dot', 'hydro-label'].forEach(id => {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis);
  });
  return visible;
}
