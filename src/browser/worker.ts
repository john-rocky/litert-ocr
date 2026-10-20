// Entry of the browser worker. It must be a classic worker: LiteRT.js 2.5.3 loads its Emscripten glue
// with importScripts(), which module workers do not allow.

import * as litert from '@litertjs/core';
import { CUT_HINT, cutShortBlob } from '../core/cutshort.js';
import { OcrError, errText } from '../core/errors.js';
import { createHandler, type Platform, type Prepared } from '../core/handler.js';
import { LITERT_FILES, LITERT_WASM_BASE, litertPrint, type RuntimeVariant } from '../core/models.js';
import type { WireImage } from '../core/protocol.js';
import { sha256Hex } from '../core/sha256.js';
import type { Rectangle } from '../core/types.js';
import { canvasDocOps, canvasOps } from './raster.js';

declare const self: DedicatedWorkerGlobalScope & {
  Module?: Record<string, unknown>;
  importScripts: (...urls: string[]) => void;
};

const MAX_THREADS = 12;
const CACHE_NAME = 'litert-ocr-v1';

const platform: Platform<ImageBitmap> = {
  name: 'browser',

  async loadRuntime(o, io) {
    const coi = self.crossOriginIsolated === true;
    const relaxedSimd = await litert.supportsFeature('relaxedSimd').catch(() => false);
    let threads = coi && relaxedSimd && typeof SharedArrayBuffer !== 'undefined';
    if (threads && !(await blobWorkersStart())) {
      threads = false;
      io.notice('This page does not allow blob: workers (Content-Security-Policy worker-src), which WebAssembly threads start from; WebAssembly runs on 1 thread. Add "worker-src blob:" to use threads.', 'warn');
    }
    if (!coi) {
      io.notice(
        'This page is not cross-origin isolated, so WebAssembly runs on 1 thread (several times slower). Serve the page with ' +
          '"Cross-Origin-Opener-Policy: same-origin" and "Cross-Origin-Embedder-Policy: require-corp" (or "credentialless"), ' +
          'or add coi-serviceworker (https://github.com/gzuidhof/coi-serviceworker) when you cannot set headers.',
        'warn',
      );
    } else if (!relaxedSimd) {
      io.notice('This browser has no WebAssembly relaxed SIMD, which the threaded LiteRT.js build needs; WebAssembly runs on 1 thread.', 'warn');
    }
    const attempt = async (variant: RuntimeVariant, useThreads: boolean) => {
      const f = LITERT_FILES[variant];
      const base = o.wasmPath;
      const js = await io.fetch({ name: f.js.file, url: new URL(f.js.file, base).href, bytes: f.js.bytes, sha256: f.js.sha256, origin: LITERT_WASM_BASE }, 'loading runtime');
      const wasm = await io.fetch({ name: f.wasm.file, url: new URL(f.wasm.file, base).href, bytes: f.wasm.bytes, sha256: f.wasm.sha256, origin: LITERT_WASM_BASE }, 'loading runtime');
      const glue = new Blob([js as BlobPart], { type: 'text/javascript' });
      const glueUrl = URL.createObjectURL(glue);
      // LiteRT.js loads <wasmPath>/<glue>.js with importScripts: hand it the verified copy instead, give the
      // wasm bytes to Emscripten directly, and start pthreads from the same blob (a cross-origin script URL
      // cannot start a worker, which is why a page that loaded the runtime from a CDN fell back to 1 thread).
      // importScripts is an own property of the worker's global object (WebIDL [Global]): swap it, then put it back
      const original = self.importScripts;
      const wanted = new URL(f.js.file, base).href;
      self.importScripts = (...urls: string[]) => original.apply(self, urls.map((u) => (u === wanted ? glueUrl : u)));
      self.Module = { ...litertPrint, wasmBinary: wasm, mainScriptUrlOrBlob: glue, locateFile: (p: string) => new URL(p, base).href };
      try {
        await litert.loadLiteRt(base, useThreads ? { threads: true } : {});
      } finally {
        self.importScripts = original;
        self.Module = undefined;
      }
    };
    const variant: RuntimeVariant = relaxedSimd ? (threads ? 'threaded' : 'plain') : 'compat';
    const origWarn = console.warn;
    // LiteRT.js warns when it cannot open a default WebGPU device; the detector choice reports it instead.
    console.warn = (...a: unknown[]) => { if (!String(a[0]).startsWith('Failed to create default WebGPU device')) origWarn(...a); };
    try {
      await attempt(variant, threads);
    } catch (e) {
      if (e instanceof OcrError) throw e;
      if (!threads) throw new OcrError('RUNTIME_LOAD_FAILED', `LiteRT.js ${variant} could not start: ${errText(e)}.`, { cause: e });
      io.notice(`The threaded LiteRT.js runtime could not start (${errText(e)}); using 1 thread.`, 'warn');
      threads = false;
      try {
        await attempt('plain', false);
      } catch (e2) {
        if (e2 instanceof OcrError) throw e2;
        throw new OcrError('RUNTIME_LOAD_FAILED', `LiteRT.js could not start: ${errText(e2)}.`, { cause: e2 });
      }
    } finally {
      console.warn = origWarn;
    }
    const n = threads ? Math.max(1, Math.min(navigator.hardwareConcurrency || 4, MAX_THREADS)) : 1;
    return { litert, threads: n };
  },

  async cache(o) {
    if (o.cacheMethod === 'none' || typeof caches === 'undefined') return null;
    try {
      const c = await caches.open(CACHE_NAME);
      return {
        async get(key) {
          const r = await c.match(key);
          return r ? new Uint8Array(await r.arrayBuffer()) : null;
        },
        async put(key, bytes) {
          await c.put(key, new Response(bytes as BlobPart, { headers: { 'content-length': String(bytes.byteLength) } }));
        },
        async has(key, bytes) {
          const r = await c.match(key);
          return !!r && (!bytes || Number(r.headers.get('content-length')) === bytes);
        },
      };
    } catch {
      return null;
    }
  },

  async sha256(bytes) {
    if (crypto?.subtle) {
      const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
      return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
    }
    return sha256Hex(bytes);
  },

  saveData: () => (navigator as { connection?: { saveData?: boolean } }).connection?.saveData === true,

  async decode(image: WireImage, onCut) {
    let blob: Blob;
    switch (image.kind) {
      case 'bitmap':
        return { src: image.bitmap, release: () => image.bitmap.close() };
      case 'pixels': {
        let bm: ImageBitmap;
        try {
          bm = await createImageBitmap(new ImageData(image.data as Uint8ClampedArray<ArrayBuffer>, image.width, image.height));
        } catch (e) {
          throw new OcrError('IMAGE_DECODE_FAILED', `The pixel data could not be used (${errText(e)}): data must hold width * height * 4 RGBA bytes.`);
        }
        return { src: bm, release: () => bm.close() };
      }
      case 'url': {
        let resp: Response;
        try {
          resp = await fetch(image.url);
        } catch (e) {
          throw new OcrError(
            'IMAGE_FETCH_FAILED',
            `Could not fetch the image at ${shortUrl(image.url)} (${errText(e)}). An image on another origin needs the header Access-Control-Allow-Origin; otherwise fetch it on your server, or pass a Blob, File or loaded <img>.`,
            { url: image.url, cause: e },
          );
        }
        if (!resp.ok) throw new OcrError('IMAGE_FETCH_FAILED', `Could not fetch the image at ${shortUrl(image.url)}: HTTP ${resp.status}.`, { url: image.url, status: resp.status });
        blob = await resp.blob();
        break;
      }
      case 'blob':
        blob = image.blob;
        break;
      case 'bytes':
        blob = new Blob([image.bytes as BlobPart]);
        break;
      case 'path':
        throw new OcrError('IMAGE_UNSUPPORTED_TYPE', 'A file path works in Node.js only. In the browser pass a URL, File, Blob, <img>, <canvas>, ImageBitmap or ImageData.');
    }
    // a PNG / JPEG cut short: browsers differ (one rejects it, another draws the part that arrived), so say it either way
    const cut = await cutShortBlob(blob).catch(() => null);
    if (cut) onCut?.(`${cut} ${CUT_HINT}`);
    let bm: ImageBitmap;
    try {
      bm = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    } catch (e) {
      throw new OcrError(
        'IMAGE_DECODE_FAILED',
        `The browser could not decode the image (${blob.type || 'unknown type'}, ${blob.size} bytes${cut ? ', cut short' : ''}): ${errText(e)}. ${cut ? 'Pass the complete file.' : 'Pass a PNG, JPEG, WebP, GIF, BMP or AVIF file; PDF and HEIC are not images this library can open.'}`,
      );
    }
    return { src: bm, release: () => bm.close() };
  },

  async prepare(bitmap, rect, maxSide): Promise<Prepared<ImageBitmap>> {
    const size = { width: bitmap.width, height: bitmap.height };
    checkReadable(bitmap);
    let sx = 0, sy = 0, sw = size.width, sh = size.height;
    if (rect) ({ sx, sy, sw, sh } = clampRect(rect, size));
    const longer = Math.max(sw, sh);
    const scale = longer > maxSide ? maxSide / longer : 1;
    if (!rect && scale === 1) return { src: bitmap, map: { scale: 1, dx: 0, dy: 0 }, size, release: () => {} };
    const opts: ImageBitmapOptions = scale === 1 ? {} : { resizeWidth: Math.max(1, Math.round(sw * scale)), resizeHeight: Math.max(1, Math.round(sh * scale)), resizeQuality: 'high' };
    const out = await createImageBitmap(bitmap, sx, sy, sw, sh, opts);
    return { src: out, map: { scale: sw / out.width, dx: sx, dy: sy }, size, release: () => out.close() };
  },

  ops: canvasOps as Platform<ImageBitmap>['ops'],
  doc: canvasDocOps,
};

/** Can this worker start a worker from a blob: URL (LiteRT.js's pthreads do)? */
function blobWorkersStart(): Promise<boolean> {
  return new Promise((ok) => {
    let w: Worker | null = null;
    const done = (v: boolean) => { clearTimeout(t); try { w?.terminate(); } catch { /* ignore */ } ok(v); };
    const t = setTimeout(() => done(false), 1000);
    try {
      w = new Worker(URL.createObjectURL(new Blob(['postMessage(1)'], { type: 'text/javascript' })));
      w.onmessage = () => done(true);
      w.onerror = () => done(false);
    } catch {
      done(false);
    }
  });
}

function checkReadable(bitmap: ImageBitmap) {
  const c = new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true })!;
  c.drawImage(bitmap, 0, 0, 1, 1);
  try {
    c.getImageData(0, 0, 1, 1);
  } catch (e) {
    throw new OcrError(
      'IMAGE_CROSS_ORIGIN',
      `The image comes from another origin without CORS, so its pixels cannot be read (${errText(e)}). Load it with crossOrigin="anonymous" from a server that sends Access-Control-Allow-Origin, or fetch it on your own server and pass the Blob.`,
    );
  }
}

export function clampRect(rect: Rectangle, size: { width: number; height: number }) {
  const sx = Math.max(0, Math.floor(rect.left));
  const sy = Math.max(0, Math.floor(rect.top));
  const ex = Math.min(size.width, Math.ceil(rect.left + rect.width));
  const ey = Math.min(size.height, Math.ceil(rect.top + rect.height));
  if (!(ex > sx && ey > sy)) {
    throw new OcrError('INVALID_ARGUMENT', `options.rectangle ${JSON.stringify(rect)} does not overlap the ${size.width} x ${size.height} image.`);
  }
  return { sx, sy, sw: ex - sx, sh: ey - sy };
}

const shortUrl = (u: string) => (u.startsWith('data:') ? u.slice(0, 40) + '…' : u);

const handler = createHandler(platform, (msg) => self.postMessage(msg));
self.onmessage = (e: MessageEvent) => handler(e.data);
self.postMessage({ type: 'hello' });
