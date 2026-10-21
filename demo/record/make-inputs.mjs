// Inputs made for the demo, all drawn here (no outside material):
//   examples/inventory-scan.pdf   (--examples) an A4 page with a ruled table, drawn at 150 dpi, turned 0.8 degrees with
//                                 uneven light and grain like a scan, as the only content of a one-page PDF (no text layer)
//   <out>/failure/                the files of the failure checks (not committed):
//     notes.txt          a text file (not a PDF or an image)
//     broken.png         the first half of examples/screenshot.png (a download cut short)
//     blank.jpg          a photo-like gradient with no text on it
//     locked.pdf         one text page, password "demo"
//     long.pdf           30 text pages (more than the page reads per file)
//     broken.pdf         the first 40 % of examples/inventory-scan.pdf
// usage (from the repository root, after npm install): node demo/record/make-inputs.mjs [--examples] [--out DIR]
// The drawing uses the system's Helvetica / Arial (macOS); elsewhere the canvas picks another sans-serif font.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas } from '@napi-rs/canvas';
import { jpegSize, makePdf } from '../../test/fixtures/pdfgen.mjs';

const DEMO = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const OUT = args.includes('--out') ? args[args.indexOf('--out') + 1] : join(DEMO, 'record/out');
const A4 = { width: 595.28, height: 841.89 };

// a fixed pseudo-random sequence, so the scan comes out the same on every run
let seed = 20261022;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

function inventoryPage() {
  const W = 1240, H = 1754; // A4 at 150 dpi
  const c = createCanvas(W, H);
  const g = c.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, W, H);
  g.fillStyle = '#111';
  g.textBaseline = 'alphabetic';
  const x0 = 150;
  g.font = 'bold 46px Helvetica, Arial, sans-serif';
  g.fillText('Storeroom B: Inventory Count', x0, 230);
  g.font = '27px Helvetica, Arial, sans-serif';
  g.fillText('Counted on 14 October 2026 by the night shift.', x0, 300);
  g.fillText('Items below their target go on the next order.', x0, 345);
  const cols = [{ t: 'Item', w: 430 }, { t: 'Shelf', w: 150 }, { t: 'Count', w: 180 }, { t: 'Target', w: 180 }];
  const rows = [
    ['Printer paper (box)', 'B1', '42', '40'],
    ['Toner, black', 'B2', '6', '8'],
    ['Envelopes C5', 'B1', '18', '18'],
    ['Cable ties (bag)', 'B4', '25', '30'],
    ['AA batteries', 'B3', '12', '12'],
    ['Label rolls', 'B4', '9', '10'],
    ['Markers (box)', 'B2', '14', '12'],
  ];
  const top = 420, rh = 66;
  const tw = cols.reduce((s, k) => s + k.w, 0);
  g.fillStyle = '#e9e9e9';
  g.fillRect(x0, top, tw, rh);
  g.strokeStyle = '#222';
  g.lineWidth = 2.5;
  for (let r = 0; r <= rows.length + 1; r++) {
    g.beginPath();
    g.moveTo(x0, top + r * rh);
    g.lineTo(x0 + tw, top + r * rh);
    g.stroke();
  }
  let x = x0;
  for (let k = 0; k <= cols.length; k++) {
    g.beginPath();
    g.moveTo(x, top);
    g.lineTo(x, top + (rows.length + 1) * rh);
    g.stroke();
    x += cols[k]?.w ?? 0;
  }
  g.fillStyle = '#111';
  const cell = (text, col, row, bold) => {
    g.font = `${bold ? 'bold ' : ''}28px Helvetica, Arial, sans-serif`;
    const left = x0 + cols.slice(0, col).reduce((s, k) => s + k.w, 0);
    g.fillText(text, left + 18, top + row * rh + 44);
  };
  cols.forEach((k, i) => cell(k.t, i, 0, true));
  rows.forEach((r, j) => r.forEach((t, i) => cell(t, i, j + 1, false)));
  g.font = '27px Helvetica, Arial, sans-serif';
  const after = top + (rows.length + 1) * rh + 80;
  g.fillText('Short: toner (2), cable ties (5), label rolls (1).', x0, after);
  g.fillText('Over: printer paper (2), markers (2).', x0, after + 45);
  g.font = '22px Helvetica, Arial, sans-serif';
  g.fillStyle = '#444';
  g.fillText('Page 1 of 1', x0, H - 120);
  return c;
}

/** The page as a scanner gives it back: turned a little, light falling off to one side, grain, a JPEG. */
function scanned(page) {
  const W = page.width, H = page.height;
  const c = createCanvas(W, H);
  const g = c.getContext('2d');
  g.fillStyle = '#fbfaf6';
  g.fillRect(0, 0, W, H);
  g.translate(W / 2, H / 2);
  g.rotate((0.8 * Math.PI) / 180);
  g.drawImage(page, -W / 2, -H / 2);
  g.setTransform(1, 0, 0, 1, 0, 0);
  const img = g.getImageData(0, 0, W, H);
  const d = img.data;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const shade = 1 - 0.07 * (x / W) - 0.04 * Math.abs(y / H - 0.4);
      const n = (rand() - 0.5) * 18;
      for (let k = 0; k < 3; k++) d[i + k] = Math.max(0, Math.min(255, d[i + k] * shade + n));
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

async function examples() {
  const jpg = await scanned(inventoryPage()).encode('jpeg', 82);
  const pdf = makePdf({ pages: [{ ...A4, jpeg: { bytes: jpg, ...jpegSize(jpg) } }] });
  writeFileSync(join(DEMO, 'examples/inventory-scan.pdf'), pdf);
  console.log(`examples/inventory-scan.pdf ${pdf.length} bytes (a ${jpg.length}-byte JPEG page)`);
}

async function failures() {
  const dir = join(OUT, 'failure');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'notes.txt'), 'Shopping list\nMilk\nBread\nCoffee beans\n');
  const png = readFileSync(join(DEMO, 'examples/screenshot.png'));
  writeFileSync(join(dir, 'broken.png'), png.subarray(0, png.length >> 1));
  const blank = createCanvas(1200, 900);
  const bg = blank.getContext('2d');
  const grad = bg.createLinearGradient(0, 0, 0, 900);
  grad.addColorStop(0, '#7fb3e6');
  grad.addColorStop(1, '#e8f1fa');
  bg.fillStyle = grad;
  bg.fillRect(0, 0, 1200, 900);
  writeFileSync(join(dir, 'blank.jpg'), await blank.encode('jpeg', 85));
  const textPage = (lines) => ({ ...A4, lines: lines.map((t, i) => ({ x: 72, y: 96 + i * 22, size: i === 0 ? 18 : 12, text: t })) });
  writeFileSync(join(dir, 'locked.pdf'), makePdf({ pages: [textPage(['Protected notes', 'This page opens with the password.', 'The meeting moves to Thursday.'])], password: 'demo' }));
  writeFileSync(join(dir, 'long.pdf'), makePdf({ pages: Array.from({ length: 30 }, (_, i) => textPage([`Page ${i + 1} of 30`, 'A short line of text on this page.', 'Another line follows it.'])) }));
  const scan = readFileSync(join(DEMO, 'examples/inventory-scan.pdf'));
  writeFileSync(join(dir, 'broken.pdf'), scan.subarray(0, Math.round(scan.length * 0.4)));
  console.log(`failure inputs in ${dir}`);
}

if (args.includes('--examples')) await examples();
await failures();
