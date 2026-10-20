// The caller's side in the browser: start the worker and turn any accepted image into something that can
// be posted to it.

import { OcrError, errText } from '../core/errors.js';
import { LITERT_WASM_BASE, MODEL_BASE } from '../core/models.js';
import type { Request, Response, WireImage } from '../core/protocol.js';
import type { ImageLike, WorkerOptions } from '../core/types.js';
import type { MainPlatform, Transport } from '../api.js';

declare const __WORKER_SOURCE__: string;

const base = () => (typeof document !== 'undefined' ? document.baseURI : typeof location !== 'undefined' ? location.href : undefined);

export function resolveUrl(u: string): string {
  try {
    return new URL(u, base()).href;
  } catch {
    return u;
  }
}

function spawn(options: Partial<WorkerOptions>): Transport {
  if (typeof Worker === 'undefined') {
    throw new OcrError('WORKER_START_FAILED', 'This environment has no Web Worker. In Node.js import the package normally (it picks the Node build); in a service worker, run OCR in a page instead.');
  }
  let url: string;
  let revoke = false;
  if (options.workerPath) {
    url = resolveUrl(options.workerPath);
  } else {
    url = URL.createObjectURL(new Blob([__WORKER_SOURCE__], { type: 'text/javascript' }));
    revoke = true;
  }
  let w: globalThis.Worker;
  try {
    w = new Worker(url, { name: 'litert-ocr' });
  } catch (e) {
    throw new OcrError('WORKER_START_FAILED', startHint(errText(e), options), { cause: e });
  }
  let started = false;
  return {
    post: (msg: Request, transfer: Transferable[] = []) => w.postMessage(msg, transfer),
    onMessage: (cb: (m: Response) => void) => {
      w.onmessage = (e) => {
        started = true;
        cb(e.data as Response);
      };
    },
    onError: (cb: (e: OcrError) => void) => {
      w.onerror = (ev) => {
        ev.preventDefault?.();
        const reason = ev.message || 'the worker script failed to load';
        cb(started
          ? new OcrError('INTERNAL', `The OCR worker stopped (${reason}). Create a new worker with createWorker(); if it happens again with the same image, please report it.`)
          : new OcrError('WORKER_START_FAILED', startHint(reason, options)));
      };
    },
    terminate: () => {
      w.terminate();
      if (revoke) URL.revokeObjectURL(url);
    },
  };
}

function startTimeoutHint(options: Partial<WorkerOptions>): string {
  return startHint('it sent nothing within 20 s', options);
}

function startHint(reason: string, options: Partial<WorkerOptions>): string {
  return options.workerPath
    ? `The worker at ${options.workerPath} could not start (${reason}). workerPath must point at this package's dist/worker.js on the page's own origin.`
    : `The OCR worker could not start (${reason}). If the page's Content-Security-Policy blocks blob: workers, add "worker-src blob:", or serve node_modules/litert-ocr/dist/worker.js yourself and pass { workerPath: '/worker.js' }.`;
}

async function toWire(image: ImageLike): Promise<{ wire: WireImage; transfer: Transferable[] }> {
  const g = globalThis as unknown as Record<string, unknown>;
  const is = (name: string) => typeof g[name] === 'function' && image instanceof (g[name] as new (...a: never[]) => unknown);
  if (typeof image === 'string') {
    if (image.startsWith('blob:')) {
      const blob = await (await fetch(image)).blob();
      return { wire: { kind: 'blob', blob }, transfer: [] };
    }
    if (image.startsWith('data:')) return { wire: { kind: 'url', url: image }, transfer: [] };
    return { wire: { kind: 'url', url: resolveUrl(image) }, transfer: [] };
  }
  if (is('Blob')) return { wire: { kind: 'blob', blob: image as Blob }, transfer: [] };
  if (is('ImageData')) {
    const d = image as ImageData;
    return { wire: { kind: 'pixels', data: d.data, width: d.width, height: d.height }, transfer: [] };
  }
  if (image instanceof ArrayBuffer) return { wire: { kind: 'bytes', bytes: new Uint8Array(image.slice(0)) }, transfer: [] };
  if (ArrayBuffer.isView(image)) {
    const v = image as ArrayBufferView;
    return { wire: { kind: 'bytes', bytes: new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer) }, transfer: [] };
  }
  if (is('HTMLImageElement')) {
    const img = image as HTMLImageElement;
    if (!img.complete || !img.naturalWidth) {
      try {
        await img.decode();
      } catch (e) {
        throw new OcrError('IMAGE_DECODE_FAILED', `The <img> (${img.currentSrc || img.src || 'no src'}) did not load (${errText(e)}).`);
      }
    }
  }
  if (is('CanvasRenderingContext2D')) image = (image as CanvasRenderingContext2D).canvas;
  const drawable = ['HTMLImageElement', 'HTMLCanvasElement', 'HTMLVideoElement', 'OffscreenCanvas', 'ImageBitmap', 'SVGImageElement', 'VideoFrame'].some(is);
  if (drawable) {
    let bitmap: ImageBitmap;
    try {
      // a copy, so the caller's ImageBitmap stays usable
      bitmap = await createImageBitmap(image as ImageBitmapSource);
    } catch (e) {
      // a browser may refuse to copy a cross-origin image at all (SecurityError) instead of tainting the copy
      if ((e as { name?: string })?.name === 'SecurityError') throw crossOrigin(e);
      throw new OcrError('IMAGE_DECODE_FAILED', `This ${(image as object).constructor?.name ?? 'image'} could not be read (${errText(e)}).`);
    }
    try {
      const probe = new OffscreenCanvas(1, 1).getContext('2d')!;
      probe.drawImage(bitmap, 0, 0, 1, 1);
      probe.getImageData(0, 0, 1, 1);
    } catch (e) {
      bitmap.close();
      throw crossOrigin(e);
    }
    return { wire: { kind: 'bitmap', bitmap }, transfer: [bitmap] };
  }
  if (image && typeof image === 'object' && 'data' in image && 'width' in image && 'height' in image) {
    const p = image as { data: Uint8ClampedArray | Uint8Array; width: number; height: number };
    return { wire: { kind: 'pixels', data: new Uint8ClampedArray(p.data), width: p.width, height: p.height }, transfer: [] };
  }
  throw new OcrError(
    'IMAGE_UNSUPPORTED_TYPE',
    `recognize() cannot read ${describe(image)}. Pass a URL or data URL string, a File or Blob, an <img>, <canvas> or <video>, an OffscreenCanvas, ImageBitmap or ImageData, or the image file's bytes (ArrayBuffer / Uint8Array).`,
  );
}

const crossOrigin = (e: unknown) =>
  new OcrError(
    'IMAGE_CROSS_ORIGIN',
    `This image comes from another origin without CORS, so its pixels cannot be read (${errText(e)}). Load it with crossOrigin="anonymous" from a server that sends Access-Control-Allow-Origin, or fetch it on your own server and pass the Blob.`,
  );

export function describe(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (typeof v !== 'object') return `a ${typeof v} (${String(v).slice(0, 40)})`;
  const name = (v as object).constructor?.name;
  return !name || name === 'Object' ? 'a plain object' : `a ${name}`;
}

export const browserMain: Omit<MainPlatform, 'doc'> = {
  name: 'browser',
  spawn,
  startTimeoutHint,
  toWire,
  resolveUrl,
  defaults: { modelBase: MODEL_BASE, wasmPath: LITERT_WASM_BASE },
};
