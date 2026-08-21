import * as THREE from 'three';
import { App } from 'locar';
import { POIS, FESTIVAL, DEMO_ORIGIN } from './pois.js';
import { makeLabelSprite, KIND } from './labels.js';
import { haversine, bearing, compass16, fmtDist } from './geo.js';
import logoUrl from '../qr/bonderam-logo.webp';

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
const chevrons = [];

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
    videoConstraints: { video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } },
    deviceOrientationOptions: { enabled: !DEMO },
    gpsOptions: { gpsMinAccuracy: DEMO ? 1e6 : 100 },
  });
  app.on('objectsIntersected', (e) => {
    const hit = e.intersections.find((i) => i.object?.properties?.poi);
    if (hit) showDetail(hit.object.properties.poi);
  });
  locar = app.locar;

  // iOS: harden the webcam <video> the instant LocAR creates it (still inside the tap).
  const v = document.querySelector('video');
  if (v) {
    v.muted = true; v.defaultMuted = true; v.playsInline = true;
    v.setAttribute('muted', ''); v.setAttribute('playsinline', ''); v.setAttribute('autoplay', '');
  }

  // Always-on camera status so a failure is visible on screen (not only ?debug).
  app.webcam.on('webcamstarted', () => { camStatus(null); if (DEBUG) dlog('webcamstarted'); });
  app.webcam.on('webcamerror', (ev) => {
    camStatus(`Camera blocked (${ev.code}). In Safari tap \u201caA\u201d in the address bar \u2192 Website Settings \u2192 Camera \u2192 Allow, then reload. (Sites & the arrow still work without it.)`);
    if (DEBUG) dlog(`WEBCAM ERR ${ev.code}: ${ev.message}`);
  });
  if (DEBUG) { refreshDbg(); setInterval(refreshDbg, 1000); }

  try {
    await app.start();
    if (DEBUG) dlog('app.start resolved');
  } catch (err) {
    if (DEBUG) dlog(`app.start REJECT ${err.code}: ${err.message}`);
    console.warn('AR sensors unavailable:', err);
  }

  // (re)play within the gesture chain
  if (v) v.play().then(() => { if (DEBUG) dlog('video.play() ok'); }).catch((e) => camStatus(`Camera acquired but couldn\u2019t play (${e.name}). Reload, and close other apps using the camera.`));

  // pre-warm guidance meshes + shaders so the first "Guide me" doesn't hitch in Safari
  ensureArrow();
  ensurePath();
  try { app.renderer.compile(app.scene, app.camera); } catch (e) {}

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

function camStatus(msg) {
  let el = $('camstatus');
  if (!msg) { if (el) el.style.display = 'none'; return; }
  if (!el) {
    el = document.createElement('div');
    el.id = 'camstatus';
    el.style.cssText = 'position:fixed;left:12px;right:12px;top:calc(var(--safe-t) + 108px);z-index:35;' +
      'background:rgba(90,20,32,0.92);border:1px solid #ff6b81;color:#ffdbe1;border-radius:12px;' +
      'padding:11px 14px;font-size:13px;line-height:1.45;backdrop-filter:blur(10px);text-align:center';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.display = 'block';
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
    if (gd < 25) { showArrival(g); }
  }
  updateSmart();
}

function showArrival(poi) {
  stopGuide();
  navigator.vibrate?.([120, 60, 120]);
  const meta = KIND[poi.kind] || KIND.church;
  let el = $('arrive');
  if (!el) {
    el = document.createElement('div');
    el.id = 'arrive';
    el.style.cssText = 'position:fixed;inset:0;z-index:45;display:flex;align-items:center;justify-content:center;' +
      'padding:28px;background:rgba(4,10,8,0.55);backdrop-filter:blur(3px)';
    document.body.appendChild(el);
  }
  el.innerHTML = '<div style="max-width:340px;width:100%;text-align:center;background:var(--panel);' +
    'border:1px solid var(--stroke);border-top:4px solid var(--go);border-radius:20px;padding:26px 22px;' +
    'backdrop-filter:blur(14px)">' +
    '<div style="font-size:46px">\u{1F389}</div>' +
    '<div style="font-size:22px;font-weight:800;margin:6px 0 2px">You\u2019ve arrived!</div>' +
    '<div style="font-size:17px">' + meta.icon + ' ' + poi.name + '</div>' +
    '<div style="color:var(--muted);font-size:13.5px;margin-top:8px;line-height:1.5">' + poi.alt + '</div>' +
    '<div style="display:flex;gap:10px;margin-top:18px">' +
    '<button class="btn go" id="arrive-info" style="flex:1">View details</button>' +
    '<button class="btn" id="arrive-ok" style="flex:1">Done</button></div></div>';
  el.style.display = 'flex';
  $('arrive-info').onclick = () => { el.style.display = 'none'; showDetail(poi); };
  $('arrive-ok').onclick = () => { el.style.display = 'none'; };
}
if (DEBUG && params.get('arrive')) setTimeout(() => { const p = POI_BY_ID[params.get('arrive')]; if (p) showArrival(p); }, 700);

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
  shaft.position.z = -0.7;
  const head = new THREE.Mesh(new THREE.ConeGeometry(0.92, 1.4, 6), mat);
  head.rotation.x = Math.PI / 2;
  head.position.z = 0.78;
  arrow.add(shaft, head);
  arrow.scale.setScalar(1.0);
  arrow.renderOrder = 20;
  arrow.visible = false;
  app.scene.add(arrow);
  return arrow;
}

// ---- ground chevron trail (Maps Live-View style path) ----
const PATH_N = 6, PATH_SPACING = 3.5, PATH_START = 2, PATH_SPEED = 2.0;
// Bonderam festive palette, cycled along the path so it flows as a rainbow.
const PATH_COLORS = [0xffd23f, 0x2fd47a, 0xff2fd0, 0x9a7bff, 0xff77c2, 0x38b6ff, 0xff8a3d];
const PATH_COLOR_OBJS = PATH_COLORS.map((h) => new THREE.Color(h));
function chevronGeom() {
  const g = new THREE.BufferGeometry();
  // flat triangle in the XZ plane, tip toward +Z (three's lookAt aims +Z at target)
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
    0, 0, 0.75, -0.55, 0, -0.45, 0.55, 0, -0.45,
  ]), 3));
  g.computeVertexNormals();
  return g;
}
function ensurePath() {
  if (chevrons.length) return;
  const geo = chevronGeom();
  for (let i = 0; i < PATH_N; i++) {
    const mat = new THREE.MeshBasicMaterial({
      color: PATH_COLORS[i % PATH_COLORS.length], transparent: true, opacity: 0.92,
      side: THREE.DoubleSide, depthWrite: false, depthTest: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.scale.setScalar(4);
    mesh.renderOrder = 15;
    mesh.visible = false;
    app.scene.add(mesh);
    chevrons.push(mesh);
  }
}

function startGuide(poi) {
  // Already at it (e.g. tapped a nearby label)? Skip the arrow, celebrate.
  if (coords && haversine(coords.latitude, coords.longitude, poi.lat, poi.lon) < 25) {
    closeSheet();
    showArrival(poi);
    return;
  }
  ensureArrow();
  ensurePath();
  guideId = poi.id;
  closeSheet();
  $('guide').style.display = 'flex';
  updateGuideBar();
  banner(`Follow the glowing path to ${poi.name}.`);
  if (!rafId) tickGuide();
}

function stopGuide() {
  guideId = null;
  if (arrow) arrow.visible = false;
  for (const c of chevrons) c.visible = false;
  $('guide').style.display = 'none';
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
}

function tickGuide() {
  rafId = requestAnimationFrame(tickGuide);
  if (!guideId || !arrow || !app) return;
  const m = markers.find((x) => x.poi.id === guideId);
  if (!m) { arrow.visible = false; for (const c of chevrons) c.visible = false; return; }
  const cam = app.camera;
  const groundY = cam.position.y - 1.7;

  // path direction: camera -> destination, horizontal
  const pdir = new THREE.Vector3().subVectors(m.sprite.position, cam.position);
  pdir.y = 0;
  const targetDist = pdir.length();
  if (targetDist < 1e-3) pdir.set(0, 0, -1); else pdir.normalize();

  // floating arrow ahead in the look direction, aimed at the target
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
  fwd.y = 0;
  if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
  fwd.normalize();
  const bob = Math.sin(performance.now() / 300) * 0.08;
  arrow.position.copy(cam.position).addScaledVector(fwd, 6);
  arrow.position.y = cam.position.y + 0.4 + bob;
  const at = m.sprite.position.clone(); at.y = arrow.position.y;
  arrow.lookAt(at);
  arrow.visible = true;

  // ground chevrons on the floor, flowing toward the destination
  const flow = (performance.now() / 1000 * PATH_SPEED) % PATH_SPACING;
  const maxD = Math.min(targetDist - 1.5, PATH_START + PATH_N * PATH_SPACING);
  const L = PATH_COLOR_OBJS.length;
  const t = performance.now() / 1000;
  for (let i = 0; i < chevrons.length; i++) {
    const c = chevrons[i];
    const d = PATH_START + flow + i * PATH_SPACING;
    if (d > maxD) { c.visible = false; continue; }
    c.position.copy(cam.position).addScaledVector(pdir, d);
    c.position.y = groundY;
    c.lookAt(c.position.x + pdir.x, groundY, c.position.z + pdir.z);
    // smooth festive colour by world-position + time (seamless across the treadmill recycle)
    const ph = ((d / 5 - t * 0.5) % L + L) % L;
    const a = Math.floor(ph), b = (a + 1) % L;
    c.material.color.copy(PATH_COLOR_OBJS[a]).lerp(PATH_COLOR_OBJS[b], ph - a);
    const fadeIn = Math.min(1, (d - PATH_START) / 3);
    const fadeOut = Math.min(1, (maxD - d) / 4);
    c.material.opacity = 0.92 * Math.max(0, Math.min(fadeIn, fadeOut));
    c.visible = c.material.opacity > 0.02;
  }
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
if ($('start-logo')) $('start-logo').src = logoUrl;
$('btn-sites').addEventListener('click', renderSites);
$('btn-capture').addEventListener('click', renderCapture);
$('sheet-close').addEventListener('click', closeSheet);
$('guide-stop').addEventListener('click', stopGuide);
$('smart').addEventListener('click', () => showDetail(POI_BY_ID[FESTIVAL.mainEvent.id]));

if (DEMO) start();
