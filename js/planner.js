// Route planning modes. Each leg (waypoint → next waypoint) is planned independently and cached,
// so moving one point only re-plans its two neighbouring legs.
//
//  main     Prefer main streets when it's ambiguous: take a main-street route (car network, one-ways
//           ignored) if it is at most ~25% longer than the shortest walk; otherwise walk the shortest way.
//           A waypoint far from any road (e.g. on a footpath) makes that leg use walking routing, so
//           marking a point is how you divert.
//  flat     Minimise height changes: gather many candidate routes (walking + hill-avoiding bike routes,
//           their alternatives, and detours via side points left/right of the direct line), score each
//           one with the terrain model and pick the lowest cost = distance + w·climb + w/3·descent.
//  short    Shortest walking route on any street or path (OSRM foot).
//  straight Straight lines between the points.

import { osrmFoot, valhalla } from './routing.js';
import { densify, haversine, lineLength, nearestIndex } from './geo.js';
import { sampleElevations } from './elevation.js';
import { analyze } from './difficulty.js';

export const MODES = {
  main: {
    label: 'Main streets',
    hint: 'Prefers main streets when the detour is small (≤ 25%). Add a point on a side street or path to divert.',
  },
  flat: {
    label: 'Flattest',
    hint: 'Compares many candidate routes, including side streets, and picks the one with the least and gentlest climbing. Takes a few seconds.',
  },
  short: { label: 'Shortest', hint: 'Shortest walking route on any street or footpath.' },
  straight: { label: 'Straight lines', hint: 'Straight lines between your points (no routing).' },
};

const MAIN_MAX_DETOUR = 1.25;   // main-street route may be up to 25% (+50 m) longer than the shortest walk
const MAIN_MAX_SNAP = 40;       // metres between a waypoint and the road the car network snaps it to
const MAIN_OPTS = { ignore_oneways: true, use_highways: 0, use_tolls: 0 };

// ---- leg cache
const CACHE_LIMIT = 300;
const legCache = new Map();
function cached(key, fn) {
  if (!legCache.has(key)) {
    legCache.set(key, fn().catch((err) => { legCache.delete(key); throw err; }));
    while (legCache.size > CACHE_LIMIT) legCache.delete(legCache.keys().next().value);
  }
  return legCache.get(key);
}
const ptKey = (p) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;

// ---- geometry helpers
function dedupe(line) {
  return line.filter((p, i) => i === 0 || haversine(line[i - 1], p) > 0.5);
}

/** Remove an out-and-back spur created by forcing a route through a via point. */
export function trimSpur(line, via) {
  line = dedupe(line);
  const k = nearestIndex(line, via);
  let i = k, j = k;
  while (i > 0 && j < line.length - 1 && haversine(line[i - 1], line[j + 1]) < 3) { i--; j++; }
  return line.slice(0, i + 1).concat(line.slice(j + 1));
}

/** Point offset sideways from the midpoint of a→b by `f` × the leg length (positive = left). */
export function sidePoint(a, b, f) {
  const kx = 111320 * Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180), ky = 110540;
  const dx = (b.lng - a.lng) * kx, dy = (b.lat - a.lat) * ky;
  return {
    lat: (a.lat + b.lat) / 2 + (dx * f) / ky,
    lng: (a.lng + b.lng) / 2 + (-dy * f) / kx,
  };
}

async function measure(line) {
  const total = lineLength(line);
  const pts = densify(line, Math.min(50, Math.max(15, total / 500)));
  const elev = await sampleElevations(pts, total > 15000 ? 14 : 15);
  pts.forEach((p, i) => { p.e = elev[i]; });
  const a = analyze(pts);
  if (!a) return { distance: total, ascent: 0, descent: 0, climbCost: 0, descentCost: 0, steepest: 0 };
  // Steepness-weighted climbing: a metre climbed at grade g counts (1 + (g / 10%)²) times, so
  // 5% → 1.25×, 10% → 2×, 20% → 5×, 30% → 10×. With a fixed height difference between the points
  // this prefers gentle detours over steep streets and stairs. Steep descents are penalised likewise.
  let climbCost = 0, descentCost = 0;
  for (let i = 0; i < a.segGrade.length; i++) {
    const dh = a.elev[i + 1] - a.elev[i], g = a.segGrade[i] / 100;
    if (dh > 0) climbCost += dh * (1 + (g / 0.10) ** 2);
    else descentCost -= dh * (1 + (g / 0.15) ** 2);
  }
  return { distance: total, ascent: a.ascent, descent: a.descent, climbCost, descentCost, steepest: a.maxSustainedUp };
}

// ---- modes
async function shortestWalk(a, b) {
  try {
    return (await valhalla([a, b], 'pedestrian'))[0];
  } catch {
    return (await osrmFoot([a, b])).routes[0];
  }
}

async function mainLeg(a, b) {
  const c = await cached(`main|${ptKey(a)}|${ptKey(b)}`, async () => {
    const [walk, ...mains] = await Promise.allSettled([
      shortestWalk(a, b),
      valhalla([a, b], 'auto', { ...MAIN_OPTS, use_distance: 0 }),
      valhalla([a, b], 'auto', { ...MAIN_OPTS, use_distance: 0.5 }),
    ]);
    if (walk.status !== 'fulfilled') throw walk.reason;
    return { walk: walk.value, mains: mains.filter((r) => r.status === 'fulfilled').map((r) => r.value[0]) };
  });
  const limit = lineLength(c.walk) * MAIN_MAX_DETOUR + 50;
  const snapsOk = (l) => haversine(l[0], a) <= MAIN_MAX_SNAP && haversine(l.at(-1), b) <= MAIN_MAX_SNAP;
  // Ordered from most "main-street" (fastest by car) to least.
  const main = c.mains.find((l) => snapsOk(l) && lineLength(l) <= limit);
  return main
    ? { line: [a, ...main, b], kind: 'main' }
    : { line: c.walk, kind: c.mains.some(snapsOk) ? 'walk' : 'path' };
}

async function flatCandidates(a, b) {
  return cached(`flat|${ptKey(a)}|${ptKey(b)}`, async () => {
    const L = haversine(a, b);
    const jobs = [
      valhalla([a, b], 'pedestrian', {}, { alternates: 2 }),
      valhalla([a, b], 'bicycle', { use_hills: 0, bicycle_type: 'Hybrid', use_roads: 0.5 }, { alternates: 2 }),
      osrmFoot([a, b], { alternatives: 2 }).then((r) => r.routes),
    ];
    if (L > 150 && L < 5000) {
      for (const f of [-0.5, -0.25, 0.25, 0.5]) {
        const via = sidePoint(a, b, f);
        jobs.push(osrmFoot([a, via, b]).then((r) => [trimSpur(r.routes[0], r.snapped[1])]));
      }
    }
    const lines = (await Promise.allSettled(jobs)).flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
    if (!lines.length) throw new Error('no route found');
    return Promise.all(lines.map(async (line) => ({ line, ...(await measure(line)) })));
  });
}

async function flatLeg(a, b, hillWeight) {
  const cands = await flatCandidates(a, b);
  const cost = (c) => c.distance + hillWeight * c.climbCost + (hillWeight / 3) * c.descentCost;
  const best = cands.reduce((x, y) => (cost(y) < cost(x) ? y : x));
  const shortest = cands.reduce((x, y) => (y.distance < x.distance ? y : x));
  return { line: best.line, kind: 'flat', best, shortest, count: cands.length };
}

/**
 * Plan a route through the waypoints.
 * Returns { line: [{lat,lng}], note: string, warning: string }.
 */
export async function planRoute(waypoints, mode, { hillWeight = 12 } = {}) {
  if (mode === 'straight') return { line: waypoints, note: '', warning: '' };
  if (mode === 'short') return { line: (await osrmFoot(waypoints)).routes[0], note: '', warning: '' };

  const failed = [];
  const legs = await Promise.all(waypoints.slice(1).map((b, i) => {
    const a = waypoints[i];
    const p = mode === 'flat' ? flatLeg(a, b, hillWeight) : mainLeg(a, b);
    return p.catch(() => { failed.push(i + 1); return { line: [a, b], kind: 'straight' }; });
  }));

  const line = legs.flatMap((l, i) => (i ? l.line.slice(1) : l.line));
  const warning = failed.length
    ? `Couldn't route leg${failed.length > 1 ? 's' : ''} ${failed.sort((x, y) => x - y).join(', ')}; drawn as straight line${failed.length > 1 ? 's' : ''}.`
    : '';

  let note = '';
  if (mode === 'main') {
    const n = legs.length, main = legs.filter((l) => l.kind === 'main').length;
    const path = legs.filter((l) => l.kind === 'path').length;
    note = main === n ? 'Following main streets.'
      : `Main streets on ${main} of ${n} leg${n > 1 ? 's' : ''}; the rest use the shortest walk` +
        (path ? ' (a point is off the road network, e.g. on a footpath).' : ' (main streets would be too big a detour).');
  } else if (mode === 'flat') {
    const ok = legs.filter((l) => l.kind === 'flat');
    if (ok.length) {
      const sum = (f) => ok.reduce((s, l) => s + f(l), 0);
      const up = sum((l) => l.best.ascent), upShort = sum((l) => l.shortest.ascent);
      const steep = Math.max(...ok.map((l) => l.best.steepest));
      const steepShort = Math.max(...ok.map((l) => l.shortest.steepest));
      const extra = sum((l) => l.best.distance - l.shortest.distance);
      const count = sum((l) => l.count);
      const same = ok.every((l) => l.best === l.shortest);
      note = same
        ? `Compared ${count} candidate routes; the shortest one is also the gentlest.`
        : `Best of ${count} candidates. Versus the shortest route: climb ↑${Math.round(up)} m instead of ↑${Math.round(upShort)} m, ` +
          `steepest 100 m ${steep.toFixed(0)}% instead of ${steepShort.toFixed(0)}%, ${extra >= 0 ? '+' : '−'}${Math.round(Math.abs(extra))} m walking.`;
    }
  }
  return { line, note, warning };
}
