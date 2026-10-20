// The page layout model (docling-layout-heron, RT-DETRv2) on LiteRT.js, in the two-graph form that runs on WebGPU
// (the r3x conversion: Graph A = backbone + encoder + the encoder head, the top-300 query selection on the host,
// Graph B = the decoder). Input: the page stretched to 640 x 640, RGB / 255 (no normalization). Output: regions
// with one of heron's 17 labels, score >= 0.5, overlapping boxes of one label (IoU > 0.7) kept once (the
// higher score).
// WebGPU trap (r3x): a compiled two-graph model that never ran does not come back from delete(); every model here
// runs once right after compiling, so a later delete() returns.

import type * as LiteRtModule from '@litertjs/core';
import { OcrError, errText } from '../core/errors.js';
import type { Region } from './geom.js';

type LiteRt = typeof LiteRtModule;
type Compiled = Awaited<ReturnType<LiteRt['loadAndCompile']>>;

export const LAYOUT_SIZE = 640;
const NQ = 300; // decoder queries
const NC = 17; // classes
const HID = 256;
const NT = 8400; // encoder tokens (80 x 80 + 40 x 40 + 20 x 20)
export const LAYOUT_MIN_SCORE = 0.5;
const COMPILE_TIMEOUT_MS = 120000;

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  return Promise.race([p, new Promise<never>((_, bad) => { t = setTimeout(() => bad(new Error(`${what} did not finish within ${ms / 1000} s`)), ms); })]).finally(() => clearTimeout(t));
}

async function datas(outs: { data(): Promise<unknown>; delete(): void }[]): Promise<Float32Array[]> {
  const d: Float32Array[] = [];
  try {
    for (const o of outs) d.push((await o.data()) as Float32Array);
  } finally {
    for (const o of outs) o.delete();
  }
  return d;
}

/** The 300 encoder tokens with the highest best-class logit (descending; ties by token index). */
export function topTokens(encClass: Float32Array): number[] {
  const s = new Float32Array(NT);
  for (let t = 0; t < NT; t++) {
    let b = encClass[t * NC]!;
    for (let c = 1; c < NC; c++) { const v = encClass[t * NC + c]!; if (v > b) b = v; }
    s[t] = b;
  }
  const thr = Float32Array.from(s).sort()[NT - NQ]!;
  const cand: number[] = [];
  for (let t = 0; t < NT; t++) if (s[t]! >= thr) cand.push(t);
  cand.sort((a, b) => (s[b]! - s[a]!) || (a - b));
  return cand.slice(0, NQ);
}

/** 640 x 640 RGBA -> [1, 3, 640, 640] RGB / 255. */
export function layoutInput(rgba: Uint8ClampedArray): Float32Array {
  const plane = LAYOUT_SIZE * LAYOUT_SIZE;
  const x = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    x[i] = rgba[i * 4]! / 255; x[plane + i] = rgba[i * 4 + 1]! / 255; x[2 * plane + i] = rgba[i * 4 + 2]! / 255;
  }
  return x;
}

/** Decoder output -> regions in page pixels (score >= minScore, one box per overlapping same-label group). */
export function decodeRegions(logits: Float32Array, boxes: Float32Array, W: number, H: number, minScore = LAYOUT_MIN_SCORE): Region[] {
  const regs: Region[] = [];
  for (let q = 0; q < NQ; q++) {
    let best = 0, bv = -Infinity;
    for (let k = 0; k < NC; k++) { const v = logits[q * NC + k]!; if (v > bv) { bv = v; best = k; } }
    const score = 1 / (1 + Math.exp(-bv));
    if (score < minScore) continue;
    const cx = boxes[q * 4]!, cy = boxes[q * 4 + 1]!, bw = boxes[q * 4 + 2]!, bh = boxes[q * 4 + 3]!;
    regs.push({ cls: best, score, x0: (cx - bw / 2) * W, y0: (cy - bh / 2) * H, x1: (cx + bw / 2) * W, y1: (cy + bh / 2) * H });
  }
  regs.sort((a, b) => b.score - a.score);
  const iou = (a: Region, b: Region) => {
    const i = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
    return i / ((a.x1 - a.x0) * (a.y1 - a.y0) + (b.x1 - b.x0) * (b.y1 - b.y0) - i);
  };
  const kept: Region[] = [];
  for (const r of regs) if (!kept.some((k) => k.cls === r.cls && iou(k, r) > 0.7)) kept.push(r);
  return kept;
}

export interface LayoutFiles {
  a: Uint8Array;
  b: Uint8Array;
  /** float32 valid[8400] followed by anchors[8400 x 4]. */
  host: Uint8Array;
}

export class LayoutModel {
  readonly compileMs: Record<string, number> = {};
  private constructor(
    private readonly litert: LiteRt,
    private readonly A: Compiled,
    private readonly B: Compiled,
    private readonly valid: Float32Array,
    private readonly anchors: Float32Array,
    private readonly bOrder: number[],
    readonly backend: 'webgpu' | 'wasm',
  ) {}

  /** Compile both graphs on `backend` and run each once (a WebGPU model must run before it can be deleted). */
  static async create(litert: LiteRt, files: LayoutFiles, backend: 'webgpu' | 'wasm', numThreads: number): Promise<LayoutModel> {
    if (files.host.byteLength !== NT * 5 * 4) throw new OcrError('MODEL_COMPILE_FAILED', `The layout host file has ${files.host.byteLength} bytes, expected ${NT * 5 * 4}.`);
    const host = new Float32Array(files.host.slice().buffer);
    const opts = backend === 'webgpu' ? { accelerator: 'webgpu' as const } : { accelerator: 'wasm' as const, cpuOptions: { numThreads } };
    const times: Record<string, number> = {};
    const compile = async (name: string, bytes: Uint8Array): Promise<Compiled> => {
      const t0 = performance.now();
      try {
        const m = await withTimeout(litert.loadAndCompile(bytes, opts), COMPILE_TIMEOUT_MS, `Compiling the layout graph ${name} on ${backend}`);
        const acc = (m as { options?: { accelerator?: string } }).options?.accelerator ?? backend;
        if (acc !== backend) {
          await warmRun(litert, m, name).catch(() => {});
          try { m.delete(); } catch { /* ignore */ }
          throw new Error(`it compiled for ${acc}, not ${backend}`);
        }
        times[`layout${name}:${backend}`] = performance.now() - t0;
        return m;
      } catch (e) {
        throw new OcrError('MODEL_COMPILE_FAILED', `LiteRT.js could not compile the layout graph ${name} on ${backend}: ${errText(e)}.`, { cause: e });
      }
    };
    const A = await compile('A', files.a);
    try {
      await withTimeout(warmRun(litert, A, 'A'), COMPILE_TIMEOUT_MS, `The first run of the layout graph A on ${backend}`);
    } catch (e) {
      throw new OcrError('MODEL_COMPILE_FAILED', `The layout graph A did not run on ${backend}: ${errText(e)}.`, { cause: e });
    }
    let B: Compiled;
    try {
      B = await compile('B', files.b);
    } catch (e) {
      try { A.delete(); } catch { /* ran once: returns */ }
      throw e;
    }
    const bOrder = B.getInputDetails().map((d) => Array.from(d.shape).reduce((p, q) => p * q, 1));
    const m = new LayoutModel(litert, A, B, host.subarray(0, NT), host.subarray(NT, NT * 5), bOrder, backend);
    try {
      await withTimeout(m.runB(new Float32Array(NT * HID), new Float32Array(NQ * HID), new Float32Array(NQ * 4)), COMPILE_TIMEOUT_MS, `The first run of the layout graph B on ${backend}`);
    } catch (e) {
      m.dispose();
      throw new OcrError('MODEL_COMPILE_FAILED', `The layout graph B did not run on ${backend}: ${errText(e)}.`, { cause: e });
    }
    Object.assign(m.compileMs, times);
    return m;
  }

  private async runB(mem2: Float32Array, msel: Float32Array, anc: Float32Array): Promise<Float32Array[]> {
    const feed: Record<number, [Float32Array, number[]]> = { [NT * HID]: [mem2, [1, NT, HID]], [NQ * HID]: [msel, [1, NQ, HID]], [NQ * 4]: [anc, [1, NQ, 4]] };
    const ins = this.bOrder.map((n) => {
      const f = feed[n];
      if (!f) throw new Error(`unexpected layout graph B input with ${n} values`);
      return this.litert.Tensor.fromTypedArray(f[0], f[1]);
    });
    try {
      return await datas(await this.B.run(ins));
    } finally {
      for (const t of ins) t.delete();
    }
  }

  /** Regions of a page (rgba640 = the page stretched to 640 x 640). W x H = the page size the boxes are scaled to. */
  async regions(rgba640: Uint8ClampedArray, W: number, H: number): Promise<{ regions: Region[]; ms: number }> {
    const t0 = performance.now();
    const x = layoutInput(rgba640);
    const inA = this.litert.Tensor.fromTypedArray(x, [1, 3, LAYOUT_SIZE, LAYOUT_SIZE]);
    let outA: Float32Array[];
    try {
      outA = await datas(await this.A.run([inA]));
    } finally {
      inA.delete();
    }
    const ec = outA.find((a) => a.length === NT * NC);
    const mem2 = outA.find((a) => a.length === NT * HID);
    if (!ec || !mem2) throw new Error(`layout graph A returned ${outA.map((a) => a.length).join(', ')} values`);
    const idx = topTokens(ec);
    const msel = new Float32Array(NQ * HID);
    const anc = new Float32Array(NQ * 4);
    for (let q = 0; q < NQ; q++) {
      const t = idx[q]!;
      if (this.valid[t] !== 0) msel.set(mem2.subarray(t * HID, (t + 1) * HID), q * HID);
      anc.set(this.anchors.subarray(t * 4, t * 4 + 4), q * 4);
    }
    const outB = await this.runB(mem2, msel, anc);
    const logits = outB.find((a) => a.length === NQ * NC);
    const boxes = outB.find((a) => a.length === NQ * 4);
    if (!logits || !boxes) throw new Error(`layout graph B returned ${outB.map((a) => a.length).join(', ')} values`);
    return { regions: decodeRegions(logits, boxes, W, H), ms: performance.now() - t0 };
  }

  dispose(): void {
    for (const m of [this.A, this.B]) {
      try { m.delete(); } catch { /* ignore */ }
    }
  }
}

async function warmRun(litert: LiteRt, m: Compiled, name: string): Promise<void> {
  if (name === 'A') {
    const t = litert.Tensor.fromTypedArray(new Float32Array(3 * LAYOUT_SIZE * LAYOUT_SIZE), [1, 3, LAYOUT_SIZE, LAYOUT_SIZE]);
    try {
      await datas(await m.run([t]));
    } finally {
      t.delete();
    }
    return;
  }
  // Graph B with zero inputs in its declared order
  const ins = m.getInputDetails().map((d) => {
    const shape = Array.from(d.shape);
    return litert.Tensor.fromTypedArray(new Float32Array(shape.reduce((p, q) => p * q, 1)), shape);
  });
  try {
    await datas(await m.run(ins));
  } finally {
    for (const t of ins) t.delete();
  }
}
