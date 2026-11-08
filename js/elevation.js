// Elevation data from the free, key-less AWS Terrain Tiles (Mapzen "Terrarium" encoding):
//   elevation (m) = R * 256 + G + B / 256 - 32768
// https://registry.opendata.aws/terrain-tiles/
// Tiles are 256x256 PNGs in the usual Web-Mercator z/x/y scheme, up to zoom 15 (~4.8 m/px at the equator;
// the underlying data resolution varies by region from ~1 m to ~90 m).

export const MAX_DEM_ZOOM = 15;
export const TILE_SIZE = 256;

const tileUrl = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
const CACHE_LIMIT = 400; // decoded tiles are 256 KB each
const cache = new Map(); // key -> { data: Float32Array | undefined, promise }

const key = (z, x, y) => `${z}/${x}/${y}`;
const wrapX = (x, z) => { const n = 1 << z; return ((x % n) + n) % n; };

let scratch;
function decode(bitmap) {
  scratch ??= typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(TILE_SIZE, TILE_SIZE)
    : Object.assign(document.createElement('canvas'), { width: TILE_SIZE, height: TILE_SIZE });
  const ctx = scratch.getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, TILE_SIZE, TILE_SIZE);
  ctx.drawImage(bitmap, 0, 0);
  const px = ctx.getImageData(0, 0, TILE_SIZE, TILE_SIZE).data;
  const out = new Float32Array(TILE_SIZE * TILE_SIZE);
  for (let i = 0, j = 0; i < out.length; i++, j += 4) {
    out[i] = px[j] * 256 + px[j + 1] + px[j + 2] / 256 - 32768;
  }
  return out;
}

/** Load (and cache) a decoded elevation tile. Resolves to Float32Array(256*256) or null. */
export function getDemTile(z, x, y) {
  x = wrapX(x, z);
  if (y < 0 || y >= (1 << z)) return Promise.resolve(null);
  const k = key(z, x, y);
  let entry = cache.get(k);
  if (entry) { // LRU touch
    cache.delete(k);
    cache.set(k, entry);
    return entry.promise;
  }
  entry = { data: undefined, promise: null };
  entry.promise = fetch(tileUrl(z, x, y))
    .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.blob(); })
    .then((b) => createImageBitmap(b, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' }))
    .then((bmp) => { entry.data = decode(bmp); bmp.close?.(); return entry.data; })
    .catch(() => { cache.delete(k); return null; });
  cache.set(k, entry);
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  return entry.promise;
}

/** Synchronous access to an already-loaded tile (or null). */
export function peekDemTile(z, x, y) {
  return cache.get(key(z, wrapX(x, z), y))?.data ?? null;
}

/** Lat/lng -> global pixel coordinates at zoom z. */
export function project(lat, lng, z) {
  const s = TILE_SIZE * 2 ** z;
  const c = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const sin = Math.sin(c * Math.PI / 180);
  return [(lng + 180) / 360 * s, (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * s];
}

/**
 * Bilinearly interpolated elevations (metres) for an array of {lat, lng}.
 * Entries are null where no data could be loaded.
 */
export async function sampleElevations(points, z = MAX_DEM_ZOOM) {
  // Pixel values describe pixel centres, hence the -0.5.
  const px = points.map((p) => project(p.lat, p.lng, z).map((v) => v - 0.5));

  const needed = new Map();
  for (const [x, y] of px) {
    const x0 = Math.floor(x), y0 = Math.floor(y);
    for (const gx of [x0, x0 + 1]) for (const gy of [y0, y0 + 1]) {
      const tx = Math.floor(gx / TILE_SIZE), ty = Math.floor(gy / TILE_SIZE);
      needed.set(key(z, tx, ty), [tx, ty]);
    }
  }
  // Keep our own references so LRU eviction can't pull tiles out from under us.
  const loaded = new Map();
  await Promise.all([...needed].map(async ([k, [tx, ty]]) => loaded.set(k, await getDemTile(z, tx, ty))));

  const pix = (gx, gy) => {
    const tx = Math.floor(gx / TILE_SIZE), ty = Math.floor(gy / TILE_SIZE);
    const t = loaded.get(key(z, tx, ty));
    return t ? t[(gy - ty * TILE_SIZE) * TILE_SIZE + (gx - tx * TILE_SIZE)] : NaN;
  };

  return px.map(([x, y]) => {
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    const v = pix(x0, y0) * (1 - fx) * (1 - fy) + pix(x0 + 1, y0) * fx * (1 - fy) +
      pix(x0, y0 + 1) * (1 - fx) * fy + pix(x0 + 1, y0 + 1) * fx * fy;
    return Number.isFinite(v) ? v : null;
  });
}
