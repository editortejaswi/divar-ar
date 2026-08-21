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
let app, locar, coords = null, firstFix = true, started = false;
const markers = [];       // { poi, sprite, dist }
const captures = [];
let openId = null;        // poi shown in detail sheet
let guideId = null;       // poi currently guided to (AR)
let arrow = null;
const chevrons = [];
let hubProj = null;
let capSel = null;        // poi id selected in the capture tool

// ---- travel mode + ETA ----
const SPEED = { walk: 80, drive: 350 };   // metres / minute (~4.8 & ~21 km/h)
const ARRIVE_R = 10;                       // metres - "you've arrived" radius (was 25)
let mode = 'walk';
const eta = (m) => Math.max(1, Math.round(m / SPEED[mode]));
const modeIcon = () => (mode === 'walk' ? '\u{1F6B6}' : '\u{1F697}');

// ---- debug ----
const dbgLog = [];
function dlog(m) { if (!DEBUG) return; dbgLog.push(m); if (dbgLog.length > 6) dbgLog.shift(); refreshDbg(); }
function refreshDbg() {
  if (!DEBUG) return;
  let el = $('dbg');
  if (!el) { el = document.createElement('pre'); el.id = 'dbg';
    el.style.cssText = 'position:fixed;left:6px;top:calc(var(--safe-t) + 64px);z-index:70;max-width:94vw;margin:0;padding:8px 10px;background:rgba(0,0,0,0.74);color:#7fffd4;font:11px/1.45 ui-monospace,monospace;white-space:pre-wrap;border-radius:8px;pointer-events:none';
    document.body.appendChild(el); }
  const v = document.querySelector('video'); const s = v && v.srcObject; const tr = s && s.getVideoTracks && s.getVideoTracks()[0];
  el.textContent = 'DEBUG\n' + [
    `secure=${window.isSecureContext}`,
    v ? `video ${v.videoWidth}x${v.videoHeight} paused=${v.paused}` : 'no <video>',
    `track=${tr ? tr.readyState : 'none'}`, ...dbgLog].join('\n');
}
if (DEBUG) window.addEventListener('error', (e) => dlog('ERR ' + (e.message || e.error)));

// ---- start (build App inside the tap gesture so iOS plays the camera) ----
async function start() {
  if (started) return; started = true;
  $('start').style.display = 'none';

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

  const v = document.querySelector('video');
  if (v) { v.muted = true; v.defaultMuted = true; v.playsInline = true;
    v.setAttribute('muted', ''); v.setAttribute('playsinline', ''); v.setAttribute('autoplay', ''); }

  app.webcam.on('webcamerror', (ev) => camStatus(`Camera blocked (${ev.code}). In Safari tap \u201caA\u201d \u2192 Website Settings \u2192 Camera \u2192 Allow, then reload.`));
  if (DEBUG) { refreshDbg(); setInterval(refreshDbg, 1000); }

  try { await app.start(); } catch (err) { dlog('start reject ' + err.code); }
  if (v) v.play().catch((e) => camStatus(`Camera couldn\u2019t start (${e.name}). Reload / close other camera apps.`));

  // pre-warm guidance shaders so the first guide doesn't hitch
  ensureArrow(); ensurePath();
  try { app.renderer.compile(app.scene, app.camera); } catch (e) {}

  locar.on('gpserror', (err) => camStatus(`GPS error (${err.code}). Move outdoors for clear sky.`));
  locar.on('gpsupdate', (ev) => { coords = ev.position.coords; if (firstFix) { addPois(); firstFix = false; } refresh(); });

  setInterval(updateFest, 1000);
  showHub();
  if (DEMO) locar.fakeGps(DEMO_ORIGIN.lon, DEMO_ORIGIN.lat); else locar.startGps();
}

function addPois() {
  for (const poi of POIS) {
    const sprite = makeLabelSprite(poi);
    locar.add(sprite, poi.lon, poi.lat, poi.elev ?? 3, { poi });
    markers.push({ poi, sprite });
  }
}

// ---- per-fix update ----
function refresh() {
  if (!coords) return;
  for (const m of markers) {
    const d = haversine(coords.latitude, coords.longitude, m.poi.lat, m.poi.lon);
    m.dist = d;
    const h = Math.min(Math.max(d * 0.1, 5), 120);
    m.sprite.scale.set(h * (m.sprite.aspect || 2), h, 1);
    m.sprite.visible = d < 4000;
  }
  if (guideId) {
    updateArBar();
    const g = POI_BY_ID[guideId];
    if (haversine(coords.latitude, coords.longitude, g.lat, g.lon) < ARRIVE_R) showArrival(g);
  }
  if ($('hub').style.display !== 'none') { renderHubList(); positionMe(); }
  updateFest();
}
const POI_BY_ID = Object.fromEntries(POIS.map((p) => [p.id, p]));

// ================= HUB (map-first landing) =================
function showHub() {
  stopGuide();
  $('arbar').style.display = 'none';
  $('hub').style.display = 'flex';
  renderHubMap(); renderHubList(); updateFest();
}

function projector(pts) {
  const lats = pts.map((p) => p.lat), lons = pts.map((p) => p.lon);
  const meanLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const k = Math.cos((meanLat * Math.PI) / 180) || 1;
  const xs = lons.map((l) => l * k);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...lats), maxY = Math.max(...lats);
  const spanX = (maxX - minX) || 1e-6, spanY = (maxY - minY) || 1e-6, pad = 15;
  const scale = Math.min((100 - 2 * pad) / spanX, (100 - 2 * pad) / spanY);
  const ox = (100 - spanX * scale) / 2, oy = (100 - spanY * scale) / 2;
  return (lat, lon) => [ox + (lon * k - minX) * scale, oy + (maxY - lat) * scale];
}

function renderHubMap() {
  const pts = POIS.slice();
  if (coords) pts.push({ lat: coords.latitude, lon: coords.longitude });
  hubProj = projector(pts);
  const mks = POIS.map((poi, i) => {
    const [x, y] = hubProj(poi.lat, poi.lon);
    const ic = (KIND[poi.kind] || KIND.church).icon;
    const short = poi.name.replace('Church of ', '').split(' ').slice(0, 2).join(' ');
    const z = poi.id === 'main-event' ? 6 : poi.id === 'piedade-church' ? 1 : 3; // Bonderam foreground, church behind
    return `<button class="mk ${y < 20 ? 'up' : ''}" data-go="${poi.id}" style="left:${x}%;top:${y}%;z-index:${z}">
      <span class="dot" style="--c:${FEST_CSS[i % FEST_CSS.length]}">${ic}</span><span class="lbl">${short}</span></button>`;
  }).join('');
  $('hub-map').innerHTML = `<div class="grid"></div><div class="sweep"></div>${mks}<div class="me" id="me-dot" style="display:none"></div>`;
  positionMe();
  $('hub-map').querySelectorAll('[data-go]').forEach((el) => el.addEventListener('click', () => chooseDest(POI_BY_ID[el.dataset.go])));
}
function positionMe() {
  const me = $('me-dot'); if (!me || !hubProj) return;
  if (!coords) { me.style.display = 'none'; return; }
  const [x, y] = hubProj(coords.latitude, coords.longitude);
  me.style.left = x + '%'; me.style.top = y + '%'; me.style.display = 'block';
}
const FEST_CSS = ['#ffd23f', '#2fd47a', '#ff2fd0', '#9a7bff', '#ff77c2', '#38b6ff', '#ff8a3d'];

function renderHubList() {
  const rows = POIS.map((poi) => ({ poi, d: coords ? haversine(coords.latitude, coords.longitude, poi.lat, poi.lon) : null }));
  if (coords) rows.sort((a, b) => a.d - b.d);
  $('hub-list').innerHTML = rows.map(({ poi, d }, i) => {
    const meta = KIND[poi.kind] || KIND.church;
    const rt = d != null
      ? `<div class="rt"><div class="d">${fmtDist(d)}</div><div class="e">${eta(d)} min ${modeIcon()}</div></div>`
      : `<div class="rt muted">\u2014</div>`;
    return `<div class="pcard" data-go="${poi.id}">
      <div class="ic" style="--c:${FEST_CSS[i % FEST_CSS.length]}">${meta.icon}</div>
      <div class="txt"><div class="nm">${poi.name}</div><div class="wh">${poi.alt}${poi.verified ? '' : ' \u00B7 <span style="color:#ffd23f;font-weight:600">\u25B3 approx</span>'}</div></div>${rt}</div>`;
  }).join('');
  $('hub-list').querySelectorAll('[data-go]').forEach((el) => el.addEventListener('click', () => chooseDest(POI_BY_ID[el.dataset.go])));
}

function fmtCountdown(ms) {
  const s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h >= 1 ? `${h}h ${String(m).padStart(2, '0')}m` : `${String(m).padStart(2, '0')}m`;
}
function updateFest() {
  const el = $('hub-fest'); if (!el) return;
  const now = Date.now(), sT = Date.parse(FESTIVAL.startsAt), eT = Date.parse(FESTIVAL.endsAt);
  let txt = now >= eT ? 'Bonderam \u2014 till next year'
    : now >= sT ? '\u{1F389} Bonderam is LIVE'
    : `\u{1F6A9} Bonderam in ${fmtCountdown(sT - now)}`;
  if (coords) { const d = haversine(coords.latitude, coords.longitude, FESTIVAL.mainEvent.lat, FESTIVAL.mainEvent.lon);
    txt += `<br>main event \u00B7 ${fmtDist(d)} \u00B7 ${eta(d)} min ${modeIcon()}`; }
  el.innerHTML = txt;
}

// ================= AR guidance =================
function chooseDest(poi) {
  $('hub').style.display = 'none';
  $('arbar').style.display = 'flex';
  if (coords && haversine(coords.latitude, coords.longitude, poi.lat, poi.lon) < ARRIVE_R) { showArrival(poi); return; }
  startGuide(poi);
}
function openExplore() {
  $('hub').style.display = 'none';
  $('arbar').style.display = 'flex';
  stopGuide();
  $('ar-name').textContent = 'Exploring Divar';
  $('ar-eta').textContent = 'Look around \u2014 tap \u2039 for the map';
}
function startGuide(poi) {
  ensureArrow(); ensurePath();
  guideId = poi.id;
  updateArBar();
  if (!rafId) tickGuide();
}
function stopGuide() {
  guideId = null;
  if (arrow) arrow.visible = false;
  for (const c of chevrons) c.visible = false;
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
}
function updateArBar() {
  const poi = POI_BY_ID[guideId]; if (!poi) return;
  const meta = KIND[poi.kind] || KIND.church;
  $('ar-name').innerHTML = `${meta.icon} ${poi.name}${poi.verified ? '' : ' <span style="color:#ffd23f" title="approximate location">\u25B3</span>'}`;
  if (coords) {
    const d = haversine(coords.latitude, coords.longitude, poi.lat, poi.lon);
    const b = bearing(coords.latitude, coords.longitude, poi.lat, poi.lon);
    $('ar-eta').textContent = `${fmtDist(d)} \u00B7 ${eta(d)} min ${modeIcon()} \u00B7 ${compass16(b)}`;
  } else $('ar-eta').textContent = 'Locating\u2026';
}

let rafId = null;
let holoEnv = null;
function makeHoloEnv(renderer) {
  if (holoEnv) return holoEnv;
  const c = document.createElement('canvas'); c.width = 1024; c.height = 512; const g = c.getContext('2d');
  const grd = g.createLinearGradient(0, 0, 1024, 512);
  grd.addColorStop(0.00, '#001b3a'); grd.addColorStop(0.22, '#00e5ff'); grd.addColorStop(0.44, '#7a5cff');
  grd.addColorStop(0.62, '#ff2fd0'); grd.addColorStop(0.80, '#2f7bff'); grd.addColorStop(1.00, '#eaf6ff');
  g.fillStyle = grd; g.fillRect(0, 0, 1024, 512);
  for (const [x, y, r, col] of [[300, 130, 130, 'rgba(255,255,255,0.95)'], [780, 370, 160, 'rgba(190,255,255,0.7)']]) {
    const rg = g.createRadialGradient(x, y, 0, x, y, r); rg.addColorStop(0, col); rg.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = rg; g.fillRect(0, 0, 1024, 512);
  }
  const tex = new THREE.CanvasTexture(c); tex.mapping = THREE.EquirectangularReflectionMapping; tex.colorSpace = THREE.SRGBColorSpace;
  const pmrem = new THREE.PMREMGenerator(renderer); const rt = pmrem.fromEquirectangular(tex); tex.dispose(); pmrem.dispose();
  holoEnv = rt.texture; return holoEnv;
}
function ensureArrow() {
  if (arrow) return arrow;
  const env = makeHoloEnv(app.renderer);
  app.scene.environment = env;
  app.scene.add(new THREE.HemisphereLight(0xffffff, 0x223344, 1.1));
  const dir = new THREE.DirectionalLight(0xffffff, 1.4); dir.position.set(1, 2, 1); app.scene.add(dir);
  const mat = new THREE.MeshPhysicalMaterial({ color: 0x9fdcff, metalness: 0.15, roughness: 0.06, transparent: true, opacity: 0.7,
    depthWrite: false, envMap: env, envMapIntensity: 1.7, clearcoat: 1.0, clearcoatRoughness: 0.06,
    iridescence: 1.0, iridescenceIOR: 1.35, iridescenceThicknessRange: [130, 500], side: THREE.DoubleSide });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uRim = { value: new THREE.Color(0x7af0ff) };
    sh.fragmentShader = 'uniform vec3 uRim;\n' + sh.fragmentShader.replace('#include <dithering_fragment>',
      'float fres = pow(1.0 - clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0), 3.0);\n gl_FragColor.rgb += uRim * fres * 1.3;\n gl_FragColor.a = clamp(gl_FragColor.a + fres * 0.55, 0.0, 1.0);\n #include <dithering_fragment>');
  };
  arrow = new THREE.Group();
  const shaft = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 1.6), mat); shaft.position.z = -0.7;
  const head = new THREE.Mesh(new THREE.ConeGeometry(0.92, 1.4, 6), mat); head.rotation.x = Math.PI / 2; head.position.z = 0.78;
  arrow.add(shaft, head); arrow.scale.setScalar(1.0); arrow.renderOrder = 20; arrow.visible = false;
  app.scene.add(arrow);
  return arrow;
}
const PATH_N = 4, PATH_SPACING = 6.5, PATH_START = 2.5, PATH_SPEED = 2.0;
const PATH_COLORS = [0xffd23f, 0x2fd47a, 0xff2fd0, 0x9a7bff, 0xff77c2, 0x38b6ff, 0xff8a3d];
const PATH_COLOR_OBJS = PATH_COLORS.map((h) => new THREE.Color(h));
function chevGeom() {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0.75, -0.55, 0, -0.45, 0.55, 0, -0.45]), 3));
  g.computeVertexNormals(); return g;
}
function ensurePath() {
  if (chevrons.length) return;
  const geo = chevGeom();
  for (let i = 0; i < PATH_N; i++) {
    const mat = new THREE.MeshBasicMaterial({ color: 0x39e0a0, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false, depthTest: false });
    const mesh = new THREE.Mesh(geo, mat); mesh.scale.setScalar(4); mesh.renderOrder = 15; mesh.visible = false;
    app.scene.add(mesh); chevrons.push(mesh);
  }
}
function tickGuide() {
  rafId = requestAnimationFrame(tickGuide);
  if (!guideId || !arrow || !app) return;
  const m = markers.find((x) => x.poi.id === guideId);
  if (!m) { arrow.visible = false; for (const c of chevrons) c.visible = false; return; }
  const cam = app.camera; const groundY = cam.position.y - 1.7;
  const pdir = new THREE.Vector3().subVectors(m.sprite.position, cam.position); pdir.y = 0;
  const targetDist = pdir.length(); if (targetDist < 1e-3) pdir.set(0, 0, -1); else pdir.normalize();
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion); fwd.y = 0;
  if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1); fwd.normalize();
  const bob = Math.sin(performance.now() / 300) * 0.08;
  arrow.position.copy(cam.position).addScaledVector(fwd, 6); arrow.position.y = cam.position.y + 0.4 + bob;
  const at = m.sprite.position.clone(); at.y = arrow.position.y; arrow.lookAt(at); arrow.visible = true;
  const flow = (performance.now() / 1000 * PATH_SPEED) % PATH_SPACING;
  const maxD = Math.min(targetDist - 1.5, PATH_START + PATH_N * PATH_SPACING);
  const L = PATH_COLOR_OBJS.length, t = performance.now() / 1000;
  for (let i = 0; i < chevrons.length; i++) {
    const c = chevrons[i]; const d = PATH_START + flow + i * PATH_SPACING;
    if (d > maxD) { c.visible = false; continue; }
    c.position.copy(cam.position).addScaledVector(pdir, d); c.position.y = groundY;
    c.lookAt(c.position.x + pdir.x, groundY, c.position.z + pdir.z);
    const ph = ((d / 5 - t * 0.5) % L + L) % L, a = Math.floor(ph), b = (a + 1) % L;
    c.material.color.copy(PATH_COLOR_OBJS[a]).lerp(PATH_COLOR_OBJS[b], ph - a);
    const fadeIn = Math.min(1, (d - PATH_START) / 3), fadeOut = Math.min(1, (maxD - d) / 4);
    c.material.opacity = 0.9 * Math.max(0, Math.min(fadeIn, fadeOut));
    c.visible = c.material.opacity > 0.02;
  }
}

// ================= detail / arrival / capture (bottom sheet) =================
function openSheet(html) { $('sheet-body').innerHTML = html; $('sheet').classList.add('open'); }
function closeSheet() { $('sheet').classList.remove('open'); openId = null; }
function showDetail(poi) {
  openId = poi.id;
  const meta = KIND[poi.kind] || KIND.church;
  let dirChip = '';
  if (coords) { const d = haversine(coords.latitude, coords.longitude, poi.lat, poi.lon);
    const b = bearing(coords.latitude, coords.longitude, poi.lat, poi.lon);
    dirChip = `<span class="chip strong">${fmtDist(d)} ${compass16(b)} \u00B7 ${eta(d)} min ${modeIcon()}</span>`; }
  const approx = poi.verified ? '' : '<span class="chip">\u25B3 approx location</span>';
  openSheet(`<h2>${meta.icon} ${poi.name}</h2><p class="alt">${poi.alt}</p>
    <div class="meta"><span class="chip">${poi.year}</span>${dirChip}${approx}</div>
    <p class="desc">${poi.blurb}</p>
    <button class="btn go wide" id="d-go">\u2794 Guide me there</button>`);
  $('d-go').addEventListener('click', () => { closeSheet(); chooseDest(poi); });
}
function showArrival(poi) {
  stopGuide(); navigator.vibrate?.([120, 60, 120]);
  const meta = KIND[poi.kind] || KIND.church;
  let el = $('arrive');
  if (!el) { el = document.createElement('div'); el.id = 'arrive';
    el.style.cssText = 'position:fixed;inset:0;z-index:55;display:flex;align-items:center;justify-content:center;padding:28px;background:rgba(4,10,8,0.55);backdrop-filter:blur(3px)';
    document.body.appendChild(el); }
  el.innerHTML = '<div style="max-width:340px;width:100%;text-align:center;background:var(--panel);border:1px solid var(--stroke);border-top:4px solid var(--go);border-radius:20px;padding:26px 22px;backdrop-filter:blur(14px)">'
    + '<div style="font-size:46px">\u{1F389}</div><div style="font-size:22px;font-weight:800;margin:6px 0 2px">You\u2019ve arrived!</div>'
    + '<div style="font-size:17px">' + meta.icon + ' ' + poi.name + '</div>'
    + '<div style="color:var(--muted);font-size:13.5px;margin-top:8px;line-height:1.5">' + poi.alt + '</div>'
    + '<div style="display:flex;gap:10px;margin-top:18px"><button class="btn go" id="a-info" style="flex:1">View details</button><button class="btn" id="a-map" style="flex:1">Back to map</button></div></div>';
  el.style.display = 'flex';
  $('a-info').onclick = () => { el.style.display = 'none'; showDetail(poi); };
  $('a-map').onclick = () => { el.style.display = 'none'; showHub(); };
}

function renderCapture() {
  if (!capSel) capSel = POIS[0]?.id;
  const opts = POIS.map((p) => `<option value="${p.id}"${p.id === capSel ? ' selected' : ''}>${p.verified ? '\u2713' : '\u25B3'} ${p.name}</option>`).join('');
  const list = captures.length
    ? captures.map((c, i) => `<div class="cap-row"><span class="n">${i + 1}</span><span>${c.name}: ${c.lat.toFixed(6)}, ${c.lon.toFixed(6)}</span><span style="margin-left:auto;color:var(--muted)">\u00B1${Math.round(c.acc)} m</span></div>`).join('')
    : '<p class="cap-empty">Pick the place you\u2019re standing at, wait for accuracy under ~10 m, then Capture. Paste the JSON into <code>src/pois.js</code>.</p>';
  openSheet(`<h2>\u{1F4CD} Add / fix a place</h2>
    <p class="cap-empty" style="margin:0 0 8px">Which place are you standing at?</p>
    <select id="c-poi" style="width:100%;padding:12px;border-radius:12px;background:var(--panel2,#141a26);color:var(--text,#eaf1ff);border:1px solid var(--stroke,#243044);font-size:15px;margin-bottom:10px">${opts}</select>
    <div>${list}</div>
    <div class="cap-actions"><button class="btn" id="c-read">Capture here</button><button class="btn" id="c-copy">Copy JSON</button><button class="btn" id="c-clear">Clear</button></div>`);
  $('c-poi').addEventListener('change', (e) => { capSel = e.target.value; });
  $('c-read').addEventListener('click', captureReading);
  $('c-copy').addEventListener('click', () => navigator.clipboard?.writeText(JSON.stringify(captures.map((c) => ({ id: c.id, lat: +c.lat.toFixed(6), lon: +c.lon.toFixed(6) })), null, 2)).then(() => banner('Copied.'), () => banner('Copy failed.')));
  $('c-clear').addEventListener('click', () => { captures.length = 0; renderCapture(); });
}
function captureReading() {
  if (!navigator.geolocation) return banner('No geolocation.');
  const id = $('c-poi')?.value || capSel; capSel = id;
  const name = POI_BY_ID[id]?.name || id;
  banner('Reading GPS\u2026');
  navigator.geolocation.getCurrentPosition(
    (p) => { captures.push({ id, name, lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy }); renderCapture(); },
    (e) => banner(`GPS error (${e.code}).`), { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
}

let bannerTimer;
function banner(msg) {
  let el = $('banner');
  if (!el) { el = document.createElement('div'); el.id = 'banner';
    el.style.cssText = 'position:fixed;left:12px;right:12px;top:calc(var(--safe-t) + 64px);z-index:50;background:var(--panel);border:1px solid var(--stroke);border-radius:12px;padding:10px 14px;font-size:13px;backdrop-filter:blur(10px);text-align:center';
    document.body.appendChild(el); }
  el.textContent = msg; el.style.display = 'block';
  clearTimeout(bannerTimer); bannerTimer = setTimeout(() => { el.style.display = 'none'; }, 4000);
}
function camStatus(msg) {
  let el = $('camstatus');
  if (!el) { el = document.createElement('div'); el.id = 'camstatus';
    el.style.cssText = 'position:fixed;left:12px;right:12px;top:calc(var(--safe-t) + 64px);z-index:50;background:rgba(90,20,32,0.92);border:1px solid #ff6b81;color:#ffdbe1;border-radius:12px;padding:11px 14px;font-size:13px;line-height:1.45;backdrop-filter:blur(10px);text-align:center';
    document.body.appendChild(el); }
  el.textContent = msg; el.style.display = 'block';
}

// ---- wire UI ----
if ($('start-logo')) $('start-logo').src = logoUrl;
$('btn-start').addEventListener('click', start);
$('ar-back').addEventListener('click', showHub);
$('ar-stop').addEventListener('click', showHub);
$('ar-name').addEventListener('click', () => { if (guideId) showDetail(POI_BY_ID[guideId]); });
$('sheet-close').addEventListener('click', closeSheet);
$('hub-explore').addEventListener('click', openExplore);
$('hub-capture').addEventListener('click', renderCapture);
$('mode').querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => {
  mode = b.dataset.mode;
  $('mode').querySelectorAll('[data-mode]').forEach((x) => x.classList.toggle('on', x === b));
  renderHubList(); updateFest();
}));

if (DEMO) start();
