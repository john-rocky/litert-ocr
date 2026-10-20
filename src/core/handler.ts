// The worker side of the protocol, shared by the browser Web Worker and the Node worker thread. Jobs run
// one at a time in arrival order.

import type * as LiteRtModule from '@litertjs/core';
import type { Region, RuledBox, Unit } from '../doc/geom.js';
import { LAYOUT_SIZE, LayoutModel } from '../doc/layout.js';
import { RULE_WIDTH, SKEW_WIDTH, estimateSkew, ruledBoxes } from '../doc/scan.js';
import { Engine } from './engine.js';
import { OcrError, errText, serializeError } from './errors.js';
import { fetchVerified, type FetchContext, type FileCache, type FileSpec } from './fetcher.js';
import { LAYOUT_BASE, LAYOUT_FILES, LAYOUT_NAME, LITERT_VERSION, MODEL_BASE, MODEL_FILES, MODEL_NAME, MODEL_REVISION, PKG_NAME, PKG_VERSION, type LayoutForm, type ModelRole } from './models.js';
import { buildPage, type CoordMap } from './output.js';
import type { RasterOps } from './pipeline.js';
import type { DocPageOptions, InitOptions, ProgressData, Request, Response, WireImage } from './protocol.js';
import type { Rectangle, WorkerInfo } from './types.js';

type LiteRt = typeof LiteRtModule;

/** Images whose longer side exceeds this are scaled down before reading (boxes stay in original pixels). */
export const MAX_SIDE = 4096;

export interface Prepared<Src> {
  src: Src;
  map: CoordMap;
  /** Size of the caller's image (before rectangle and scaling). */
  size: { width: number; height: number };
  release(): void;
}

export interface Platform<Src> {
  name: WorkerInfo['platform'];
  loadRuntime(o: InitOptions, io: RuntimeIO): Promise<{ litert: LiteRt; threads: number }>;
  cache(o: InitOptions): Promise<FileCache | null>;
  sha256(bytes: Uint8Array): Promise<string>;
  readLocal?: (url: string) => Promise<Uint8Array> | null;
  decode(image: WireImage): Promise<{ src: Src; release(): void }>;
  prepare(src: Src, rect: Rectangle | null, maxSide: number): Promise<Prepared<Src>>;
  ops: RasterOps<Src, unknown, unknown>;
  /** Page steps of convert(): an RGBA copy scaled to w x h (default smoothing), and the page turned back by deg. */
  doc: {
    scaled(src: Src, w: number, h: number): Uint8ClampedArray;
    rotate(src: Src, deg: number): Promise<{ src: Src; release(): void }>;
  };
}

/** What the OCR path of convert() returns for one page (boxes in the caller's image pixels). */
export interface DocPageData {
  units: Unit[];
  ruled: RuledBox[];
  regions: Region[] | null;
  page: { width: number; height: number };
  /** Degrees the page was turned back by (0 = not turned). */
  skew: number;
  layout: { used: 'model' | 'geometry'; backend: LayoutForm | null; reason: string | null };
  timing: { totalMs: number; skewMs: number; detMs: number; recMs: number; ruleMs: number; layoutMs: number };
}

export interface RuntimeIO {
  notice(message: string, level?: 'info' | 'warn'): void;
  progress(data: ProgressData): void;
  fetch(spec: FileSpec, status: string): Promise<Uint8Array>;
}

export function createHandler<Src>(platform: Platform<Src>, post: (msg: Response) => void): (req: Request) => void {
  let engine: Engine | null = null;
  let info: WorkerInfo | null = null;
  let chain: Promise<void> = Promise.resolve();
  let terminated = false;
  // kept from init for the layout model of convert(), which loads on the first page that needs it
  let runtime: { litert: LiteRt; threads: number } | null = null;
  let initOpts: InitOptions | null = null;
  let fileCache: FileCache | null = null;
  const layouts: Partial<Record<LayoutForm, LayoutModel>> = {};
  const layoutFailed: Partial<Record<LayoutForm, string>> = {};

  const send = (id: string, data: ProgressData) => post({ type: 'progress', id, data });

  async function init(id: string, o: InitOptions): Promise<WorkerInfo> {
    const notice = (message: string, level: 'info' | 'warn' = 'info') => send(id, { status: 'notice', progress: 1, message, level });
    const cache = await platform.cache(o);
    fileCache = cache;
    initOpts = o;
    if (!cache && o.cacheMethod !== 'none') notice('No cache is available here (Cache API needs a secure context); the files download on every start.', 'warn');
    const makeCtx = (selfHost: 'modelBase' | 'wasmPath', onBytes: FetchContext['onBytes']): FetchContext => ({
      cache,
      cacheMethod: o.cacheMethod,
      sha256: platform.sha256,
      notice: (m) => notice(m, 'warn'),
      readLocal: platform.readLocal ?? (() => null),
      selfHostOption: selfHost,
      onBytes,
    });
    const io: RuntimeIO = {
      notice,
      progress: (d) => send(id, d),
      fetch: (spec, status) =>
        fetchVerified(spec, makeCtx('wasmPath', (loaded, total, fromCache) => send(id, { status, progress: total ? loaded / total : 0, file: spec.name, loaded, total, fromCache }))),
    };
    const { litert, threads } = await platform.loadRuntime(o, io);
    runtime = { litert, threads };
    const specOf = (role: ModelRole): FileSpec => {
      const over = o.modelFiles[role];
      const pinned = MODEL_FILES[role];
      if (over) return over.sha256 ? { name: pinned.file, url: over.url, sha256: over.sha256, origin: MODEL_BASE } : { name: pinned.file, url: over.url, origin: MODEL_BASE };
      return { name: pinned.file, url: joinUrl(o.modelBase, pinned.file), bytes: pinned.bytes, sha256: pinned.sha256, origin: MODEL_BASE };
    };
    // Model files: one progress stream over the files loaded at start.
    const startRoles: ModelRole[] = o.eager ? ['characters', 'det', 'rec320', 'rec640', 'rec960'] : ['characters', 'det', 'rec320'];
    const specs = startRoles.map(specOf);
    const total = specs.reduce((s, f) => s + (f.bytes ?? 0), 0);
    const got: Partial<Record<ModelRole, Uint8Array>> = {};
    // in parallel; one progress stream over the bytes of all of them
    const loadedBy = new Array<number>(specs.length).fill(0);
    const bytes = await Promise.all(
      specs.map((spec, i) =>
        fetchVerified(
          spec,
          makeCtx('modelBase', (loaded, _t, fromCache) => {
            loadedBy[i] = loaded;
            const sum = loadedBy.reduce((a, b) => a + b, 0);
            send(id, { status: 'loading model', progress: total ? Math.min(1, sum / total) : 0, file: spec.name, loaded: sum, total, fromCache });
          }),
        ),
      ),
    );
    startRoles.forEach((role, i) => { got[role] = bytes[i]!; });
    const lazy = async (width: 640 | 960): Promise<Uint8Array> => {
      const role = `rec${width}` as ModelRole;
      if (got[role]) {
        const b = got[role]!;
        delete got[role];
        return b;
      }
      notice(`A line wider than ${width === 640 ? 320 : 640} px at height 48 needs ${MODEL_FILES[role].file}; loading it now (once).`);
      const spec = specOf(role);
      return fetchVerified(spec, makeCtx('modelBase', (loaded, t, fromCache) => send(currentJob, { status: 'loading model', progress: t ? loaded / t : 0, file: spec.name, loaded, total: t, fromCache })));
    };
    engine = await Engine.create({
      litert,
      det: got.det!,
      rec320: got.rec320!,
      characters: got.characters!,
      loadRec: lazy,
      numThreads: threads,
      backend: o.backend,
      recognizer: o.recognizer ?? 'wasm',
      rec320Safe: o.modelFiles.rec320 !== undefined,
      notice,
      progress: (p, step) => send(id, { status: 'initializing model', progress: p, message: step }),
    });
    delete got.det;
    delete got.rec320;
    if (o.eager) {
      await engine.recognizer(640);
      await engine.recognizer(960);
    }
    const rb = engine.recBackends;
    const planned = o.recognizer === 'webgpu' && engine.gpuUsable ? 'webgpu' : 'wasm';
    const recognizers = { '320': rb[320], '640': o.eager ? rb[640] : planned, '960': o.eager ? rb[960] : planned } as const;
    const kinds = new Set(Object.values(recognizers));
    info = {
      detector: engine.detector,
      recognizer: kinds.size > 1 ? 'mixed' : [...kinds][0]!,
      recognizers,
      threads,
      runtime: `LiteRT.js ${LITERT_VERSION}`,
      model: `${MODEL_NAME} @${MODEL_REVISION.slice(0, 7)}`,
      platform: platform.name,
    };
    const recText = info.recognizer === 'mixed' ? `recognizer 320 ${recognizers['320']} / 640, 960 ${recognizers['640']}` : `recognizer ${info.recognizer}`;
    send(id, { status: 'initialized', progress: 1, message: `detector ${info.detector}, ${recText}, ${threads} thread${threads === 1 ? '' : 's'}` });
    return info;
  }

  let currentJob = '';

  async function recognize(req: Extract<Request, { type: 'recognize' }>) {
    if (!engine || !info) throw new OcrError('INTERNAL', 'recognize() reached a worker that is not initialized.');
    const id = req.id;
    currentJob = id;
    const t0 = performance.now();
    send(id, { status: 'recognizing text', progress: 0 });
    const decoded = await platform.decode(req.image);
    let prepared: Prepared<Src> | null = null;
    try {
      prepared = await platform.prepare(decoded.src, req.rectangle, MAX_SIDE);
      if (prepared.map.scale !== 1) {
        send(id, { status: 'notice', progress: 1, level: 'info', message: `The image is ${prepared.size.width} x ${prepared.size.height}; it is read at ${MAX_SIDE} px on the longer side (boxes are in the original pixels).` });
      }
      let lastSent = 0;
      const r = await engine.read(prepared.src, platform.ops, {
        whitelist: req.params.whitelist,
        blacklist: req.params.blacklist,
        singleLine: req.params.singleLine,
        onLine: (done, total) => {
          const now = performance.now();
          if (done === total || now - lastSent > 100) {
            lastSent = now;
            send(id, { status: 'recognizing text', progress: total ? 0.1 + (0.9 * done) / total : 1 });
          }
        },
      });
      const page = buildPage(r.lines, req.output, prepared.size, prepared.map, `${PKG_NAME} ${PKG_VERSION} (${info.model}, ${info.runtime})`);
      send(id, { status: 'recognizing text', progress: 1 });
      return { page, timing: { totalMs: performance.now() - t0, detMs: r.detMs, recMs: r.recMs }, detector: engine.detector };
    } finally {
      prepared?.release();
      decoded.release();
    }
  }

  /**
   * The layout model for a page, loaded on first use. 'auto' = WebGPU form where a WebGPU device exists in a browser,
   * the WebAssembly form in Node.js / Deno / Bun, else none; 'model' = WebGPU form where possible, else WebAssembly.
   * Files missing, a download failing or a graph not compiling is not an error: the page is laid out by geometry and
   * a notice says why (once per form).
   */
  async function layoutFor(mode: DocPageOptions['layout'], id: string): Promise<{ model: LayoutModel | null; reason: string | null }> {
    if (mode === 'geometry') return { model: null, reason: null };
    const notice = (message: string) => send(id, { status: 'notice', progress: 1, message, level: 'warn' });
    const base = initOpts?.layoutBase ?? null;
    if (!base) {
      const reason = `The layout model (${LAYOUT_NAME}) is not published yet, so pages are laid out by geometry. To use it, pass layoutModelBase: a directory that holds its files (modelInfo.layout).`;
      if (!layoutFailed.webgpu && !layoutFailed.wasm) notice(reason);
      layoutFailed.webgpu = layoutFailed.wasm = reason;
      return { model: null, reason };
    }
    const forceWasm = initOpts?.layoutBackend === 'wasm';
    const gpu = !forceWasm && engine!.gpuUsable && platform.name === 'browser';
    if (mode === 'auto' && platform.name === 'browser' && !gpu && !forceWasm) {
      return { model: null, reason: 'No WebGPU device here, so the layout model is not loaded and pages are laid out by geometry. Pass layout: "model" to run it on WebAssembly (173 MB, slower).' };
    }
    const form: LayoutForm = gpu ? 'webgpu' : 'wasm';
    if (layouts[form]) return { model: layouts[form]!, reason: null };
    if (layoutFailed[form]) return { model: null, reason: layoutFailed[form]! };
    const files = LAYOUT_FILES[form];
    const origin = LAYOUT_BASE ?? 'the converted docling-layout-heron files (modelInfo.layout)';
    const specs: FileSpec[] = (['a', 'b', 'host'] as const).map((r) => ({ name: files[r].file, url: joinUrl(base, files[r].file), bytes: files[r].bytes, sha256: files[r].sha256, origin }));
    const total = specs.reduce((s, f) => s + (f.bytes ?? 0), 0);
    const loadedBy = specs.map(() => 0);
    try {
      const [a, b, host] = await Promise.all(
        specs.map((spec, i) =>
          fetchVerified(spec, {
            cache: fileCache,
            cacheMethod: initOpts!.cacheMethod,
            sha256: platform.sha256,
            notice,
            readLocal: platform.readLocal ?? (() => null),
            selfHostOption: 'layoutModelBase',
            onBytes: (loaded, _t, fromCache) => {
              loadedBy[i] = loaded;
              const sum = loadedBy.reduce((x, y) => x + y, 0);
              send(id, { status: 'loading layout model', progress: total ? Math.min(1, sum / total) : 0, file: spec.name, loaded: sum, total, fromCache });
            },
          }),
        ),
      );
      send(id, { status: 'initializing layout model', progress: 0, message: form });
      const m = await LayoutModel.create(runtime!.litert, { a: a!, b: b!, host: host! }, form, runtime!.threads);
      send(id, { status: 'initializing layout model', progress: 1, message: `${LAYOUT_NAME} on ${form === 'webgpu' ? 'WebGPU' : `WebAssembly, ${runtime!.threads} thread${runtime!.threads === 1 ? '' : 's'}`}` });
      layouts[form] = m;
      return { model: m, reason: null };
    } catch (e) {
      const reason = `The layout model could not be used on ${form === 'webgpu' ? 'WebGPU' : 'WebAssembly'} (${errText(e)}), so pages are laid out by geometry.`;
      layoutFailed[form] = reason;
      notice(reason);
      return { model: null, reason };
    }
  }

  async function docPage(req: Extract<Request, { type: 'docPage' }>): Promise<DocPageData> {
    if (!engine || !info || !runtime) throw new OcrError('INTERNAL', 'convert() reached a worker that is not initialized.');
    const id = req.id;
    currentJob = id;
    const t0 = performance.now();
    send(id, { status: 'recognizing text', progress: 0 });
    const decoded = await platform.decode(req.image);
    let prepared: Prepared<Src> | null = null;
    let turned: { src: Src; release(): void } | null = null;
    try {
      prepared = await platform.prepare(decoded.src, null, MAX_SIDE);
      if (prepared.map.scale !== 1) {
        send(id, { status: 'notice', progress: 1, level: 'info', message: `The image is ${prepared.size.width} x ${prepared.size.height}; it is read at ${MAX_SIDE} px on the longer side (boxes are in the original pixels).` });
      }
      let src = prepared.src;
      const { width: W, height: H } = platform.ops.size(src);
      // 1. skew: estimated on a 1000-px-wide copy, the page turned back on white (as measured)
      let skew = 0;
      const ts = performance.now();
      if (req.options.deskew) {
        const w = Math.min(SKEW_WIDTH, W), h = Math.round((H * w) / W);
        skew = estimateSkew(platform.doc.scaled(src, w, h), w, h);
        if (skew) {
          turned = await platform.doc.rotate(src, skew);
          src = turned.src;
        }
      }
      const skewMs = performance.now() - ts;
      // 2. text lines
      let lastSent = 0;
      const r = await engine.read(src, platform.ops, {
        whitelist: null,
        blacklist: null,
        singleLine: false,
        onLine: (done, total) => {
          const now = performance.now();
          if (done === total || now - lastSent > 100) {
            lastSent = now;
            send(id, { status: 'recognizing text', progress: total ? 0.1 + (0.8 * done) / total : 0.9 });
          }
        },
      });
      // 3. ruled lines (table regions for the geometry)
      const tr = performance.now();
      const rw = Math.min(W, RULE_WIDTH), rh = Math.round((H * rw) / W);
      const ruled = ruledBoxes(platform.doc.scaled(src, rw, rh), rw, rh, rw / W);
      const ruleMs = performance.now() - tr;
      // 4. layout regions
      const lay = await layoutFor(req.options.layout, id);
      let regions: Region[] | null = null;
      let layoutMs = 0;
      let used: 'model' | 'geometry' = 'geometry';
      let reason = lay.reason;
      if (lay.model) {
        try {
          const out = await lay.model.regions(platform.ops.detRGBA(src, LAYOUT_SIZE), W, H);
          regions = out.regions;
          layoutMs = out.ms;
          used = 'model';
        } catch (e) {
          reason = `The layout model failed on this page (${errText(e)}); it is laid out by geometry.`;
          send(id, { status: 'notice', progress: 1, level: 'warn', message: reason });
        }
      }
      const m = prepared.map;
      const mx = (x: number) => x * m.scale + m.dx, my = (y: number) => y * m.scale + m.dy;
      const units: Unit[] = r.lines.map((l) => ({ x0: mx(l.box[0]), y0: my(l.box[1]), x1: mx(l.box[2]), y1: my(l.box[3]), text: l.text, score: l.score }));
      send(id, { status: 'recognizing text', progress: 1 });
      return {
        units,
        ruled: ruled.map((b) => ({ x0: mx(b.x0), y0: my(b.y0), x1: mx(b.x1), y1: my(b.y1) })),
        regions: regions && regions.map((g) => ({ ...g, x0: mx(g.x0), y0: my(g.y0), x1: mx(g.x1), y1: my(g.y1) })),
        page: prepared.size,
        skew,
        layout: { used, backend: used === 'model' ? lay.model!.backend : null, reason: used === 'model' ? null : reason },
        timing: { totalMs: performance.now() - t0, skewMs, detMs: r.detMs, recMs: r.recMs, ruleMs, layoutMs },
      };
    } finally {
      turned?.release();
      prepared?.release();
      decoded.release();
    }
  }

  async function handle(req: Request): Promise<void> {
    try {
      if (req.type === 'terminate') {
        terminated = true;
        engine?.dispose();
        engine = null;
        for (const f of Object.keys(layouts) as LayoutForm[]) layouts[f]?.dispose();
        post({ type: 'resolve', id: req.id, data: { terminated: true } });
        return;
      }
      if (terminated) throw new OcrError('WORKER_TERMINATED', 'This worker was terminated. Create a new one with createWorker().');
      if (req.type === 'init') {
        const i = await init(req.id, req.options);
        post({ type: 'resolve', id: req.id, data: { info: i, timings: engine?.timings } });
        return;
      }
      if (req.type === 'recognize') {
        post({ type: 'resolve', id: req.id, data: await recognize(req) });
        return;
      }
      if (req.type === 'docPage') {
        post({ type: 'resolve', id: req.id, data: await docPage(req) });
        return;
      }
    } catch (e) {
      post({ type: 'reject', id: req.id, error: serializeError(e) });
    }
  }

  return (req: Request) => {
    chain = chain.then(() => handle(req));
  };
}

export function joinUrl(base: string, file: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(base)) return new URL(file, base.endsWith('/') ? base : base + '/').href;
  return base.endsWith('/') ? base + file : `${base}/${file}`;
}
