// Writes src/core/probe.ts: the fixed text line that recognizer 'auto' reads on WebAssembly and on WebGPU before it
// trusts WebGPU (src/core/engine.ts). One line of Latin letters, digits, symbols and kanji, dark text on white, at the
// recognizer's height (48 px) in a 320-px-wide strip; gray levels kept to 16, run-length coded.
//   node scripts/make-probe.mjs        (needs @napi-rs/canvas; the output is committed, so this runs only to change it)
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { createCanvas } = require('@napi-rs/canvas');
const { version } = require('@napi-rs/canvas/package.json');

const W = 320, H = 48;
const TEXT = 'Total ¥8,415 合計 OK';
const FONT = '28px "Hiragino Sans"';

const c = createCanvas(W, H);
const g = c.getContext('2d');
g.fillStyle = '#fff';
g.fillRect(0, 0, W, H);
g.font = FONT;
const width = g.measureText(TEXT).width;
if (width > W - 8) throw new Error(`the text is ${width.toFixed(1)} px wide; it must fit in ${W - 8} px`);
g.fillStyle = '#1a1a1a';
g.textBaseline = 'middle';
g.fillText(TEXT, 4, H / 2);
const rgba = g.getImageData(0, 0, W, H).data;

// gray (the mean of R, G, B) in 16 levels; runs of one level, at most 16 long: one byte = (run - 1) << 4 | level
const out = [];
let prev = -1, run = 0;
const flush = () => { if (run) out.push(((run - 1) << 4) | prev); };
for (let i = 0; i < W * H; i++) {
  const v = Math.round((rgba[4 * i] + rgba[4 * i + 1] + rgba[4 * i + 2]) / 3 / 17);
  if (v === prev && run < 16) run++;
  else { flush(); prev = v; run = 1; }
}
flush();
const b64 = Buffer.from(out).toString('base64');

const src = `// The fixed text line of the recognizer check (recognizer 'auto', src/core/engine.ts): ${W} x ${H} gray pixels drawn by
// scripts/make-probe.mjs (text ${JSON.stringify(TEXT)}, font ${FONT.replace(/"/g, '')}, @napi-rs/canvas ${version}). Gray levels 0-15,
// run-length coded: each byte is (run - 1) << 4 | level, level * 17 = the 8-bit gray value. Generated; do not edit.

export const PROBE_TEXT = ${JSON.stringify(TEXT)};
export const PROBE_W = ${W};
export const PROBE_H = ${H};
const RLE = '${b64}';

/** The line as recognizer input of width W (>= ${W}): BGR, (x - 127.5) / 127.5, zero (normalized) right padding. */
export function probeInput(W: number): Float32Array {
  const bin = atob(RLE);
  const gray = new Uint8Array(PROBE_W * PROBE_H);
  let p = 0;
  for (let i = 0; i < bin.length; i++) {
    const b = bin.charCodeAt(i);
    gray.fill((b & 15) * 17, p, p + (b >> 4) + 1);
    p += (b >> 4) + 1;
  }
  const plane = PROBE_H * W;
  const out = new Float32Array(3 * plane);
  for (let y = 0; y < PROBE_H; y++) {
    for (let x = 0; x < PROBE_W; x++) {
      const v = (gray[y * PROBE_W + x]! - 127.5) / 127.5;
      const t = y * W + x;
      out[t] = v;
      out[plane + t] = v;
      out[2 * plane + t] = v;
    }
  }
  return out;
}
`;
const dest = fileURLToPath(new URL('../src/core/probe.ts', import.meta.url));
writeFileSync(dest, src);
console.log(`wrote ${dest}: text ${JSON.stringify(TEXT)} (${width.toFixed(1)} px), ${out.length} bytes coded, ${b64.length} base64 chars`);
