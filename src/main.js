import * as THREE from 'three';
import { App } from 'locar';
import { POIS, FESTIVAL, DEMO_ORIGIN } from './pois.js';
import { makeLabelSprite, KIND } from './labels.js';
import { haversine, bearing, compass16, fmtDist } from './geo.js';
import logoUrl from '../qr/bonderam-logo.webp';
import { relAngle, cueFor, nearestOnPoly, alongPoly } from './guide-math.js';
import mapUrl from './divar-map.webp';
import { ROUTES, ROUTE_DEST } from './routes.js';
import { analyticsVisit, analyticsBeat } from './analytics.js';

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
let voiceOn = false;      // AR voice disabled (logic kept; toggle hidden). Flip true + unhide #ar-voice to re-enable.
let vCue = '', vAt = 0, vDist = null; // last spoken cue / time / distance
let sCam = null;          // smoothed camera XZ (low-pass GPS jitter so the ground path doesn't snap/flicker)

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
  await applyOverrides();   // pull live on-site coordinate captures from the repo before first render

  setInterval(updateFest, 1000);
  showHub();
  if (DEMO) locar.fakeGps(DEMO_ORIGIN.lon, DEMO_ORIGIN.lat); else locar.startGps();
  if (params.get('arrive')) setTimeout(() => showArrival(POI_BY_ID[params.get('arrive')] || POI_BY_ID[ROUTE_DEST]), 1500); // preview: ?arrive=main-event
  if (params.has('fov')) { app.camera.fov = +params.get('fov') || 65; app.camera.updateProjectionMatrix(); } // preview real-phone FOV headlessly
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
    m.sprite.visible = !celebrating && d < 4000;
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

// Fixed Web-Mercator projection matching the stitched OSM map (src/divar-map.png).
const MAP = { z: 14, x0: 11553, y0: 7474, wpx: 1280, hpx: 1280 };
function mapProject(lat, lon) {
  const n = 2 ** MAP.z;
  const xt = (lon + 180) / 360 * n;
  const r = (lat * Math.PI) / 180;
  const yt = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
  return [((xt - MAP.x0) * 256) / MAP.wpx * 100, ((yt - MAP.y0) * 256) / MAP.hpx * 100];
}

function renderHubMap() {
  hubProj = mapProject;
  const el = $('hub-map');
  el.style.height = 'auto'; el.style.minHeight = '0'; el.style.flex = 'none'; el.style.maxWidth = '520px'; el.style.margin = '0 auto';
  const mks = POIS.map((poi, i) => {
    const [x, y] = mapProject(poi.lat, poi.lon);
    const ic = (KIND[poi.kind] || KIND.church).icon;
    const short = poi.name.replace('Church of ', '').split(' ').slice(0, 2).join(' ');
    const z = poi.id === 'main-event' ? 6 : poi.id === 'piedade-church' ? 1 : 3; // Bonderam foreground, church behind
    return `<button class="mk ${y < 12 ? 'up' : ''}" data-go="${poi.id}" style="left:${x}%;top:${y}%;z-index:${z}">
      <span class="dot" style="--c:${FEST_CSS[i % FEST_CSS.length]}">${ic}</span><span class="lbl">${short}</span></button>`;
  }).join('');
  el.innerHTML = `<img src="${mapUrl}" alt="Map of Divar Island" style="display:block;width:100%;height:auto">`
    + `<div class="sweep"></div>${mks}<div class="me" id="me-dot" style="display:none"></div>`
    + `<div style="position:absolute;right:6px;bottom:5px;z-index:8;font-size:9px;color:#0a1020;background:rgba(255,255,255,0.62);padding:1px 5px;border-radius:5px">\u00A9 OpenStreetMap</div>`;
  positionMe();
  el.querySelectorAll('[data-go]').forEach((x) => x.addEventListener('click', () => chooseDest(POI_BY_ID[x.dataset.go])));
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
  rows.sort((a, b) => {
    if (a.poi.id === 'main-event') return -1;   // Bonderam 2026 always first
    if (b.poi.id === 'main-event') return 1;
    return coords ? a.d - b.d : 0;              // rest by distance
  });
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
  if (coords) { const me = POI_BY_ID['main-event'] || FESTIVAL.mainEvent; const d = haversine(coords.latitude, coords.longitude, me.lat, me.lon);
    txt += `<br>main event \u00B7 ${fmtDist(d)} \u00B7 ${eta(d)} min ${modeIcon()}`; }
  el.innerHTML = txt;
}
// ---- voice guidance (Web Speech) ----
function speak(text) {
  if (!voiceOn || !('speechSynthesis' in window)) return;
  try { speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(text); u.rate = 1; u.lang = 'en-US'; speechSynthesis.speak(u); } catch (e) {}
}
const CUE_PHRASE = { straight: 'Straight ahead', right: 'Head right', left: 'Head left', around: 'Turn around' };
function guideVoice(relAng, dist) {
  if (DEBUG) window.__voice = { relAng: Math.round(relAng), dist: Math.round(dist), cue: cueFor(relAng, vCue) };
  if (!voiceOn) return;
  const now = performance.now();
  const cue = cueFor(relAng, vCue);
  const progressed = vDist != null && (vDist - dist) >= 40;   // re-announce every ~40 m closer
  if ((cue !== vCue || progressed) && now - vAt > 5000) {     // hard 5 s min gap
    speak(`${CUE_PHRASE[cue]}${dist ? `, ${fmtDist(dist)} to go` : ''}`);
    vCue = cue; vAt = now; vDist = dist;
  }
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
  analyticsBeat(coords && coords.latitude, coords && coords.longitude, poi.id);
  updateArBar();
  vCue = ''; vDist = null; vAt = performance.now();
  if (coords) { const d = haversine(coords.latitude, coords.longitude, poi.lat, poi.lon);
    speak(`Guiding you to ${poi.name}, ${fmtDist(d)} away.`); }
  else speak(`Guiding you to ${poi.name}.`);
  if (!rafId) tickGuide();
}
function stopGuide() {
  guideId = null; vCue = ''; sCam = null;
  stopCelebration();
  if ('speechSynthesis' in window) { try { speechSynthesis.cancel(); } catch (e) {} }
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
const PATH_N = 6, PATH_SPACING = 6.5, PATH_START = 2.5, PATH_SPEED = 2.0;
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
    const mesh = new THREE.Mesh(geo, mat); mesh.scale.setScalar(4); mesh.renderOrder = 15 + i; mesh.visible = false;
    app.scene.add(mesh); chevrons.push(mesh);
  }
}
// ---- road-following (baked OSRM routes; see routes.js) ----
const _routeCache = {};   // id -> { poly, lat, lon } (rebuilt only when the venue coord changes)
const _camXZ = new THREE.Vector2();
function routeWorldPoly(id) {
  const base = ROUTES[id]; if (!base) return null;
  const venue = POI_BY_ID[ROUTE_DEST];
  const end = base[base.length - 1];
  if (venue && haversine(end[0], end[1], venue.lat, venue.lon) > 50) return null; // venue re-published far away -> route stale
  const c = _routeCache[id];
  if (c && (!venue || (c.lat === venue.lat && c.lon === venue.lon))) return c.poly;
  try {
    const poly = base.map(([lat, lon]) => { const [x, z] = locar.lonLatToWorldCoords(lon, lat); return { x, z }; });
    if (venue) { const [x, z] = locar.lonLatToWorldCoords(venue.lon, venue.lat); poly[poly.length - 1] = { x, z }; } // end at the live marker
    if (poly.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.z))) return null;
    _routeCache[id] = { poly, lat: venue ? venue.lat : null, lon: venue ? venue.lon : null };
    return poly;
  } catch (e) { return null; }   // origin not set yet
}
function pickRoute(px, pz) {
  let best = null;
  for (const id of Object.keys(ROUTES)) {
    const poly = routeWorldPoly(id); if (!poly) continue;
    const np = nearestOnPoly(px, pz, poly);
    if (!best || np.dist < best.np.dist) best = { id, poly, np };
  }
  return best && best.np.dist < 80 ? best : null;   // follow the road only when within 80 m of it
}
function tickGuide() {
  rafId = requestAnimationFrame(tickGuide);
  if (!guideId || !arrow || !app) return;
  const m = markers.find((x) => x.poi.id === guideId);
  if (!m) { arrow.visible = false; for (const c of chevrons) c.visible = false; return; }
  const cam = app.camera, groundY = cam.position.y - 1.7, t = performance.now() / 1000, L = PATH_COLOR_OBJS.length;
  const bob = Math.sin(performance.now() / 300) * 0.08;
  if (!sCam) sCam = new THREE.Vector2(cam.position.x, cam.position.z);
  else sCam.lerp(_camXZ.set(cam.position.x, cam.position.z), 0.12);
  const camFwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion); camFwd.y = 0;
  if (camFwd.lengthSq() < 1e-6) camFwd.set(0, 0, -1); camFwd.normalize();

  const route = guideId === ROUTE_DEST ? pickRoute(sCam.x, sCam.y) : null;
  if (DEBUG) dlog('route=' + (route ? route.id + ' d' + route.np.dist.toFixed(0) : 'straight'));
  const flow = (t * PATH_SPEED) % PATH_SPACING;

  // arrow points along the road (next turn) when on a route, else straight at the POI
  let tgt;
  if (route) { const la = alongPoly(route.poly, route.np.seg, route.np.t, 9); tgt = new THREE.Vector3(la.x, groundY, la.z); }
  else tgt = m.sprite.position.clone();
  arrow.position.set(cam.position.x + camFwd.x * 6, cam.position.y + 0.4 + bob, cam.position.z + camFwd.z * 6);
  arrow.lookAt(tgt.x, arrow.position.y, tgt.z); arrow.visible = true;

  const eul = new THREE.Euler().setFromQuaternion(cam.quaternion, 'YXZ');
  guideVoice(relAngle(eul.y, tgt.x - sCam.x, tgt.z - sCam.y), Math.hypot(m.sprite.position.x - sCam.x, m.sprite.position.z - sCam.y));

  if (route) {
    for (let i = 0; i < chevrons.length; i++) {
      const c = chevrons[i], d = PATH_START + flow + i * PATH_SPACING, p = alongPoly(route.poly, route.np.seg, route.np.t, d);
      c.position.set(p.x, groundY, p.z); c.lookAt(p.x + p.dx, groundY, p.z + p.dz);
      const ph = ((d / 5 - t * 0.5) % L + L) % L, a = Math.floor(ph), b = (a + 1) % L;
      c.material.color.copy(PATH_COLOR_OBJS[a]).lerp(PATH_COLOR_OBJS[b], ph - a);
      c.material.opacity = 0.92 * Math.min(1, (d - PATH_START) / 3) * (p.end ? 0 : 1);
      c.visible = c.material.opacity > 0.02;
    }
  } else {
    const pdir = new THREE.Vector3(m.sprite.position.x - sCam.x, 0, m.sprite.position.z - sCam.y);
    const targetDist = pdir.length(); if (targetDist < 1e-3) pdir.set(0, 0, -1); else pdir.normalize();
    const maxD = Math.min(targetDist - 1.5, PATH_START + PATH_N * PATH_SPACING);
    for (let i = 0; i < chevrons.length; i++) {
      const c = chevrons[i], d = PATH_START + flow + i * PATH_SPACING;
      if (d > maxD) { c.visible = false; continue; }
      c.position.set(sCam.x + pdir.x * d, groundY, sCam.y + pdir.z * d);
      c.lookAt(c.position.x + pdir.x, groundY, c.position.z + pdir.z);
      const ph = ((d / 5 - t * 0.5) % L + L) % L, a = Math.floor(ph), b = (a + 1) % L;
      c.material.color.copy(PATH_COLOR_OBJS[a]).lerp(PATH_COLOR_OBJS[b], ph - a);
      const fadeIn = Math.min(1, (d - PATH_START) / 3), fadeOut = Math.min(1, (maxD - d) / 4);
      c.material.opacity = 0.9 * Math.max(0, Math.min(fadeIn, fadeOut));
      c.visible = c.material.opacity > 0.02;
    }
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
  speak(`You have arrived at ${poi.name}.`);
  if (poi.id === ROUTE_DEST) return celebrateArrival(poi);   // festive 3D AR celebration at the venue
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

// ================= 3D festive arrival (balloons + confetti + hovering banner) =================
let celebRaf = null, celebText = null, celebConfetti = null, celebAnchor = null, celebLast = 0, celebrating = false;
const celebBalloons = [];
const CELEB_PAL = [0xffd23f, 0x2fd47a, 0xff2fd0, 0x9a7bff, 0xff77c2, 0x38b6ff, 0xff8a3d, 0xff5a5a];
function celebrateArrival(poi) {
  $('arbar').style.display = 'none'; $('hub').style.display = 'none';
  startCelebration();
  let el = $('celeb-ctl');
  if (!el) { el = document.createElement('div'); el.id = 'celeb-ctl';
    el.style.cssText = 'position:fixed;left:14px;right:14px;bottom:calc(var(--safe-b) + 18px);z-index:55;display:flex;gap:10px;justify-content:center';
    document.body.appendChild(el); }
  el.innerHTML = `<button class="btn go" id="cb-info" style="flex:1;max-width:210px">${(KIND[poi.kind] || KIND.church).icon} View details</button>`
    + `<button class="btn" id="cb-map" style="flex:1;max-width:210px">\u2039 Back to map</button>`;
  el.style.display = 'flex';
  $('cb-info').onclick = () => { stopCelebration(); showHub(); showDetail(poi); };
  $('cb-map').onclick = () => { stopCelebration(); showHub(); };
}
function makeArrivedPlaque() {
  const grp = new THREE.Group();
  const W = 2.4, H = 0.92, D = 0.16;
  const frame = new THREE.Mesh(new THREE.BoxGeometry(W + 0.14, H + 0.14, D * 0.62),
    new THREE.MeshStandardMaterial({ color: 0xffd23f, metalness: 0.9, roughness: 0.22, emissive: 0x3a2a00, emissiveIntensity: 0.25 }));
  frame.position.z = -0.03;
  const body = new THREE.Mesh(new THREE.BoxGeometry(W, H, D),
    new THREE.MeshStandardMaterial({ color: 0x121826, metalness: 0.4, roughness: 0.35, emissive: 0x0a1024, emissiveIntensity: 0.35 }));
  const c = document.createElement('canvas'); c.width = 1024; c.height = 384; const g = c.getContext('2d');
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = '120px serif'; g.fillText('\u{1F389}', 126, 150); g.fillText('\u{1F388}', 898, 150);
  g.fillStyle = '#ffffff'; g.font = 'bold 96px system-ui, sans-serif'; g.fillText('You\u2019ve arrived!', 512, 142);
  g.fillStyle = '#ffd23f'; g.font = 'bold 64px system-ui, sans-serif'; g.fillText('Bonderam 2026', 512, 250);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
  const face = new THREE.Mesh(new THREE.PlaneGeometry(W * 0.92, H * 0.86),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
  face.position.z = D / 2 + 0.003;
  grp.add(frame, body, face);
  return grp;
}
function makeBalloonTex(hex) {
  const c = document.createElement('canvas'); c.width = 512; c.height = 256; const g = c.getContext('2d');
  g.fillStyle = '#' + hex.toString(16).padStart(6, '0'); g.fillRect(0, 0, 512, 256);
  const grd = g.createLinearGradient(0, 0, 0, 256);
  grd.addColorStop(0, 'rgba(255,255,255,0.28)'); grd.addColorStop(0.5, 'rgba(255,255,255,0)'); grd.addColorStop(1, 'rgba(0,0,0,0.18)');
  g.fillStyle = grd; g.fillRect(0, 0, 512, 256);
  g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = 'bold 48px system-ui, sans-serif';
  const gold = (y) => { const gg = g.createLinearGradient(0, y - 26, 0, y + 26); gg.addColorStop(0, '#fff6c2'); gg.addColorStop(0.45, '#ffd23f'); gg.addColorStop(0.55, '#f4b400'); gg.addColorStop(1, '#9c6b08'); return gg; };
  g.lineWidth = 3; g.strokeStyle = 'rgba(70,48,0,0.55)';   // dark-gold outline for legibility on any balloon
  for (const x of [128, 384]) {
    g.fillStyle = gold(98); g.strokeText('Viva', x, 98); g.fillText('Viva', x, 98);
    g.fillStyle = gold(156); g.strokeText('Bonderam', x, 156); g.fillText('Bonderam', x, 156);
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t;
}
function startCelebration() {
  if (!app) return;
  ensureArrow();                 // guarantees scene lights + environment for glossy balloons
  stopCelebration();             // guard re-entry (no double batch)
  celebrating = true; for (const m of markers) m.sprite.visible = false;   // hide POI labels during the celebration
  const cam = app.camera;
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion); fwd.y = 0;
  if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1); fwd.normalize();
  celebAnchor = cam.position.clone(); const ay = celebAnchor.y;
  celebText = makeArrivedPlaque();
  celebText.position.set(celebAnchor.x + fwd.x * 4.5, ay + 0.55, celebAnchor.z + fwd.z * 4.5);
  celebText.userData.baseYaw = Math.atan2(-fwd.x, -fwd.z);   // front (+Z) faces the user
  celebText.rotation.y = celebText.userData.baseYaw;
  app.scene.add(celebText);
  for (let i = 0; i < 16; i++) {
    const col = CELEB_PAL[i % CELEB_PAL.length], grp = new THREE.Group();
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.4, 28, 20),
      new THREE.MeshStandardMaterial({ map: makeBalloonTex(col), roughness: 0.18, metalness: 0, emissive: col, emissiveIntensity: 0.03 }));
    body.scale.set(1, 1.18, 1);
    const str = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.9, 6),
      new THREE.MeshBasicMaterial({ color: 0xdddddd, transparent: true, opacity: 0.45 }));
    str.position.y = -0.72; grp.add(body, str);
    const fa = Math.atan2(fwd.z, fwd.x), a = fa + (Math.random() - 0.5) * 3.0, rad = 3 + Math.random() * 6;
    grp.position.set(celebAnchor.x + Math.cos(a) * rad, ay - 1.5 + Math.random() * 3.2, celebAnchor.z + Math.sin(a) * rad);
    grp.userData = { vy: 0.5 + Math.random() * 0.7, sw: 0.3 + Math.random() * 0.4, ph: Math.random() * 6.28, bx: grp.position.x, bz: grp.position.z };
    app.scene.add(grp); celebBalloons.push(grp);
  }
  const N = 300, pos = new Float32Array(N * 3), col = new Float32Array(N * 3), vel = new Float32Array(N), phase = new Float32Array(N), c3 = new THREE.Color();
  for (let i = 0; i < N; i++) {
    pos[i * 3] = celebAnchor.x + (Math.random() - 0.5) * 22;
    pos[i * 3 + 1] = ay + 3 + Math.random() * 10;
    pos[i * 3 + 2] = celebAnchor.z + (Math.random() - 0.5) * 22;
    c3.set(CELEB_PAL[Math.floor(Math.random() * CELEB_PAL.length)]); col[i * 3] = c3.r; col[i * 3 + 1] = c3.g; col[i * 3 + 2] = c3.b;
    vel[i] = 0.8 + Math.random() * 1.5; phase[i] = Math.random() * 6.28;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  celebConfetti = new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.06, sizeAttenuation: true, vertexColors: true, transparent: true, opacity: 0.95, depthWrite: false }));
  celebConfetti.userData = { vel, phase, N, ay }; celebConfetti.renderOrder = 28; app.scene.add(celebConfetti);
  celebLast = performance.now(); celebrateTick();
}
function celebrateTick() {
  celebRaf = requestAnimationFrame(celebrateTick);
  const now = performance.now(), dt = Math.min(0.05, (now - celebLast) / 1000), t = now / 1000; celebLast = now;
  for (const grp of celebBalloons) {
    const u = grp.userData; grp.position.y += u.vy * dt;
    grp.position.x = u.bx + Math.sin(t * u.sw + u.ph) * 0.35;
    grp.position.z = u.bz + Math.cos(t * u.sw * 0.8 + u.ph) * 0.35;
    grp.rotation.z = Math.sin(t * u.sw + u.ph) * 0.12;
    if (grp.position.y > celebAnchor.y + 16) grp.position.y = celebAnchor.y - 2;
  }
  if (celebConfetti) {
    const p = celebConfetti.geometry.attributes.position.array, u = celebConfetti.userData;
    for (let i = 0; i < u.N; i++) {
      p[i * 3 + 1] -= u.vel[i] * dt;
      p[i * 3] += Math.sin(t * 2 + u.phase[i]) * 0.012;
      p[i * 3 + 2] += Math.cos(t * 1.7 + u.phase[i]) * 0.012;
      if (p[i * 3 + 1] < u.ay - 2) p[i * 3 + 1] = u.ay + 9 + Math.random() * 2;
    }
    celebConfetti.geometry.attributes.position.needsUpdate = true;
  }
  if (celebText) {
    celebText.position.y = celebAnchor.y + 0.55 + Math.sin(t * 1.4) * 0.07;
    celebText.rotation.y = celebText.userData.baseYaw + Math.sin(t * 0.6) * 0.28;   // turn to show its 3D depth
    celebText.rotation.x = Math.sin(t * 0.9) * 0.05;
  }
}
function stopCelebration() {
  if (celebRaf) { cancelAnimationFrame(celebRaf); celebRaf = null; }
  const rm = (o) => { if (!o || !app) return; app.scene.remove(o); o.traverse((n) => { if (n.geometry) n.geometry.dispose(); if (n.material) { (Array.isArray(n.material) ? n.material : [n.material]).forEach((m) => { if (m.map) m.map.dispose(); m.dispose(); }); } }); };
  celebBalloons.forEach(rm); celebBalloons.length = 0;
  rm(celebConfetti); celebConfetti = null;
  rm(celebText); celebText = null;
  const el = $('celeb-ctl'); if (el) el.style.display = 'none';
  celebrating = false; for (const m of markers) if (m.dist != null) m.sprite.visible = m.dist < 4000;   // restore POI labels
}

function renderCapture() {
  if (!capSel) capSel = POIS[0]?.id;
  const opts = POIS.map((p) => `<option value="${p.id}"${p.id === capSel ? ' selected' : ''}>${p.verified ? '\u2713' : '\u25B3'} ${p.name}</option>`).join('');
  const last = [...captures].reverse().find((c) => c.id === capSel);
  const tok = ghToken();
  const list = captures.length
    ? captures.map((c, i) => `<div class="cap-row"><span class="n">${i + 1}</span><span>${c.name}: ${c.lat.toFixed(6)}, ${c.lon.toFixed(6)}</span><span style="margin-left:auto;color:var(--muted)">\u00B1${Math.round(c.acc)} m</span></div>`).join('')
    : '<p class="cap-empty">Pick the place you\u2019re standing at, wait for accuracy under ~10 m, tap Capture, then Publish live.</p>';
  openSheet(`<h2>\u{1F4CD} Add / fix a place</h2>
    <p class="cap-empty" style="margin:0 0 8px">Which place are you standing at?</p>
    <select id="c-poi" style="width:100%;padding:12px;border-radius:12px;background:var(--panel2,#141a26);color:var(--text,#eaf1ff);border:1px solid var(--stroke,#243044);font-size:15px;margin-bottom:10px">${opts}</select>
    <div>${list}</div>
    <div class="cap-actions">
      <button class="btn" id="c-read">\u{1F4E1} Capture here</button>
      <button class="btn go" id="c-pub"${last ? '' : ' disabled style="opacity:.5"'}>\u2B06 Publish live</button>
      <button class="btn" id="c-copy">Copy JSON</button>
    </div>
    <p class="cap-empty" style="margin-top:10px;font-size:12px;line-height:1.5">
      ${last ? `Ready: <b>${last.name}</b> \u2192 ${last.lat.toFixed(6)}, ${last.lon.toFixed(6)}. ` : ''}
      ${tok ? 'Publish sends it straight to the live site (\u2248 1 min). ' : 'Publishing needs a one-time GitHub token \u2014 stored only on this phone. '}
      <a id="c-tok" style="color:var(--go);text-decoration:underline;cursor:pointer">${tok ? 'change / remove token' : 'set token'}</a>
    </p>`);
  $('c-poi').addEventListener('change', (e) => { capSel = e.target.value; renderCapture(); });
  $('c-read').addEventListener('click', captureReading);
  $('c-pub').addEventListener('click', () => publishOverride(capSel));
  $('c-copy').addEventListener('click', () => navigator.clipboard?.writeText(JSON.stringify(captures.map((c) => ({ id: c.id, lat: +c.lat.toFixed(6), lon: +c.lon.toFixed(6) })), null, 2)).then(() => banner('Copied.'), () => banner('Copy failed.')));
  $('c-tok').addEventListener('click', () => {
    if (ghToken()) { if (confirm('Remove the saved GitHub token from this device?')) { localStorage.removeItem('divar_gh_token'); banner('Token removed.'); } }
    else promptToken();
    renderCapture();
  });
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

// ---- live capture publishing (client -> GitHub; token stays on the operator's device) ----
const REPO = 'editortejaswi/divar-ar', OVR_PATH = 'public/overrides.json';
const b64enc = (s) => btoa(unescape(encodeURIComponent(s)));
const b64dec = (s) => decodeURIComponent(escape(atob(s.replace(/\s/g, ''))));
const ghToken = () => localStorage.getItem('divar_gh_token') || '';
function promptToken() {
  const t = prompt('Paste a GitHub token (fine-grained: Contents \u2192 Read and write on the divar-ar repo). Stored only on this phone.');
  if (t && t.trim()) { localStorage.setItem('divar_gh_token', t.trim()); return t.trim(); }
  return '';
}
async function applyOverrides() {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 3000);   // don't let a slow 4G fetch freeze startup
  try {
    const r = await fetch(`${import.meta.env.BASE_URL}overrides.json?t=${Date.now()}`, { cache: 'no-store', signal: ac.signal });
    if (!r.ok) return;
    const ov = await r.json();
    for (const [id, o] of Object.entries(ov)) {
      const poi = POI_BY_ID[id];
      if (poi && Number.isFinite(o.lat) && Number.isFinite(o.lon)) { poi.lat = o.lat; poi.lon = o.lon; poi.verified = true; }
    }
  } catch (e) {} finally { clearTimeout(t); }
}
async function publishOverride(poiId) {
  const c = [...captures].reverse().find((x) => x.id === poiId);
  if (!c) return banner('Capture a reading here first.');
  let tok = ghToken(); if (!tok) { tok = promptToken(); if (!tok) return; }
  banner('Publishing\u2026');
  const api = `https://api.github.com/repos/${REPO}/contents/${OVR_PATH}`;
  const headers = { Authorization: `Bearer ${tok}`, Accept: 'application/vnd.github+json' };
  try {
    let sha, data = {};
    const g = await fetch(`${api}?ref=main&t=${Date.now()}`, { headers, cache: 'no-store' });
    if (g.status === 200) { const j = await g.json(); sha = j.sha; try { data = JSON.parse(b64dec(j.content)); } catch (e) { data = {}; } }
    else if (g.status === 401 || g.status === 403) return banner('Token rejected or missing Contents write \u2014 tap \u201cchange token\u201d.');
    else if (g.status !== 404) throw new Error('read ' + g.status);
    data[poiId] = { lat: +c.lat.toFixed(6), lon: +c.lon.toFixed(6), acc: Math.round(c.acc), ts: Date.now() };
    const body = { message: `Capture ${poiId} -> ${data[poiId].lat},${data[poiId].lon}`, content: b64enc(JSON.stringify(data, null, 2) + '\n'), branch: 'main' };
    if (sha) body.sha = sha;
    const p = await fetch(api, { method: 'PUT', headers, body: JSON.stringify(body) });
    if (p.status === 401 || p.status === 403) return banner('Token rejected or missing Contents write \u2014 tap \u201cchange token\u201d.');
    if (!p.ok) throw new Error('write ' + p.status);
    const poi = POI_BY_ID[poiId]; if (poi) { poi.lat = data[poiId].lat; poi.lon = data[poiId].lon; poi.verified = true; }
    if ($('hub').style.display !== 'none') { renderHubMap(); renderHubList(); }
    banner(`Published ${poi ? poi.name : poiId}. Live on the site in \u2248 1 min.`);
  } catch (e) { banner('Publish failed: ' + e.message); }
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
if ($('ar-voice')) $('ar-voice').style.display = 'none';   // voice disabled: keep logic, hide the toggle
$('ar-name').addEventListener('click', () => { if (guideId) showDetail(POI_BY_ID[guideId]); });
$('sheet-close').addEventListener('click', closeSheet);
$('hub-explore').addEventListener('click', openExplore);
$('hub-capture').addEventListener('click', renderCapture);
if (!params.has('admin')) $('hub-capture').style.display = 'none';   // operator-only: open ?admin=1
$('mode').querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => {
  mode = b.dataset.mode;
  $('mode').querySelectorAll('[data-mode]').forEach((x) => x.classList.toggle('on', x === b));
  renderHubList(); updateFest();
}));

if (DEMO) start();

// ---- analytics: count this visit, and beat presence every 120s while visible (D1 free-tier friendly) ----
analyticsVisit();
setInterval(() => analyticsBeat(coords && coords.latitude, coords && coords.longitude, guideId), 120000);
