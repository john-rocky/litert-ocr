// The worker side of the protocol, shared by the browser Web Worker and the Node worker thread. Jobs run
// one at a time in arrival order.

import type * as LiteRtModule from '@litertjs/core';
import { Engine } from './engine.js';
import { OcrError, serializeError } from './errors.js';
import { fetchVerified, type FetchContext, type FileCache, type FileSpec } from './fetcher.js';
import { LITERT_VERSION, MODEL_BASE, MODEL_FILES, MODEL_NAME, MODEL_REVISION, PKG_NAME, PKG_VERSION, type ModelRole } from './models.js';
import { buildPage, type CoordMap } from './output.js';
import type { RasterOps } from './pipeline.js';
import type { InitOptions, ProgressData, Request, Response, WireImage } from './protocol.js';
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

  const send = (id: string, data: ProgressData) => post({ type: 'progress', id, data });

  async function init(id: string, o: InitOptions): Promise<WorkerInfo> {
    const notice = (message: string, level: 'info' | 'warn' = 'info') => send(id, { status: 'notice', progress: 1, message, level });
    const cache = await platform.cache(o);
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
    let before = 0;
    for (let i = 0; i < startRoles.length; i++) {
      const spec = specs[i]!;
      const base = before;
      got[startRoles[i]!] = await fetchVerified(
        spec,
        makeCtx('modelBase', (loaded, _t, fromCache) => send(id, { status: 'loading model', progress: total ? Math.min(1, (base + loaded) / total) : 0, file: spec.name, loaded: base + loaded, total, fromCache })),
      );
      before += got[startRoles[i]!]!.byteLength;
    }
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
    const planned = o.recognizer === 'webgpu' && litert.isWebGPUSupported() ? 'webgpu' : 'wasm';
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

  async function handle(req: Request): Promise<void> {
    try {
      if (req.type === 'terminate') {
        terminated = true;
        engine?.dispose();
        engine = null;
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
