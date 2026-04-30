/* ============================================
   CivicPulse Poznań — Network Link Animation
   Shows a brief visual link from a clicked device to
   other devices it's connected to (same operator/network).
   ============================================ */

const LINE_SRC = 'netlink-lines';
const NODE_SRC = 'netlink-nodes';
const ORIGIN_SRC = 'netlink-origin';

const LINE_LAYER = 'netlink-lines';
const LINE_GLOW_LAYER = 'netlink-lines-glow';
const NODE_LAYER = 'netlink-nodes';
const ORIGIN_LAYER = 'netlink-origin';

let rafId = null;
let activeMap = null;

function haversineMeters(a, b) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(h));
}

function removeLayerIfExists(map, id) {
  if (map.getLayer(id)) map.removeLayer(id);
}
function removeSourceIfExists(map, id) {
  if (map.getSource(id)) map.removeSource(id);
}

export function clearNetworkLinks(map) {
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  activeMap = null;
  [LINE_LAYER, LINE_GLOW_LAYER, NODE_LAYER, ORIGIN_LAYER].forEach(id => removeLayerIfExists(map, id));
  [LINE_SRC, NODE_SRC, ORIGIN_SRC].forEach(id => removeSourceIfExists(map, id));
}

/**
 * Show a brief animated link visualization from `clickedFeature` to other
 * features in `allFeatures` that share the same value on `linkKey`.
 *
 * Only real relationships are drawn — if no other feature shares the key, nothing happens.
 */
export function showNetworkLinks(map, clickedFeature, allFeatures, linkKey, options = {}) {
  const {
    color = '#00cfff',
    maxLinks = 8,
    maxDistanceMeters = 8000,
    durationMs = 2600
  } = options;

  if (!clickedFeature || !clickedFeature.geometry || clickedFeature.geometry.type !== 'Point') return;
  const origin = clickedFeature.geometry.coordinates;
  const keyVal = clickedFeature.properties ? clickedFeature.properties[linkKey] : null;
  if (!keyVal) return;

  const peers = allFeatures
    .filter(f =>
      f !== clickedFeature &&
      f.geometry && f.geometry.type === 'Point' &&
      f.properties && f.properties[linkKey] === keyVal
    )
    .map(f => ({ f, d: haversineMeters(origin, f.geometry.coordinates) }))
    .filter(x => x.d > 0 && x.d <= maxDistanceMeters)
    .sort((a, b) => a.d - b.d)
    .slice(0, maxLinks);

  if (peers.length === 0) return;

  clearNetworkLinks(map);
  activeMap = map;

  const lineFC = {
    type: 'FeatureCollection',
    features: peers.map(p => ({
      type: 'Feature',
      properties: { dist: p.d },
      geometry: { type: 'LineString', coordinates: [origin, p.f.geometry.coordinates] }
    }))
  };

  const nodeFC = {
    type: 'FeatureCollection',
    features: peers.map(p => ({
      type: 'Feature',
      properties: {},
      geometry: { type: 'Point', coordinates: p.f.geometry.coordinates }
    }))
  };

  const originFC = {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: origin } }]
  };

  map.addSource(LINE_SRC, { type: 'geojson', data: lineFC, lineMetrics: true });
  map.addSource(NODE_SRC, { type: 'geojson', data: nodeFC });
  map.addSource(ORIGIN_SRC, { type: 'geojson', data: originFC });

  map.addLayer({
    id: LINE_GLOW_LAYER,
    type: 'line',
    source: LINE_SRC,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': color,
      'line-width': 6,
      'line-blur': 4,
      'line-opacity': 0.25
    }
  });

  map.addLayer({
    id: LINE_LAYER,
    type: 'line',
    source: LINE_SRC,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': color,
      'line-width': 1.4,
      'line-opacity': 0.95,
      'line-trim-offset': [0, 0]
    }
  });

  map.addLayer({
    id: NODE_LAYER,
    type: 'circle',
    source: NODE_SRC,
    paint: {
      'circle-radius': 4,
      'circle-color': 'rgba(0,0,0,0)',
      'circle-stroke-color': color,
      'circle-stroke-width': 1.2,
      'circle-opacity': 1
    }
  });

  map.addLayer({
    id: ORIGIN_LAYER,
    type: 'circle',
    source: ORIGIN_SRC,
    paint: {
      'circle-radius': 6,
      'circle-color': 'rgba(0,0,0,0)',
      'circle-stroke-color': color,
      'circle-stroke-width': 1.5,
      'circle-opacity': 1
    }
  });

  const start = performance.now();
  const growMs = 600;
  const fadeMs = 600;

  function frame(now) {
    if (activeMap !== map) return;
    const t = now - start;

    // Grow the line from origin → peer using line-trim-offset (MapLibre 3+).
    // trim-offset hides [start, end] of the line; animate end from 1 → 0.
    const grow = Math.min(t / growMs, 1);
    const eased = 1 - Math.pow(1 - grow, 3);
    try {
      map.setPaintProperty(LINE_LAYER, 'line-trim-offset', [0, 1 - eased]);
    } catch (_) { /* older maplibre — line stays fully drawn */ }

    // Pulsing rings on peer nodes (1.2s cycle).
    const pulse = (t % 1200) / 1200;
    map.setPaintProperty(NODE_LAYER, 'circle-radius', 4 + pulse * 16);
    map.setPaintProperty(NODE_LAYER, 'circle-stroke-opacity', 0.9 * (1 - pulse));

    // Stronger pulse at the origin (1.8s cycle).
    const opulse = (t % 1800) / 1800;
    map.setPaintProperty(ORIGIN_LAYER, 'circle-radius', 6 + opulse * 26);
    map.setPaintProperty(ORIGIN_LAYER, 'circle-stroke-opacity', 1 - opulse);

    // Fade everything out in the final fadeMs.
    const remaining = durationMs - t;
    if (remaining <= fadeMs) {
      const fade = Math.max(remaining / fadeMs, 0);
      map.setPaintProperty(LINE_LAYER, 'line-opacity', 0.95 * fade);
      map.setPaintProperty(LINE_GLOW_LAYER, 'line-opacity', 0.25 * fade);
      map.setPaintProperty(NODE_LAYER, 'circle-stroke-opacity',
        (0.9 * (1 - pulse)) * fade);
      map.setPaintProperty(ORIGIN_LAYER, 'circle-stroke-opacity',
        (1 - opulse) * fade);
    }

    if (t >= durationMs) {
      clearNetworkLinks(map);
      return;
    }
    rafId = requestAnimationFrame(frame);
  }

  rafId = requestAnimationFrame(frame);
}
