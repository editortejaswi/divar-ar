import { App } from 'locar';
import { POIS, FESTIVAL, DEMO_ORIGIN } from './pois.js';
import { makeLabelSprite, KIND } from './labels.js';
import { haversine, bearing, compass16, fmtDist } from './geo.js';

const $ = (id) => document.getElementById(id);
const DEMO = new URLSearchParams(location.search).has('demo');

// ---- state ----
let app, locar;
let coords = null;          // { latitude, longitude, accuracy }
let firstFix = true;
let started = false;
const markers = [];         // { poi, sprite, dist }
const captures = [];        // { lat, lon, acc }
let openId = null;          // POI id currently shown in the sheet
const POI_BY_ID = Object.fromEntries(POIS.map((p) => [p.id, p]));

// walking ETA in minutes at ~4.8 km/h (80 m/min), straight-line.
const walkEta = (m) => Math.max(1, Math.round(m / 80));

// ---- build the AR app ----
function build() {
  app = new App({
    cameraOptions: { hFov: 80, near: 0.1, far: 8000 },
    canvas: $('glscene'),
    deviceOrientationOptions: { enabled: !DEMO },
    gpsOptions: { gpsMinAccuracy: DEMO ? 1e6 : 100 },
  });

  app.on('objectsIntersected', (e) => {
    const hit = e.intersections.find((i) => i.object?.properties?.poi);
    if (hit) showDetail(hit.object.properties.poi);
  });
}

// ---- start (must be called from a user gesture for iOS permissions) ----
async function start() {
  if (started) return;
  started = true;
  $('start').style.display = 'none';
  $('hud').style.display = 'flex';
  $('smart').style.display = 'block';
  $('toolbar').style.display = 'flex';

  locar = app.locar;
  try {
    await app.start();
  } catch (err) {
    console.warn('AR sensors unavailable:', err);
    banner('Camera or motion unavailable \u2014 use \u2630 Sites for a list & directions.');
  }

  locar.on('gpserror', (err) => banner(`GPS error (${err.code}). Move outdoors for a clear sky view.`));

  locar.on('gpsupdate', (ev) => {
    coords = ev.position.coords;
    if (firstFix) { addPois(); firstFix = false; }
    refresh();
  });

  updateSmart();
  setInterval(updateSmart, 1000); // keep the countdown ticking

  if (DEMO) locar.fakeGps(DEMO_ORIGIN.lon, DEMO_ORIGIN.lat);
  else locar.startGps();
}

// ---- place every POI as a floating label (only valid after first fix) ----
function addPois() {
  for (const poi of POIS) {
    const sprite = makeLabelSprite(poi);
    locar.add(sprite, poi.lon, poi.lat, poi.elev ?? 3, { poi });
    markers.push({ poi, sprite });
  }
}

// ---- per-fix update: constant-apparent-size labels + HUD ----
function refresh() {
  if (!coords) return;
  let nearest = null;
  let nearestD = Infinity;

  for (const m of markers) {
    const d = haversine(coords.latitude, coords.longitude, m.poi.lat, m.poi.lon);
    m.dist = d;
    const h = Math.min(Math.max(d * 0.1, 5), 120);
    m.sprite.scale.set(h * (m.sprite.aspect || 2), h, 1);
    m.sprite.visible = d < 4000;
    // The nearest label for the HUD prefers something to *explore* (heritage).
    if (m.poi.layer !== 'festival' && d < nearestD) { nearestD = d; nearest = m; }
  }

  if (nearest) {
    const b = bearing(coords.latitude, coords.longitude, nearest.poi.lat, nearest.poi.lon);
    const ic = (KIND[nearest.poi.kind] || KIND.church).icon;
    $('hud-near').textContent =
      `${ic} ${nearest.poi.name} \u00B7 ${fmtDist(nearestD)} \u00B7 ~${walkEta(nearestD)} min ${compass16(b)}`;
  }
  const acc = Math.round(coords.accuracy);
  $('hud-dot').className = 'dot' + (acc <= 30 ? ' ok' : '');
  $('hud-acc').textContent = `\u00B1${acc} m`;

  if (openId) renderDetail(POI_BY_ID[openId]);
  updateSmart();
}

// ---- adaptive Bonderam banner: countdown + distance + ETA to main event ----
function distToEvent() {
  if (!coords) return null;
  const { lat, lon } = FESTIVAL.mainEvent;
  const d = haversine(coords.latitude, coords.longitude, lat, lon);
  return { d, eta: walkEta(d), brg: bearing(coords.latitude, coords.longitude, lat, lon) };
}

function fmtCountdown(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h >= 1
    ? `${h}h ${String(m).padStart(2, '0')}m`
    : `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

const fmtClock = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

function nearestExploreHint() {
  if (!coords || !markers.length) return '';
  let best = null, bestD = Infinity;
  for (const m of markers) {
    if (m.poi.layer === 'festival') continue;
    const d = m.dist ?? haversine(coords.latitude, coords.longitude, m.poi.lat, m.poi.lon);
    if (d < bestD) { bestD = d; best = m; }
  }
  return best ? `nearest: ${best.poi.name} \u00B7 ${fmtDist(bestD)} (~${walkEta(bestD)} min)` : '';
}

function updateSmart() {
  const el = $('smart');
  if (!el || el.style.display === 'none') return;
  const now = Date.now();
  const start = Date.parse(FESTIVAL.startsAt);
  const end = Date.parse(FESTIVAL.endsAt);
  const de = distToEvent();
  const where = de ? `${fmtDist(de.d)} ${compass16(de.brg)} \u00B7 ~${de.eta} min walk` : '';

  let phase, html;
  if (now >= end) {
    phase = 'after';
    const hint = nearestExploreHint();
    html = `<b>Explore Divar</b>${hint ? ' \u00B7 ' + hint : ' \u00B7 tap for sites'}`;
  } else if (now >= start) {
    phase = 'live';
    const floaty = now < Date.parse(FESTIVAL.floatAt) ? 'float parade at 4 PM' : 'float parade underway';
    html = `<b>\u{1F389} Bonderam is LIVE</b> \u00B7 ${de ? 'main event ' + where : floaty}`;
  } else {
    const ms = start - now;
    if (ms <= 6 * 3600 * 1000 && de) {
      phase = 'soon';
      const leaveBy = new Date(start - de.eta * 60 * 1000);
      html = `<b>\u23F3 Starts in ${fmtCountdown(ms)}</b> \u00B7 you\u2019re ${where} \u00B7 leave by ${fmtClock(leaveBy)}`;
    } else {
      phase = 'before';
      html = `<b>\u{1F6A9} Bonderam in ${fmtCountdown(ms)}</b> \u00B7 ${de ? 'main event ' + where : 'Sat 22 Aug, 3 PM'}`;
    }
  }
  el.dataset.phase = phase;
  el.innerHTML = html;
}

// ---- bottom sheet ----
function openSheet(html) { $('sheet-body').innerHTML = html; $('sheet').classList.add('open'); }
function closeSheet() { $('sheet').classList.remove('open'); openId = null; }
function showDetail(poi) { openId = poi.id; renderDetail(poi); $('sheet').classList.add('open'); }

function renderDetail(poi) {
  if (!poi) return;
  const meta = KIND[poi.kind] || KIND.church;
  let dirChip = '';
  if (coords) {
    const d = haversine(coords.latitude, coords.longitude, poi.lat, poi.lon);
    const b = bearing(coords.latitude, coords.longitude, poi.lat, poi.lon);
    dirChip = `<span class="chip strong">${fmtDist(d)} ${compass16(b)} \u00B7 ~${walkEta(d)} min</span>`;
  }
  const approx = poi.verified ? '' : `<span class="chip">\u25B3 approx location</span>`;
  const hint = poi.verified ? '' :
    `<p class="desc" style="color:var(--muted);font-size:13px">Approximate coordinate.
      Stand at the spot and tap <b>&#128205; Capture</b> to record the exact position.</p>`;
  $('sheet-body').innerHTML = `
    <h2>${meta.icon} ${poi.name}</h2>
    <p class="alt">${poi.alt}</p>
    <div class="meta"><span class="chip">${poi.year}</span>${dirChip}${approx}</div>
    <p class="desc">${poi.blurb}</p>
    ${hint}`;
}

function renderSites() {
  const rows = markers.length ? markers.slice() : POIS.map((poi) => ({ poi, dist: null }));
  if (coords) {
    for (const r of rows) r.dist = haversine(coords.latitude, coords.longitude, r.poi.lat, r.poi.lon);
    rows.sort((a, b) => a.dist - b.dist);
  }
  const html = rows.map((r) => {
    const meta = KIND[r.poi.kind] || KIND.church;
    let dist = '';
    if (r.dist != null) {
      const b = bearing(coords.latitude, coords.longitude, r.poi.lat, r.poi.lon);
      dist = `<div class="dist"><div class="d">${fmtDist(r.dist)}</div><div class="b">~${walkEta(r.dist)} min ${compass16(b)}</div></div>`;
    }
    return `<div class="site" data-id="${r.poi.id}">
      <div class="ic">${meta.icon}</div>
      <div><div class="name">${r.poi.name}</div><div class="where">${r.poi.alt}</div></div>
      ${dist}
    </div>`;
  }).join('');
  openSheet(`<h2>Explore &amp; navigate</h2><div>${html}</div>`);
  $('sheet-body').querySelectorAll('.site').forEach((el) => {
    el.addEventListener('click', () => showDetail(POI_BY_ID[el.dataset.id]));
  });
}

// ---- on-site coordinate capture ----
function renderCapture() {
  const list = captures.length
    ? captures.map((c, i) =>
        `<div class="cap-row"><span class="n">${i + 1}</span>
          <span>${c.lat.toFixed(6)}, ${c.lon.toFixed(6)}</span>
          <span style="margin-left:auto;color:var(--muted)">\u00B1${Math.round(c.acc)} m</span>
        </div>`).join('')
    : `<p class="cap-empty">Stand at a spot, wait for accuracy below ~10 m, then tap
        <b>Capture reading</b>. Copy the JSON back into <code>src/pois.js</code>.</p>`;
  openSheet(`
    <h2>&#128205; Capture location</h2>
    <div>${list}</div>
    <div class="cap-actions">
      <button class="btn" id="cap-read">Capture reading</button>
      <button class="btn" id="cap-copy">Copy JSON</button>
      <button class="btn" id="cap-clear">Clear</button>
    </div>`);
  $('cap-read').addEventListener('click', captureReading);
  $('cap-copy').addEventListener('click', () => {
    const json = JSON.stringify(
      captures.map((c) => ({ lat: +c.lat.toFixed(6), lon: +c.lon.toFixed(6), acc: Math.round(c.acc) })), null, 2);
    navigator.clipboard?.writeText(json).then(
      () => banner('Coordinates copied to clipboard.'),
      () => banner('Copy failed \u2014 values are in the list above.'));
  });
  $('cap-clear').addEventListener('click', () => { captures.length = 0; renderCapture(); });
}

function captureReading() {
  if (!navigator.geolocation) return banner('Geolocation not supported.');
  banner('Reading GPS\u2026');
  navigator.geolocation.getCurrentPosition(
    (pos) => { captures.push({ lat: pos.coords.latitude, lon: pos.coords.longitude, acc: pos.coords.accuracy }); renderCapture(); },
    (err) => banner(`GPS error (${err.code}).`),
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
}

// ---- transient banner ----
let bannerTimer;
function banner(msg) {
  let el = $('banner');
  if (!el) {
    el = document.createElement('div');
    el.id = 'banner';
    el.style.cssText = `position:fixed;left:12px;right:12px;top:calc(var(--safe-t) + 108px);
      z-index:30;background:var(--panel);border:1px solid var(--stroke);border-radius:12px;
      padding:10px 14px;font-size:13px;backdrop-filter:blur(10px);text-align:center`;
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.display = 'block';
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => { el.style.display = 'none'; }, 4200);
}

// ---- wire UI ----
build();
$('btn-start').addEventListener('click', start);
$('btn-demo').addEventListener('click', () => { DEMO ? start() : (location.search = '?demo=1'); });
$('btn-sites').addEventListener('click', renderSites);
$('btn-capture').addEventListener('click', renderCapture);
$('sheet-close').addEventListener('click', closeSheet);
$('smart').addEventListener('click', () => showDetail(POI_BY_ID[FESTIVAL.mainEvent.id]));

if (DEMO) start();
