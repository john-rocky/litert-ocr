// Test inputs for the document tests, written into test/out/fixtures/ (all English, made here):
//   report.pdf   from test/fixtures/report.html, printed by Chrome (2 pages with a text layer) — only when missing,
//                as test/fixtures/report.pdf is committed
//   scan.jpg     page 1 of report.pdf drawn at 150 dpi, turned 0.8 degrees, JPEG
//   scan.pdf     that JPEG as the page of an image-only PDF (no text layer)
//   mixed.pdf    page 1 = text, page 2 = the scan image
//   locked.pdf   one text page, password "open-sesame"
//   long.pdf     120 text pages
//   blank.pdf    one empty page
//   broken.pdf   the first 40 % of report.pdf
//   notes.txt, slides.pptx   files that are not documents convert() reads
// usage: node test/fixtures/make-pdfs.mjs [--report]   (--report: print report.pdf again with Chrome)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { jpegSize, makePdf } from './pdfgen.mjs';

const FIX = fileURLToPath(new URL('./', import.meta.url));
const OUT = fileURLToPath(new URL('../out/fixtures/', import.meta.url));
mkdirSync(OUT, { recursive: true });

if (process.argv.includes('--report') || !existsSync(join(FIX, 'report.pdf'))) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--mute-audio'] });
  const page = await browser.newPage();
  await page.goto('file://' + join(FIX, 'report.html'));
  writeFileSync(join(FIX, 'report.pdf'), await page.pdf({ preferCSSPageSize: true, printBackground: true }));
  await browser.close();
}
const report = readFileSync(join(FIX, 'report.pdf'));
writeFileSync(join(OUT, 'report.pdf'), report);

// page 1 drawn at 150 dpi with pdf.js and @napi-rs/canvas, turned a little, as a scan would be
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
const { createCanvas } = await import('@napi-rs/canvas');
const doc = await pdfjs.getDocument({ data: new Uint8Array(report), isEvalSupported: false, verbosity: 0 }).promise;
const page = await doc.getPage(1);
const vp = page.getViewport({ scale: 150 / 72 });
const W = Math.ceil(vp.width), H = Math.ceil(vp.height);
const flat = createCanvas(W, H);
const fctx = flat.getContext('2d');
fctx.fillStyle = '#fff';
fctx.fillRect(0, 0, W, H);
await page.render({ canvasContext: fctx, viewport: vp, canvas: flat }).promise;
const scan = createCanvas(W, H);
const sctx = scan.getContext('2d');
sctx.fillStyle = '#fff';
sctx.fillRect(0, 0, W, H);
sctx.translate(W / 2, H / 2);
sctx.rotate((0.8 * Math.PI) / 180);
sctx.drawImage(flat, -W / 2, -H / 2);
const jpg = await scan.encode('jpeg', 85);
writeFileSync(join(OUT, 'scan.jpg'), jpg);
const size = jpegSize(jpg);
const A4 = { width: 595.28, height: 841.89 };
writeFileSync(join(OUT, 'scan.pdf'), makePdf({ pages: [{ ...A4, jpeg: { bytes: jpg, ...size } }] }));
const textPage = (lines) => ({ ...A4, lines: lines.map((t, i) => ({ x: 72, y: 96 + i * 22, size: i === 0 ? 18 : 12, text: t })) });
writeFileSync(join(OUT, 'mixed.pdf'), makePdf({ pages: [textPage(['Field notes', 'The east gate opens at seven.', 'Bring the spare keys to the office.', 'The boiler check is on Friday.']), { ...A4, jpeg: { bytes: jpg, ...size } }] }));
writeFileSync(join(OUT, 'locked.pdf'), makePdf({ pages: [textPage(['Protected page', 'This page is protected by a password.', 'Only the committee may read it.'])], password: 'open-sesame' }));
writeFileSync(join(OUT, 'long.pdf'), makePdf({ pages: Array.from({ length: 120 }, (_, i) => textPage([`Page ${i + 1} of 120`, 'A short line of text on this page.', 'Another line follows here.'])) }));
writeFileSync(join(OUT, 'blank.pdf'), makePdf({ pages: [{ ...A4, lines: [] }] }));
writeFileSync(join(OUT, 'broken.pdf'), report.subarray(0, Math.floor(report.length * 0.4)));
writeFileSync(join(OUT, 'notes.txt'), 'These are plain text notes, not a PDF or an image.\nSecond line.\n');
writeFileSync(join(OUT, 'slides.pptx'), Buffer.concat([Buffer.from('504b0304140000000800', 'hex'), Buffer.from('[Content_Types].xml')]));
console.log('fixtures written to', OUT);
