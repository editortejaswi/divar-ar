// First-party analytics beacon -> our Cloudflare Worker (divar-analytics).
// Anonymous, device-local session id. No-op until ENDPOINT is set (post-deploy).
const ENDPOINT = '';   // set to https://divar-analytics.<subdomain>.workers.dev after deploy (no-op until then)

const params = new URLSearchParams(location.search);
let sid = localStorage.getItem('divar_sid');
if (!sid) { sid = Date.now().toString(36) + Math.random().toString(36).slice(2, 8); localStorage.setItem('divar_sid', sid); }
// QR scans arrive via /s/ -> /divar-ar/?src=qr ; everything else is "direct".
const src = params.get('src') === 'qr' ? 'qr' : 'direct';
if (params.get('src')) { const u = new URL(location.href); u.searchParams.delete('src'); history.replaceState(null, '', u.pathname + (u.search || '') + u.hash); }

function send(payload) {
  if (!ENDPOINT) return;
  try {
    const body = JSON.stringify({ sid, src, ...payload });
    const blob = new Blob([body], { type: 'text/plain' });   // simple request -> no CORS preflight
    if (navigator.sendBeacon && navigator.sendBeacon(ENDPOINT + '/e', blob)) return;
    fetch(ENDPOINT + '/e', { method: 'POST', body, keepalive: true, mode: 'no-cors' }).catch(() => {});
  } catch (e) { /* never break the app for analytics */ }
}

// one visit per page load
export function analyticsVisit() { send({ kind: 'visit' }); }
// presence beat (only when the tab is visible); carries live location + guided POI if known
export function analyticsBeat(lat, lon, poi) {
  if (document.visibilityState !== 'visible') return;
  send({ kind: 'beat', lat: Number.isFinite(lat) ? lat : null, lon: Number.isFinite(lon) ? lon : null, poi: poi || null });
}
