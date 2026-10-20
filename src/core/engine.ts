// Compiles the model files with LiteRT.js and runs the pipeline. Shared by the browser worker and the
// Node worker; the platform supplies the LiteRT module (already loaded), the file bytes and the image ops.
// The detector, the 320-wide recognizer and the vocabulary load at start; the 640 / 960 recognizers load
// the first time a line needs them (same files, same output — only later).

import type * as LiteRtModule from '@litertjs/core';
import { OcrError, errText } from './errors.js';
import { MODEL_FILES, VOCAB_SIZE, type ModelRole } from './models.js';
import { DET_SIZE } from './db.js';
import { REC_H, readPage, type RasterOps, type ReadOptions, type RecWidth, type Runners } from './pipeline.js';
import { probeInput } from './probe.js';

type LiteRt = typeof LiteRtModule;
type Compiled = Awaited<ReturnType<LiteRt['loadAndCompile']>>;

export interface EngineInit {
  litert: LiteRt;
  det: Uint8Array;
  rec320: Uint8Array;
  characters: Uint8Array;
  /** Bytes of a recognizer that is not loaded yet (640 or 960), fetched on first use. */
  loadRec: (width: 640 | 960) => Promise<Uint8Array>;
  numThreads: number;
  backend: 'auto' | 'wasm';
  /**
   * 'auto' (default): WebAssembly, or WebGPU where WebAssembly has 1 thread, a WebGPU device exists, rec320Safe holds
   * and a fixed line reads the same on both (checked per width when it loads). 'wasm': every recognizer on
   * WebAssembly. 'webgpu': the 640 / 960 recognizers on WebGPU (the published files read the same there), the 320 one
   * only when rec320Safe, no check.
   */
  recognizer?: 'auto' | 'wasm' | 'webgpu';
  /** The 320-wide file is one that WebGPU reads correctly (not the published file, which misreads: LiteRT issue #9661). */
  rec320Safe?: boolean;
  /** Tests only: the check sees one output step changed on WebGPU. */
  checkHook?: 'mismatch';
  notice: (message: string, level?: 'info' | 'warn') => void;
  /** Compile progress 0..1 and a label of the step. */
  progress: (p: number, step: string) => void;
}

export interface EngineTimings {
  compileMs: Record<string, number>;
  warmupMs: Record<string, number>;
}

export interface RecognizerCheck {
  width: number;
  /** Output steps compared (argmax per step). */
  steps: number;
  differing: number;
  ms: number;
  /** The check line as WebAssembly read it. */
  text: string;
}

/** WebGPU can run here: the API exists and LiteRT.js opened a device for it (a browser without a GPU has the API but no device). */
export function webGpuUsable(litert: LiteRt): boolean {
  try {
    return litert.isWebGPUSupported() && litert.getWebGpuDevice() != null;
  } catch {
    return false;
  }
}

export class Engine {
  readonly timings: EngineTimings = { compileMs: {}, warmupMs: {} };
  private readonly recs = new Map<RecWidth, Compiled>();
  private readonly pending = new Map<RecWidth, Promise<Compiled>>();
  /** Bytes of the recognizers on WebGPU, kept to move them to WebAssembly if WebGPU fails later. */
  private readonly gpuRecBytes = new Map<RecWidth, Uint8Array>();
  readonly recBackends: Record<RecWidth, 'wasm' | 'webgpu'> = { 320: 'wasm', 640: 'wasm', 960: 'wasm' };
  private det!: Compiled;
  detector: 'webgpu' | 'wasm' = 'wasm';
  chars!: string[];
  /** recognizer 'auto': the start check passed, so the wider recognizers go to WebGPU too (each checked when it loads). */
  autoGpu = false;
  /** Why the recognizers run where they do (worker.info.recognizerReason). */
  recognizerReason = '';
  /** The start check of recognizer 'auto' (null when it did not run). */
  recognizerCheck: RecognizerCheck | null = null;

  private constructor(private readonly init: EngineInit) {}

  get gpuUsable(): boolean {
    return webGpuUsable(this.init.litert);
  }

  /** This width's recognizer is loaded or loading. */
  hasRecognizer(width: RecWidth): boolean {
    return this.recs.has(width) || this.pending.has(width);
  }

  static async create(init: EngineInit): Promise<Engine> {
    const e = new Engine(init);
    await e.start();
    return e;
  }

  private async compile(role: ModelRole, bytes: Uint8Array, accelerator: 'wasm' | 'webgpu'): Promise<Compiled> {
    const t0 = performance.now();
    try {
      const opts = accelerator === 'wasm' ? { accelerator, cpuOptions: { numThreads: this.init.numThreads } } : { accelerator };
      const m = await this.init.litert.loadAndCompile(bytes, opts);
      this.timings.compileMs[`${role}:${accelerator}`] = performance.now() - t0;
      return m;
    } catch (e) {
      throw new OcrError('MODEL_COMPILE_FAILED', `LiteRT.js could not compile ${MODEL_FILES[role].file} on ${accelerator}: ${errText(e)}`, { cause: e });
    }
  }

  private async warm(label: string, m: Compiled, shape: number[]): Promise<void> {
    const t0 = performance.now();
    await runModel(this.init.litert, m, new Float32Array(shape.reduce((a, b) => a * b, 1)), shape);
    this.timings.warmupMs[label] = performance.now() - t0;
  }

  private async start(): Promise<void> {
    const { notice } = this.init;
    let chars: unknown;
    try {
      chars = JSON.parse(new TextDecoder().decode(this.init.characters));
    } catch (e) {
      throw new OcrError('MODEL_COMPILE_FAILED', `${MODEL_FILES.characters.file} is not valid JSON (${errText(e)}).`);
    }
    if (!Array.isArray(chars) || chars.length !== VOCAB_SIZE) {
      throw new OcrError('MODEL_COMPILE_FAILED', `${MODEL_FILES.characters.file} has ${Array.isArray(chars) ? chars.length : 'no'} entries, expected ${VOCAB_SIZE}.`);
    }
    this.chars = chars as string[];
    this.init.progress(0, 'recognizer 320');
    const mode = this.init.recognizer ?? 'auto';
    if (mode === 'auto') {
      this.recs.set(320, await this.startAuto());
    } else {
      if (mode === 'webgpu' && !this.init.rec320Safe) {
        notice('The 320-wide recognizer stays on WebAssembly: the published file misreads lines on WebGPU (LiteRT issue #9661). The 640 / 960 ones use WebGPU.');
      }
      this.recs.set(320, await this.compileRec(320, this.init.rec320));
      this.recognizerReason = mode === 'wasm'
        ? 'recognizer: "wasm" was asked, so the recognizers run on WebAssembly.'
        : this.recBackends[320] === 'webgpu'
          ? 'recognizer: "webgpu" was asked: the recognizers run on WebGPU (not checked against WebAssembly).'
          : `recognizer: "webgpu" was asked: ${this.gpuUsable ? 'the 640 / 960 recognizers run on WebGPU, the 320-wide one on WebAssembly (the published file misreads lines on WebGPU)' : 'there is no WebGPU device here, so the recognizers run on WebAssembly'}.`;
    }
    this.init.progress(0.5, 'detector');
    let det: Compiled | null = null;
    if (this.init.backend !== 'wasm' && this.gpuUsable) {
      try {
        det = await this.compile('det', this.init.det, 'webgpu');
        const acc = (det as { options?: { accelerator?: string } }).options?.accelerator ?? 'webgpu';
        if (acc !== 'webgpu') throw new Error(`compiled for ${acc}`);
        await this.warm('det', det, [1, 3, DET_SIZE, DET_SIZE]);
        this.detector = 'webgpu';
      } catch (e) {
        notice(`WebGPU could not run the text detector (${errText(e)}); it runs on WebAssembly instead.`);
        try { det?.delete(); } catch { /* ignore */ }
        det = null;
      }
    } else if (this.init.backend !== 'wasm') {
      notice('WebGPU is not available here; the text detector runs on WebAssembly.');
    }
    if (!det) {
      det = await this.compile('det', this.init.det, 'wasm');
      await this.warm('det', det, [1, 3, DET_SIZE, DET_SIZE]);
      this.detector = 'wasm';
    }
    this.det = det;
    this.init.progress(1, 'done');
  }

  /**
   * recognizer 'auto' at start: WebAssembly unless WebAssembly has 1 thread, a WebGPU device exists and the 320-wide
   * file is one WebGPU reads correctly; then the fixed line is read on both and WebGPU is used only if every output
   * step (the argmax over the vocabulary) is the same.
   */
  private async startAuto(): Promise<Compiled> {
    const { numThreads } = this.init;
    const wasmOnly = (reason: string) => {
      this.recognizerReason = reason;
      return this.compileRec(320, this.init.rec320, 'wasm');
    };
    if (numThreads > 1) return wasmOnly(`WebAssembly runs on ${numThreads} threads here, so the recognizers run on WebAssembly.`);
    if (!this.gpuUsable) return wasmOnly('WebAssembly runs on 1 thread here and there is no WebGPU device, so the recognizers run on WebAssembly.');
    if (!this.init.rec320Safe) {
      return wasmOnly('WebAssembly runs on 1 thread here, but the WebGPU form of the 320-wide recognizer is not published yet (modelInfo.rec320WebGpu; pass it as modelFiles.rec320), so the recognizers run on WebAssembly.');
    }
    const r = await this.checkWidth(320, this.init.rec320);
    if (!r.check) {
      this.recognizerReason = `WebAssembly runs on 1 thread here, but WebGPU could not run the recognizer (${r.error}), so the recognizers run on WebAssembly.`;
      return r.model;
    }
    this.recognizerCheck = r.check;
    if (r.backend === 'webgpu') {
      this.autoGpu = true;
      this.recognizerReason = `WebAssembly runs on 1 thread here, and the WebGPU recognizer read the check line exactly as WebAssembly (${r.check.steps} of ${r.check.steps} output steps), so the recognizers run on WebGPU.`;
    } else {
      this.recognizerReason = `WebAssembly runs on 1 thread here, but the WebGPU recognizer read the check line differently from WebAssembly (${r.check.differing} of ${r.check.steps} output steps), so the recognizers run on WebAssembly.`;
    }
    return r.model;
  }

  /**
   * The check of recognizer 'auto' for one width: compile the file on WebAssembly and on WebGPU, read the fixed line
   * (padded to the width) on both, keep WebGPU only if every output step's argmax is the same. The other model is
   * deleted after it ran (a WebGPU model deleted before its first run can stall LiteRT.js for tens of seconds).
   */
  private async checkWidth(width: RecWidth, bytes: Uint8Array): Promise<{ model: Compiled; backend: 'wasm' | 'webgpu'; check: RecognizerCheck | null; error?: string }> {
    const role = `rec${width}` as ModelRole;
    const shape = [1, 3, REC_H, width];
    const t0 = performance.now();
    const wasm = await this.compile(role, bytes, 'wasm');
    await this.warm(role, wasm, shape);
    let gpu: Compiled | null = null;
    try {
      gpu = await this.compile(role, bytes, 'webgpu');
      const acc = (gpu as { options?: { accelerator?: string } }).options?.accelerator ?? 'webgpu';
      if (acc !== 'webgpu') throw new Error(`compiled for ${acc}`);
      await this.warm(`${role}:webgpu`, gpu, shape);
    } catch (e) {
      try { gpu?.delete(); } catch { /* ignore */ }
      this.recBackends[width] = 'wasm';
      return { model: wasm, backend: 'wasm', check: null, error: errText(e) };
    }
    const input = probeInput(width);
    const C = this.chars.length;
    const a = argmaxSteps(await runModel(this.init.litert, wasm, input, shape), C);
    const b = argmaxSteps(await runModel(this.init.litert, gpu, input, shape), C);
    if (this.init.checkHook === 'mismatch' && b.length) b[0] = (b[0]! + 1) % C;
    let differing = Math.abs(a.length - b.length);
    for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) differing++;
    // the line as WebAssembly read it (greedy CTC: repeats collapsed, blanks dropped)
    let text = '';
    for (let i = 0, prev = -1; i < a.length; prev = a[i]!, i++) if (a[i] !== 0 && a[i] !== prev) text += this.chars[a[i]!];
    const check: RecognizerCheck = { width, steps: a.length, differing, ms: performance.now() - t0, text };
    if (differing === 0) {
      try { wasm.delete(); } catch { /* ignore */ }
      this.recBackends[width] = 'webgpu';
      this.gpuRecBytes.set(width, bytes);
      return { model: gpu, backend: 'webgpu', check };
    }
    try { gpu.delete(); } catch { /* ignore */ }
    this.recBackends[width] = 'wasm';
    return { model: wasm, backend: 'wasm', check };
  }

  /**
   * Compile a recognizer. The default is WebAssembly (the measured pipeline: on WebGPU the published 320 file
   * misreads lines, LiteRT issue #9661). With recognizer 'webgpu' the 640 / 960 files (and a 320 file given
   * in modelFiles.rec320) go to WebGPU when it compiles there; with 'auto' a wider recognizer goes to WebGPU after
   * the start check passed and its own check passes.
   */
  private async compileRec(width: RecWidth, bytes: Uint8Array, force?: 'wasm'): Promise<Compiled> {
    const role = `rec${width}` as ModelRole;
    const shape = [1, 3, REC_H, width];
    const mode = this.init.recognizer ?? 'auto';
    if (!force && mode === 'auto' && this.autoGpu && width !== 320) {
      const r = await this.checkWidth(width, bytes);
      if (r.backend === 'wasm') {
        this.init.notice(r.check
          ? `The ${width}-wide recognizer read the check line differently on WebGPU (${r.check.differing} of ${r.check.steps} output steps), so it runs on WebAssembly.`
          : `WebGPU could not run the ${width}-wide recognizer (${r.error}); it runs on WebAssembly.`);
      }
      return r.model;
    }
    const gpu = !force && mode === 'webgpu' && this.gpuUsable && (width !== 320 || this.init.rec320Safe === true);
    if (gpu) {
      try {
        const m = await this.compile(role, bytes, 'webgpu');
        const acc = (m as { options?: { accelerator?: string } }).options?.accelerator ?? 'webgpu';
        if (acc !== 'webgpu') throw new Error(`compiled for ${acc}`);
        await this.warm(role, m, shape);
        this.recBackends[width] = 'webgpu';
        this.gpuRecBytes.set(width, bytes);
        return m;
      } catch (e) {
        this.init.notice(`WebGPU could not run the ${width}-wide recognizer (${errText(e)}); it runs on WebAssembly.`);
      }
    } else if (!force && mode === 'webgpu' && !this.gpuUsable && width === 320) {
      this.init.notice('WebGPU is not available here; the recognizer runs on WebAssembly.');
    }
    const m = await this.compile(role, bytes, 'wasm');
    await this.warm(role, m, shape);
    this.recBackends[width] = 'wasm';
    return m;
  }

  /** The recognizer of this width, loading it on first use. */
  async recognizer(width: RecWidth): Promise<Compiled> {
    const have = this.recs.get(width);
    if (have) return have;
    let p = this.pending.get(width);
    if (!p) {
      p = (async () => {
        const m = await this.compileRec(width, await this.init.loadRec(width as 640 | 960));
        this.recs.set(width, m);
        return m;
      })();
      this.pending.set(width, p);
      p.catch(() => this.pending.delete(width));
    }
    return p;
  }

  get runners(): Runners {
    return {
      det: async (nchw) => {
        try {
          return await runModel(this.init.litert, this.det, nchw, [1, 3, DET_SIZE, DET_SIZE]);
        } catch (e) {
          if (this.detector !== 'webgpu') throw e;
          // A WebGPU failure mid-session (device lost): move the detector to WebAssembly and retry once.
          this.init.notice(`The WebGPU text detector failed (${errText(e)}); switching it to WebAssembly.`);
          try { this.det.delete(); } catch { /* already gone */ }
          this.det = await this.compile('det', this.init.det, 'wasm');
          this.detector = 'wasm';
          return runModel(this.init.litert, this.det, nchw, [1, 3, DET_SIZE, DET_SIZE]);
        }
      },
      rec: async (width, nchw) => {
        const m = await this.recognizer(width);
        try {
          return await runModel(this.init.litert, m, nchw, [1, 3, REC_H, width]);
        } catch (e) {
          const bytes = this.gpuRecBytes.get(width);
          if (this.recBackends[width] !== 'webgpu' || !bytes) throw e;
          this.init.notice(`The WebGPU ${width}-wide recognizer failed (${errText(e)}); switching it to WebAssembly.`);
          try { m.delete(); } catch { /* already gone */ }
          const w = await this.compile(`rec${width}` as ModelRole, bytes, 'wasm');
          this.recs.set(width, w);
          this.recBackends[width] = 'wasm';
          this.gpuRecBytes.delete(width);
          return runModel(this.init.litert, w, nchw, [1, 3, REC_H, width]);
        }
      },
    };
  }

  read<Src, Crop, Strip>(src: Src, ops: RasterOps<Src, Crop, Strip>, opts: ReadOptions) {
    const prefetch = (widths: RecWidth[]) => {
      // start every missing width now, in parallel; a failure surfaces when the width is used
      for (const w of widths) if (!this.recs.has(w)) this.recognizer(w).catch(() => {});
    };
    return readPage(src, ops, this.runners, this.chars, { ...opts, prefetch });
  }

  dispose(): void {
    for (const m of [this.det, ...this.recs.values()]) {
      try { m?.delete(); } catch { /* ignore */ }
    }
    this.recs.clear();
  }
}

/** Argmax over the vocabulary for each output step of a recognizer (probabilities [T, C]). */
function argmaxSteps(probs: Float32Array, C: number): Int32Array {
  const T = probs.length / C;
  const out = new Int32Array(T);
  for (let t = 0; t < T; t++) {
    const off = t * C;
    let best = 0, bv = probs[off]!;
    for (let c = 1; c < C; c++) {
      const v = probs[off + c]!;
      if (v > bv) { bv = v; best = c; }
    }
    out[t] = best;
  }
  return out;
}

async function runModel(litert: LiteRt, model: Compiled, nchw: Float32Array, shape: number[]): Promise<Float32Array> {
  const input = litert.Tensor.fromTypedArray(nchw, shape);
  try {
    const outputs = await model.run([input]);
    try {
      return (await outputs[0]!.data()) as Float32Array;
    } finally {
      for (const o of outputs) o.delete();
    }
  } finally {
    input.delete();
  }
}
