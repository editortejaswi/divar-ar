# Divar Heritage AR + Bonderam

Marker-free, **geolocation-based web AR** for Divar Island, Goa. Point a phone
around the island and its churches, temple ruins, ferries — and the **Bonderam
festival** main event — float in place as tappable labels. No QR anchors, no app
install: GPS + compass + camera in the browser. Built on
[LocAR.js](https://github.com/AR-js-org/locar.js) + Three.js.

## Quick start

```bash
npm install
npm run dev            # http://localhost:5173  (desktop)
```

Preview with fake GPS (no phone/GPS needed): **http://localhost:5173/?demo=1**

## Test on your phone (iPhone/Android)

Camera + GPS need **HTTPS**. Two ways:

- **Same Wi-Fi, self-signed:** `npm run dev:phone` → open the printed
  `https://<mac-ip>:5173/` on the phone, accept the cert warning.
- **Public HTTPS via tunnel (no cert warning, works on cellular):**
  ```bash
  npm run dev
  cloudflared tunnel --url http://localhost:5173     # prints a https URL
  ```

On the phone: tap **Start AR** → allow **camera / location (Precise) / motion** →
go outside with sky view. iOS: `Settings → Safari → Motion & Orientation Access`
must be ON; use a normal (non-Private) tab.

## What it does

- **Explore layer** — heritage POIs (churches, Saptakoteshwar ruins, three ferry
  ramps) with history; the **HUD** shows the nearest thing to explore with
  distance + walking ETA.
- **Bonderam layer** — an adaptive banner that counts down to the festival and,
  once it knows where you are, shows **distance + walking ETA to the main event**
  and a **leave-by time** in the last 6 hours. Phases: `before → soon → live →
  after`. Times/anchor live in `FESTIVAL` at the top of `src/pois.js`.
- **☰ Sites** — every point sorted by distance with ETA + compass (works even if
  camera/compass are flaky — a reliable fallback).
- **📍 Capture** — record exact coordinates on-site (see below).

## Fixing coordinates (important)

Only the church is source-verified; everything else — **including the Bonderam
main-event location** — is approximate (`△ approx` badge). The ETA/countdown are
only as good as that coordinate, so before the festival:

1. Stand at the actual spot (e.g. the Divar Center stage / flag-march ground).
2. **📍 Capture → Capture reading** (wait for accuracy < ~10 m).
3. **Copy JSON** → paste `lat`/`lon` into that entry in `src/pois.js` (and into
   `FESTIVAL.mainEvent`), set `verified: true`.

## QR code + share poster

```bash
node make-qr.mjs <your-public-url>
```

Writes `qr/divar-ar-qr.png` (1024 px) and `qr/divar-ar-qr.svg` (scalable, for
print). A ready share/print poster is at `qr/divar-ar-poster.png` (1080×1350).

> The QR must point at a **permanent** URL. A `trycloudflare.com` tunnel URL is
> temporary — fine for testing, useless on a printed poster tomorrow. Deploy
> first (below), then regenerate the QR with the permanent URL.

## Deploy a permanent URL

The whole app is **static + client-side** (no backend), so host it on a CDN —
it'll handle festival-scale traffic for free.

- **Fastest, no CLI:** `npm run build`, then drag the **`dist/`** folder onto
  <https://app.netlify.com/drop> → instant permanent `something.netlify.app`.
- **Cloudflare Pages / GitHub Pages:** also fine (Pages/Netlify serve at the
  domain root, so no Vite `base` tweak needed).

Then: `node make-qr.mjs https://something.netlify.app` and re-share.

**Festival-scale tip:** make it an offline PWA so it keeps working when the
island's cellular network is saturated by the crowd — each phone then hits the
network only once (ideally on the ferry in). (Not yet added; recommended next.)

## Project layout

```
index.html        overlay UI (start, HUD, Bonderam banner, sheet, toolbar) + styles
src/main.js       bootstrap, GPS lifecycle, labels, festival banner, tools
src/pois.js       FESTIVAL config + Divar POI dataset (edit me)
src/labels.js     billboarded canvas-texture label sprites
src/geo.js        haversine distance, bearing, compass
make-qr.mjs       QR generator (PNG + SVG)
qr/               generated QR + poster
vite.config.js    HTTPS toggle + tunnel host allow-list
```

## Honest accuracy notes

Phone GPS is ~5–20 m outdoors (worse in crowds/near metal, useless indoors);
compass can be 10–30° off. Great for "the main event is ~150 m NW, ~2 min walk";
not for pinning content to a doorway. Centimetre precision needs a pre-scanned
VPS — a heavier path this app deliberately avoids.
