// Divar AR analytics Worker — beacon ingest (/e) + stats API (/api/stats).
// The dashboard (/, index.html) is served from ./public via the assets binding.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'content-type',
};
const json = (o, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json', ...CORS } });

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

    // ---- beacon ingest (fire-and-forget from the app) ----
    if (url.pathname === '/e' && req.method === 'POST') {
      try {
        const b = JSON.parse(await req.text());
        const sid = String(b.sid || '').slice(0, 40);
        if (sid) {
          await env.DB.prepare(
            'INSERT INTO events (ts,kind,sid,src,poi,lat,lon,country) VALUES (?,?,?,?,?,?,?,?)'
          ).bind(
            Date.now(),
            b.kind === 'beat' ? 'beat' : 'visit',
            sid,
            b.src === 'qr' ? 'qr' : 'direct',
            b.poi ? String(b.poi).slice(0, 40) : null,
            Number.isFinite(b.lat) ? b.lat : null,
            Number.isFinite(b.lon) ? b.lon : null,
            (req.cf && req.cf.country) || null
          ).run();
        }
      } catch (e) { /* never fail a beacon */ }
      return new Response(null, { status: 204, headers: CORS });
    }

    // ---- stats API (key-gated) ----
    if (url.pathname === '/api/stats') {
      if ((url.searchParams.get('key') || '') !== env.DASH_KEY) return json({ error: 'unauthorized' }, 401);
      const now = Date.now(), dayAgo = now - 86400000, live = now - 90000;
      const sod = (() => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); return d.getTime(); })();
      const first = (sql, ...a) => env.DB.prepare(sql).bind(...a).first();
      const all = (sql, ...a) => env.DB.prepare(sql).bind(...a).all();

      const totals = await first(
        `SELECT COUNT(DISTINCT sid) uniq,
                COUNT(DISTINCT CASE WHEN kind='visit' THEN sid END) visitors,
                SUM(kind='visit') visits,
                SUM(kind='visit' AND src='qr') scans,
                SUM(kind='visit' AND src='direct') direct
         FROM events`);
      const today = await first(
        `SELECT COUNT(DISTINCT CASE WHEN kind='visit' THEN sid END) visitors,
                SUM(kind='visit') visits,
                SUM(kind='visit' AND src='qr') scans
         FROM events WHERE ts>=?`, sod);
      const active = await first(`SELECT COUNT(DISTINCT sid) n FROM events WHERE ts>=?`, live);
      const locs = await all(
        `SELECT sid, lat, lon, MAX(ts) ts, poi FROM events WHERE ts>=? AND lat IS NOT NULL GROUP BY sid`, live);
      const hourly = await all(
        `SELECT CAST(ts/3600000 AS INTEGER) hr, COUNT(DISTINCT sid) n
         FROM events WHERE ts>=? AND kind='visit' GROUP BY hr ORDER BY hr`, dayAgo);
      const countries = await all(
        `SELECT country, COUNT(DISTINCT sid) n FROM events
         WHERE kind='visit' AND country IS NOT NULL GROUP BY country ORDER BY n DESC LIMIT 8`);
      const pois = await all(
        `SELECT poi, COUNT(DISTINCT sid) n FROM events
         WHERE poi IS NOT NULL GROUP BY poi ORDER BY n DESC LIMIT 12`);

      return json({
        now, totals, today, active: active.n,
        live: locs.results, hourly: hourly.results,
        countries: countries.results, pois: pois.results,
      });
    }

    return new Response('Not found', { status: 404 });
  },

  // daily prune — keep beats 2 days, visits 1 year (storage + reads stay tiny)
  async scheduled(evt, env) {
    const now = Date.now();
    await env.DB.prepare("DELETE FROM events WHERE kind='beat' AND ts<?").bind(now - 2 * 86400000).run();
    await env.DB.prepare("DELETE FROM events WHERE kind='visit' AND ts<?").bind(now - 365 * 86400000).run();
  },
};
