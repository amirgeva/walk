// Stores a route in the URL fragment, so that a link alone is enough to reproduce it.
//
//   #wp=lat,lng,lat,lng,...&mode=flat&hills=30     points to route through
//   #t=lat,lng,dLat,dLng,dLat,dLng,...             imported track, in units of 1e-5 degrees (~1 m)
//
// Coordinates only use digits, '.', ',' and '-', because messaging apps and mail clients detect links
// in plain text and can cut one short at other punctuation. Older links separated points with '|'.

const MAX_TRACK_CHARS = 1600; // keeps the whole mailto: link under the ~2000 characters mail clients accept
const DEFAULT_HILLS = 12;
const METRES_PER_DEGREE = 111320;

const validCoord = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
const toNumbers = (s) => (s ? s.split(/[|,]/) : []).map((t) => (t.trim() === '' ? NaN : Number(t)));

function distanceToSegment([px, py], [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

/** Douglas-Peucker: drop points that lie within toleranceM metres of the simplified line. */
export function simplify(line, toleranceM) {
  const cos = Math.cos(line[0].lat * Math.PI / 180);
  const xy = line.map((p) => [p.lng * cos * METRES_PER_DEGREE, p.lat * METRES_PER_DEGREE]);
  const keep = new Uint8Array(line.length);
  keep[0] = keep[line.length - 1] = 1;
  const stack = [[0, line.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let worst = 0, at = -1;
    for (let i = a + 1; i < b; i++) {
      const d = distanceToSegment(xy[i], xy[a], xy[b]);
      if (d > worst) { worst = d; at = i; }
    }
    if (worst > toleranceM) {
      keep[at] = 1;
      stack.push([a, at], [at, b]);
    }
  }
  return line.filter((_, i) => keep[i]);
}

function deltaEncode(line) {
  const out = [];
  let prevLat = 0, prevLng = 0;
  for (const p of line) {
    const lat = Math.round(p.lat * 1e5), lng = Math.round(p.lng * 1e5);
    out.push(lat - prevLat, lng - prevLng);
    prevLat = lat;
    prevLng = lng;
  }
  return out.join(',');
}

/** Encode a track, simplifying it only as much as is needed to fit in a link. */
export function encodeTrack(line, maxChars = MAX_TRACK_CHARS) {
  for (let tolerance = 2; ; tolerance *= 1.5) {
    const encoded = deltaEncode(simplify(line, tolerance));
    if (encoded.length <= maxChars) return encoded;
  }
}

function decodeTrack(text) {
  const n = toNumbers(text);
  if (n.length < 4 || n.length % 2 || !n.every(Number.isInteger)) return null;
  const line = [];
  let lat = 0, lng = 0;
  for (let i = 0; i < n.length; i += 2) {
    lat += n[i];
    lng += n[i + 1];
    if (!validCoord(lat / 1e5, lng / 1e5)) return null;
    line.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return line;
}

/** URL fragment (without '#') for a route, or '' if there is nothing to store. */
export function routeHash({ waypoints, track, mode, hillWeight }) {
  if (track) return `t=${encodeTrack(track)}`;
  if (!waypoints.length) return '';
  const wp = waypoints.map((p) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`).join(',');
  const hills = mode === 'flat' && hillWeight !== DEFAULT_HILLS ? `&hills=${hillWeight}` : '';
  return `wp=${wp}&mode=${mode}${hills}`;
}

/** Parse a URL fragment. Anything invalid is ignored, so a damaged link opens as an empty map at worst. */
export function parseRouteHash(hash) {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const numbers = toNumbers(params.get('wp'));
  const waypoints = [];
  for (let i = 0; i + 1 < numbers.length; i += 2) {
    if (validCoord(numbers[i], numbers[i + 1])) waypoints.push({ lat: numbers[i], lng: numbers[i + 1] });
  }
  return {
    waypoints,
    track: decodeTrack(params.get('t')),
    mode: params.get('streets') === '0' ? 'straight' : params.get('mode') || 'main',
    hills: Number(params.get('hills')) || DEFAULT_HILLS,
  };
}
