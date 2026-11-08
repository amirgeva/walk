// Map overlay rendered client-side from the elevation tiles: hillshade, slope or colour-coded elevation.
import { getDemTile, peekDemTile, sampleElevations, MAX_DEM_ZOOM, TILE_SIZE } from './elevation.js';
import { GRADE_CLASSES, gradeClass } from './difficulty.js';

const EARTH_CIRCUMFERENCE = 40075016.686;
const N = TILE_SIZE;

// Elevation colour ramp (low → high).
const RAMP = [
  [0.0, [38, 115, 77]], [0.25, [134, 190, 90]], [0.5, [244, 221, 130]],
  [0.75, [205, 133, 63]], [1.0, [122, 69, 50]],
];
export const RAMP_CSS = `linear-gradient(to right, ${RAMP.map(([t, c]) => `rgb(${c}) ${t * 100}%`).join(', ')})`;
const LUT = new Uint8Array(256 * 3);
for (let i = 0; i < 256; i++) {
  const t = i / 255;
  let k = 0;
  while (k < RAMP.length - 2 && t > RAMP[k + 1][0]) k++;
  const [t0, c0] = RAMP[k], [t1, c1] = RAMP[k + 1];
  const f = (t - t0) / (t1 - t0);
  for (let j = 0; j < 3; j++) LUT[i * 3 + j] = Math.round(c0[j] + (c1[j] - c0[j]) * f);
}

const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const CLASS_RGB = GRADE_CLASSES.map((c) => hexRgb(c.color));

// Light from the north-west, 45° above the horizon (x = east, y = north, z = up).
const AZ = 315 * Math.PI / 180, ALT = 45 * Math.PI / 180;
const LX = Math.sin(AZ) * Math.cos(ALT), LY = Math.cos(AZ) * Math.cos(ALT), LZ = Math.sin(ALT);

function rowLatitude(z, y, row) {
  const n = Math.PI - 2 * Math.PI * (y + (row + 0.5) / N) / 2 ** z;
  return Math.atan(Math.sinh(n));
}

const P = N + 2; // padded tile width

/**
 * Tile elevations with a 1-pixel border taken from the neighbouring tiles (when loaded), so that
 * slopes at tile edges match across tiles. Missing neighbours fall back to edge clamping.
 */
function paddedDem(coords) {
  const { x, y, z } = coords;
  const c = peekDemTile(z, x, y);
  const nb = { n: peekDemTile(z, x, y - 1), s: peekDemTile(z, x, y + 1), w: peekDemTile(z, x - 1, y), e: peekDemTile(z, x + 1, y) };
  const out = new Float32Array(P * P);
  for (let r = 0; r < N; r++) out.set(c.subarray(r * N, r * N + N), (r + 1) * P + 1);
  for (let i = 0; i < N; i++) {
    out[i + 1] = nb.n ? nb.n[(N - 1) * N + i] : c[i];
    out[(P - 1) * P + i + 1] = nb.s ? nb.s[i] : c[(N - 1) * N + i];
    out[(i + 1) * P] = nb.w ? nb.w[i * N + N - 1] : c[i * N];
    out[(i + 1) * P + P - 1] = nb.e ? nb.e[i * N] : c[i * N + N - 1];
  }
  out[0] = out[1]; out[P - 1] = out[P - 2]; // corners
  out[(P - 1) * P] = out[(P - 1) * P + 1]; out[P * P - 1] = out[P * P - 2];
  return out;
}

export function renderTile(canvas, coords, { mode, range, exaggeration }) {
  const dem = peekDemTile(coords.z, coords.x, coords.y);
  if (!dem) return;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(N, N);
  const out = img.data;

  if (mode === 'elevation') {
    const [lo, hi] = range, span = Math.max(1, hi - lo);
    for (let i = 0; i < N * N; i++) {
      const t = Math.min(1, Math.max(0, (dem[i] - lo) / span));
      const c = Math.round(t * 255) * 3;
      out[i * 4] = LUT[c]; out[i * 4 + 1] = LUT[c + 1]; out[i * 4 + 2] = LUT[c + 2]; out[i * 4 + 3] = 255;
    }
  } else {
    const pd = paddedDem(coords);
    const baseMpp = EARTH_CIRCUMFERENCE / (N * 2 ** coords.z);
    for (let row = 0; row < N; row++) {
      const mpp = baseMpp * Math.cos(rowLatitude(coords.z, coords.y, row));
      const pr = (row + 1) * P;
      for (let col = 0; col < N; col++) {
        const pc = pr + col + 1;
        const dzdx = (pd[pc + 1] - pd[pc - 1]) / (2 * mpp);
        const dzdy = (pd[pc - P] - pd[pc + P]) / (2 * mpp); // northward
        const o = (row * N + col) * 4;
        if (mode === 'slope') {
          const s = Math.hypot(dzdx, dzdy) * 100;
          if (s < 3) continue; // transparent
          const [r, g, b] = CLASS_RGB[gradeClass(s)];
          out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = 255;
        } else { // hillshade
          const nx = -dzdx * exaggeration, ny = -dzdy * exaggeration;
          const shade = (nx * LX + ny * LY + LZ) / Math.sqrt(nx * nx + ny * ny + 1);
          if (shade < LZ) { out[o + 3] = Math.min(255, (LZ - shade) / LZ * 255); }
          else { out[o] = out[o + 1] = out[o + 2] = 255; out[o + 3] = (shade - LZ) / (1 - LZ) * 160; }
        }
      }
    }
  }
  ctx.putImageData(img, 0, 0);
}

export const TerrainLayer = L.GridLayer.extend({
  options: {
    maxNativeZoom: MAX_DEM_ZOOM,
    mode: 'hillshade',      // 'hillshade' | 'slope' | 'elevation'
    range: [0, 100],        // elevation colour range in metres (auto-fitted to the view)
    exaggeration: 2,        // hillshade vertical exaggeration
    className: 'terrain-layer',
  },

  createTile(coords, done) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = N;
    const { x, y, z } = coords;
    // Neighbours are needed for seamless slopes/shading at the tile edges.
    Promise.all([[x, y], [x, y - 1], [x, y + 1], [x - 1, y], [x + 1, y]].map(([tx, ty]) => getDemTile(z, tx, ty)))
      .then(() => {
        renderTile(canvas, coords, this.options);
        done(null, canvas);
      });
    return canvas;
  },

  /** Re-render visible tiles in place (no refetch, no flicker). */
  refresh() {
    for (const k in this._tiles) {
      const t = this._tiles[k];
      renderTile(t.el, t.coords, this.options);
    }
  },

  setMode(mode) {
    this.options.mode = mode;
    this.refresh();
    if (mode === 'elevation') this.fitRangeToView();
  },

  /** Stretch the elevation colours over the 2nd–98th percentile of the visible area. */
  async fitRangeToView() {
    const map = this._map;
    if (!map || this.options.mode !== 'elevation') return;
    const b = map.getBounds(), G = 24, pts = [];
    for (let i = 0; i < G; i++) for (let j = 0; j < G; j++) {
      pts.push({
        lat: b.getSouth() + (i + 0.5) / G * (b.getNorth() - b.getSouth()),
        lng: b.getWest() + (j + 0.5) / G * (b.getEast() - b.getWest()),
      });
    }
    const z = Math.max(0, Math.min(MAX_DEM_ZOOM, Math.round(map.getZoom())));
    const el = (await sampleElevations(pts, z)).filter((v) => v != null).sort((a, c) => a - c);
    if (!el.length) return;
    let lo = el[Math.floor(el.length * 0.02)], hi = el[Math.ceil(el.length * 0.98) - 1];
    if (hi - lo < 10) { const m = (lo + hi) / 2; lo = m - 5; hi = m + 5; }
    const [clo, chi] = this.options.range;
    if (Math.abs(lo - clo) + Math.abs(hi - chi) > 0.05 * (hi - lo)) {
      this.options.range = [lo, hi];
      this.refresh();
    }
    this.fire('rangechange', { range: this.options.range });
  },
});
