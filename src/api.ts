// The public API, the same shape as tesseract.js 7: createWorker / worker.recognize / worker.terminate,
// createScheduler, and the deprecated one-shot recognize(). The platform (browser or Node) supplies the
// worker and the image conversion.

import { OEM, PSM, SINGLE_LINE_PSM, checkLangs, languages } from './core/constants.js';
import { OcrError, deserializeError } from './core/errors.js';
import type { CacheMethod } from './core/fetcher.js';
import { MODEL_ROLES, type ModelRole } from './core/models.js';
import type { InitOptions, JobParams, ProgressData, Request, Response, WireImage } from './core/protocol.js';
import type {
  ImageLike,
  LoggerMessage,
  OutputFormats,
  Page,
  RecognizeOptions,
  RecognizeResult,
  Rectangle,
  Scheduler,
  Worker,
  WorkerInfo,
  WorkerOptions,
} from './core/types.js';

export interface Transport {
  post(msg: Request, transfer?: Transferable[]): void;
  onMessage(cb: (m: Response) => void): void;
  onError(cb: (e: OcrError) => void): void;
  terminate(): void | Promise<unknown>;
}

export interface MainPlatform {
  name: 'browser' | 'node';
  spawn(options: Partial<WorkerOptions>): Transport;
  toWire(image: ImageLike): Promise<{ wire: WireImage; transfer: Transferable[] }>;
  resolveUrl(u: string): string;
  defaults: { modelBase: string; wasmPath: string };
}

/** Startup details of a worker (not in tesseract.js): where it runs and what it loaded. */
export interface StartupInfo extends WorkerInfo {
  startup: { totalMs: number; compileMs: Record<string, number>; warmupMs: Record<string, number> };
}

const rand = () => Math.random().toString(16).slice(3, 8);
let workerCounter = 0;
let jobCounter = 0;
let logging = false;

const USED_PARAMS = new Set(['tessedit_char_whitelist', 'tessedit_char_blacklist', 'tessedit_pageseg_mode']);
const UNSUPPORTED_OUTPUTS: (keyof OutputFormats)[] = ['box', 'unlv', 'osd', 'pdf', 'imageColor', 'imageGrey', 'imageBinary', 'layoutBlocks', 'debug'];
const IGNORED_OPTIONS: (keyof WorkerOptions)[] = ['corePath', 'langPath', 'dataPath', 'workerBlobURL', 'gzip', 'legacyCore', 'legacyLang'];

export function makeApi(main: MainPlatform) {
  /**
   * Start a worker: loads the LiteRT.js runtime and the model (downloaded once, then cached) and resolves
   * when it can read.
   * @param langs tesseract language codes ('eng', 'jpn', 'eng+jpn', ['eng', 'jpn']). One model reads every
   *   covered language, so the value does not choose a model; it is checked, and a language whose script the
   *   model cannot read (Korean, Cyrillic, Arabic, Hebrew, Thai, Indic) or an unknown code rejects with
   *   LANG_NOT_SUPPORTED. Default 'eng'.
   * @param oem Accepted and ignored (one engine).
   * @param options See WorkerOptions.
   */
  async function createWorker(langs?: string | string[] | { code: string }[], oem?: number, options: Partial<WorkerOptions> = {}, _config?: unknown): Promise<Worker & { info: StartupInfo }> {
    void oem;
    checkLangs(langs);
    const id = `Worker-${workerCounter++}-${rand()}`;
    const logger = typeof options.logger === 'function' ? options.logger : null;
    const errorHandler = typeof options.errorHandler === 'function' ? options.errorHandler : null;
    const warned = new Set<string>();
    const warnOnce = (message: string) => {
      if (warned.has(message)) return;
      warned.add(message);
      console.warn(`[litert-ocr] ${message}`);
    };
    const emit = (jobId: string, d: ProgressData) => {
      if (d.status === 'notice' && d.level === 'warn') warnOnce(d.message ?? '');
      if (logging) console.debug(`[litert-ocr] ${id} ${jobId}`, d);
      if (!logger) return;
      const m: LoggerMessage = { workerId: id, jobId, userJobId: jobId, status: d.status, progress: d.progress };
      for (const k of ['message', 'file', 'loaded', 'total', 'fromCache'] as const) if (d[k] !== undefined) (m as unknown as Record<string, unknown>)[k] = d[k];
      try {
        logger(m);
      } catch {
        /* a throwing logger must not break the job */
      }
    };
    const localNotice = (jobId: string, message: string, level: 'info' | 'warn' = 'info') => emit(jobId, { status: 'notice', progress: 1, message, level });

    const ignoredOpts = IGNORED_OPTIONS.filter((k) => options[k] !== undefined);
    const init = buildInit(options, main);

    const transport = main.spawn(options);
    const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: OcrError) => void }>();
    let state: 'starting' | 'ready' | 'terminated' = 'starting';
    const failAll = (e: OcrError) => {
      for (const p of pending.values()) p.reject(e);
      pending.clear();
    };
    transport.onMessage((m) => {
      if (m.type === 'progress') return emit(m.id, m.data);
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.type === 'resolve') p.resolve(m.data);
      else p.reject(deserializeError(m.error));
    });
    transport.onError((e) => {
      state = 'terminated';
      failAll(e);
      void transport.terminate();
    });
    const call = <T>(msg: Request, transfer?: Transferable[]) =>
      new Promise<T>((resolve, reject) => {
        pending.set(msg.id, { resolve: resolve as (v: unknown) => void, reject });
        try {
          transport.post(msg, transfer);
        } catch (e) {
          pending.delete(msg.id);
          reject(e instanceof OcrError ? e : new OcrError('INVALID_ARGUMENT', `The image could not be sent to the worker: ${(e as Error).message}`));
        }
      });

    const initJob = `Job-${jobCounter++}-${rand()}`;
    if (ignoredOpts.length) localNotice(initJob, `Ignored options (tesseract.js paths, not used here): ${ignoredOpts.join(', ')}. The model comes from modelBase and the runtime from wasmPath.`);
    const t0 = performance.now();
    type Started = { info: WorkerInfo; timings: { compileMs: Record<string, number>; warmupMs: Record<string, number> } };
    let started: Started;
    try {
      started = await call<Started>({ type: 'init', id: initJob, options: init });
    } catch (e) {
      state = 'terminated';
      void transport.terminate();
      throw e;
    }
    state = 'ready';
    const info: StartupInfo = { ...started.info, startup: { totalMs: performance.now() - t0, ...started.timings } };
    let params: Record<string, unknown> = {};

    const terminatedError = (method: string) =>
      new OcrError('WORKER_TERMINATED', `This worker was terminated, so ${method}() cannot run. Create a new one with createWorker() (or keep one worker for all images and call terminate() once at the end).`);

    const worker = {
      id,
      info,
      async recognize(image: ImageLike, opts: RecognizeOptions = {}, output: Partial<OutputFormats> = { text: true }, jobId?: string): Promise<RecognizeResult> {
        const jid = jobId ?? `Job-${jobCounter++}-${rand()}`;
        try {
          if (state === 'terminated') throw terminatedError('recognize');
          if (opts === null || typeof opts !== 'object') throw new OcrError('INVALID_ARGUMENT', `recognize(image, options): options must be an object, got ${typeof opts}.`);
          const merged = { ...params, ...opts };
          const job = jobParams(merged);
          const rect = checkRect(opts.rectangle);
          const asked = UNSUPPORTED_OUTPUTS.filter((k) => output?.[k]);
          if (asked.length) localNotice(jid, `Output formats not produced by this library (null in the result): ${asked.join(', ')}. text, blocks, hocr and tsv are available.`, 'warn');
          const { wire, transfer } = await main.toWire(image);
          const out = { text: true, ...output };
          const r = await call<{ page: Page }>({ type: 'recognize', id: jid, image: wire, rectangle: rect, params: job, output: out }, transfer);
          return { jobId: jid, data: r.page };
        } catch (e) {
          const err = e instanceof OcrError ? e : new OcrError('INTERNAL', String((e as Error)?.message ?? e));
          if (errorHandler) {
            try { errorHandler(err); } catch { /* ignore */ }
          }
          throw err;
        }
      },
      async setParameters(p: Record<string, unknown>, jobId?: string) {
        const jid = jobId ?? `Job-${jobCounter++}-${rand()}`;
        if (state === 'terminated') throw terminatedError('setParameters');
        if (p === null || typeof p !== 'object') throw new OcrError('INVALID_ARGUMENT', 'setParameters(params): params must be an object.');
        jobParams({ ...params, ...p }); // validate
        params = { ...params, ...p };
        const ignored = Object.keys(p).filter((k) => !USED_PARAMS.has(k));
        if (ignored.length) localNotice(jid, `Ignored parameters (no effect on this engine): ${ignored.join(', ')}. Used: tessedit_char_whitelist, tessedit_char_blacklist, tessedit_pageseg_mode (single-line modes).`);
        return { jobId: jid, data: { ignored } };
      },
      async reinitialize(l?: string | string[], _oem?: number, _config?: unknown, jobId?: string) {
        if (state === 'terminated') throw terminatedError('reinitialize');
        checkLangs(l);
        return { jobId: jobId ?? `Job-${jobCounter++}-${rand()}`, data: null };
      },
      async detect(_image: ImageLike, _jobId?: string): Promise<never> {
        throw new OcrError('INVALID_ARGUMENT', 'detect() (orientation and script detection) is not supported. recognize() reads rotated lines on its own: tall lines are turned before reading.');
      },
      async load(jobId?: string) {
        return { jobId: jobId ?? `Job-${jobCounter++}-${rand()}`, data: null };
      },
      async terminate(jobId?: string) {
        const jid = jobId ?? `Job-${jobCounter++}-${rand()}`;
        if (state === 'terminated') return { jobId: jid, data: { terminated: true as const } };
        state = 'terminated';
        const ack = call({ type: 'terminate', id: jid }).catch(() => undefined);
        await Promise.race([ack, new Promise((r) => setTimeout(r, 1000))]);
        failAll(terminatedError('recognize'));
        await transport.terminate();
        return { jobId: jid, data: { terminated: true as const } };
      },
      // tesseract.js file-system helpers: there is no file system here.
      writeText: () => Promise.reject(new OcrError('INVALID_ARGUMENT', 'writeText() is a Tesseract file-system helper; this library has no worker file system.')),
      readText: () => Promise.reject(new OcrError('INVALID_ARGUMENT', 'readText() is a Tesseract file-system helper; this library has no worker file system.')),
      removeFile: () => Promise.reject(new OcrError('INVALID_ARGUMENT', 'removeFile() is a Tesseract file-system helper; this library has no worker file system.')),
      FS: () => Promise.reject(new OcrError('INVALID_ARGUMENT', 'FS() is a Tesseract file-system helper; this library has no worker file system.')),
    };
    return worker as Worker & { info: StartupInfo };
  }

  /** Deprecated in tesseract.js: create a worker, read one image, terminate. */
  async function recognize(image: ImageLike, langs?: string, options?: Partial<WorkerOptions>): Promise<RecognizeResult> {
    const worker = await createWorker(langs, 1, options);
    try {
      return await worker.recognize(image);
    } finally {
      await worker.terminate();
    }
  }

  async function detect(): Promise<never> {
    throw new OcrError('INVALID_ARGUMENT', 'detect() (orientation and script detection) is not supported by this library.');
  }

  function createScheduler(): Scheduler {
    const workers = new Map<string, Worker>();
    const busy = new Set<string>();
    let queue: { run: (w: Worker) => void }[] = [];
    const dequeue = () => {
      for (const [wid, w] of workers) {
        if (!queue.length) return;
        if (busy.has(wid)) continue;
        queue.shift()!.run(w);
      }
    };
    return {
      addWorker(w: Worker) {
        workers.set(w.id, w);
        dequeue();
        return w.id;
      },
      async addJob(action: 'recognize', ...args: Parameters<Worker['recognize']>) {
        if (action !== 'recognize') throw new OcrError('INVALID_ARGUMENT', `scheduler.addJob('${String(action)}'): only 'recognize' is supported.`);
        if (!workers.size) throw new OcrError('INVALID_ARGUMENT', 'scheduler.addJob(): add a worker first (scheduler.addWorker(await createWorker())).');
        return new Promise<RecognizeResult>((resolve, reject) => {
          queue.push({
            run: (w) => {
              busy.add(w.id);
              w.recognize(...args)
                .then(resolve, reject)
                .finally(() => {
                  busy.delete(w.id);
                  dequeue();
                });
            },
          });
          dequeue();
        });
      },
      async terminate() {
        queue = [];
        await Promise.all([...workers.values()].map((w) => w.terminate()));
        workers.clear();
      },
      getQueueLen: () => queue.length,
      getNumWorkers: () => workers.size,
    };
  }

  function setLogging(on: boolean) {
    logging = !!on;
  }

  return { createWorker, recognize, detect, createScheduler, setLogging, OEM, PSM, languages };
}

function buildInit(options: Partial<WorkerOptions>, main: MainPlatform): InitOptions {
  // Node.js / Deno / Bun: WebAssembly unless asked (Deno has WebGPU; it is opt-in there, not the default)
  const backend = options.backend ?? (main.name === 'node' ? 'wasm' : 'auto');
  if (backend !== 'auto' && backend !== 'wasm') throw new OcrError('INVALID_ARGUMENT', `options.backend must be 'auto' or 'wasm', got ${JSON.stringify(backend)}.`);
  const cacheMethod: CacheMethod = options.cacheMethod ?? 'write';
  if (!['write', 'readOnly', 'refresh', 'none'].includes(cacheMethod)) throw new OcrError('INVALID_ARGUMENT', `options.cacheMethod must be 'write', 'readOnly', 'refresh' or 'none', got ${JSON.stringify(cacheMethod)}.`);
  const modelFiles: InitOptions['modelFiles'] = {};
  for (const [role, v] of Object.entries(options.modelFiles ?? {})) {
    if (!MODEL_ROLES.includes(role as ModelRole)) throw new OcrError('INVALID_ARGUMENT', `options.modelFiles.${role}: unknown file; use ${MODEL_ROLES.join(', ')}.`);
    const spec = typeof v === 'string' ? { url: v } : v;
    if (!spec || typeof spec.url !== 'string') throw new OcrError('INVALID_ARGUMENT', `options.modelFiles.${role} must be a URL string or { url, sha256 }.`);
    const s: { url: string; sha256?: string } = { url: main.resolveUrl(spec.url) };
    if (spec.sha256) s.sha256 = spec.sha256.toLowerCase();
    modelFiles[role as ModelRole] = s;
  }
  const dir = (u: string) => (u.endsWith('/') ? u : u + '/');
  const o: InitOptions = {
    modelBase: dir(options.modelBase ? main.resolveUrl(options.modelBase) : main.defaults.modelBase),
    modelFiles,
    wasmPath: dir(options.wasmPath ? main.resolveUrl(options.wasmPath) : main.defaults.wasmPath),
    backend,
    cacheMethod,
    eager: options.eager === true,
  };
  if (options.cachePath) o.cachePath = options.cachePath;
  return o;
}

function jobParams(p: Record<string, unknown>): JobParams {
  const str = (k: string) => {
    const v = p[k];
    if (v === undefined || v === null || v === '') return null;
    if (typeof v !== 'string') throw new OcrError('INVALID_ARGUMENT', `${k} must be a string of characters, got ${typeof v}.`);
    return v;
  };
  const psm = p.tessedit_pageseg_mode;
  return { whitelist: str('tessedit_char_whitelist'), blacklist: str('tessedit_char_blacklist'), singleLine: psm !== undefined && SINGLE_LINE_PSM.has(String(psm)) };
}

function checkRect(r: unknown): Rectangle | null {
  if (r === undefined || r === null) return null;
  const o = r as Record<string, unknown>;
  for (const k of ['left', 'top', 'width', 'height']) {
    if (typeof o[k] !== 'number' || !Number.isFinite(o[k] as number)) {
      throw new OcrError('INVALID_ARGUMENT', `options.rectangle must be { left, top, width, height } in pixels; ${k} is ${JSON.stringify(o[k])}.`);
    }
  }
  if ((o.width as number) <= 0 || (o.height as number) <= 0) throw new OcrError('INVALID_ARGUMENT', 'options.rectangle width and height must be greater than 0.');
  return { left: o.left as number, top: o.top as number, width: o.width as number, height: o.height as number };
}
