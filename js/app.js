import { sampleElevations, MAX_DEM_ZOOM } from './elevation.js';
import { TerrainLayer, RAMP_CSS } from './terrain.js';
import { planRoute, MODES } from './planner.js';
import { densify, lineLength, nearestIndex } from './geo.js';
import { analyze, GRADE_CLASSES, LEVELS } from './difficulty.js';
import { ProfileChart } from './profile.js';
import { routeHash, parseRouteHash } from './share.js';

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- map & layers
const map = L.map('map', { zoomControl: true });
const OSM_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const bases = {
  'Streets (OSM)': L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: OSM_ATTR }),
  'Streets (Humanitarian)': L.tileLayer('https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png',
    { maxZoom: 19, subdomains: 'abc', attribution: `${OSM_ATTR}, Tiles: <a href="https://www.hotosm.org/">HOT</a>` }),
  'Topographic': L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    { maxZoom: 17, subdomains: 'abc', attribution: `${OSM_ATTR}, SRTM | &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)` }),
};
bases['Streets (OSM)'].addTo(map);
L.control.layers(bases, null, { position: 'topright' }).addTo(map);
L.control.scale({ imperial: false }).addTo(map);

const terrain = new TerrainLayer({
  zIndex: 5, opacity: 0.55,
  attribution: 'Elevation: <a href="https://registry.opendata.aws/terrain-tiles/">AWS Terrain Tiles</a>',
});

// Elevation under the mouse pointer
const ElevReadout = L.Control.extend({
  onAdd() { const el = L.DomUtil.create('div', 'elev-readout'); el.textContent = 'Elevation: –'; return el; },
});
const readout = new ElevReadout({ position: 'bottomleft' }).addTo(map);
let readoutTimer;
map.on('mousemove', (ev) => {
  clearTimeout(readoutTimer);
  readoutTimer = setTimeout(async () => {
    const z = Math.min(MAX_DEM_ZOOM, Math.max(10, Math.round(map.getZoom())));
    const [v] = await sampleElevations([ev.latlng], z);
    readout.getContainer().textContent = v == null ? 'Elevation: –' : `Elevation: ${Math.round(v)} m`;
  }, 80);
});

// ---------------------------------------------------------------- state
const state = {
  waypoints: [],   // L.Marker[]
  track: null,     // imported GPX track [{lat, lng}] (replaces waypoint routing)
  mode: 'main',    // see MODES in planner.js
  hillWeight: 12,  // flat mode: metres of extra walking worth avoiding 1 m of climb
  pace: 1,
  pts: null,       // densified route samples [{lat, lng, d, e}]
  analysis: null,
  wpSample: [],    // sample index of each waypoint
  token: 0,
};

const routeLayer = L.layerGroup().addTo(map);
const hoverMarker = L.circleMarker([0, 0], { radius: 7, color: '#111', weight: 2, fillColor: '#fff', fillOpacity: 1, interactive: false });
const climbHighlight = L.polyline([], { color: '#111', weight: 11, opacity: 0.35, interactive: false });

const profile = new ProfileChart($('profile'), $('profile-tip'), (i) => showHover(i));

// ---------------------------------------------------------------- helpers
const fmtDist = (m) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 10000 ? 2 : 1)} km`);
const fmtPct = (g) => `${g >= 0 ? '' : '−'}${Math.abs(g).toFixed(1)}%`;
function fmtTime(hours) {
  const mins = Math.round(hours * 60);
  return mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)} h ${String(mins % 60).padStart(2, '0')} min`;
}

function setStatus(text, kind = '') {
  const el = $('status');
  el.textContent = text;
  el.className = kind;
}

function showHover(i) {
  if (i == null || !state.pts) { hoverMarker.remove(); return; }
  hoverMarker.setLatLng(state.pts[i]).addTo(map);
}

// ---------------------------------------------------------------- waypoints
function waypointIcon(i, n) {
  const cls = i === 0 ? 'start' : i === n - 1 ? 'end' : 'via';
  const label = i === 0 ? 'S' : i === n - 1 ? 'F' : '';
  return L.divIcon({ className: '', html: `<div class="wp wp-${cls}">${label}</div>`, iconSize: [22, 22], iconAnchor: [11, 11] });
}

function refreshIcons() {
  const n = state.waypoints.length;
  state.waypoints.forEach((m, i) => m.setIcon(waypointIcon(i, n)));
}

function addWaypoint(latlng, index = state.waypoints.length) {
  const m = L.marker(latlng, { draggable: true, autoPan: true, title: 'Drag to move · click to remove' });
  m.on('dragend', scheduleUpdate);
  m.on('click', () => removeWaypoint(m));
  m.addTo(map);
  state.waypoints.splice(index, 0, m);
  refreshIcons();
  scheduleUpdate();
}

function removeWaypoint(m) {
  m.remove();
  state.waypoints = state.waypoints.filter((x) => x !== m);
  refreshIcons();
  scheduleUpdate();
}

function clearAll() {
  state.waypoints.forEach((m) => m.remove());
  state.waypoints = [];
  state.track = null;
  scheduleUpdate();
}

map.on('click', (ev) => {
  if (state.track) { setStatus('An imported track is loaded. Press “Clear” to draw your own route.', 'warn'); return; }
  addWaypoint(ev.latlng);
});

// ---------------------------------------------------------------- route computation
let updateTimer;
function scheduleUpdate() { clearTimeout(updateTimer); updateTimer = setTimeout(update, 120); }

async function update() {
  const token = ++state.token;
  saveHash();

  const wps = state.waypoints.map((m) => m.getLatLng());
  if (!state.track && wps.length < 2) {
    clearRoute();
    setStatus(wps.length ? 'Click to add the next point.' : '');
    return;
  }

  let warning = '', note = '';
  try {
    let line;
    if (state.track) {
      line = state.track;
    } else {
      setStatus(state.mode === 'flat' ? 'Comparing candidate routes…' : 'Finding a walking route…', 'busy');
      try {
        ({ line, note, warning } = await planRoute(wps, state.mode, { hillWeight: state.hillWeight }));
      } catch (err) {
        line = wps;
        warning = `Routing failed (${err.message}); using straight lines.`;
      }
    }
    if (token !== state.token) return;

    setStatus('Reading elevation data…', 'busy');
    const total = lineLength(line);
    const pts = densify(line, Math.min(50, Math.max(10, total / 4000)));
    const z = total > 40000 ? 13 : total > 15000 ? 14 : MAX_DEM_ZOOM;
    const elev = await sampleElevations(pts, z);
    if (token !== state.token) return;
    pts.forEach((p, i) => { p.e = elev[i]; });

    state.pts = pts;
    state.wpSample = [];
    if (!state.track) {
      let from = 0;
      for (const w of wps) { from = nearestIndex(pts, w, from); state.wpSample.push(from); }
    }
    if (!recompute()) return;
    const missing = state.analysis.missing;
    if (missing) warning ||= `Elevation missing for ${Math.round(missing / pts.length * 100)}% of the route (interpolated).`;
    setStatus(warning || note, warning ? 'warn' : 'info');
  } catch (err) {
    if (token === state.token) setStatus(`Error: ${err.message}`, 'error');
  }
}

function recompute() {
  if (!state.pts) return false;
  const a = analyze(state.pts, { paceFactor: state.pace });
  if (!a) {
    clearRoute();
    setStatus('No elevation data available for this route.', 'error');
    return false;
  }
  state.analysis = a;
  drawRoute();
  renderResults();
  refreshShare();
  $('profile-wrap').hidden = false;
  map.invalidateSize();
  profile.setData(a);
  return true;
}

function clearRoute() {
  state.pts = null;
  state.analysis = null;
  routeLayer.clearLayers();
  hoverMarker.remove();
  climbHighlight.remove();
  $('results').hidden = true;
  if (!$('profile-wrap').hidden) { $('profile-wrap').hidden = true; map.invalidateSize(); }
  profile.setData(null);
}

function drawRoute() {
  const { pts, analysis: a } = state;
  routeLayer.clearLayers();
  climbHighlight.remove();
  L.polyline(pts, { color: '#fff', weight: 9, opacity: 0.9, interactive: false }).addTo(routeLayer);
  for (let i = 0; i < pts.length - 1;) {
    const cls = a.segClass[i];
    let j = i;
    while (j < pts.length - 1 && a.segClass[j] === cls) j++;
    L.polyline(pts.slice(i, j + 1), { color: GRADE_CLASSES[cls].color, weight: 5, opacity: 1, interactive: false, lineCap: 'butt' }).addTo(routeLayer);
    i = j;
  }
  // Invisible wide line for hovering / inserting waypoints.
  const hit = L.polyline(pts, { weight: 18, opacity: 0, bubblingMouseEvents: false }).addTo(routeLayer);
  hit.on('mousemove', (ev) => {
    const i = nearestIndex(pts, ev.latlng);
    showHover(i);
    profile.setHighlight(i);
  });
  hit.on('mouseout', () => { showHover(null); profile.setHighlight(null); });
  hit.on('click', (ev) => {
    if (state.track) return;
    const k = nearestIndex(pts, ev.latlng);
    let pos = state.wpSample.findIndex((s) => s > k);
    if (pos < 0) pos = state.waypoints.length;
    addWaypoint(ev.latlng, Math.max(1, pos));
  });
}

// ---------------------------------------------------------------- results panel
function renderResults() {
  const a = state.analysis, lv = LEVELS[a.level];
  const climbs = [...a.climbs].sort((x, y) => y.gain - x.gain).slice(0, 5).sort((x, y) => x.start - y.start);
  const breakdown = GRADE_CLASSES.map((c, i) => ({ ...c, dist: a.classDist[i] })).filter((c) => c.dist > 0);

  $('results').hidden = false;
  $('results').innerHTML = `
    <div class="level" style="--lv:${lv.color}">
      <div class="level-num">${a.level + 1}<small>/5</small></div>
      <div><div class="level-name">${lv.name}</div><div class="level-text">${lv.text}</div></div>
    </div>
    <dl class="stats">
      <div><dt>Distance</dt><dd>${fmtDist(a.distance)}</dd></div>
      <div><dt>Walking time</dt><dd>${fmtTime(a.hours)}</dd></div>
      <div><dt>Total climb</dt><dd>↑ ${Math.round(a.ascent)} m</dd></div>
      <div><dt>Total descent</dt><dd>↓ ${Math.round(a.descent)} m</dd></div>
      <div><dt>Steepest 100 m</dt><dd>${fmtPct(a.maxSustainedUp)} <small>up</small></dd></div>
      <div><dt>Hilliness</dt><dd>${Math.round(a.hilliness)} m/km <small>${a.hillinessLabel}</small></dd></div>
      <div><dt>Elevation range</dt><dd>${Math.round(a.minElev)}–${Math.round(a.maxElev)} m</dd></div>
      <div><dt>Effort</dt><dd>${a.effortKm.toFixed(1)} <small>effort-km</small></dd></div>
    </dl>
    <h3>Terrain breakdown</h3>
    <div class="breakdown">${breakdown.map((c) =>
      `<span style="flex:${c.dist};background:${c.color}" title="${c.label}: ${fmtDist(c.dist)}"></span>`).join('')}</div>
    <ul class="grade-legend">${breakdown.map((c) =>
      `<li><i style="background:${c.color}"></i>${c.label} <small>(${c.range})</small><b>${fmtDist(c.dist)}</b></li>`).join('')}</ul>
    <h3>Main climbs</h3>
    ${climbs.length ? `<ol class="climbs">${climbs.map((c) => `
      <li data-start="${c.start}" data-end="${c.end}" tabindex="0">
        <b>↑ ${Math.round(c.gain)} m</b> over ${fmtDist(c.length)}
        <span>avg ${c.avgGrade.toFixed(1)}%, max ${c.maxGrade.toFixed(0)}% · from km ${(c.startDist / 1000).toFixed(2)}</span>
      </li>`).join('')}</ol>` : '<p class="muted">No significant climbs (≥ 10 m).</p>'}
    <details>
      <summary>How is the difficulty calculated?</summary>
      <ul>${a.reasons.map((r) => `<li>${r}</li>`).join('')}</ul>
      <p>Levels by effort-km: Easy &lt; 4, Moderate &lt; 8, Challenging &lt; 13, Hard &lt; 20, Very hard ≥ 20.
      One level is added for ≥ 150 m of climbing steeper than 10%, and another (if the total climb is ≥ 60 m)
      for ≥ 300 m steeper than 15% or a 100 m stretch averaging ≥ 20%.</p>
      <p>Walking time uses Tobler's hiking function (≈ 5 km/h on the flat, slower uphill and on steep descents),
      scaled by the chosen pace. Elevations are smoothed over ~50 m to filter out terrain-model noise.</p>
    </details>`;
}

$('results').addEventListener('click', (ev) => {
  const li = ev.target.closest('.climbs li');
  if (!li || !state.pts) return;
  const seg = state.pts.slice(+li.dataset.start, +li.dataset.end + 1);
  climbHighlight.setLatLngs(seg).addTo(map);
  map.fitBounds(L.latLngBounds(seg), { padding: [60, 60], maxZoom: 17 });
});

// ---------------------------------------------------------------- controls
function setMode(mode) {
  if (!MODES[mode]) mode = 'main';
  state.mode = mode;
  $('opt-mode').value = mode;
  $('mode-hint').textContent = MODES[mode].hint;
  $('hill-opt').hidden = mode !== 'flat';
}
$('opt-mode').addEventListener('change', (ev) => { setMode(ev.target.value); scheduleUpdate(); });
$('opt-hills').addEventListener('change', (ev) => { state.hillWeight = +ev.target.value; scheduleUpdate(); });
$('opt-pace').addEventListener('change', (ev) => { state.pace = +ev.target.value; if (recompute()) setStatus(''); });
$('btn-undo').addEventListener('click', () => { const m = state.waypoints.at(-1); if (m) removeWaypoint(m); });
$('btn-clear').addEventListener('click', clearAll);
$('btn-reverse').addEventListener('click', () => {
  if (state.track) state.track.reverse();
  else { state.waypoints.reverse(); refreshIcons(); }
  scheduleUpdate();
});
$('btn-loop').addEventListener('click', () => {
  if (state.track || state.waypoints.length < 2) return;
  addWaypoint(state.waypoints[0].getLatLng());
});
$('btn-fit').addEventListener('click', () => {
  if (state.pts) map.fitBounds(L.latLngBounds(state.pts), { padding: [40, 40] });
});
$('btn-gpx').addEventListener('click', exportGpx);
$('file-gpx').addEventListener('change', async (ev) => {
  const file = ev.target.files[0];
  ev.target.value = '';
  if (file) importGpx(await file.text());
});

// Terrain overlay controls
function updateTerrainLegend() {
  const mode = terrain.options.mode, el = $('terrain-legend');
  if (!map.hasLayer(terrain)) { el.innerHTML = ''; return; }
  if (mode === 'slope') {
    el.innerHTML = GRADE_CLASSES.slice(3).map((c) => `<span><i style="background:${c.color}"></i>${c.range}</span>`).join('') +
      (map.getZoom() < 13 ? '<p class="muted">Zoom in (≥ 13) for meaningful slopes.</p>' : '');
  } else if (mode === 'elevation') {
    const [lo, hi] = terrain.options.range;
    el.innerHTML = `<div class="ramp" style="background:${RAMP_CSS}"></div>
      <div class="ramp-labels"><span>${Math.round(lo)} m</span><span>${Math.round(hi)} m</span></div>
      <p class="muted">Colours stretch to the visible area.</p>`;
  } else {
    el.innerHTML = '<p class="muted">Shaded relief, lit from the north-west.</p>';
  }
}

document.querySelectorAll('input[name="terrain"]').forEach((r) => r.addEventListener('change', (ev) => {
  const mode = ev.target.value;
  if (mode === 'none') terrain.remove();
  else {
    if (!map.hasLayer(terrain)) terrain.addTo(map);
    terrain.setMode(mode);
  }
  updateTerrainLegend();
  try { localStorage.setItem('walk.terrain', mode); } catch { /* ignore */ }
}));
$('terrain-opacity').addEventListener('input', (ev) => terrain.setOpacity(+ev.target.value));
terrain.on('rangechange', updateTerrainLegend);
map.on('moveend', () => {
  if (map.hasLayer(terrain)) terrain.fitRangeToView();
  updateTerrainLegend();
  try { localStorage.setItem('walk.view', JSON.stringify([map.getCenter(), map.getZoom()])); } catch { /* ignore */ }
});

// Place search (Nominatim)
$('search').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const q = $('search-q').value.trim();
  if (!q) return;
  setStatus('Searching…', 'busy');
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`);
    const [hit] = await res.json();
    if (!hit) { setStatus(`Nothing found for “${q}”.`, 'warn'); return; }
    const [s, n, w, e] = hit.boundingbox.map(Number);
    map.fitBounds([[s, w], [n, e]], { maxZoom: 16 });
    setStatus('');
  } catch (err) {
    setStatus(`Search failed: ${err.message}`, 'error');
  }
});
$('btn-locate').addEventListener('click', () => map.locate({ setView: true, maxZoom: 16 }));
map.on('locationerror', (ev) => setStatus(`Location unavailable: ${ev.message}`, 'warn'));

// ---------------------------------------------------------------- GPX import / export
function exportGpx() {
  if (!state.pts) return;
  const { pts, analysis: a } = state;
  const trkpts = pts.map((p, i) =>
    `<trkpt lat="${p.lat.toFixed(6)}" lon="${p.lng.toFixed(6)}"><ele>${a.elev[i].toFixed(1)}</ele></trkpt>`).join('\n      ');
  const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Walk Hills" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>Walk – ${fmtDist(a.distance)}, ↑${Math.round(a.ascent)} m, ${LEVELS[a.level].name}</name>
    <trkseg>
      ${trkpts}
    </trkseg>
  </trk>
</gpx>
`;
  const url = URL.createObjectURL(new Blob([gpx], { type: 'application/gpx+xml' }));
  const link = Object.assign(document.createElement('a'), { href: url, download: 'walk.gpx' });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function importGpx(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  let nodes = doc.getElementsByTagName('trkpt');
  if (!nodes.length) nodes = doc.getElementsByTagName('rtept');
  const line = [...nodes]
    .map((n) => ({ lat: +n.getAttribute('lat'), lng: +n.getAttribute('lon') }))
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
  if (line.length < 2) { setStatus('No track or route points found in that GPX file.', 'error'); return; }
  state.waypoints.forEach((m) => m.remove());
  state.waypoints = [];
  state.track = line;
  map.fitBounds(L.latLngBounds(line), { padding: [40, 40] });
  scheduleUpdate();
}

// ---------------------------------------------------------------- URL hash (shareable routes)
const routeFragment = () => routeHash({
  waypoints: state.waypoints.map((m) => m.getLatLng()),
  track: state.track,
  mode: state.mode,
  hillWeight: state.hillWeight,
});

function saveHash() {
  const fragment = routeFragment();
  history.replaceState(null, '', fragment ? `#${fragment}` : location.pathname + location.search);
  refreshShare();
}

function loadHash() {
  const route = parseRouteHash(location.hash);
  setMode(route.mode);
  const known = [...$('opt-hills').options].some((o) => +o.value === route.hills);
  state.hillWeight = known ? route.hills : 12;
  $('opt-hills').value = state.hillWeight;

  state.waypoints.forEach((m) => m.remove());
  state.waypoints = [];
  state.track = route.track;
  if (!route.track) route.waypoints.forEach((p) => addWaypoint(L.latLng(p)));
  scheduleUpdate();
  const shown = route.track || route.waypoints;
  if (shown.length) map.fitBounds(L.latLngBounds(shown), { padding: [60, 60], maxZoom: 16 });
}

// ---------------------------------------------------------------- share
const shareableRoute = () => Boolean(state.track) || state.waypoints.length >= 2;

function refreshShare() {
  $('btn-share').disabled = !shareableRoute();
  if (!shareableRoute()) showSharePanel(false);
  if ($('share').hidden) return;

  const url = `${location.origin}${location.pathname}${location.search}#${routeFragment()}`;
  const a = state.analysis;
  const title = a
    ? `Walk route: ${fmtDist(a.distance)}, ↑ ${Math.round(a.ascent)} m climb, ${LEVELS[a.level].name} (${a.level + 1}/5)`
    : 'Walk route';
  $('share-url').value = url;
  $('share-whatsapp').href = `https://wa.me/?text=${encodeURIComponent(`${title}\n${url}`)}`;
  $('share-mail').href = `mailto:?subject=${encodeURIComponent(title)}&body=${encodeURIComponent(`${title}\n\n${url}\n`)}`;
}

function showSharePanel(show) {
  $('share').hidden = !show;
  $('btn-share').setAttribute('aria-expanded', String(show));
}

$('btn-share').addEventListener('click', () => {
  showSharePanel($('share').hidden);
  refreshShare();
});

let copiedTimer;
$('btn-copy').addEventListener('click', async () => {
  const button = $('btn-copy');
  $('share-url').select();
  try {
    await navigator.clipboard.writeText($('share-url').value);
    button.textContent = 'Copied ✓';
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => { button.textContent = 'Copy link'; }, 1500);
  } catch {
    setStatus('Couldn’t reach the clipboard. The link is selected, press Ctrl+C to copy it.', 'warn');
  }
});
$('share-url').addEventListener('focus', (ev) => ev.target.select());

// ---------------------------------------------------------------- start-up
(function init() {
  let view = null;
  try { view = JSON.parse(localStorage.getItem('walk.view')); } catch { /* ignore */ }
  map.setView(view?.[0] ?? [37.7599, -122.4370], view?.[1] ?? 14); // default: San Francisco's hills

  loadHash();
  // Opening a shared link in a tab that already shows the app only changes the fragment, without reloading.
  window.addEventListener('hashchange', loadHash);

  let mode = 'hillshade';
  try { mode = localStorage.getItem('walk.terrain') || mode; } catch { /* ignore */ }
  const radio = document.querySelector(`input[name="terrain"][value="${mode}"]`);
  if (radio) { radio.checked = true; radio.dispatchEvent(new Event('change')); }
})();
