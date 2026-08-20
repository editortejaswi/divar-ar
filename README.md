# Divar Heritage AR + Bonderam

**Live:** https://editortejaswi.github.io/divar-ar/

Marker-free, **geolocation-based web AR** for Divar Island, Goa. Point a phone
around the island and its churches, temple ruins, ferries — and the **Bonderam
festival** main event — float in place as tappable labels. No QR anchors, no app
install: GPS + compass + camera in the browser. Built on
[LocAR.js](https://github.com/AR-js-org/locar.js) + Three.js.

## Use it (phone)

Open the live URL in **Safari/Chrome**, tap **Start AR**, allow **camera /
location (Precise) / motion**, go outside with sky view. Indoor preview with
fake GPS: append `?demo=1`.

## Develop locally

```bash
npm install
npm run dev             # http://localhost:5173  (add /?demo=1 to preview)
npm run dev:phone       # HTTPS + LAN, for testing on a phone on the same Wi-Fi
```

## What it does

- **Explore layer** — heritage POIs (churches, Saptakoteshwar ruins, three ferry
  ramps) with history; the HUD shows the nearest thing to explore with distance
  + walking ETA.
- **Bonderam layer** — an adaptive banner that counts down to the festival and,
  once it knows where you are, shows distance + walking ETA to the main event
  and a leave-by time in the last 6 hours (`before → soon → live → after`). Times
  + anchor live in `FESTIVAL` at the top of `src/pois.js`.
- **☰ Sites** — everything sorted by distance with ETA + compass (works even if
  camera/compass are flaky).
- **📍 Capture** — record exact coordinates on-site (see below).

## Fixing coordinates (important)

Only the church is source-verified; everything else — **including the Bonderam
main-event location** — is approximate (`△ approx` badge), and the ETA/countdown
are only as good as it. Stand at the real spot → **📍 Capture → Capture reading**
(accuracy < ~10 m) → **Copy JSON** → paste `lat`/`lon` into that entry in
`src/pois.js` (and `FESTIVAL.mainEvent`), set `verified: true`, commit + push.

## Deployment (automatic)

Pushing to `main` triggers `.github/workflows/deploy.yml`, which builds and
publishes to GitHub Pages. The Vite `base` is `/divar-ar/` (project-pages
subpath) — change `REPO` in `vite.config.js` if you rename the repo.

## QR + share poster

```bash
node make-qr.mjs https://editortejaswi.github.io/divar-ar/
```

`qr/divar-ar-qr.png` / `.svg` are the codes; `qr/divar-ar-poster.png`
(2160×2700) is the Bonderam-styled share/print poster (official logo + festival
photos + QR). Regenerate both if the URL changes.

## Project layout

```
index.html        overlay UI (start, HUD, Bonderam banner, sheet, toolbar) + styles
src/main.js       bootstrap, GPS lifecycle, labels, festival banner, tools
src/pois.js       FESTIVAL config + Divar POI dataset (edit me)
src/labels.js     billboarded canvas-texture label sprites
src/geo.js        haversine distance, bearing, compass
make-qr.mjs       QR generator (PNG + SVG)
qr/               generated QR + poster + cleaned Bonderam logo
.github/workflows/deploy.yml   CI build + Pages deploy
```

## Honest accuracy notes

Phone GPS is ~5–20 m outdoors (worse in crowds/near metal, useless indoors);
compass can be 10–30° off. Great for "the main event is ~150 m NW, ~2 min walk";
not for pinning content to a doorway. Centimetre precision would need a
pre-scanned VPS — a heavier path this app deliberately avoids.
