/* ============================================
   CivicPulse — Car Traffic Layer
   Real-time traffic flow from TomTom Traffic API.
   Tiles are colored by congestion vs. free-flow speed
   (green = free, yellow/orange = slow, red = jammed).

   Requires a free TomTom API key. Get one at
   https://developer.tomtom.com (2,500 free traffic
   tile requests per day) and add it to .env as
   VITE_TOMTOM_API_KEY.
   ============================================ */

const TOMTOM_KEY = import.meta.env.VITE_TOMTOM_API_KEY || 'iQS1YElqYlJ08jdGeMARItWgrsyltfHs';

const SOURCE_ID = 'traffic-flow';
const LAYER_ID  = 'traffic-flow-layer';

let map = null;
let visible = true;

// --- Initialization ---

export async function initTraffic(mapInstance) {
  map = mapInstance;

  if (!TOMTOM_KEY) {
    console.warn(
      '%c[CivicPulse Traffic] No TomTom API key set — layer disabled.\n' +
      '  Get a free key at https://developer.tomtom.com and add to .env:\n' +
      '  VITE_TOMTOM_API_KEY=your_key_here',
      'color: #ff5544;'
    );
    return;
  }

  // TomTom Traffic Flow tiles. Style "relative0" colors each segment by its
  // current speed relative to free-flow (green→yellow→orange→red).
  // https://developer.tomtom.com/traffic-api/documentation/traffic-flow/flow-tiles
  map.addSource(SOURCE_ID, {
    type: 'raster',
    tiles: [
      `https://api.tomtom.com/traffic/map/4/tile/flow/relative0/{z}/{x}/{y}.png?key=${TOMTOM_KEY}`
    ],
    tileSize: 256,
    minzoom: 4,
    maxzoom: 22,
    attribution: '© TomTom Traffic'
  });

  // Insert before 'buildings-3d' so traffic sits over roads but under the
  // 3D building extrusions at high zoom.
  const beforeId = map.getLayer('buildings-3d') ? 'buildings-3d' : undefined;
  map.addLayer({
    id: LAYER_ID,
    type: 'raster',
    source: SOURCE_ID,
    paint: {
      'raster-opacity': 0.85
    }
  }, beforeId);

  console.log('%c[CivicPulse Traffic] TomTom Traffic Flow tiles loaded', 'color: #ff5544;');
}

// --- Teardown ---

export function destroyTraffic() {
  if (map?.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
  if (map?.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
  visible = true;
  map = null;
}

// --- Visibility ---

export function toggleTraffic() {
  visible = !visible;
  const vis = visible ? 'visible' : 'none';
  if (map?.getLayer(LAYER_ID)) {
    map.setLayoutProperty(LAYER_ID, 'visibility', vis);
  }
  return visible;
}
