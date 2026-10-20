// The caller's side in Node.js (and Deno, Bun): the engine runs in a worker thread.

import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker as ThreadWorker } from 'node:worker_threads';
import { OcrError, errText } from '../core/errors.js';
import { MODEL_BASE } from '../core/models.js';
import type { Request, Response, WireImage } from '../core/protocol.js';
import type { ImageLike, WorkerOptions } from '../core/types.js';
import type { MainPlatform, Transport } from '../api.js';

function resolveUrl(u: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(u) && !/^[a-z]:[\\/]/i.test(u)) return u; // a URL (not a Windows drive path)
  return isAbsolute(u) ? u : resolve(u);
}

function spawn(_options: Partial<WorkerOptions>): Transport {
  let w: ThreadWorker;
  try {
    // stdout: true = the thread's console output goes to stderr below, never into the caller's stdout (which may
    // carry a protocol, as in `litert-ocr mcp`, or the converted document)
    w = new ThreadWorker(new URL('./node-worker.js', import.meta.url), { name: 'litert-ocr', stdout: true });
    w.stdout.pipe(process.stderr);
  } catch (e) {
    throw new OcrError('WORKER_START_FAILED', `The OCR worker thread could not start (${errText(e)}). The package needs Node.js 20.19 or newer (or Deno 2 / Bun 1.1+) and its dist/node-worker.js file.`, { cause: e });
  }
  let closing = false;
  return {
    post: (msg: Request, transfer: Transferable[] = []) => w.postMessage(msg, transfer as never[]),
    onMessage: (cb: (m: Response) => void) => { w.on('message', cb); },
    onError: (cb: (e: OcrError) => void) => {
      w.on('error', (e) => cb(new OcrError('INTERNAL', `The OCR worker thread stopped: ${errText(e)}.`, { cause: e })));
      w.on('exit', (code) => {
        if (!closing) cb(new OcrError('INTERNAL', `The OCR worker thread exited (code ${code}). Create a new worker with createWorker().`));
      });
    },
    terminate: async () => {
      closing = true;
      await w.terminate();
    },
  };
}

async function toWire(image: ImageLike): Promise<{ wire: WireImage; transfer: Transferable[] }> {
  if (typeof image === 'string') {
    if (/^(https?|data):/i.test(image)) return { wire: { kind: 'url', url: image }, transfer: [] };
    if (/^file:/i.test(image)) return { wire: { kind: 'path', path: fileURLToPath(image) }, transfer: [] };
    if (/^[a-z][a-z0-9+.-]*:/i.test(image) && !/^[a-z]:[\\/]/i.test(image)) {
      throw new OcrError('IMAGE_UNSUPPORTED_TYPE', `recognize() cannot open ${image.slice(0, 60)}: use an http(s) or data URL, a file path, or the image bytes.`);
    }
    return { wire: { kind: 'path', path: resolveUrl(image) }, transfer: [] };
  }
  if (image instanceof URL) return toWire(image.href);
  if (image instanceof ArrayBuffer) return { wire: { kind: 'bytes', bytes: new Uint8Array(image.slice(0)) }, transfer: [] };
  if (ArrayBuffer.isView(image)) {
    const v = image as ArrayBufferView;
    return { wire: { kind: 'bytes', bytes: new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer) }, transfer: [] };
  }
  if (typeof Blob !== 'undefined' && image instanceof Blob) {
    return { wire: { kind: 'bytes', bytes: new Uint8Array(await image.arrayBuffer()) }, transfer: [] };
  }
  if (image && typeof image === 'object' && 'data' in image && 'width' in image && 'height' in image) {
    const p = image as { data: Uint8ClampedArray | Uint8Array; width: number; height: number };
    return { wire: { kind: 'pixels', data: new Uint8ClampedArray(p.data), width: p.width, height: p.height }, transfer: [] };
  }
  throw new OcrError(
    'IMAGE_UNSUPPORTED_TYPE',
    `recognize() cannot read ${describe(image)}. In Node.js pass a file path, an http(s) or data URL, a Buffer / Uint8Array / ArrayBuffer of a PNG or JPEG file, a Blob, or raw pixels { data, width, height } (RGBA).`,
  );
}

function describe(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (typeof v !== 'object') return `a ${typeof v} (${String(v).slice(0, 40)})`;
  const name = (v as object).constructor?.name;
  return !name || name === 'Object' ? 'a plain object' : `a ${name}`;
}

export const nodeMain: Omit<MainPlatform, 'doc'> = {
  name: 'node',
  spawn,
  startTimeoutHint: () => 'The OCR worker thread did not start within 20 s (it sent nothing). Check that dist/node-worker.js is installed next to dist/node.js and that worker_threads are allowed.',
  toWire,
  resolveUrl,
  defaults: { modelBase: MODEL_BASE, wasmPath: '' },
};
