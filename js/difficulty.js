// Route analysis: elevation profile -> climb statistics, walking time and a 1–5 difficulty level.
// Pure functions, no DOM / map dependencies.

/** Signed grade classes (percent), used for colouring the map, the profile and the breakdown. */
export const GRADE_CLASSES = [
  { max: -10, label: 'Steep descent', range: 'below −10%', color: '#2c5282' },
  { max: -3, label: 'Descent', range: '−10% to −3%', color: '#63b3ed' },
  { max: 3, label: 'Flat', range: '−3% to 3%', color: '#48bb78' },
  { max: 6, label: 'Gentle climb', range: '3% to 6%', color: '#d6b52a' },
  { max: 10, label: 'Moderate climb', range: '6% to 10%', color: '#ed8936' },
  { max: 15, label: 'Steep climb', range: '10% to 15%', color: '#e53e3e' },
  { max: Infinity, label: 'Very steep climb', range: 'above 15%', color: '#7b1d4f' },
];
const STEEP = 5, VERY_STEEP = 6;

export function gradeClass(gradePct) {
  for (let i = 0; i < GRADE_CLASSES.length; i++) if (gradePct < GRADE_CLASSES[i].max) return i;
  return GRADE_CLASSES.length - 1;
}

export const LEVELS = [
  { name: 'Easy', color: '#2f855a', text: 'Short and/or nearly flat. Fine for almost anyone.' },
  { name: 'Moderate', color: '#b7791f', text: 'Some climbing. A normal fitness level is enough.' },
  { name: 'Challenging', color: '#dd6b20', text: 'Sustained or steep climbs. Expect to get out of breath.' },
  { name: 'Hard', color: '#c53030', text: 'Long and/or very steep climbs. Good fitness recommended.' },
  { name: 'Very hard', color: '#702459', text: 'Big elevation gain. For fit, experienced walkers.' },
];
// Upper bounds of "effort kilometres" for levels 1..4 (anything above is level 5).
const EFFORT_THRESHOLDS = [4, 8, 13, 20];

const HILLINESS = [[10, 'flat'], [25, 'rolling'], [50, 'hilly'], [80, 'very hilly'], [Infinity, 'mountainous']];

/** Replace null/NaN elevations by linear interpolation (by index). Returns null if no data at all. */
export function fillGaps(values) {
  const out = Float64Array.from(values, (v) => (v == null || !Number.isFinite(v) ? NaN : v));
  const first = out.findIndex((v) => !Number.isNaN(v));
  if (first < 0) return null;
  for (let i = 0; i < first; i++) out[i] = out[first];
  let last = first;
  for (let i = first + 1; i < out.length; i++) {
    if (Number.isNaN(out[i])) continue;
    for (let k = last + 1; k < i; k++) out[k] = out[last] + (out[i] - out[last]) * (k - last) / (i - last);
    last = i;
  }
  for (let i = last + 1; i < out.length; i++) out[i] = out[last];
  return out;
}

/** Symmetric moving average over ±half metres (window shrinks at the ends so endpoints stay put). */
export function smooth(d, e, half) {
  const n = e.length, out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const h = Math.min(half, d[i] - d[0], d[n - 1] - d[i]);
    let s = e[i], c = 1;
    for (let k = i - 1; k >= 0 && d[i] - d[k] <= h; k--) { s += e[k]; c++; }
    for (let k = i + 1; k < n && d[k] - d[i] <= h; k++) { s += e[k]; c++; }
    out[i] = s / c;
  }
  return out;
}

/** Tobler's hiking function: walking speed in m/h for a grade given as a fraction (0.1 = 10%). */
export function toblerSpeed(grade) {
  return 6000 * Math.exp(-3.5 * Math.abs(grade + 0.05));
}

/**
 * Find climbs: rises of at least `minGain` metres, tolerating dips of less than `tolerance` metres.
 * Returns [{start, end}] index pairs into `e`.
 */
export function findClimbs(e, { minGain = 10, tolerance = 5 } = {}) {
  const climbs = [];
  let low = 0, peak = -1;
  for (let i = 1; i < e.length; i++) {
    if (peak < 0) {
      if (e[i] < e[low]) low = i;
      else if (e[i] - e[low] >= tolerance) peak = i;
    } else if (e[i] >= e[peak]) {
      peak = i;
    } else if (e[peak] - e[i] >= tolerance) {
      if (e[peak] - e[low] >= minGain) climbs.push({ start: low, end: peak });
      low = i;
      peak = -1;
    }
  }
  if (peak >= 0 && e[peak] - e[low] >= minGain) climbs.push({ start: low, end: peak });
  return climbs;
}

/**
 * Analyse a route.
 * @param pts [{lat, lng, d, e}] evenly-ish spaced samples; d = cumulative metres, e = elevation or null.
 * @param opts.paceFactor multiplies walking speed (0.8 relaxed … 1.2 brisk).
 */
export function analyze(pts, { paceFactor = 1 } = {}) {
  const n = pts.length;
  if (n < 2) return null;
  const d = Float64Array.from(pts, (p) => p.d);
  const distance = d[n - 1];
  if (!(distance > 0)) return null;
  const raw = fillGaps(pts.map((p) => p.e));
  if (!raw) return null;
  const missing = pts.reduce((c, p) => c + (p.e == null ? 1 : 0), 0);

  const spacing = distance / (n - 1);
  const e = smooth(d, raw, Math.max(25, 1.5 * spacing)); // DEM noise would otherwise inflate climb totals
  const gradeHalf = Math.max(20, spacing);

  // Per-segment grade (%) measured over a ±gradeHalf window around the segment midpoint.
  const segGrade = new Float64Array(n - 1);
  const segClass = new Uint8Array(n - 1);
  const classDist = new Array(GRADE_CLASSES.length).fill(0);
  let ascent = 0, descent = 0, hours = 0, lo = 0, hi = 0;
  for (let i = 0; i < n - 1; i++) {
    const mid = (d[i] + d[i + 1]) / 2;
    while (lo < i && d[lo + 1] <= mid - gradeHalf) lo++;
    if (hi < i + 1) hi = i + 1;
    while (hi < n - 1 && d[hi] < mid + gradeHalf) hi++;
    const g = (e[hi] - e[lo]) / (d[hi] - d[lo]) * 100;
    segGrade[i] = g;
    segClass[i] = gradeClass(g);

    const len = d[i + 1] - d[i];
    const dh = e[i + 1] - e[i];
    if (dh > 0) ascent += dh; else descent -= dh;
    classDist[segClass[i]] += len;
    hours += len / (toblerSpeed(g / 100) * paceFactor);
  }

  // Steepest sustained grade over 100 m (up and down).
  const W = Math.min(100, distance);
  let maxUp = -Infinity, maxDown = Infinity;
  for (let i = 0, j = 0; i < n; i++) {
    if (j < i) j = i;
    while (j < n - 1 && d[j] - d[i] < W) j++;
    if (d[j] - d[i] < W) break;
    const g = (e[j] - e[i]) / (d[j] - d[i]) * 100;
    if (g > maxUp) maxUp = g;
    if (g < maxDown) maxDown = g;
  }

  const climbs = findClimbs(e).map(({ start, end }) => {
    let maxGrade = -Infinity;
    for (let i = start; i < end; i++) maxGrade = Math.max(maxGrade, segGrade[i]);
    const gain = e[end] - e[start], length = d[end] - d[start];
    return { start, end, gain, length, avgGrade: gain / length * 100, maxGrade, startDist: d[start] };
  });

  let minElev = Infinity, maxElev = -Infinity;
  for (const v of e) { minElev = Math.min(minElev, v); maxElev = Math.max(maxElev, v); }

  // ---- Difficulty level ----
  // 1. "Effort kilometres": distance plus 1 km for every 100 m of climbing
  //    (the Swiss hiking "Leistungskilometer"; Naismith's rule gives a similar ratio).
  const km = distance / 1000;
  const effortKm = km + ascent / 100;
  let base = EFFORT_THRESHOLDS.findIndex((t) => effortKm < t);
  if (base < 0) base = EFFORT_THRESHOLDS.length;
  const reasons = [
    `Effort: ${km.toFixed(2)} km + ${Math.round(ascent)} m climb ÷ 100 = ${effortKm.toFixed(1)} effort-km → ${LEVELS[base].name}.`,
  ];
  // 2. Steepness bumps: steep pitches are hard even when the total climb is modest.
  const steepUp = classDist[STEEP] + classDist[VERY_STEEP];
  const veryUp = classDist[VERY_STEEP];
  let bump = 0;
  if (steepUp >= 150) {
    bump++;
    reasons.push(`+1: ${Math.round(steepUp)} m of climbing steeper than 10%.`);
  }
  if (ascent >= 60 && (veryUp >= 300 || maxUp >= 20)) {
    bump++;
    reasons.push(veryUp >= 300
      ? `+1: ${Math.round(veryUp)} m of climbing steeper than 15%.`
      : `+1: a 100 m stretch averaging ${maxUp.toFixed(0)}% uphill.`);
  }
  const level = Math.min(LEVELS.length - 1, base + bump);

  const hilliness = ascent / Math.max(km, 0.001);

  return {
    distance, ascent, descent, hours, effortKm, level, reasons,
    hilliness, hillinessLabel: HILLINESS.find(([t]) => hilliness < t)[1],
    maxSustainedUp: Number.isFinite(maxUp) ? maxUp : 0,
    maxSustainedDown: Number.isFinite(maxDown) ? maxDown : 0,
    minElev, maxElev, startElev: e[0], endElev: e[n - 1],
    classDist, climbs, missing,
    d, elev: e, segGrade, segClass,
  };
}
