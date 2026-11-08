// Clients for the public FOSSGIS routing servers (OpenStreetMap data):
//   OSRM foot profile  https://routing.openstreetmap.de/
//   Valhalla           https://valhalla1.openstreetmap.de/  (configurable costing per request)
// Both are free for light use; requests are throttled to stay polite.

const OSRM_FOOT = 'https://routing.openstreetmap.de/routed-foot/route/v1/foot/';
const VALHALLA = 'https://valhalla1.openstreetmap.de/route';

// ---- simple concurrency limiter
const MAX_CONCURRENT = 4;
let active = 0;
const queue = [];
function limited(fn) {
  return new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); pump(); });
}
function pump() {
  while (active < MAX_CONCURRENT && queue.length) {
    const { fn, resolve, reject } = queue.shift();
    active++;
    fn().then(resolve, reject).finally(() => { active--; pump(); });
  }
}

async function getJson(url) {
  const res = await fetch(url);
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON error page */ }
  return { ok: res.ok, status: res.status, json };
}

/** Decode a Valhalla polyline (precision 6) into [{lat, lng}]. */
export function decodePolyline6(str) {
  const out = [];
  let i = 0, lat = 0, lng = 0;
  const next = () => {
    let result = 0, shift = 0, b;
    do { b = str.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (i < str.length) {
    lat += next();
    lng += next();
    out.push({ lat: lat / 1e6, lng: lng / 1e6 });
  }
  return out;
}

/**
 * OSRM walking route through `points`.
 * Returns { routes: [[{lat,lng}]], snapped: [{lat,lng}] } (alternatives only work with 2 points).
 */
export async function osrmFoot(points, { alternatives = 0 } = {}) {
  const coords = points.map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
  const alt = alternatives ? `&alternatives=${alternatives}` : '';
  const { status, json } = await limited(() => getJson(`${OSRM_FOOT}${coords}?overview=full&geometries=geojson${alt}`));
  if (json?.code !== 'Ok' || !json.routes?.length) throw new Error(json?.message || `routing server returned ${status}`);
  return {
    routes: json.routes.map((r) => r.geometry.coordinates.map(([lng, lat]) => ({ lat, lng }))),
    snapped: json.waypoints.map((w) => ({ lng: w.location[0], lat: w.location[1] })),
  };
}

/**
 * Valhalla route through `points` with the given costing ('pedestrian', 'bicycle', 'auto', …).
 * Returns an array of lines: the best route first, then any alternates (2-point requests only).
 */
export async function valhalla(points, costing, costingOptions = {}, { alternates = 0 } = {}) {
  const body = {
    locations: points.map((p) => ({ lat: +p.lat.toFixed(6), lon: +p.lng.toFixed(6) })),
    costing,
    costing_options: { [costing]: costingOptions },
    directions_type: 'none',
  };
  if (alternates) body.alternates = alternates;
  const { status, json } = await limited(() => getJson(`${VALHALLA}?json=${encodeURIComponent(JSON.stringify(body))}`));
  if (!json?.trip) throw new Error(json?.error || `routing server returned ${status}`);
  return [json.trip, ...(json.alternates || []).map((a) => a.trip)]
    .map((trip) => trip.legs.flatMap((leg, i) => decodePolyline6(leg.shape).slice(i ? 1 : 0)));
}
