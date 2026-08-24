# Divar AR — self-hosted live analytics (Cloudflare Workers + D1)

Free, private, always-on dashboard for the Divar AR app. Accessible from anywhere
(incl. iPhone) at a permanent URL, gated by a secret key so only you can see it.

## Pieces
- `src/worker.js` — Worker: `POST /e` ingests beacons; `GET /api/stats?key=…` returns stats (key-gated); nightly prune.
- `schema.sql` — D1 (SQLite) `events` table: visits + presence beats.
- `public/index.html` — the dashboard UI (live Divar map, active-now, scans-vs-direct, per-hour, most-guided places, countries). Served at `/`.

## Deploy (one time, ~5 min — free Cloudflare account)
```bash
cd analytics
npm install
npx wrangler login                       # OAuth in your browser (no token to paste)
npx wrangler d1 create divar_analytics   # copy the printed database_id into wrangler.toml
npm run schema:remote                    # create the events table in the live D1
npx wrangler secret put DASH_KEY         # set your private dashboard key
npm run deploy                           # -> https://divar-analytics.<your-subdomain>.workers.dev
```
Then point the app at it: in `../src/analytics.js` set
`const ENDPOINT = 'https://divar-analytics.<your-subdomain>.workers.dev';`
rebuild + redeploy the app (`npm run build` in the app, push to GitHub Pages).

## Use it
Open on your iPhone and bookmark:
`https://divar-analytics.<your-subdomain>.workers.dev/?key=YOUR_DASH_KEY`
The key is stored on the device and stripped from the URL. Anyone without the key gets a lock screen.

## Cost / scale
Free tier: Workers 100k requests/day, D1 5 GB + 5M row-reads/day, 100k row-writes/day.
Each visit = 1 request; presence beats are every 60 s and only while the tab is visible.
That comfortably covers a large festival. Only sustained *thousands of concurrent, long-lived*
sessions would approach the daily request cap — then the $5/mo Workers Paid plan (10M requests) removes it.

## Privacy
Anonymous device-local session id; no accounts, no PII. Location is sent only while the app
is open and is shown to you as aggregate live pins. The app tells users their location is shared
to help run the festival.
