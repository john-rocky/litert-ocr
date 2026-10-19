// One page: detect text lines, cut each line out upright, read it, keep the lines the recognizer is sure
// of. This is the pipeline measured in the r1a comparison (candidate L3): detector input = the whole
// image stretched to 640 x 640, DB 0.2 / 0.45 / unclip 1.4, minimum-area rectangle + affine crop (tall
// crops turned 90 degrees counter-clockwise), recognizer width 320 / 640 / 960 chosen by the line's width
// at height 48 (wider lines split at ink gaps), lines whose mean token probability is under 0.5 dropped.

import { allowedClasses, ctcDecode } from './ctc.js';
import { DET_SIZE, dbPostprocess, detPreprocess, type Point, type Quad } from './db.js';
import { columnInkProfile, splitByInk, windowSeparator, type InkPiece } from './ink.js';

export const REC_H = 48;
export const REC_WIDTHS = [320, 640, 960] as const;
export type RecWidth = (typeof REC_WIDTHS)[number];
const MAX_REC_W = 960;
const MIN_SCORE = 0.5;

/** Image operations the pipeline needs; the browser does them on OffscreenCanvas, Node in plain JS. */
export interface RasterOps<Src, Crop, Strip> {
  size(src: Src): { width: number; height: number };
  /** The whole source stretched to S x S RGBA. */
  detRGBA(src: Src, S: number): Uint8ClampedArray;
  /** Upright crop of quad (TL, TR, BR, BL in source px); turned counter-clockwise when tall; null if degenerate. */
  cropQuad(src: Src, quad: Quad): { crop: Crop; width: number; height: number; rotated: boolean } | null;
  /** The crop resized to nat x h (high-quality smoothing). */
  strip(crop: Crop, nat: number, h: number): Strip;
  stripRGBA(strip: Strip, nat: number, h: number): Uint8ClampedArray;
  /** Strip columns [from, from + pw) into a cw x h window (squashed when pw > cw). */
  windowRGBA(strip: Strip, from: number, pw: number, cw: number, h: number): Uint8ClampedArray;
}

export interface Runners {
  det(nchw: Float32Array): Promise<Float32Array>;
  rec(width: RecWidth, nchw: Float32Array): Promise<Float32Array>;
}

/** A character placed along its line: f0..f1 = fraction of the line's reading length. */
export interface PlacedChar {
  ch: string;
  prob: number;
  f: number;
  /** Separator inserted between two recognizer windows (no probability of its own). */
  synthetic: boolean;
}

export interface ReadLine {
  quad: Quad;
  /** Axis-aligned box [x0, y0, x1, y1] of the quad, in source px. */
  box: [number, number, number, number];
  text: string;
  /** Mean token probability (0..1). */
  score: number;
  rotated: boolean;
  chars: PlacedChar[];
}

export interface ReadOptions {
  /** Called once after detection with the recognizer widths the lines will need (to start loading them early). */
  prefetch?: (widths: RecWidth[]) => void;
  whitelist: string | null;
  blacklist: string | null;
  /** Read the whole source as one line (no detection). */
  singleLine: boolean;
  onLine?: (done: number, total: number) => void;
}

/** RGBA strip (48 x cw) -> recognizer input of width W: BGR, (x - 127.5) / 127.5, zero (normalized) right padding. */
export function recPreprocess(rgba: Uint8ClampedArray, cw: number, W: number): Float32Array {
  const H = REC_H, plane = H * W;
  const out = new Float32Array(3 * plane);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < cw; x++) {
      const s = (y * cw + x) * 4, t = y * W + x;
      out[t] = (rgba[s + 2]! - 127.5) / 127.5;
      out[plane + t] = (rgba[s + 1]! - 127.5) / 127.5;
      out[2 * plane + t] = (rgba[s]! - 127.5) / 127.5;
    }
  }
  return out;
}

export async function readPage<Src, Crop, Strip>(
  src: Src,
  ops: RasterOps<Src, Crop, Strip>,
  run: Runners,
  chars: string[],
  opts: ReadOptions,
): Promise<{ lines: ReadLine[]; detMs: number; recMs: number }> {
  const { width: W, height: H } = ops.size(src);
  const allowed = allowedClasses(chars, opts.whitelist, opts.blacklist);
  let quads: Quad[];
  let detMs = 0;
  if (opts.singleLine) {
    quads = [[[0, 0], [W, 0], [W, H], [0, H]]];
  } else {
    const t0 = performance.now();
    const prob = await run.det(detPreprocess(ops.detRGBA(src, DET_SIZE), DET_SIZE));
    detMs = performance.now() - t0;
    const sx = DET_SIZE / W, sy = DET_SIZE / H;
    quads = dbPostprocess(prob, DET_SIZE, DET_SIZE).map((q) =>
      q.quad.map(([x, y]) => [Math.min(W, Math.max(0, Math.round(x / sx))), Math.min(H, Math.max(0, Math.round(y / sy)))] as Point) as Quad,
    );
  }
  opts.prefetch?.([...new Set(quads.flatMap(widthsFor))]);
  const minScore = opts.singleLine ? 0 : MIN_SCORE;
  const lines: ReadLine[] = [];
  let recMs = 0;
  for (let i = 0; i < quads.length; i++) {
    const quad = quads[i]!;
    opts.onLine?.(i, quads.length);
    const c = ops.cropQuad(src, quad);
    if (!c) continue;
    const r = await readCrop(c, ops, run, chars, allowed);
    recMs += r.recMs;
    if (!r.text.trim() || r.score < minScore) continue;
    const xs = quad.map((p) => p[0]), ys = quad.map((p) => p[1]);
    lines.push({
      quad,
      box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
      text: r.text,
      score: r.score,
      rotated: c.rotated,
      chars: r.chars,
    });
  }
  opts.onLine?.(quads.length, quads.length);
  return { lines, detMs, recMs };
}

/** Recognizer widths a quad will use: its crop at height 48 (as cropQuad sizes it), split above 960. */
function widthsFor(quad: Quad): RecWidth[] {
  const [p0, p1, p2, p3] = quad;
  const d = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  let w = Math.max(1, Math.floor(Math.max(d(p0, p1), d(p2, p3))));
  let h = Math.max(1, Math.floor(Math.max(d(p0, p3), d(p1, p2))));
  if (h / w >= 1.5) [w, h] = [h, w];
  const nat = Math.max(1, Math.ceil((REC_H * w) / h));
  if (nat <= 320) return [320];
  if (nat <= 640) return [640];
  return nat <= MAX_REC_W ? [960] : [640, 960];
}

async function readCrop<Src, Crop, Strip>(
  c: { crop: Crop; width: number; height: number },
  ops: RasterOps<Src, Crop, Strip>,
  run: Runners,
  chars: string[],
  allowed: Int32Array | null,
): Promise<{ text: string; score: number; recMs: number; chars: PlacedChar[] }> {
  // height 48, keep aspect; lines wider than 960 at that height are split at ink gaps
  const nat = Math.max(1, Math.ceil((REC_H * c.width) / c.height));
  const strip = ops.strip(c.crop, nat, REC_H);
  let pieces: InkPiece[] = [{ from: 0, to: nat, midWord: false }];
  if (nat > MAX_REC_W) {
    const { profile } = columnInkProfile(ops.stripRGBA(strip, nat, REC_H), nat, REC_H);
    pieces = splitByInk(profile, nat, { maxW: 870, squashLimit: MAX_REC_W });
  }
  let text = '', scoreSum = 0, scoreN = 0, recMs = 0;
  let prev: { text: string; midWord: boolean } | null = null;
  const placed: PlacedChar[] = [];
  for (const pc of pieces) {
    const pw = pc.to - pc.from;
    if (pw < 2) continue;
    const cw = Math.min(MAX_REC_W, pw);
    const W = REC_WIDTHS.find((w) => w >= cw)!;
    const nchw = recPreprocess(ops.windowRGBA(strip, pc.from, pw, cw, REC_H), cw, W);
    const t0 = performance.now();
    const out = await run.rec(W, nchw);
    recMs += performance.now() - t0;
    const T = out.length / chars.length;
    const d = ctcDecode(out, T, chars.length, chars, allowed);
    const cur = { text: d.text, midWord: pc.midWord };
    if (prev && d.text) {
      const sep = windowSeparator(prev, cur);
      text += sep;
      if (sep) placed.push({ ch: sep, prob: 1, f: pc.from / nat, synthetic: true });
    }
    text += d.text;
    const step = W / T; // window px per timestep
    for (const ch of d.chars) {
      const xs = pc.from + (ch.t + 0.5) * step * (pw / cw);
      placed.push({ ch: ch.ch, prob: ch.prob, f: Math.min(1, Math.max(0, xs / nat)), synthetic: false });
    }
    if (d.text) {
      prev = cur;
      scoreSum += d.score;
      scoreN++;
    }
  }
  return { text, score: scoreN ? scoreSum / scoreN : 0, recMs, chars: placed };
}
