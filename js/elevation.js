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

function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/**
 * Decode a Terrarium PNG (ArrayBuffer) to Float32Array(256*256) of elevations in metres.
 *
 * This deliberately parses the PNG itself instead of drawing it on a canvas and calling getImageData():
 * browser anti-fingerprinting features and privacy extensions add noise to canvas read-backs, and in this
 * encoding one flipped low bit of the red channel is an error of 256 m.
 */
export async function decodePng(buffer) {
  const bytes = new Uint8Array(buffer), view = new DataView(buffer);
  if (view.getUint32(0) !== 0x89504e47 || view.getUint32(4) !== 0x0d0a1a0a) throw new Error('not a PNG');

  let width = 0, height = 0, bitDepth = 0, colorType = -1, interlace = 0;
  const idat = [];
  for (let pos = 8; pos + 8 <= bytes.length;) {
    const len = view.getUint32(pos), type = view.getUint32(pos + 4);
    if (type === 0x49484452) { // IHDR
      width = view.getUint32(pos + 8);
      height = view.getUint32(pos + 12);
      bitDepth = bytes[pos + 16];
      colorType = bytes[pos + 17];
      interlace = bytes[pos + 20];
    } else if (type === 0x49444154) { // IDAT
      idat.push(bytes.subarray(pos + 8, pos + 8 + len));
    } else if (type === 0x49454e44) { // IEND
      break;
    }
    pos += 12 + len;
  }
  const bpp = colorType === 2 ? 3 : colorType === 6 ? 4 : 0; // RGB or RGBA
  if (width !== TILE_SIZE || height !== TILE_SIZE || bitDepth !== 8 || !bpp || interlace) {
    throw new Error(`unsupported PNG (${width}x${height}, depth ${bitDepth}, colour type ${colorType}, interlace ${interlace})`);
  }

  const stream = new Blob(idat).stream().pipeThrough(new DecompressionStream('deflate'));
  const raw = new Uint8Array(await new Response(stream).arrayBuffer());
  const stride = width * bpp;
  if (raw.length !== (stride + 1) * height) throw new Error('truncated PNG data');

  // Undo the per-scanline filters in place, then convert to elevations.
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const row = y * (stride + 1) + 1, up = row - stride - 1;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? raw[row + i - bpp] : 0;
      const b = y ? raw[up + i] : 0;
      const c = y && i >= bpp ? raw[up + i - bpp] : 0;
      const predictor = filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b
        : filter === 3 ? (a + b) >> 1 : filter === 4 ? paeth(a, b, c) : NaN;
      if (Number.isNaN(predictor)) throw new Error(`bad PNG filter ${filter}`);
      raw[row + i] = (raw[row + i] + predictor) & 255;
    }
    for (let x = 0; x < width; x++) {
      const p = row + x * bpp;
      out[y * width + x] = raw[p] * 256 + raw[p + 1] + raw[p + 2] / 256 - 32768;
    }
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
    .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer(); })
    .then(decodePng)
    .then((data) => { entry.data = data; return data; })
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
