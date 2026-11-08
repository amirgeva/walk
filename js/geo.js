// Small geodesy helpers. Points are {lat, lng} objects (L.LatLng compatible).

const R = 6371008.8; // mean Earth radius, metres
const RAD = Math.PI / 180;

export function haversine(a, b) {
  const dLat = (b.lat - a.lat) * RAD;
  const dLng = (b.lng - a.lng) * RAD;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function lineLength(line) {
  let total = 0;
  for (let i = 1; i < line.length; i++) total += haversine(line[i - 1], line[i]);
  return total;
}

/**
 * Resample a polyline so consecutive points are at most `step` metres apart.
 * Returns [{lat, lng, d}] where d is the cumulative distance in metres.
 */
export function densify(line, step) {
  if (!line.length) return [];
  const out = [{ lat: line[0].lat, lng: line[0].lng, d: 0 }];
  let total = 0;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1], b = line[i];
    const len = haversine(a, b);
    if (len === 0) continue;
    const n = Math.max(1, Math.ceil(len / step));
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      out.push({
        lat: a.lat + (b.lat - a.lat) * t,
        lng: a.lng + (b.lng - a.lng) * t,
        d: total + len * t,
      });
    }
    total += len;
  }
  return out;
}

/** Index of the point in `pts` closest to `p` (flat-earth approximation, fine locally). */
export function nearestIndex(pts, p, from = 0, to = pts.length) {
  const k = Math.cos(p.lat * RAD);
  let best = -1, bestD = Infinity;
  for (let i = from; i < to; i++) {
    const dy = pts[i].lat - p.lat, dx = (pts[i].lng - p.lng) * k;
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}
