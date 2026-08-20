// Generate scannable QR codes (PNG + SVG) for the AR app URL.
//   node make-qr.mjs <url>
// Outputs qr/divar-ar-qr.png (1024px) and qr/divar-ar-qr.svg.
// High error-correction (H) so a small logo can be overlaid later if wanted.
import QRCode from 'qrcode';
import { mkdirSync, writeFileSync } from 'node:fs';

const url = process.argv[2];
if (!url) {
  console.error('Usage: node make-qr.mjs <url>');
  process.exit(1);
}

mkdirSync('qr', { recursive: true });
const opts = { errorCorrectionLevel: 'H', margin: 4, color: { dark: '#0b0e14', light: '#ffffff' } };

await QRCode.toFile('qr/divar-ar-qr.png', url, { ...opts, width: 1024, type: 'png' });
const svg = await QRCode.toString(url, { ...opts, type: 'svg' });
writeFileSync('qr/divar-ar-qr.svg', svg);
console.log(`QR written for: ${url}\n  qr/divar-ar-qr.png\n  qr/divar-ar-qr.svg`);
