import * as THREE from 'three';
import { App } from 'locar';
import { POIS, FESTIVAL, DEMO_ORIGIN } from './pois.js';
import { makeLabelSprite, KIND } from './labels.js';
import { haversine, bearing, compass16, fmtDist } from './geo.js';

const params = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);
const DEMO = params.has('demo');
const DEBUG = params.has('debug');

// ---- state ----
let app, locar;
let coords = null;
let firstFix = true;
let started = false;
const markers = [];
const captures = [];
let openId = null;
const POI_BY_ID = Object.fromEntries(POIS.map((p) => [p.id, p]));
const walkEta = (m) => Math.max(1, Math.round(m / 80));

// ---- guidance state ----
let arrow = null;
let guideId = null;
let rafId = null;

// ---- debug diagnostics (?debug=1) ------------------------------------------
const dbgLog = [];
function dlog(msg) {
  if (!DEBUG) return;
  dbgLog.push(msg);
  if (dbgLog.length > 6) dbgLog.shift();
  refreshDbg();
}
function refreshDbg() {
  if (!DEBUG) return;
  let el = $('dbg');
  if (!el) {
    el = document.createElement('pre');
    el.id = 'dbg';
    el.style.cssText = `position:fixed;left:6px;top:calc(var(--safe-t) + 108px);z-index:60;max-width:94vw;
      margin:0;padding:8px 10px;background:rgba(0,0,0,0.74);color:#7fffd4;font:11px/1.45 ui-monospace,monospace;
      border-radius:8px;white-space:pre-wrap;pointer-events:none`;
    document.body.appendChild(el);
  }
  const v = document.querySelector('video');
  const s = v && v.srcObject;
  const tr = s && s.getVideoTracks && s.getVideoTracks()[0];
  const set = tr && tr.getSettings ? tr.getSettings() : {};
  const line = [
    `secure=${window.isSecureContext} dpr=${devicePixelRatio}`,
    v ? `video ${v.videoWidth}x${v.videoHeight} rs=${v.readyState} paused=${v.paused}` : 'NO <video> element',
    `srcObject=${s ? 'yes' : 'no'} track=${tr ? (tr.readyState + '/' + (tr.enabled ? 'en' : 'dis')) : 'none'}`,
    set.width ? `stream ${set.width}x${set.height} facing=${set.facingMode || '?'}` : '',
    `canvasBG=${getComputedStyle($('glscene')).backgroundColor}`,
  ].filter(Boolean).join('\n');
  el.textContent = 'DEBUG\n' + line + (dbgLog.length ? '\n' + dbgLog.join('\n') : '');
}
if (DEBUG) {
  window.addEventListener('error', (e) => dlog('JSERR ' + (e.message || e.error)));
  window.addEventListener('unhandledrejection', (e) => dlog('REJECT ' + (e.reason?.message || e.reason)));
}

// ---- start (construct App INSIDE the tap gesture so iOS plays the camera) ---
async function start() {
  if (started) return;
  started = true;
  $('start').style.display = 'none';
  $('hud').style.display = 'flex';
  $('smart').style.display = 'block';
  $('toolbar').style.display = 'flex';

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
  locar = app.locar;

  if (DEBUG) {
    app.webcam.on('webcamstarted', (ev) => dlog(`webcamstarted ${ev.videoWidth}x${ev.videoHeight}`));
    app.webcam.on('webcamerror', (ev) => dlog(`WEBCAM ERR ${ev.code}: ${ev.message}`));
    refreshDbg();
    setInterval(refreshDbg, 1000);
  }

  try {
    await app.start();
    dlog('app.start resolved');
  } catch (err) {
    dlog(`app.start REJECT ${err.code}: ${err.message}`);
    console.warn('AR sensors unavailable:', err);
    banner('Camera or motion unavailable \u2014 use \u2630 Sites for a list & directions.');
  }

  // Belt-and-braces for iOS Safari: inline + muted + play within this gesture.
  const v = document.querySelector('video');
  if (v) { v.muted = true; v.setAttribute('playsinline', ''); v.play().then(() => dlog('video.play() ok')).catch((e) => dlog('video.play() fail ' + e.name)); }

  locar.on('gpserror', (err) => banner(`GPS error (${err.code}). Move outdoors for a clear sky view.`));
  locar.on('gpsupdate', (ev) => {
    coords = ev.position.coords;
    if (firstFix) { addPois(); firstFix = false; }
    refresh();
  });

  updateSmart();
  setInterval(updateSmart, 1000);

  if (DEMO) locar.fakeGps(DEMO_ORIGIN.lon, DEMO_ORIGIN.lat);
  else locar.startGps();
}

// ---- place POI labels (valid only after first fix) ----
function addPois() {
  for (const poi of POIS) {
    const sprite = makeLabelSprite(poi);
    locar.add(sprite, poi.lon, poi.lat, poi.elev ?? 3, { poi });
    markers.push({ poi, sprite });
  }
  dlog(`added ${markers.length} POIs`);
}

// ---- per-fix update ----
function refresh() {
  if (!coords) return;
  let nearest = null, nearestD = Infinity;
  for (const m of markers) {
    const d = haversine(coords.latitude, coords.longitude, m.poi.lat, m.poi.lon);
    m.dist = d;
    const h = Math.min(Math.max(d * 0.1, 5), 120);
    m.sprite.scale.set(h * (m.sprite.aspect || 2), h, 1);
    m.sprite.visible = d < 4000;
    if (m.poi.layer !== 'festival' && d < nearestD) { nearestD = d; nearest = m; }
  }
  if (nearest) {
    const b = bearing(coords.latitude, coords.longitude, nearest.poi.lat, nearest.poi.lon);
    const ic = (KIND[nearest.poi.kind] || KIND.church).icon;
    $('hud-near').textContent = `${ic} ${nearest.poi.name} \u00B7 ${fmtDist(nearestD)} \u00B7 ~${walkEta(nearestD)} min ${compass16(b)}`;
  }
  const acc = Math.round(coords.accuracy);
  $('hud-dot').className = 'dot' + (acc <= 30 ? ' ok' : '');
  $('hud-acc').textContent = `\u00B1${acc} m`;

  if (openId) renderDetail(POI_BY_ID[openId]);
  if (guideId) {
    updateGuideBar();
    const g = POI_BY_ID[guideId];
    const gd = haversine(coords.latitude, coords.longitude, g.lat, g.lon);
    if (gd < 20) { banner(`You\u2019ve reached ${g.name}. \u{1F389}`); stopGuide(); }
  }
  updateSmart();
}

// ---- 3D arrow wayfinding ----------------------------------------------------
let holoEnv = null;
function makeHoloEnv(renderer) {
  if (holoEnv) return holoEnv;
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 512;
  const g = c.getContext('2d');
  const grd = g.createLinearGradient(0, 0, 1024, 512);
  grd.addColorStop(0.00, '#001b3a'); grd.addColorStop(0.22, '#00e5ff');
  grd.addColorStop(0.44, '#7a5cff'); grd.addColorStop(0.62, '#ff2fd0');
  grd.addColorStop(0.80, '#2f7bff'); grd.addColorStop(1.00, '#eaf6ff');
  g.fillStyle = grd; g.fillRect(0, 0, 1024, 512);
  for (const [x, y, r, col] of [[300, 130, 130, 'rgba(255,255,255,0.95)'], [780, 370, 160, 'rgba(190,255,255,0.7)']]) {
    const rg = g.createRadialGradient(x, y, 0, x, y, r);
    rg.addColorStop(0, col); rg.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = rg; g.fillRect(0, 0, 1024, 512);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const rt = pmrem.fromEquirectangular(tex);
  tex.dispose(); pmrem.dispose();
  holoEnv = rt.texture;
  return holoEnv;
}

function ensureArrow() {
  if (arrow) return arrow;
  const env = makeHoloEnv(app.renderer);
  app.scene.environment = env;
  app.scene.add(new THREE.HemisphereLight(0xffffff, 0x223344, 1.1));
  const dir = new THREE.DirectionalLight(0xffffff, 1.4);
  dir.position.set(1, 2, 1);
  app.scene.add(dir);

  const mat = new THREE.MeshPhysicalMaterial({
    color: 0x9fdcff, metalness: 0.15, roughness: 0.06,
    transparent: true, opacity: 0.7, depthWrite: false,
    envMap: env, envMapIntensity: 1.7,
    clearcoat: 1.0, clearcoatRoughness: 0.06,
    iridescence: 1.0, iridescenceIOR: 1.35, iridescenceThicknessRange: [130, 500],
    side: THREE.DoubleSide,
  });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uRim = { value: new THREE.Color(0x7af0ff) };
    shader.fragmentShader = 'uniform vec3 uRim;\n' + shader.fragmentShader.replace(
      '#include <dithering_fragment>',
      `float fres = pow(1.0 - clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0), 3.0);
       gl_FragColor.rgb += uRim * fres * 1.3;
       gl_FragColor.a = clamp(gl_FragColor.a + fres * 0.55, 0.0, 1.0);
       #include <dithering_fragment>`
    );
  };

  arrow = new THREE.Group();
  const shaft = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 1.6), mat);
  shaft.position.z = 0.7;
  const head = new THREE.Mesh(new THREE.ConeGeometry(0.92, 1.4, 6), mat);
  head.rotation.x = -Math.PI / 2;
  head.position.z = -0.78;
  arrow.add(shaft, head);
  arrow.scale.setScalar(0.5);
  arrow.renderOrder = 20;
  arrow.visible = false;
  app.scene.add(arrow);
  return arrow;
}

function startGuide(poi) {
  ensureArrow();
  guideId = poi.id;
  closeSheet();
  $('guide').style.display = 'flex';
  updateGuideBar();
  banner(`Follow the arrow to ${poi.name}.`);
  if (!rafId) tickGuide();
}

function stopGuide() {
  guideId = null;
  if (arrow) arrow.visible = false;
  $('guide').style.display = 'none';
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
}

function tickGuide() {
  rafId = requestAnimationFrame(tickGuide);
  if (!guideId || !arrow || !app) return;
  const m = markers.find((x) => x.poi.id === guideId);
  if (!m) { arrow.visible = false; return; }
  const cam = app.camera;
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
  fwd.y = 0;
  if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
  fwd.normalize();
  const bob = Math.sin(performance.now() / 300) * 0.08;
  arrow.position.copy(cam.position).addScaledVector(fwd, 5);
  arrow.position.y = cam.position.y - 1.0 + bob;
  const tgt = m.sprite.position.clone();
  tgt.y = arrow.position.y;
  arrow.lookAt(tgt);
  arrow.visible = true;
}

function updateGuideBar() {
  const poi = POI_BY_ID[guideId];
  if (!poi) return;
  let txt = poi.name;
  if (coords) {
    const d = haversine(coords.latitude, coords.longitude, poi.lat, poi.lon);
    const b = bearing(coords.latitude, coords.longitude, poi.lat, poi.lon);
    txt = `${poi.name} \u00B7 ${fmtDist(d)} \u00B7 ~${walkEta(d)} min ${compass16(b)}`;
  }
  $('guide-txt').textContent = '\u2794 ' + txt;
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
  $('sheet-body').innerHTML = `
    <h2>${meta.icon} ${poi.name}</h2>
    <p class="alt">${poi.alt}</p>
    <div class="meta"><span class="chip">${poi.year}</span>${dirChip}${approx}</div>
    <p class="desc">${poi.blurb}</p>
    <button class="btn go wide" id="detail-guide">\u2794 Guide me there</button>`;
  $('detail-guide').addEventListener('click', () => startGuide(poi));
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
    return `<div class="site">
      <div class="ic">${meta.icon}</div>
      <div class="main" data-open="${r.poi.id}"><div class="name">${r.poi.name}</div><div class="where">${r.poi.alt}</div></div>
      ${dist}
      <button class="row-guide" data-guide="${r.poi.id}" title="Guide me">\u2794</button>
    </div>`;
  }).join('');
  openSheet(`<h2>Explore &amp; navigate</h2><div>${html}</div>`);
  $('sheet-body').querySelectorAll('[data-open]').forEach((el) =>
    el.addEventListener('click', () => showDetail(POI_BY_ID[el.dataset.open])));
  $('sheet-body').querySelectorAll('[data-guide]').forEach((el) =>
    el.addEventListener('click', () => startGuide(POI_BY_ID[el.dataset.guide])));
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

// ---- adaptive Bonderam banner ----
function distToEvent() {
  if (!coords) return null;
  const { lat, lon } = FESTIVAL.mainEvent;
  const d = haversine(coords.latitude, coords.longitude, lat, lon);
  return { d, eta: walkEta(d), brg: bearing(coords.latitude, coords.longitude, lat, lon) };
}
function fmtCountdown(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h >= 1 ? `${h}h ${String(m).padStart(2, '0')}m` : `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}
const fmtClock = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

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
    html = `<b>Explore Divar</b> \u00B7 tap for the main event`;
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
$('btn-start').addEventListener('click', start);
$('btn-demo').addEventListener('click', () => { DEMO ? start() : (location.search = '?demo=1'); });
$('btn-sites').addEventListener('click', renderSites);
$('btn-capture').addEventListener('click', renderCapture);
$('sheet-close').addEventListener('click', closeSheet);
$('guide-stop').addEventListener('click', stopGuide);
$('smart').addEventListener('click', () => showDetail(POI_BY_ID[FESTIVAL.mainEvent.id]));

if (DEMO) start();
