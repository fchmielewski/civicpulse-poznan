/* ============================================
   CivicPulse — Multi-City Express Proxy Server
   Supported cities: Poznań, Łódź.
   Real data only — every endpoint routes to each city's live source.
   ============================================ */
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const GtfsRealtimeBindings = require('gtfs-realtime-bindings');
const { execSync } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());

// ---------- Serve Vite build in production ----------
const distPath = path.join(__dirname, 'dist');
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
  console.log('[CivicPulse] Serving static files from dist/');
}

// ============================================================
// City configuration
// Every city-specific value lives here: bboxes, feed URLs,
// GIOŚ filters, hydro river, GTFS endpoints.
// ============================================================

const CITIES = {
  poznan: {
    name: 'Poznań',
    // Overpass expects (S,W,N,E); SI2PEM WFS expects (W,S,E,N,CRS).
    overpassBbox: '52.35,16.80,52.47,17.05',
    si2pemBbox: '16.80,52.35,17.05,52.47,EPSG:4326',
    gtfs: {
      staticUrl: 'https://www.ztm.poznan.pl/pl/dla-deweloperow/getGTFSFile',
      // ZTM uses a ?file= parameter for RT feeds (Protocol Buffers)
      rtVehicles:    { url: 'https://www.ztm.poznan.pl/pl/dla-deweloperow/getGtfsRtFile?file=vehicle_positions.pb' },
      rtTripUpdates: { url: 'https://www.ztm.poznan.pl/pl/dla-deweloperow/getGtfsRtFile?file=trip_updates.pb' },
    },
    gios: {
      // Known Poznań stations — avoid paginating every request
      stations: [
        { id: 931,   name: 'Poznań, ul. Spychalskiego',  lat: 52.392866, lng: 16.928442, address: 'ul. Spychalskiego 34' },
        { id: 932,   name: 'Poznań, ul. Szymanowskiego', lat: 52.459192, lng: 16.906200, address: 'ul. Szymanowskiego 17' },
        { id: 944,   name: 'Poznań, ul. Dąbrowskiego',   lat: 52.420319, lng: 16.877289, address: 'ul. Dąbrowskiego 169' },
        { id: 10148, name: 'Poznań, ul. Hetmańska',      lat: 52.384293, lng: 16.918156, address: 'ul. Hetmańska' },
        { id: 16493, name: 'Poznań, ul. Szwajcarska',    lat: 52.390879, lng: 16.998053, address: 'ul. Szwajcarska' },
      ]
    },
    hydro: {
      // Warta river basin around Poznań
      bbox: { south: 52.2, north: 52.6, west: 16.5, east: 17.3 },
      primaryStationMatch: 'Most Rocha',
      warningCm: 400,
      alarmCm: 500,
      riverLabel: 'Warta'
    },
    parking: 'ztm-poznan',                // ZTM Poznań CSV feeds
    bicycleCounters: 'poznan-eco-counter', // poznan.pl map_service eco_counter
    bikeSharing: null                      // nothing here yet
  },

  lodz: {
    name: 'Łódź',
    overpassBbox: '51.68,19.35,51.82,19.58',
    si2pemBbox: '19.35,51.68,19.58,51.82,EPSG:4326',
    gtfs: {
      // MPK Łódź — official open data portal
      staticUrl:    'https://otwarte.miasto.lodz.pl/wp-content/uploads/2025/06/GTFS.zip',
      rtVehicles:    { url: 'https://otwarte.miasto.lodz.pl/wp-content/uploads/2025/06/vehicle_positions.bin' },
      rtTripUpdates: { url: 'https://otwarte.miasto.lodz.pl/wp-content/uploads/2025/06/trip_updates.bin' },
      rtAlerts:      { url: 'https://otwarte.miasto.lodz.pl/wp-content/uploads/2025/06/alerts.bin' },
    },
    gios: {
      // Populated on first request via GIOŚ /station/findAll paginated lookup
      stations: null,
      cityMatch: 'Łódź'
    },
    // No major river runs through Łódź proper. The Ner is south/west of
    // the city; the closest IMGW gauge (Poddębice) is ~50 km away — too
    // far to honestly call a "Łódź river level". Layer is disabled.
    hydro: null,
    parking: null,                                   // ZDiT publishes no real-time occupancy
    bicycleCounters: null,                           // no equivalent city feed
    bikeSharing: null                                // Łódzki Rower Publiczny was discontinued;
                                                     //   no active GBFS/public feed

  },

  warszawa: {
    name: 'Warszawa',
    // Administrative city bbox: Białołęka in the north down to Wilanów/Ursynów
    // in the south, Bemowo/Włochy west to Wesoła east.
    overpassBbox: '52.10,20.85,52.37,21.28',
    si2pemBbox: '20.85,52.10,21.28,52.37,EPSG:4326',
    gtfs: {
      // ZTM Warszawa / WTP doesn't publish a stable GTFS endpoint of its own;
      // mkuran.pl (Mikołaj Kuranowski) re-packages the official feed daily and
      // is the de-facto open source for Warsaw GTFS + GTFS-RT.
      // Includes tram (30), metro (M1/M2), SKM rail (S1–S40), and bus routes.
      staticUrl:    'https://mkuran.pl/gtfs/warsaw.zip',
      rtVehicles:   { url: 'https://mkuran.pl/gtfs/warsaw/vehicles.pb' },
      rtAlerts:     { url: 'https://mkuran.pl/gtfs/warsaw/alerts.pb' },
      // No public trip-updates feed — mkuran returns 404 for /trip-updates.pb
    },
    gios: {
      // Resolve dynamically on first request — Warsaw has 10+ GIOŚ stations
      // and the list changes occasionally as sensors come online / retire.
      stations: null,
      cityMatch: 'Warszawa'
    },
    hydro: {
      // Wisła basin around Warsaw. The bbox catches Warszawa-Bulwary
      // (downtown), Warszawa-Nadwilanówka (south), and any nearby Wisła
      // gauges (Wyszogród, Modlin) for context upstream/downstream.
      bbox: { south: 52.0, north: 52.5, west: 20.7, east: 21.4 },
      primaryStationMatch: 'Bulwary',
      // Official IMGW thresholds for Warszawa-Bulwary (id 152210170):
      // ostrzegawczy (warning) 600 cm, alarmowy (alarm) 650 cm.
      warningCm: 600,
      alarmCm: 650,
      riverLabel: 'Wisła'
    },
    // No public real-time SPPN occupancy feed (api.um.warszawa.pl requires
    // an apikey and has no key-less anonymous tier).
    parking: null,
    // Warsaw's Eco-Counter cycle counters live behind the same apikey-gated
    // api.um.warszawa.pl endpoint, so no key-less open feed.
    bicycleCounters: null,
    // Veturilo 3.0 / Nextbike Warsaw — 344 stations, mirrored on CityBikes.
    bikeSharing: 'veturilo'
  }
};

const DEFAULT_CITY = 'poznan';

function getCityKey(req) {
  const c = String(req.query.city || DEFAULT_CITY).toLowerCase();
  return CITIES[c] ? c : DEFAULT_CITY;
}

// ============================================================
// Static GTFS loading (per city)
// ============================================================

const GTFS_ROOT = path.join(__dirname, 'data', 'gtfs');
const GTFS_MAX_AGE_DAYS = 3;

function gtfsDir(city) {
  // Keep Poznań backward-compatible: its original dir is `data/gtfs` (flat).
  if (city === 'poznan') return GTFS_ROOT;
  return path.join(GTFS_ROOT, city);
}

function refreshGTFSIfNeeded(city) {
  const cfg = CITIES[city];
  if (!cfg || !cfg.gtfs || !cfg.gtfs.staticUrl) return;
  const dir = gtfsDir(city);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const tripsFile = path.join(dir, 'trips.txt');
    let needsRefresh = false;

    if (!fs.existsSync(tripsFile)) {
      console.log(`[GTFS:${city}] No trips.txt — downloading fresh data...`);
      needsRefresh = true;
    } else {
      const ageDays = (Date.now() - fs.statSync(tripsFile).mtimeMs) / (1000 * 60 * 60 * 24);
      if (ageDays > GTFS_MAX_AGE_DAYS) {
        console.log(`[GTFS:${city}] Data is ${Math.round(ageDays)} days old — refreshing...`);
        needsRefresh = true;
      } else {
        console.log(`[GTFS:${city}] Data is ${ageDays.toFixed(1)} days old — OK`);
      }
    }

    if (needsRefresh) {
      const tmpZip = path.join(__dirname, 'data', `gtfs_${city}_latest.zip`);
      console.log(`[GTFS:${city}] Downloading ${cfg.gtfs.staticUrl}`);
      execSync(`curl -sL -o "${tmpZip}" "${cfg.gtfs.staticUrl}"`, { timeout: 90000 });

      const zipSize = fs.statSync(tmpZip).size;
      if (zipSize < 100000) {
        console.warn(`[GTFS:${city}] Downloaded file too small (${zipSize}B), keeping old data`);
        fs.unlinkSync(tmpZip);
        return;
      }

      fs.readdirSync(dir).forEach(f => {
        if (f.endsWith('.txt')) fs.unlinkSync(path.join(dir, f));
      });
      execSync(`unzip -o "${tmpZip}" -d "${dir}"`, { timeout: 60000 });
      fs.unlinkSync(tmpZip);
      console.log(`[GTFS:${city}] Fresh data extracted`);
    }
  } catch (err) {
    console.warn(`[GTFS:${city}] Auto-refresh failed, using existing data:`, err.message);
  }
}

function readCSV(filepath) {
  const content = fs.readFileSync(filepath, 'utf-8').replace(/^\uFEFF/, '');
  return parse(content, { columns: true, skip_empty_lines: true, relax_column_count: true });
}

// Streaming variant for stop_times.txt — Warsaw's file is 526 MB / 7.75M rows,
// so an in-memory `parse()` would peak at multiple gigabytes building the
// intermediate object array. We walk the buffer line-by-line instead so only
// the source string and the caller's accumulated structure stay resident.
//
// GTFS spec stop_times.txt has no quoted fields (values are integers or trip-id
// strings without commas), so a plain split(',') is safe per spec.
function streamCSV(filepath, perRow) {
  const buf = fs.readFileSync(filepath, 'utf-8').replace(/^﻿/, '');
  const headerEnd = buf.indexOf('\n');
  if (headerEnd < 0) return;
  const header = buf.slice(0, headerEnd).replace(/\r$/, '').split(',');
  const cols = {};
  header.forEach((c, i) => { cols[c.trim()] = i; });
  let start = headerEnd + 1;
  const len = buf.length;
  while (start < len) {
    let end = buf.indexOf('\n', start);
    if (end < 0) end = len;
    const stop = (end > start && buf.charCodeAt(end - 1) === 13) ? end - 1 : end;
    if (stop > start) perRow(buf.slice(start, stop).split(','), cols);
    start = end + 1;
  }
}

function loadCityGTFS(city) {
  const dir = gtfsDir(city);
  if (!fs.existsSync(path.join(dir, 'trips.txt'))) {
    console.warn(`[GTFS:${city}] No static data available — transit endpoints will be empty.`);
    return null;
  }

  const read = f => readCSV(path.join(dir, f));

  const rawRoutes = read('routes.txt');
  const routesMap = {};
  const routes = rawRoutes.map(r => {
    const type = parseInt(r.route_type);
    const route = {
      id: r.route_id,
      shortName: (r.route_short_name || '').replace(/"/g, ''),
      longName:  (r.route_long_name  || '').replace(/"/g, ''),
      type,
      color:     '#' + (r.route_color || (type === 0 ? 'FF2244' : '00AAFF')),
      textColor: '#' + (r.route_text_color || 'FFFFFF')
    };
    routesMap[route.id] = route;
    return route;
  });
  const tramCt  = routes.filter(r => r.type === 0).length;
  const metroCt = routes.filter(r => r.type === 1).length;
  const railCt  = routes.filter(r => r.type === 2).length;
  const busCt   = routes.filter(r => r.type === 3).length;
  console.log(
    `[GTFS:${city}] ${routes.length} routes (` +
    `${tramCt} tram, ${busCt} bus` +
    (metroCt ? `, ${metroCt} metro` : '') +
    (railCt  ? `, ${railCt} rail`  : '') + `)`
  );

  const rawStops = read('stops.txt');
  const stopsMap = {};
  const stops = rawStops.map(s => {
    const stop = {
      id: s.stop_id,
      code: (s.stop_code || '').replace(/"/g, ''),
      name: (s.stop_name || '').replace(/"/g, ''),
      lat: parseFloat(s.stop_lat),
      lng: parseFloat(s.stop_lon),
      zone: s.zone_id
    };
    stopsMap[stop.id] = stop;
    return stop;
  });
  console.log(`[GTFS:${city}] ${stops.length} stops`);

  const rawTrips = read('trips.txt');
  const tripsMap = {};
  rawTrips.forEach(t => {
    tripsMap[(t.trip_id || '').replace(/"/g, '')] = {
      routeId: t.route_id,
      headsign: (t.trip_headsign || '').replace(/"/g, ''),
      directionId: parseInt(t.direction_id),
      shapeId: t.shape_id
    };
  });
  console.log(`[GTFS:${city}] ${Object.keys(tripsMap).length} trips`);

  const shapesById = {};
  const rawShapes = fs.existsSync(path.join(dir, 'shapes.txt')) ? read('shapes.txt') : [];
  rawShapes.forEach(s => {
    const id = s.shape_id;
    if (!shapesById[id]) shapesById[id] = [];
    shapesById[id].push({
      lat: parseFloat(s.shape_pt_lat),
      lng: parseFloat(s.shape_pt_lon),
      seq: parseInt(s.shape_pt_sequence)
    });
  });
  Object.values(shapesById).forEach(pts => pts.sort((a, b) => a.seq - b.seq));

  const routeShapes = {};
  rawTrips.forEach(t => {
    const shapeId = t.shape_id;
    const dir = parseInt(t.direction_id);
    if (!shapeId || !shapesById[shapeId]) return;
    const key = `${t.route_id}_${dir}`;
    if (!routeShapes[key]) routeShapes[key] = { routeId: t.route_id, directionId: dir, shapeId };
  });

  const routeGeoJSON = { type: 'FeatureCollection', features: [] };
  const addedShapes = new Set();
  Object.values(routeShapes).forEach(({ routeId, shapeId }) => {
    if (addedShapes.has(shapeId)) return;
    addedShapes.add(shapeId);
    const route = routesMap[routeId];
    const pts = shapesById[shapeId];
    if (!route || !pts || pts.length < 2) return;
    routeGeoJSON.features.push({
      type: 'Feature',
      properties: { routeId, shortName: route.shortName, type: route.type, color: route.color },
      geometry: { type: 'LineString', coordinates: pts.map(p => [p.lng, p.lat]) }
    });
  });
  console.log(`[GTFS:${city}] ${routeGeoJSON.features.length} route shapes`);

  // Per-trip stop sequences (used by the vehicle popup to show first/last stop
  // and the next-stop arrival time). Warsaw's stop_times.txt has 7.75M rows so
  // we (a) stream-parse it to avoid the giant intermediate array and (b) keep
  // only the fields we actually read — dropping `departure_time` halves the
  // per-row footprint.
  const tripStopTimes = {};
  const stopTimesPath = path.join(dir, 'stop_times.txt');
  if (fs.existsSync(stopTimesPath)) {
    streamCSV(stopTimesPath, (f, c) => {
      const tripId = (f[c.trip_id] || '').replace(/"/g, '');
      if (!tripStopTimes[tripId]) tripStopTimes[tripId] = [];
      tripStopTimes[tripId].push({
        stopId: f[c.stop_id],
        arrival: f[c.arrival_time],
        sequence: parseInt(f[c.stop_sequence])
      });
    });
    Object.values(tripStopTimes).forEach(arr => arr.sort((a, b) => a.sequence - b.sequence));
  }

  const routeTripCounts = {};
  rawTrips.forEach(t => { routeTripCounts[t.route_id] = (routeTripCounts[t.route_id] || 0) + 1; });
  const routeFrequency = {};
  Object.entries(routeTripCounts).forEach(([routeId, count]) => {
    routeFrequency[routeId] = Math.round(count / 2 / 18 * 10) / 10;
  });

  return { routes, routesMap, stops, stopsMap, tripsMap, tripStopTimes, routeFrequency, routeGeoJSON };
}

// Load GTFS for all cities with a staticUrl configured
const cityData = {};
for (const city of Object.keys(CITIES)) {
  if (!CITIES[city].gtfs || !CITIES[city].gtfs.staticUrl) continue;
  refreshGTFSIfNeeded(city);
  cityData[city] = loadCityGTFS(city);
}
console.log('[GTFS] All city data loaded.');

// ============================================================
// Static GTFS endpoints
// ============================================================

app.get('/api/routes', (req, res) => {
  const city = getCityKey(req);
  const d = cityData[city];
  if (!d) return res.json([]);
  res.json(d.routes);
});

app.get('/api/stops', (req, res) => {
  const city = getCityKey(req);
  const d = cityData[city];
  if (!d) return res.json({ type: 'FeatureCollection', features: [] });
  res.json({
    type: 'FeatureCollection',
    features: d.stops.map(s => ({
      type: 'Feature',
      properties: { id: s.id, name: s.name, code: s.code, zone: s.zone },
      geometry: { type: 'Point', coordinates: [s.lng, s.lat] }
    }))
  });
});

app.get('/api/shapes', (req, res) => {
  const city = getCityKey(req);
  const d = cityData[city];
  if (!d) return res.json({ type: 'FeatureCollection', features: [] });
  res.json(d.routeGeoJSON);
});

// ============================================================
// Real-time transit (GTFS-RT per city)
// ============================================================

async function fetchGtfsRT(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GTFS-RT fetch failed: ${response.status}`);
  const buffer = await response.arrayBuffer();
  return GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(new Uint8Array(buffer));
}

app.get('/api/vehicles', async (req, res) => {
  const city = getCityKey(req);
  const cfg = CITIES[city];
  const d = cityData[city];
  if (!cfg?.gtfs?.rtVehicles || !d) return res.json({ timestamp: Date.now(), vehicles: [] });

  try {
    const feed = await fetchGtfsRT(cfg.gtfs.rtVehicles.url);
    const vehicles = feed.entity.map(entity => {
      const vp = entity.vehicle;
      if (!vp || !vp.position) return null;

      const tripId = vp.trip?.tripId;
      const tripInfo = tripId ? d.tripsMap[tripId] : null;
      const routeId = vp.trip?.routeId || tripInfo?.routeId;
      const route = routeId ? d.routesMap[routeId] : null;

      let fromStop = null, toStop = null, nextStopArrival = null, nextStopName = null;
      if (tripId && d.tripStopTimes[tripId]) {
        const stSeq = d.tripStopTimes[tripId];
        if (stSeq.length > 0) {
          fromStop = d.stopsMap[stSeq[0].stopId]?.name || stSeq[0].stopId;
          toStop = d.stopsMap[stSeq[stSeq.length - 1].stopId]?.name || stSeq[stSeq.length - 1].stopId;
          const currentStopSeq = vp.currentStopSequence;
          if (currentStopSeq !== undefined && currentStopSeq !== null) {
            const nextSt = stSeq.find(s => s.sequence >= currentStopSeq);
            if (nextSt) {
              nextStopName = d.stopsMap[nextSt.stopId]?.name;
              nextStopArrival = nextSt.arrival;
            }
          }
        }
      }

      return {
        id: entity.id,
        lat: vp.position.latitude,
        lng: vp.position.longitude,
        bearing: vp.position.bearing || 0,
        speed: vp.position.speed || 0,
        tripId,
        routeId,
        routeShortName: route?.shortName || routeId,
        routeType: route?.type,
        routeColor: route?.color || '#00AAFF',
        headsign: tripInfo?.headsign || vp.trip?.routeId,
        currentStopSequence: vp.currentStopSequence,
        currentStatus: vp.currentStatus,
        timestamp: vp.timestamp ? parseInt(vp.timestamp) : null,
        from: fromStop,
        to: toStop,
        nextStop: nextStopName,
        nextStopArrival,
        frequency: routeId ? d.routeFrequency[routeId] : null
      };
    }).filter(Boolean);

    res.json({ timestamp: Date.now(), vehicles });
  } catch (err) {
    console.error(`[RT:${city}] Vehicle positions error:`, err.message);
    res.status(502).json({ error: 'Failed to fetch vehicle positions', message: err.message });
  }
});

app.get('/api/trip-updates', async (req, res) => {
  const city = getCityKey(req);
  const cfg = CITIES[city];
  const d = cityData[city];
  if (!cfg?.gtfs?.rtTripUpdates || !d) return res.json({ timestamp: Date.now(), updates: [] });

  try {
    const feed = await fetchGtfsRT(cfg.gtfs.rtTripUpdates.url);
    const updates = feed.entity.map(entity => {
      const tu = entity.tripUpdate;
      if (!tu) return null;
      const tripId = tu.trip?.tripId;
      const tripInfo = tripId ? d.tripsMap[tripId] : null;
      return {
        id: entity.id,
        tripId,
        routeId: tu.trip?.routeId || tripInfo?.routeId,
        delay: tu.delay,
        stopTimeUpdates: (tu.stopTimeUpdate || []).map(stu => ({
          stopId: stu.stopId,
          stopName: d.stopsMap[stu.stopId]?.name,
          arrival: stu.arrival ? {
            delay: stu.arrival.delay,
            time: stu.arrival.time ? parseInt(stu.arrival.time) : null
          } : null,
          departure: stu.departure ? {
            delay: stu.departure.delay,
            time: stu.departure.time ? parseInt(stu.departure.time) : null
          } : null
        }))
      };
    }).filter(Boolean);

    res.json({ timestamp: Date.now(), updates });
  } catch (err) {
    console.error(`[RT:${city}] Trip updates error:`, err.message);
    res.status(502).json({ error: 'Failed to fetch trip updates', message: err.message });
  }
});

// ============================================================
// Generic cache helper
// ============================================================

function makeCityCache(ttlMs) {
  const store = {};
  return {
    get(city) {
      const entry = store[city];
      if (entry && (Date.now() - entry.time < ttlMs)) return entry.data;
      return null;
    },
    set(city, data) {
      store[city] = { data, time: Date.now() };
    },
    raw(city) { return store[city]?.data || null; }
  };
}

// Overpass servers reject requests without an identifying User-Agent
// (undici's default UA triggers 406 Not Acceptable on overpass-api.de).
const OVERPASS_HEADERS = {
  'Content-Type': 'application/x-www-form-urlencoded',
  'Accept': 'application/json',
  'User-Agent': 'CivicPulse/1.0 (https://github.com/; contact: ops@civicpulse.local)'
};

async function overpassQuery(queryQL) {
  const mirrors = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.openstreetmap.ru/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter'
  ];
  const errors = [];
  for (const mirror of mirrors) {
    try {
      const resp = await fetch(mirror, {
        method: 'POST',
        headers: OVERPASS_HEADERS,
        body: `data=${encodeURIComponent(queryQL)}`
      });
      if (!resp.ok) { errors.push(`${mirror}: HTTP ${resp.status}`); continue; }
      const text = await resp.text();
      if (text.startsWith('<') || text.startsWith('<?xml')) { errors.push(`${mirror}: got HTML/XML`); continue; }
      return JSON.parse(text);
    } catch (e) { errors.push(`${mirror}: ${e.message}`); }
  }
  throw new Error(`All Overpass mirrors failed — ${errors.join(' | ')}`);
}

function staticFallback(filename) {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'data', filename), 'utf-8'));
  } catch { return null; }
}

// ============================================================
// Bicycle counters (Poznań only — no equivalent Łódź feed)
// ============================================================

app.get('/api/bicycle-counters', async (req, res) => {
  const city = getCityKey(req);
  if (CITIES[city].bicycleCounters !== 'poznan-eco-counter') {
    return res.json({ type: 'FeatureCollection', features: [] });
  }
  try {
    const response = await fetch('https://www.poznan.pl/mim/plan/map_service.html?mtype=cycling&co=eco_counter');
    if (!response.ok) throw new Error(`Bicycle counter fetch failed: ${response.status}`);
    const text = await response.text();
    res.json(JSON.parse(text));
  } catch (err) {
    console.error(`[RT:${city}] Bicycle counters error:`, err.message);
    res.status(502).json({ error: 'Failed to fetch bicycle counters', message: err.message });
  }
});

// ============================================================
// Bike-sharing (Łódź — Nextbike / Łódzki Rower Publiczny via CityBikes)
// CityBikes.org mirrors GBFS feeds for thousands of systems and is
// the most stable public endpoint. Data is real bike-station occupancy.
// ============================================================

const bikeSharingCache = makeCityCache(90 * 1000); // 90s — fresh enough

const BIKE_SHARING_SOURCES = {
  lodzkirowerpubliczny: 'https://api.citybik.es/v2/networks/lodzki-rower-publiczny',
  veturilo:             'https://api.citybik.es/v2/networks/veturilo-nextbike-warsaw'
};

app.get('/api/bike-sharing', async (req, res) => {
  const city = getCityKey(req);
  const key = CITIES[city].bikeSharing;
  if (!key || !BIKE_SHARING_SOURCES[key]) {
    return res.json({ type: 'FeatureCollection', features: [] });
  }
  const cached = bikeSharingCache.get(city);
  if (cached) return res.json(cached);

  try {
    const resp = await fetch(BIKE_SHARING_SOURCES[key]);
    if (!resp.ok) throw new Error(`CityBikes ${resp.status}`);
    const data = await resp.json();
    const network = data.network || {};
    const stations = network.stations || [];

    const features = stations.map(s => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [s.longitude, s.latitude] },
      properties: {
        stationId: s.id,
        name: s.name || '',
        emptySlots: s.empty_slots ?? null,
        freeBikes: s.free_bikes ?? null,
        totalSlots: (s.empty_slots != null && s.free_bikes != null) ? (s.empty_slots + s.free_bikes) : null,
        timestamp: s.timestamp || null,
        address: s.extra?.address || '',
        online: s.extra?.online ?? null,
        ebikes: s.extra?.ebikes ?? null,
        slots: s.extra?.slots ?? null,
        operator: network.name || '',
        networkId: network.id || key
      }
    }));

    const geojson = { type: 'FeatureCollection', features };
    bikeSharingCache.set(city, geojson);
    console.log(`[RT:${city}] Bike-sharing: ${features.length} stations (${network.name})`);
    res.json(geojson);
  } catch (err) {
    console.error(`[RT:${city}] Bike-sharing error:`, err.message);
    const cached = bikeSharingCache.raw(city);
    if (cached) return res.json(cached);
    res.status(502).json({ error: 'Failed to fetch bike-sharing data', message: err.message });
  }
});

// ============================================================
// EMF measurements (SI2PEM WFS — nationwide; per-city via bbox)
// ============================================================

app.get('/api/emf-measurements', async (req, res) => {
  const city = getCityKey(req);
  const bbox = CITIES[city].si2pemBbox;
  try {
    const url = `https://si2pem.gov.pl/geoserver/public/wfs?service=WFS&version=1.1.0&request=GetFeature&typeName=public:measures_all&outputFormat=application/json&bbox=${bbox}&maxFeatures=5000`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`SI2PEM WFS failed: ${response.status}`);
    res.json(await response.json());
  } catch (err) {
    console.error(`[RT:${city}] EMF measurements error:`, err.message);
    res.status(502).json({ error: 'Failed to fetch EMF data', message: err.message });
  }
});

// ============================================================
// Mobile base stations (SI2PEM WFS)
// ============================================================

function parseTechnologies(permitJson) {
  if (!permitJson) return [];
  try {
    const entries = typeof permitJson === 'string' ? JSON.parse(permitJson) : permitJson;
    const techCodes = [...new Set(entries.map(e => e.technology))];
    const standards = new Set();
    for (const code of techCodes) {
      if (code.startsWith('g5')) standards.add('5G NR');
      else if (code.startsWith('l')) standards.add('LTE');
      else if (code.startsWith('u')) standards.add('UMTS');
      else if (code.startsWith('g')) standards.add('GSM');
      else if (code.startsWith('i')) standards.add('LTE');
      else standards.add(code.toUpperCase());
    }
    return [...standards].sort((a, b) => {
      const order = { '5G NR': 0, 'LTE': 1, 'UMTS': 2, 'GSM': 3 };
      return (order[a] ?? 9) - (order[b] ?? 9);
    });
  } catch { return []; }
}

app.get('/api/base-stations', async (req, res) => {
  const city = getCityKey(req);
  const bbox = CITIES[city].si2pemBbox;
  try {
    const url = `https://si2pem.gov.pl/geoserver/public/wfs?service=WFS&version=1.1.0&request=GetFeature&typeName=public:extend_base_stations&outputFormat=application/json&bbox=${bbox}&maxFeatures=5000`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`SI2PEM WFS failed: ${response.status}`);
    const geojson = await response.json();
    geojson.features.forEach(f => {
      const p = f.properties;
      const techs = parseTechnologies(p.no_permit || p.permit);
      p.standards = techs;
      p.standardsDisplay = techs.length > 0 ? techs.join(' / ') : '—';
      p.has5G = techs.includes('5G NR');
      p.hasLTE = techs.includes('LTE');
    });
    res.json(geojson);
  } catch (err) {
    console.error(`[RT:${city}] Base stations error:`, err.message);
    res.status(502).json({ error: 'Failed to fetch base stations', message: err.message });
  }
});

// ============================================================
// Parking (Poznań only — Łódź has no real-time feed)
// ============================================================

const POZNAN_PARKINGS = {
  'Głogowska - przy dw. Zachodnim': { lng: 16.8985, lat: 52.4010, total: 42, type: 'buffer', address: 'ul. Głogowska (Dworzec Zachodni)' },
  'Reymonta':                        { lng: 16.8808, lat: 52.4158, total: 84, type: 'buffer', address: 'ul. Reymonta (Park Kasprowicza)' },
  'Maratońska':                      { lng: 16.8870, lat: 52.3945, total: 72, type: 'buffer', address: 'ul. Maratońska' },
  'biskupinska':                     { lng: 16.8528, lat: 52.4580, total: 50, type: 'P&R', address: 'ul. Biskupińska' },
  'staroleka':                       { lng: 16.9530, lat: 52.3870, total: 30, type: 'P&R', address: 'Rondo Starołęka' },
  'swmichala':                       { lng: 16.9300, lat: 52.4190, total: 10, type: 'P&R', address: 'ul. Św. Michała' },
  'Szymanowskiego':                  { lng: 16.8745, lat: 52.4230, total: 40, type: 'P&R', address: 'ul. Szymanowskiego' },
};

function parseCSVLine(line) { return line.replace(/"/g, '').split(';'); }

// ZTM's freeSpots column occasionally goes negative (e.g. swmichala has been
// observed at -4) — an entry/exit sensor over-counts and the running total
// drops below zero until the next manual sync. A negative free count is
// physically impossible, so treat any sub-zero value as "0 free / lot full".
function parseFreeSpots(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

function getLatestEntry(csvText) {
  const lines = csvText.trim().split('\n');
  if (lines.length < 2) return null;
  const last = parseCSVLine(lines[lines.length - 1]);
  return {
    timestamp: last[0],
    freeSpots: parseFreeSpots(last[1]),
    entering: parseInt(last[2], 10) || 0,
    leaving: parseInt(last[3], 10) || 0,
    name: last[4]
  };
}

app.get('/api/parking', async (req, res) => {
  const city = getCityKey(req);
  if (CITIES[city].parking !== 'ztm-poznan') {
    return res.json({ type: 'FeatureCollection', features: [] });
  }
  try {
    const bufferUrl = 'https://www.ztm.poznan.pl/pl/dla-deweloperow/getBuforParkingFile';
    const prFiles = [
      'ZTM_ParkAndRide__biskupinska.csv',
      'ZTM_ParkAndRide__rondo_staroleka.csv',
      'ZTM_ParkAndRide__swmichala.csv',
      'ZTM_ParkAndRide__szymanowskiego.csv',
    ];
    const fetches = [
      fetch(bufferUrl).then(r => r.text()),
      ...prFiles.map(f => fetch(`https://www.ztm.poznan.pl/pl/dla-deweloperow/getParkingFile/?file=${f}`).then(r => r.text()))
    ];
    const results = await Promise.allSettled(fetches);
    const features = [];

    if (results[0].status === 'fulfilled') {
      const lines = results[0].value.trim().split('\n');
      const latest = {};
      for (let i = 1; i < lines.length; i++) {
        const parts = parseCSVLine(lines[i]);
        const name = parts[4];
        latest[name] = {
          timestamp: parts[0],
          freeSpots: parseFreeSpots(parts[1]),
          entering: parseInt(parts[2], 10) || 0,
          leaving: parseInt(parts[3], 10) || 0,
          name
        };
      }
      for (const [name, entry] of Object.entries(latest)) {
        const meta = POZNAN_PARKINGS[name];
        if (!meta) continue;
        // Some P&R lots have grown since POZNAN_PARKINGS was written, so
        // ZTM's live freeSpots can exceed meta.total. Use the larger as
        // the effective capacity — keeps "free / total" internally consistent
        // and prevents negative `occupied` downstream.
        const total = Math.max(meta.total, entry.freeSpots);
        features.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [meta.lng, meta.lat] },
          properties: {
            name, freeSpots: entry.freeSpots, totalSpots: total,
            timestamp: entry.timestamp, parkingType: meta.type, address: meta.address,
            occupancy: total > 0 ? Math.max(0, Math.min(1, 1 - entry.freeSpots / total)) : 0
          }
        });
      }
    }

    for (let i = 0; i < prFiles.length; i++) {
      if (results[i + 1].status !== 'fulfilled') continue;
      const entry = getLatestEntry(results[i + 1].value);
      if (!entry) continue;
      const meta = POZNAN_PARKINGS[entry.name];
      if (!meta) continue;
      const total = Math.max(meta.total, entry.freeSpots);
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [meta.lng, meta.lat] },
        properties: {
          name: entry.name, freeSpots: entry.freeSpots, totalSpots: total,
          timestamp: entry.timestamp, parkingType: meta.type, address: meta.address,
          occupancy: total > 0 ? Math.max(0, Math.min(1, 1 - entry.freeSpots / total)) : 0
        }
      });
    }

    res.json({ type: 'FeatureCollection', features });
  } catch (err) {
    console.error(`[RT:${city}] Parking error:`, err.message);
    res.status(502).json({ error: 'Failed to fetch parking data', message: err.message });
  }
});

// ============================================================
// Tor relays (nationwide — not city-specific)
// ============================================================

let relayCache = null;
let relayCacheTime = 0;
const RELAY_CACHE_TTL = 30 * 60 * 1000;

async function batchGeolocate(ips) {
  const results = {};
  const batches = [];
  for (let i = 0; i < ips.length; i += 100) batches.push(ips.slice(i, i + 100));
  for (const batch of batches) {
    try {
      const body = batch.map(ip => ({ query: ip, fields: 'status,city,lat,lon' }));
      const resp = await fetch('http://ip-api.com/batch?fields=status,city,lat,lon', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
      const data = await resp.json();
      data.forEach((d, idx) => {
        if (d.status === 'success') results[batch[idx]] = { lat: d.lat, lng: d.lon, city: d.city };
      });
      if (batches.length > 1) await new Promise(r => setTimeout(r, 4500));
    } catch (e) {
      console.error('[RT] GeoIP batch error:', e.message);
    }
  }
  return results;
}

app.get('/api/tor', async (req, res) => {
  try {
    if (relayCache && (Date.now() - relayCacheTime < RELAY_CACHE_TTL)) return res.json(relayCache);

    const onionooUrl = 'https://onionoo.torproject.org/details?search=country:pl&fields=nickname,fingerprint,or_addresses,running,flags,as_name,observed_bandwidth,consensus_weight,contact,version,first_seen,last_seen,exit_policy_summary';
    const resp = await fetch(onionooUrl);
    if (!resp.ok) throw new Error(`Onionoo failed: ${resp.status}`);
    const data = await resp.json();
    const relays = data.relays.filter(r => r.running);
    const ipMap = {};
    relays.forEach(r => {
      const addr = r.or_addresses[0];
      const ip = addr.startsWith('[') ? addr.match(/\[([^\]]+)\]/)?.[1] : addr.split(':')[0];
      if (ip) ipMap[r.fingerprint] = ip;
    });
    const uniqueIPs = [...new Set(Object.values(ipMap))];
    console.log(`[RT] Geolocating ${uniqueIPs.length} relay IPs...`);
    const geoResults = await batchGeolocate(uniqueIPs);

    const features = [];
    for (const relay of relays) {
      const ip = ipMap[relay.fingerprint];
      const geo = geoResults[ip];
      if (!geo) continue;
      const flags = relay.flags || [];
      const bw = relay.observed_bandwidth || 0;
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [geo.lng, geo.lat] },
        properties: {
          nickname: relay.nickname,
          fingerprint: relay.fingerprint.substring(0, 8),
          ip,
          city: geo.city || '—',
          bandwidth: bw,
          bandwidthMB: Math.round(bw / 1024 / 1024 * 10) / 10,
          consensusWeight: relay.consensus_weight || 0,
          flags,
          isExit: flags.includes('Exit'),
          isGuard: flags.includes('Guard'),
          isFast: flags.includes('Fast'),
          isStable: flags.includes('Stable'),
          asName: relay.as_name || '—',
          version: relay.version || '—',
          firstSeen: relay.first_seen || '—',
          lastSeen: relay.last_seen || '—',
          contact: relay.contact || '—'
        }
      });
    }

    const geojson = { type: 'FeatureCollection', features };
    relayCache = geojson;
    relayCacheTime = Date.now();
    console.log(`[RT] Tor relays: ${features.length} geolocated`);
    res.json(geojson);
  } catch (err) {
    console.error('[RT] Tor relay error:', err.message);
    res.status(502).json({ error: 'Failed to fetch Tor relay data', message: err.message });
  }
});

// ============================================================
// Connection points — physical telecom street infrastructure
// (OSM / Overpass — per city). Covers explicit telecom=* tags
// plus telecom-categorised street cabinets and communication towers.
// ============================================================

const connectionPointsCache = makeCityCache(24 * 60 * 60 * 1000);

// OSM telecom=* values worth showing as discrete connection points
const TELECOM_VALUES = [
  'connection_point', 'exchange', 'data_center', 'service_device', 'distribution_point'
];

// Friendly type labels (uppercase token → human-readable)
const CP_TYPE_LABELS = {
  connection_point:    'Connection Point',
  exchange:            'Telephone Exchange',
  data_center:         'Data Center',
  service_device:      'Service Device',
  distribution_point:  'Distribution Point',
  street_cabinet:      'Street Cabinet',
  communication_tower: 'Comms Tower'
};

// Distance below which a `communication_tower` from OSM is considered the
// same physical structure as a SI2PEM base station and should be deduped.
// Polish urban cell towers are virtually never closer than 150m to each other,
// so 75m is a safe "same site" threshold even with mapping imprecision.
const TOWER_DEDUPE_RADIUS_M = 75;

// Cheap equirectangular distance (good to <1% under 100m at ~52°N).
// Avoids the haversine sqrt+trig for what's a tight-loop dedup check.
function approxMeters(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * 111_320;          // metres per degree latitude
  const dLon = (lon2 - lon1) * 68_500;           // ~52°N: 111320·cos(52°)
  return Math.sqrt(dLat * dLat + dLon * dLon);
}

// Pull just the SI2PEM base-station coordinates (no EMF/tech parsing needed).
// Returns [[lon, lat], ...]. Returns [] gracefully on failure so dedup
// just falls through and the connection-points endpoint still serves.
async function fetchBaseStationCoords(city) {
  const bbox = CITIES[city].si2pemBbox;
  const url = `https://si2pem.gov.pl/geoserver/public/wfs?service=WFS&version=1.1.0&request=GetFeature&typeName=public:extend_base_stations&outputFormat=application/json&bbox=${bbox}&maxFeatures=5000`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) return [];
    const data = await resp.json();
    return (data.features || [])
      .map(f => f.geometry?.coordinates)
      .filter(c => Array.isArray(c) && c.length >= 2);
  } catch { return []; }
}

app.get('/api/connection-points', async (req, res) => {
  const city = getCityKey(req);
  const bbox = CITIES[city].overpassBbox;
  try {
    const cached = connectionPointsCache.get(city);
    if (cached) return res.json(cached);

    // Three families of nodes/ways: explicit telecom tags, telecom street
    // cabinets, and communication towers. `nwr` so we catch ways/relations
    // (data centers, exchanges) and not just nodes.
    const ql = `[out:json][timeout:30];
(
  nwr["telecom"~"^(${TELECOM_VALUES.join('|')})$"](${bbox});
  nwr["man_made"="street_cabinet"]["street_cabinet"="telecom"](${bbox});
  nwr["man_made"="tower"]["tower:type"="communication"](${bbox});
);
out center tags;`;

    const data = await overpassQuery(ql);
    const features = [];
    for (const el of data.elements) {
      const tags = el.tags || {};
      // Use node coords or way/relation centroid
      const lat = el.lat ?? el.center?.lat;
      const lon = el.lon ?? el.center?.lon;
      if (!lat || !lon) continue;

      // Determine the "kind" — drives icon/color and label
      let kind;
      if (tags.telecom && TELECOM_VALUES.includes(tags.telecom)) {
        kind = tags.telecom;
      } else if (tags.man_made === 'street_cabinet') {
        kind = 'street_cabinet';
      } else if (tags.man_made === 'tower') {
        kind = 'communication_tower';
      } else {
        continue;
      }

      // Operators come from various tags
      const operator = tags.operator || tags['operator:short'] || tags.network || '';
      // Normalized join key for the same-operator network animation —
      // OSM contributors aren't consistent about case (e.g. "Netia" vs "netia"),
      // so collapse trivial variation. Empty string = no real operator data,
      // which means no animation will fire (honest "real data only" behavior).
      const operatorKey = operator.trim().toLowerCase();

      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [lon, lat] },
        properties: {
          osmId: `${el.type[0]}${el.id}`,           // n123, w456, r789
          kind,                                       // machine token
          kindLabel: CP_TYPE_LABELS[kind] || kind,    // human label
          name: tags.name || '',
          ref: tags.ref || tags['ref:telecom'] || '',
          operator,
          operatorKey,                                // normalized for grouping
          owner: tags.owner || '',
          note: tags.note || tags.description || '',
          // Address bits (any present)
          address: [tags['addr:street'], tags['addr:housenumber']].filter(Boolean).join(' '),
          // Tower-specific
          height: tags.height || '',
          // Telecom medium where tagged (fiber/copper)
          medium: tags['telecom:medium'] || tags.medium || ''
        }
      });
    }

    // Dedupe: drop OSM `communication_tower` features that overlap (within
    // TOWER_DEDUPE_RADIUS_M) with a cellular base station already shown by
    // the mobile layer. Other kinds (cabinets, exchanges, data centers, etc.)
    // are different infrastructure and stay even if they sit at a tower's base.
    const towerCoords = await fetchBaseStationCoords(city);
    let droppedTowers = 0;
    const deduped = features.filter(f => {
      if (f.properties.kind !== 'communication_tower') return true;
      const [lon, lat] = f.geometry.coordinates;
      const overlaps = towerCoords.some(
        ([blon, blat]) => approxMeters(lat, lon, blat, blon) < TOWER_DEDUPE_RADIUS_M
      );
      if (overlaps) droppedTowers++;
      return !overlaps;
    });

    const geojson = { type: 'FeatureCollection', features: deduped };
    connectionPointsCache.set(city, geojson);
    const towersKept = deduped.filter(f => f.properties.kind === 'communication_tower').length;
    console.log(
      `[RT:${city}] Connection points: ${deduped.length} kept` +
      ` (${droppedTowers} towers dropped as cellular dupes; ${towersKept} non-cellular towers retained)`
    );
    res.json(geojson);
  } catch (err) {
    console.error(`[RT:${city}] Connection points error:`, err.message);
    const cached = connectionPointsCache.raw(city);
    if (cached) return res.json(cached);
    res.status(502).json({ error: 'Failed to fetch connection-point data', message: err.message });
  }
});

// ============================================================
// Wi-Fi hotspots (OSM / Overpass — per city)
// ============================================================

const wifiCache = makeCityCache(60 * 60 * 1000);

app.get('/api/wifi', async (req, res) => {
  const city = getCityKey(req);
  const bbox = CITIES[city].overpassBbox;
  try {
    const cached = wifiCache.get(city);
    if (cached) return res.json(cached);

    const data = await overpassQuery(`[out:json][timeout:25];node["internet_access"="wlan"](${bbox});out body;`);
    const features = [];
    for (const el of data.elements) {
      const tags = el.tags || {};
      const lat = el.lat || el.center?.lat;
      const lon = el.lon || el.center?.lon;
      if (!lat || !lon) continue;
      const name = tags.name || tags.operator || 'Unknown';
      const ssid = tags['internet_access:ssid'] || '—';
      const fee = tags['internet_access:fee'] || 'unknown';
      const isFree = fee === 'no' || fee === 'free';
      const venueType = tags.amenity || tags.tourism || tags.shop || tags.leisure || tags.office || 'other';
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [lon, lat] },
        properties: {
          name, ssid, fee, isFree, venueType,
          operator: tags.operator || '—',
          address: [tags['addr:street'], tags['addr:housenumber']].filter(Boolean).join(' ') || '—',
          website: tags.website || '—',
          openingHours: tags.opening_hours || '—'
        }
      });
    }
    const geojson = { type: 'FeatureCollection', features };
    wifiCache.set(city, geojson);
    console.log(`[RT:${city}] WiFi: ${features.length} hotspots`);
    res.json(geojson);
  } catch (err) {
    console.error(`[RT:${city}] WiFi error:`, err.message);
    const cached = wifiCache.raw(city);
    if (cached) return res.json(cached);
    // Poznań has a static fallback; Łódź does not
    if (city === 'poznan') {
      const fallback = staticFallback('wifi_hotspots.json');
      if (fallback) { wifiCache.set(city, fallback); return res.json(fallback); }
    }
    res.status(502).json({ error: 'Failed to fetch WiFi data', message: err.message });
  }
});

// ============================================================
// Electricity grid (OSM / Overpass — per city)
// Substations, transformers, generators, plants, transmission
// towers and switchgear. Power infrastructure changes slowly,
// so a 24h cache mirrors connection-points / parcels.
// ============================================================

const electricityCache = makeCityCache(24 * 60 * 60 * 1000);

// OSM power=* values worth showing as discrete points. We deliberately
// skip `pole` (utility poles) — they're tagged in the millions and
// would swamp the map at city zoom without adding insight.
const POWER_VALUES = ['substation', 'transformer', 'generator', 'plant', 'tower', 'switch', 'portal'];

const POWER_TYPE_LABELS = {
  substation:  'Substation',
  transformer: 'Transformer',
  generator:   'Generator',
  plant:       'Power Plant',
  tower:       'Transmission Tower',
  switch:      'Switchgear',
  portal:      'Line Portal'
};

app.get('/api/electricity', async (req, res) => {
  const city = getCityKey(req);
  const bbox = CITIES[city].overpassBbox;
  try {
    const cached = electricityCache.get(city);
    if (cached) return res.json(cached);

    // `nwr` so we catch substations and plants mapped as ways/relations
    // (they're often large polygonal areas), with `out center` returning
    // a centroid we can render as a point.
    const ql = `[out:json][timeout:30];
(
  nwr["power"~"^(${POWER_VALUES.join('|')})$"](${bbox});
);
out center tags;`;

    const data = await overpassQuery(ql);
    const features = [];
    for (const el of data.elements) {
      const tags = el.tags || {};
      const lat = el.lat ?? el.center?.lat;
      const lon = el.lon ?? el.center?.lon;
      if (!lat || !lon) continue;

      const kind = tags.power;
      if (!POWER_VALUES.includes(kind)) continue;

      // Voltage is often a "/"-separated list when multiple buses share a
      // substation (e.g. "110000/15000"). Keep the raw string for display
      // and a numeric "max kV" for styling/sorting.
      const voltageRaw = tags.voltage || '';
      let voltageKv = null;
      if (voltageRaw) {
        const nums = voltageRaw.split(/[\/;,]/).map(s => parseInt(s, 10)).filter(Number.isFinite);
        if (nums.length) voltageKv = Math.round(Math.max(...nums) / 1000);
      }

      const operator = tags.operator || tags['operator:short'] || '';
      const operatorKey = operator.trim().toLowerCase();

      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [lon, lat] },
        properties: {
          osmId: `${el.type[0]}${el.id}`,
          kind,
          kindLabel: POWER_TYPE_LABELS[kind] || kind,
          name: tags.name || '',
          ref: tags.ref || '',
          operator,
          operatorKey,
          owner: tags.owner || '',
          voltage: voltageRaw,
          voltageKv,
          // Generator-specific
          source: tags['generator:source'] || tags['plant:source'] || '',
          method: tags['generator:method'] || '',
          output: tags['generator:output:electricity'] || tags['plant:output:electricity'] || '',
          // Substation/transformer extras
          substation: tags.substation || '',
          frequency: tags.frequency || '',
          // Address bits (any present)
          address: [tags['addr:street'], tags['addr:housenumber']].filter(Boolean).join(' '),
          // Tower-specific
          height: tags.height || '',
          structure: tags.structure || tags['tower:type'] || ''
        }
      });
    }

    const geojson = { type: 'FeatureCollection', features };
    electricityCache.set(city, geojson);

    const counts = {};
    features.forEach(f => { counts[f.properties.kind] = (counts[f.properties.kind] || 0) + 1; });
    const breakdown = Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ');
    console.log(`[RT:${city}] Electricity: ${features.length} nodes (${breakdown || 'none'})`);
    res.json(geojson);
  } catch (err) {
    console.error(`[RT:${city}] Electricity error:`, err.message);
    const cached = electricityCache.raw(city);
    if (cached) return res.json(cached);
    res.status(502).json({ error: 'Failed to fetch electricity data', message: err.message });
  }
});

// ============================================================
// Environmental sensors (GIOŚ — Poznań hardcoded, Łódź dynamic lookup)
// ============================================================

const GIOS_BASE = 'https://api.gios.gov.pl/pjp-api/v1/rest';
const envCache = makeCityCache(30 * 60 * 1000);

const AQ_NAMES = {
  'Bardzo dobry': 'Very Good',
  'Dobry': 'Good',
  'Umiarkowany': 'Moderate',
  'Dostateczny': 'Sufficient',
  'Zły': 'Bad',
  'Bardzo zły': 'Very Bad',
  'Brak indeksu': 'No Index'
};

async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`GIOŚ ${r.status}`);
  return r.json();
}

// Dynamically resolve stations when not pre-populated.
// GIOŚ findAll is paginated; walk all pages and filter by city name.
async function resolveGiosStationsForCity(cityKey) {
  const cfg = CITIES[cityKey];
  if (cfg.gios.stations) return cfg.gios.stations;
  const cityMatch = cfg.gios.cityMatch;
  if (!cityMatch) return [];

  const stations = [];
  let page = 0;
  const maxPages = 20;
  try {
    while (page < maxPages) {
      const url = `${GIOS_BASE}/station/findAll?page=${page}&size=500`;
      const json = await fetchJSON(url);
      const items = json['Lista stacji pomiarowych'] || [];
      for (const s of items) {
        const cityName = s['Nazwa miasta'] || s['Miasto']?.['Nazwa miasta'] || '';
        if (cityName && cityName.toLowerCase().includes(cityMatch.toLowerCase())) {
          // GIOŚ field names vary; current schema uses the short "φ N" / "λ E"
          // form. Fall back to the older "geograficzna" labels just in case.
          const lat = parseFloat(s['WGS84 φ N'] ?? s['WGS84 φ geograficzna']);
          const lng = parseFloat(s['WGS84 λ E'] ?? s['WGS84 λ geograficzna']);
          if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
          // Avoid "Łódź, Łódź, ul. Czernika" — only prepend cityMatch if the
          // station name doesn't already contain it.
          const rawName = (s['Nazwa stacji'] || s['Ulica'] || '').trim();
          const fullName = rawName.toLowerCase().includes(cityMatch.toLowerCase())
            ? rawName
            : `${cityMatch}, ${rawName}`;
          stations.push({
            id: s['Identyfikator stacji'],
            name: fullName,
            lat,
            lng,
            address: s['Ulica'] || ''
          });
        }
      }
      const total = json.totalElements || json.totalCount || (page + 1) * 500;
      page++;
      if (page * 500 >= total) break;
      if (items.length === 0) break;
    }
    cfg.gios.stations = stations;
    console.log(`[GIOŚ:${cityKey}] Resolved ${stations.length} stations for "${cityMatch}"`);
  } catch (err) {
    console.error(`[GIOŚ:${cityKey}] Station resolution failed:`, err.message);
  }
  return stations;
}

app.get('/api/environment', async (req, res) => {
  const city = getCityKey(req);
  try {
    const cached = envCache.get(city);
    if (cached) return res.json(cached);

    const stationList = await resolveGiosStationsForCity(city);
    const features = [];

    for (const station of stationList) {
      try {
        const [sensorsResp, indexResp] = await Promise.allSettled([
          fetchJSON(`${GIOS_BASE}/station/sensors/${station.id}`),
          fetchJSON(`${GIOS_BASE}/aqindex/getIndex/${station.id}`)
        ]);

        const sensors = sensorsResp.status === 'fulfilled'
          ? (sensorsResp.value['Lista stanowisk pomiarowych dla podanej stacji'] || [])
          : [];

        const readings = {};
        const keySensors = sensors.filter(s => ['PM10', 'PM2.5', 'NO2', 'SO2', 'O3', 'CO', 'C6H6'].includes(s['Wskaźnik - wzór']));
        const dataResults = await Promise.allSettled(keySensors.map(s =>
          fetchJSON(`${GIOS_BASE}/data/getData/${s['Identyfikator stanowiska']}?size=5`)
            .then(d => ({ sensor: s, data: d }))
        ));

        for (const r of dataResults) {
          if (r.status !== 'fulfilled' || !r.value) continue;
          const { sensor, data } = r.value;
          const values = data['Lista danych pomiarowych'] || [];
          const latest = values.find(v => v['Wartość'] !== null);
          if (latest) {
            const code = sensor['Wskaźnik - wzór'];
            readings[code] = {
              value: latest['Wartość'],
              date: latest['Data'],
              unit: code === 'CO' ? 'mg/m³' : 'µg/m³',
              name: sensor['Wskaźnik']
            };
          }
        }

        let aqIndex = null;
        if (indexResp.status === 'fulfilled') {
          const aq = indexResp.value.AqIndex || {};
          const catPl = aq['Nazwa kategorii indeksu'] || 'Brak indeksu';
          aqIndex = {
            value: aq['Wartość indeksu'],
            category: AQ_NAMES[catPl] || catPl,
            categoryPl: catPl,
            calcDate: aq['Data wykonania obliczeń indeksu'],
            pm10: aq['Nazwa kategorii indeksu dla wskażnika PM10'] ? AQ_NAMES[aq['Nazwa kategorii indeksu dla wskażnika PM10']] : null,
            pm25: aq['Nazwa kategorii indeksu dla wskażnika PM2.5'] ? AQ_NAMES[aq['Nazwa kategorii indeksu dla wskażnika PM2.5']] : null,
            no2: aq['Nazwa kategorii indeksu dla wskażnika NO2'] ? AQ_NAMES[aq['Nazwa kategorii indeksu dla wskażnika NO2']] : null,
            o3: aq['Nazwa kategorii indeksu dla wskażnika O3'] ? AQ_NAMES[aq['Nazwa kategorii indeksu dla wskażnika O3']] : null,
            so2: aq['Nazwa kategorii indeksu dla wskażnika SO2'] ? AQ_NAMES[aq['Nazwa kategorii indeksu dla wskażnika SO2']] : null,
          };
        }

        let qualityLevel = -1;
        if (aqIndex && aqIndex.value !== null && aqIndex.value >= 0) qualityLevel = aqIndex.value;

        features.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [station.lng, station.lat] },
          properties: {
            stationId: station.id,
            name: station.name,
            address: station.address,
            readings,
            aqIndex,
            qualityLevel,
            sensorCount: keySensors.length
          }
        });
      } catch (e) {
        console.error(`[RT:${city}] Env station ${station.id} error:`, e.message);
      }
    }

    const geojson = { type: 'FeatureCollection', features };
    envCache.set(city, geojson);
    console.log(`[RT:${city}] Environment: ${features.length} stations with readings`);
    res.json(geojson);
  } catch (err) {
    console.error(`[RT:${city}] Environment error:`, err.message);
    const cached = envCache.raw(city);
    if (cached) return res.json(cached);
    res.status(502).json({ error: 'Failed to fetch environment data', message: err.message });
  }
});

// ============================================================
// Parcel lockers (OSM / Overpass — per city)
// ============================================================

const parcelCache = makeCityCache(24 * 60 * 60 * 1000);

const BRAND_NORMALIZE = {
  'Paczkomat InPost': 'InPost', 'dpd': 'DPD', 'DPD Pickup Station': 'DPD',
  'Allegro One Box': 'Allegro', 'Allegro Onebox': 'Allegro',
  'DHL BOX 24/7': 'DHL', 'DHL POP BOX': 'DHL',
  'Poczta Polska Spółka Akcyjna': 'Poczta Polska', 'Pocztex': 'Poczta Polska'
};

app.get('/api/parcels', async (req, res) => {
  const city = getCityKey(req);
  const bbox = CITIES[city].overpassBbox;
  try {
    const cached = parcelCache.get(city);
    if (cached) return res.json(cached);

    const data = await overpassQuery(`[out:json][timeout:25];node["amenity"="parcel_locker"](${bbox});out body;`);
    const features = data.elements.map(e => {
      const tags = e.tags || {};
      let brand = tags.operator || tags.brand || 'Unknown';
      brand = BRAND_NORMALIZE[brand] || brand;
      return {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [e.lon, e.lat] },
        properties: {
          name: tags.name || tags.ref || brand,
          ref: tags.ref || '',
          brand,
          operator: tags.operator || '',
          address: [tags['addr:street'], tags['addr:housenumber']].filter(Boolean).join(' ') || '',
          openingHours: tags.opening_hours || '24/7',
          website: tags.website || ''
        }
      };
    });
    const geojson = { type: 'FeatureCollection', features };
    parcelCache.set(city, geojson);
    console.log(`[RT:${city}] Parcels: ${features.length} lockers`);
    res.json(geojson);
  } catch (err) {
    console.error(`[RT:${city}] Parcels error:`, err.message);
    const cached = parcelCache.raw(city);
    if (cached) return res.json(cached);
    if (city === 'poznan') {
      const fb = staticFallback('parcel_lockers.json');
      if (fb) { parcelCache.set(city, fb); return res.json(fb); }
    }
    res.status(502).json({ error: 'Failed to fetch parcel data', message: err.message });
  }
});

// ============================================================
// Emergency services (OSM / Overpass — per city)
// ============================================================

const emergencyCache = makeCityCache(24 * 60 * 60 * 1000);

app.get('/api/emergency', async (req, res) => {
  const city = getCityKey(req);
  const bbox = CITIES[city].overpassBbox;
  try {
    const cached = emergencyCache.get(city);
    if (cached) return res.json(cached);

    const q = `[out:json][timeout:25];(node["amenity"="fire_station"](${bbox});node["amenity"="police"](${bbox});node["amenity"="hospital"](${bbox});node["emergency"="ambulance_station"](${bbox});way["amenity"="fire_station"](${bbox});way["amenity"="police"](${bbox});way["amenity"="hospital"](${bbox}););out center body;`;
    const data = await overpassQuery(q);
    const features = data.elements.map(e => {
      const tags = e.tags || {};
      const lat = e.lat || e.center?.lat;
      const lon = e.lon || e.center?.lon;
      if (!lat || !lon) return null;
      const amenity = tags.amenity || tags.emergency || '';
      let serviceType = 'other';
      if (amenity === 'fire_station') serviceType = 'fire';
      else if (amenity === 'police') serviceType = 'police';
      else if (amenity === 'hospital') serviceType = 'hospital';
      else if (amenity === 'ambulance_station') serviceType = 'ambulance';
      return {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [lon, lat] },
        properties: {
          name: tags.name || '',
          serviceType,
          address: [tags['addr:street'], tags['addr:housenumber']].filter(Boolean).join(' ') || '',
          phone: tags.phone || '',
          website: tags.website || '',
          openingHours: tags.opening_hours || '',
          operator: tags.operator || '',
          emergencyPhone: tags['emergency:phone'] || ''
        }
      };
    }).filter(Boolean);
    const geojson = { type: 'FeatureCollection', features };
    emergencyCache.set(city, geojson);
    console.log(`[RT:${city}] Emergency: ${features.length} services`);
    res.json(geojson);
  } catch (err) {
    console.error(`[RT:${city}] Emergency error:`, err.message);
    const cached = emergencyCache.raw(city);
    if (cached) return res.json(cached);
    if (city === 'poznan') {
      const fb = staticFallback('emergency_services.json');
      if (fb) { emergencyCache.set(city, fb); return res.json(fb); }
    }
    res.status(502).json({ error: 'Failed to fetch emergency data', message: err.message });
  }
});

// ============================================================
// CCTV cameras (OSM / Overpass — per city)
// ============================================================

const cctvCache = makeCityCache(24 * 60 * 60 * 1000);

app.get('/api/cctv', async (req, res) => {
  const city = getCityKey(req);
  const bbox = CITIES[city].overpassBbox;
  try {
    const cached = cctvCache.get(city);
    if (cached) return res.json(cached);

    const data = await overpassQuery(`[out:json][timeout:25];node["man_made"="surveillance"](${bbox});out body;`);
    const features = data.elements.map(e => {
      const tags = e.tags || {};
      if (!e.lat || !e.lon) return null;
      return {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [e.lon, e.lat] },
        properties: {
          cameraType: tags['camera:type'] || 'unknown',
          mount: tags['camera:mount'] || 'unknown',
          zone: tags['surveillance:zone'] || 'unknown',
          surveillance: tags.surveillance || 'unknown',
          direction: tags.direction || '',
          operator: tags.operator || '',
          description: tags.description || ''
        }
      };
    }).filter(Boolean);
    const geojson = { type: 'FeatureCollection', features };
    cctvCache.set(city, geojson);
    console.log(`[RT:${city}] CCTV: ${features.length} cameras`);
    res.json(geojson);
  } catch (err) {
    console.error(`[RT:${city}] CCTV error:`, err.message);
    const cached = cctvCache.raw(city);
    if (cached) return res.json(cached);
    if (city === 'poznan') {
      const fb = staticFallback('cctv_cameras.json');
      if (fb) { cctvCache.set(city, fb); return res.json(fb); }
    }
    res.status(502).json({ error: 'Failed to fetch CCTV data', message: err.message });
  }
});

// ============================================================
// Traffic lights (OSM / Overpass — per city)
// ============================================================

const trafficLightsCache = makeCityCache(24 * 60 * 60 * 1000);

app.get('/api/traffic-lights', async (req, res) => {
  const city = getCityKey(req);
  const bbox = CITIES[city].overpassBbox;
  try {
    const cached = trafficLightsCache.get(city);
    if (cached) return res.json(cached);

    const data = await overpassQuery(`[out:json][timeout:25];node["highway"="traffic_signals"](${bbox});out body;`);
    const features = data.elements.map(e => {
      const tags = e.tags || {};
      if (!e.lat || !e.lon) return null;
      return {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [e.lon, e.lat] },
        properties: {
          signalType: tags.traffic_signals || 'standard',
          direction: tags['traffic_signals:direction'] || tags.direction || '',
          crossing: tags.crossing || '',
          buttonOperated: tags.button_operated || '',
          sound: tags['traffic_signals:sound'] || '',
          radar: tags.radar || ''
        }
      };
    }).filter(Boolean);
    const geojson = { type: 'FeatureCollection', features };
    trafficLightsCache.set(city, geojson);
    console.log(`[RT:${city}] Traffic lights: ${features.length} signals`);
    res.json(geojson);
  } catch (err) {
    console.error(`[RT:${city}] Traffic lights error:`, err.message);
    const cached = trafficLightsCache.raw(city);
    if (cached) return res.json(cached);
    if (city === 'poznan') {
      const fb = staticFallback('traffic_lights.json');
      if (fb) { trafficLightsCache.set(city, fb); return res.json(fb); }
    }
    res.status(502).json({ error: 'Failed to fetch traffic lights data', message: err.message });
  }
});

// ============================================================
// ATMs (OSM / Overpass — per city)
// ============================================================

const atmCache = makeCityCache(24 * 60 * 60 * 1000);

const ATM_OP_NORMALIZE = {
  'PKO': 'PKO BP', 'PKO Bank Polski': 'PKO BP', 'PKO Bank Polski S.A.': 'PKO BP',
  'Santander Bank': 'Santander', 'Santander Bank Polska': 'Santander',
  'Planet': 'Planet Cash', 'Bank Millennium S.A.': 'Bank Millennium',
  'eCard': 'Planet Cash'
};

app.get('/api/atms', async (req, res) => {
  const city = getCityKey(req);
  const bbox = CITIES[city].overpassBbox;
  try {
    const cached = atmCache.get(city);
    if (cached) return res.json(cached);

    const data = await overpassQuery(`[out:json][timeout:25];node["amenity"="atm"](${bbox});out body;`);
    const features = data.elements.map(e => {
      const t = e.tags || {};
      if (!e.lat || !e.lon) return null;
      let operator = t.operator || t.brand || '';
      operator = ATM_OP_NORMALIZE[operator] || operator;
      return {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [e.lon, e.lat] },
        properties: {
          operator,
          network: t.network || '',
          brand: t.brand || '',
          name: t.name || '',
          address: [t['addr:street'], t['addr:housenumber']].filter(Boolean).join(' ') || '',
          cashIn: t.cash_in || '',
          currency: t.currency || 'PLN',
          openingHours: t.opening_hours || '24/7',
          fee: t.fee || '',
          indoor: t.indoor || ''
        }
      };
    }).filter(Boolean);
    const geojson = { type: 'FeatureCollection', features };
    atmCache.set(city, geojson);
    console.log(`[RT:${city}] ATMs: ${features.length} machines`);
    res.json(geojson);
  } catch (err) {
    console.error(`[RT:${city}] ATMs error:`, err.message);
    const cached = atmCache.raw(city);
    if (cached) return res.json(cached);
    if (city === 'poznan') {
      const fb = staticFallback('atm_locations.json');
      if (fb) { atmCache.set(city, fb); return res.json(fb); }
    }
    res.status(502).json({ error: 'Failed to fetch ATM data', message: err.message });
  }
});

// ============================================================
// Advertising billboards (OSM / Overpass — per city)
// Digital outdoor advertising only — LED screens and animated
// surfaces. Static billboards/posters/columns are excluded by
// design (the previous mixed-mode layer rendered fine for
// Poznań but timed out the Overpass query for the larger
// Łódź / Warszawa bboxes; narrowing to digital keeps the layer
// useful while staying well inside Overpass query limits).
// ============================================================

const billboardCache = makeCityCache(24 * 60 * 60 * 1000);

// OSM advertising=* values we'll still surface IF they're flagged digital
// (animated=yes or advertising:type=digital). `screen` is digital by definition.
const ADVERTISING_VALUES = [
  'billboard', 'board', 'column', 'poster_box',
  'screen', 'sign', 'totem', 'wall_painting', 'flag', 'tarp'
];

const ADVERTISING_TYPE_LABELS = {
  billboard:     'Digital Billboard',
  board:         'Digital Board',
  column:        'Digital Column',
  poster_box:    'Digital Poster Box',
  screen:        'Digital Screen',
  sign:          'Digital Sign',
  totem:         'Digital Totem',
  wall_painting: 'Digital Wall Display',
  flag:          'Digital Flag',
  tarp:          'Digital Tarp'
};

// Common Polish outdoor-advertising operators — normalize OSM-tagged variants.
const BILLBOARD_OP_NORMALIZE = {
  'AMS S.A.': 'AMS', 'AMS Spółka Akcyjna': 'AMS',
  'Stroer': 'Ströer', 'Stroer Polska': 'Ströer', 'Ströer Polska': 'Ströer',
  'Clear Channel Poland': 'Clear Channel',
  'JCDecaux Polska': 'JCDecaux',
  'Cityboard Media Sp. z o.o.': 'Cityboard'
};

app.get('/api/billboards', async (req, res) => {
  const city = getCityKey(req);
  const bbox = CITIES[city].overpassBbox;
  try {
    const cached = billboardCache.get(city);
    if (cached) return res.json(cached);

    // Three families of digital ads:
    //   - advertising=screen      (LED screen — digital by definition)
    //   - any advertising=* with animated=yes
    //   - any advertising=* with advertising:type=digital
    // `nwr` catches both point-tagged screens and screen ways/relations.
    const valuePattern = `^(${ADVERTISING_VALUES.join('|')})$`;
    const ql = `[out:json][timeout:25];
(
  nwr["advertising"="screen"](${bbox});
  nwr["advertising"~"${valuePattern}"]["animated"="yes"](${bbox});
  nwr["advertising"~"${valuePattern}"]["advertising:type"="digital"](${bbox});
);
out center tags;`;

    const data = await overpassQuery(ql);
    const features = [];
    for (const el of data.elements) {
      const tags = el.tags || {};
      const lat = el.lat ?? el.center?.lat;
      const lon = el.lon ?? el.center?.lon;
      if (!lat || !lon) continue;

      const kind = tags.advertising;
      if (!ADVERTISING_VALUES.includes(kind)) continue;

      // Defense-in-depth digital filter — even if Overpass returns something
      // unexpected, drop anything that isn't clearly digital. This is the
      // contract this endpoint promises: digital only.
      const isDigital = kind === 'screen'
        || tags.animated === 'yes'
        || tags['advertising:type'] === 'digital';
      if (!isDigital) continue;

      let operator = tags.operator || tags.owner || tags.brand || '';
      operator = BILLBOARD_OP_NORMALIZE[operator] || operator;
      const operatorKey = operator.trim().toLowerCase();

      // `lit=yes` / `lit=24/7` / `lit=automatic` all indicate illumination.
      // Digital screens are de facto illuminated, but the OSM `lit` tag is
      // independent — preserve it when present.
      const litRaw = (tags.lit || '').toLowerCase();
      const isLit = litRaw && litRaw !== 'no' && litRaw !== 'unknown';

      // `sides=2` is two-sided, `sides=1` single-sided. Default unknown.
      const sidesRaw = parseInt(tags.sides, 10);
      const sides = Number.isFinite(sidesRaw) ? sidesRaw : null;

      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [lon, lat] },
        properties: {
          osmId: `${el.type[0]}${el.id}`,
          kind,
          kindLabel: ADVERTISING_TYPE_LABELS[kind] || kind,
          name: tags.name || '',
          ref: tags.ref || '',
          operator,
          operatorKey,
          owner: tags.owner || '',
          brand: tags.brand || '',
          // Physical descriptors
          height: tags.height || '',
          width: tags.width || '',
          material: tags.material || '',
          structure: tags.support || tags.structure || '',
          sides,
          // Display attributes — every feature here is digital by contract.
          isLit,
          litMode: litRaw,
          isDigital: true,
          message: tags.message || tags.description || '',
          // Address bits
          address: [tags['addr:street'], tags['addr:housenumber']].filter(Boolean).join(' '),
          startDate: tags.start_date || ''
        }
      });
    }

    const geojson = { type: 'FeatureCollection', features };
    billboardCache.set(city, geojson);

    const counts = {};
    features.forEach(f => { counts[f.properties.kind] = (counts[f.properties.kind] || 0) + 1; });
    const breakdown = Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ');
    console.log(`[RT:${city}] Billboards (digital): ${features.length} structures (${breakdown || 'none'})`);
    res.json(geojson);
  } catch (err) {
    console.error(`[RT:${city}] Billboards error:`, err.message);
    const cached = billboardCache.raw(city);
    if (cached) return res.json(cached);
    res.status(502).json({ error: 'Failed to fetch billboard data', message: err.message });
  }
});

// ============================================================
// River hydro (IMGW — Warta for Poznań; Łódź has no in-city river)
// ============================================================

const hydroCache = makeCityCache(10 * 60 * 1000);
const IMGW_HYDRO_URL = 'https://danepubliczne.imgw.pl/api/data/hydro/';

app.get('/api/hydro', async (req, res) => {
  const city = getCityKey(req);
  const cfg = CITIES[city].hydro;
  if (!cfg) return res.json({ timestamp: Date.now(), stations: [], primary: null });

  try {
    const cached = hydroCache.get(city);
    if (cached) return res.json(cached);

    const resp = await fetch(IMGW_HYDRO_URL);
    if (!resp.ok) throw new Error('IMGW API returned ' + resp.status);
    const allStations = await resp.json();

    const nearby = allStations.filter(s => {
      if (!s.lat || !s.lon) return false;
      const lat = parseFloat(s.lat), lon = parseFloat(s.lon);
      return lat > cfg.bbox.south && lat < cfg.bbox.north && lon > cfg.bbox.west && lon < cfg.bbox.east;
    });

    const stations = nearby.map(s => ({
      id: s.id_stacji,
      name: s.stacja,
      river: s.rzeka,
      lat: parseFloat(s.lat),
      lon: parseFloat(s.lon),
      waterLevel: s.stan_wody ? parseInt(s.stan_wody) : null,
      waterLevelTime: s.stan_wody_data_pomiaru,
      waterTemp: s.temperatura_wody ? parseFloat(s.temperatura_wody) : null,
      waterTempTime: s.temperatura_wody_data_pomiaru,
      flow: s.przeplyw ? parseFloat(s.przeplyw) : null,
      flowTime: s.przeplyw_data,
      warningLevel: cfg.primaryStationMatch && s.stacja.includes(cfg.primaryStationMatch) ? cfg.warningCm : null,
      alarmLevel: cfg.primaryStationMatch && s.stacja.includes(cfg.primaryStationMatch) ? cfg.alarmCm : null,
      iceEvent: s.zjawisko_lodowe
    }));

    let primary = null;
    if (cfg.primaryStationMatch) primary = stations.find(s => s.name.includes(cfg.primaryStationMatch));
    if (!primary) primary = stations.find(s => s.river && s.river.toLowerCase().includes(cfg.riverLabel.toLowerCase())) || stations[0] || null;

    const result = { timestamp: Date.now(), stations, primary, riverLabel: cfg.riverLabel };
    hydroCache.set(city, result);

    if (primary) {
      console.log(`[RT:${city}] Hydro: ${cfg.riverLabel} @ ${primary.name} = ${primary.waterLevel}cm, flow ${primary.flow}m³/s`);
    } else {
      console.log(`[RT:${city}] Hydro: ${stations.length} stations in bbox (${cfg.riverLabel})`);
    }
    res.json(result);
  } catch (err) {
    console.error(`[RT:${city}] Hydro error:`, err.message);
    const cached = hydroCache.raw(city);
    if (cached) return res.json(cached);
    res.status(502).json({ error: 'Failed to fetch hydro data', message: err.message });
  }
});

// ============================================================
// SPA fallback — serve index.html for non-API routes (production)
// ============================================================
const distIndex = path.join(__dirname, 'dist', 'index.html');
if (fs.existsSync(distIndex)) {
  app.get('{*path}', (req, res) => {
    res.sendFile(distIndex);
  });
}

// ============================================================
// Start server
// ============================================================

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n[CivicPulse] CivicPulse multi-city proxy on http://localhost:${PORT}`);
  console.log('[CivicPulse] Cities:', Object.keys(CITIES).map(c => `${c} (${CITIES[c].name})`).join(', '));
  console.log(`[CivicPulse] Append ?city=<key> to any endpoint; default = ${DEFAULT_CITY}.`);
  console.log('[CivicPulse] Endpoints:');
  [
    '/api/routes', '/api/stops', '/api/shapes',
    '/api/vehicles', '/api/trip-updates',
    '/api/bicycle-counters', '/api/bike-sharing',
    '/api/emf-measurements', '/api/base-stations',
    '/api/parking', '/api/tor', '/api/connection-points', '/api/wifi',
    '/api/environment', '/api/parcels', '/api/emergency',
    '/api/cctv', '/api/traffic-lights', '/api/atms', '/api/hydro'
  ].forEach(e => console.log(`  GET ${e}`));
  console.log('');
});
