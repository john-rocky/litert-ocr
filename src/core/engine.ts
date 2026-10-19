// Compiles the model files with LiteRT.js and runs the pipeline. Shared by the browser worker and the
// Node worker; the platform supplies the LiteRT module (already loaded), the file bytes and the image ops.
// The detector, the 320-wide recognizer and the vocabulary load at start; the 640 / 960 recognizers load
// the first time a line needs them (same files, same output — only later).

import type * as LiteRtModule from '@litertjs/core';
import { OcrError, errText } from './errors.js';
import { MODEL_FILES, VOCAB_SIZE, type ModelRole } from './models.js';
import { DET_SIZE } from './db.js';
import { REC_H, readPage, type RasterOps, type ReadOptions, type RecWidth, type Runners } from './pipeline.js';

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
  notice: (message: string, level?: 'info' | 'warn') => void;
  /** Compile progress 0..1 and a label of the step. */
  progress: (p: number, step: string) => void;
}

export interface EngineTimings {
  compileMs: Record<string, number>;
  warmupMs: Record<string, number>;
}

export class Engine {
  readonly timings: EngineTimings = { compileMs: {}, warmupMs: {} };
  private readonly recs = new Map<RecWidth, Compiled>();
  private readonly pending = new Map<RecWidth, Promise<Compiled>>();
  private det!: Compiled;
  detector: 'webgpu' | 'wasm' = 'wasm';
  chars!: string[];

  private constructor(private readonly init: EngineInit) {}

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
    const { litert, notice } = this.init;
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
    // The recognizer runs on WebAssembly: on WebGPU it misreads lines (LiteRT issue #9661, still open).
    const rec = await this.compile('rec320', this.init.rec320, 'wasm');
    await this.warm('rec320', rec, [1, 3, REC_H, 320]);
    this.recs.set(320, rec);
    this.init.progress(0.5, 'detector');
    let det: Compiled | null = null;
    if (this.init.backend !== 'wasm' && litert.isWebGPUSupported()) {
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

  /** The recognizer of this width, loading it on first use. */
  async recognizer(width: RecWidth): Promise<Compiled> {
    const have = this.recs.get(width);
    if (have) return have;
    let p = this.pending.get(width);
    if (!p) {
      p = (async () => {
        const bytes = await this.init.loadRec(width as 640 | 960);
        const m = await this.compile(`rec${width}` as ModelRole, bytes, 'wasm');
        await this.warm(`rec${width}`, m, [1, 3, REC_H, width]);
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
      rec: async (width, nchw) => runModel(this.init.litert, await this.recognizer(width), nchw, [1, 3, REC_H, width]),
    };
  }

  read<Src, Crop, Strip>(src: Src, ops: RasterOps<Src, Crop, Strip>, opts: ReadOptions) {
    return readPage(src, ops, this.runners, this.chars, opts);
  }

  dispose(): void {
    for (const m of [this.det, ...this.recs.values()]) {
      try { m?.delete(); } catch { /* ignore */ }
    }
    this.recs.clear();
  }
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
