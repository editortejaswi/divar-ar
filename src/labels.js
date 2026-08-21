import * as THREE from 'three';

// Per-kind icon glyph + accent colour.
export const KIND = {
  event:    { icon: '\u{1F3AA}', color: '#ff6b6b' }, // 🎪 Bonderam main event (festival tent)
  church:   { icon: '\u26EA', color: '#ffd27f' }, // ⛪ warm gold
  temple:   { icon: '\u{1F6D5}', color: '#ff9e7f' }, // 🛕 terracotta
  ferry:    { icon: '\u26F4\uFE0F', color: '#7fd4ff' }, // ⛴ river blue
  festival: { icon: '\u{1F3AA}', color: '#c79bff' }, // 🎪 violet
};

const CANVAS_W = 512;
const CANVAS_H = 256;
const CARD_TOP = 8;
const CARD_H = CANVAS_H - 56;          // room for the downward pointer
const CARD_MID = CARD_TOP + CARD_H / 2;

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function wrap(ctx, text, maxWidth, maxLines) {
  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = w;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    lines[maxLines - 1] += '\u2026';
  }
  return lines;
}

// Build a billboarded label Sprite for a POI. Apparent size is set later, per
// frame, by main.js so labels stay readable regardless of distance.
export function makeLabelSprite(poi) {
  const meta = KIND[poi.kind] || KIND.church;
  const canvas = document.createElement('canvas');
  canvas.width = CANVAS_W;
  canvas.height = CANVAS_H;
  const ctx = canvas.getContext('2d');

  // Card.
  ctx.fillStyle = 'rgba(12,14,20,0.82)';
  roundRect(ctx, CARD_TOP, CARD_TOP, CANVAS_W - 16, CARD_H, 28);
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = meta.color;
  ctx.stroke();
  // Downward pointer.
  ctx.beginPath();
  ctx.moveTo(CANVAS_W / 2 - 22, CARD_TOP + CARD_H);
  ctx.lineTo(CANVAS_W / 2 + 22, CARD_TOP + CARD_H);
  ctx.lineTo(CANVAS_W / 2, CANVAS_H - 8);
  ctx.closePath();
  ctx.fillStyle = meta.color;
  ctx.fill();

  // Icon (vertically centred in the card).
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = '56px system-ui, "Apple Color Emoji", sans-serif';
  ctx.fillText(meta.icon, 30, CARD_MID);

  // Title, vertically centred. Verified names get 3 lines; unverified reserve
  // the bottom-right corner for the "approx" badge, so cap at 2 lines.
  const maxLines = poi.verified ? 3 : 2;
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 38px system-ui, sans-serif';
  const lines = wrap(ctx, poi.name, CANVAS_W - 150, maxLines);
  const lineH = 42;
  const startY = CARD_MID - ((lines.length - 1) * lineH) / 2;
  lines.forEach((ln, i) => ctx.fillText(ln, 116, startY + i * lineH));

  // "approx" badge, bottom-right corner.
  if (!poi.verified) {
    ctx.textAlign = 'right';
    ctx.fillStyle = meta.color;
    ctx.font = 'bold 24px system-ui, sans-serif';
    ctx.fillText('\u25B3 approx', CANVAS_W - 28, CARD_TOP + CARD_H - 22);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
  });
  const sprite = new THREE.Sprite(material);
  sprite.aspect = CANVAS_W / CANVAS_H;
  sprite.properties = { poi };
  return sprite;
}
