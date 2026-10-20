// convert() in the browser: read the input (sniff PDF or image), load pdf.js from a pinned URL (each file checked by
// sha256, imported from a blob: URL so a CDN copy works without a bundler), and draw PDF pages for OCR.

import { OcrError, errText } from '../core/errors.js';
import { fetchVerified, type FileCache } from '../core/fetcher.js';
import { PDFJS_BASE, PDFJS_FILES, PDFJS_VERSION } from '../core/models.js';
import { sha256Hex } from '../core/sha256.js';
import type { ImageLike } from '../core/types.js';
import type { DocPlatform, Opened } from '../doc/convert.js';
import type { PdfJs, PdfPage } from '../doc/pdf.js';
import { isPdf, sniffOther } from '../doc/sniff.js';
import type { DocInput } from '../doc/types.js';
import { describe, resolveUrl } from './main.js';

const CACHE_NAME = 'litert-ocr-v1';

async function head(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.slice(0, 1024).arrayBuffer());
}

function nameOf(u: string): string | null {
  if (u.startsWith('data:')) return null;
  try {
    return decodeURIComponent(new URL(u, location.href).pathname.split('/').pop() || '') || null;
  } catch {
    return null;
  }
}

async function open(input: DocInput): Promise<Opened> {
  if (input instanceof URL) input = input.href;
  if (typeof input === 'string') {
    const url = input.startsWith('data:') || input.startsWith('blob:') ? input : resolveUrl(input);
    let resp: Response;
    try {
      resp = await fetch(url);
    } catch (e) {
      throw new OcrError('IMAGE_FETCH_FAILED', `Could not fetch ${url.slice(0, 80)} (${errText(e)}). A file on another origin needs the header Access-Control-Allow-Origin; otherwise fetch it on your server, or pass a Blob or File.`, { url, cause: e });
    }
    if (!resp.ok) throw new OcrError('IMAGE_FETCH_FAILED', `Could not fetch ${url}: HTTP ${resp.status}.`, { url, status: resp.status });
    const blob = await resp.blob();
    return fromBlob(blob, nameOf(url));
  }
  if (typeof Blob !== 'undefined' && input instanceof Blob) return fromBlob(input, (input as File).name ?? null);
  if (input instanceof ArrayBuffer || ArrayBuffer.isView(input)) {
    const v = input instanceof ArrayBuffer ? new Uint8Array(input) : new Uint8Array((input as ArrayBufferView).buffer, (input as ArrayBufferView).byteOffset, (input as ArrayBufferView).byteLength);
    if (isPdf(v)) return { kind: 'pdf', bytes: new Uint8Array(v), name: null };
    return fromBlob(new Blob([v as BlobPart]), null);
  }
  if (input && typeof input === 'object') return { kind: 'image', image: input as ImageLike, name: null };
  throw new OcrError('DOC_UNSUPPORTED_TYPE', `convert() cannot read ${describe(input)}. Pass a PDF or an image: a URL, File, Blob, ArrayBuffer / Uint8Array, or an image element, canvas, ImageBitmap or ImageData.`);
}

async function fromBlob(blob: Blob, name: string | null): Promise<Opened> {
  const h = await head(blob);
  if (isPdf(h) || blob.type === 'application/pdf') return { kind: 'pdf', bytes: new Uint8Array(await blob.arrayBuffer()), name };
  const kind = sniffOther(h);
  if (kind) throw new OcrError('DOC_UNSUPPORTED_TYPE', `convert() reads PDF files and images; ${name ? `${name} ` : 'this file '}looks like ${kind}. Convert it to PDF first.`);
  return { kind: 'image', image: blob, name };
}

let loaded: { base: string; promise: Promise<{ pdfjs: PdfJs; params: Record<string, unknown> }> } | null = null;

async function mainCache(method: string | undefined): Promise<FileCache | null> {
  if (method === 'none' || typeof caches === 'undefined') return null;
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
    };
  } catch {
    return null;
  }
}

async function loadPdfjs(o: { pdfjsPath?: string; cacheMethod?: string }) {
  const base = o.pdfjsPath ? (resolveUrl(o.pdfjsPath).replace(/\/?$/, '/')) : PDFJS_BASE;
  if (loaded?.base === base) return loaded.promise;
  const promise = (async () => {
    const cache = await mainCache(o.cacheMethod);
    const get = (f: { file: string; bytes: number; sha256: string }) =>
      fetchVerified(
        { name: f.file, url: new URL(f.file, base).href, bytes: f.bytes, sha256: f.sha256, origin: PDFJS_BASE },
        {
          cache,
          cacheMethod: (o.cacheMethod as 'write') ?? 'write',
          sha256: async (b) => {
            if (crypto?.subtle) {
              const d = new Uint8Array(await crypto.subtle.digest('SHA-256', b as BufferSource));
              return Array.from(d, (x) => x.toString(16).padStart(2, '0')).join('');
            }
            return sha256Hex(b);
          },
          onBytes: () => {},
          notice: (m) => console.warn(`[litert-ocr] ${m}`),
          selfHostOption: 'pdfjsPath',
        },
      );
    let main: Uint8Array, worker: Uint8Array;
    try {
      [main, worker] = await Promise.all([get(PDFJS_FILES.main), get(PDFJS_FILES.worker)]);
    } catch (e) {
      throw new OcrError('PDF_UNAVAILABLE', `pdf.js ${PDFJS_VERSION}, which reads PDFs, could not be loaded: ${errText(e)}.`, { cause: e });
    }
    const mainUrl = URL.createObjectURL(new Blob([main as BlobPart], { type: 'text/javascript' }));
    const workerUrl = URL.createObjectURL(new Blob([worker as BlobPart], { type: 'text/javascript' }));
    let mod: PdfJs & { GlobalWorkerOptions: { workerSrc: string } };
    try {
      mod = await import(/* webpackIgnore: true */ /* @vite-ignore */ mainUrl);
    } catch (e) {
      throw new OcrError('PDF_UNAVAILABLE', `pdf.js ${PDFJS_VERSION} could not start (${errText(e)}). If the page's Content-Security-Policy blocks blob: scripts, allow "script-src blob:".`, { cause: e });
    }
    mod.GlobalWorkerOptions.workerSrc = workerUrl;
    const params = { cMapUrl: new URL('cmaps/', base).href, cMapPacked: true, standardFontDataUrl: new URL('standard_fonts/', base).href, wasmUrl: new URL('wasm/', base).href, iccUrl: new URL('iccs/', base).href };
    return { pdfjs: mod, params };
  })();
  loaded = { base, promise };
  promise.catch(() => { if (loaded?.promise === promise) loaded = null; });
  return promise;
}

async function render(page: PdfPage, scale: number): Promise<ImageLike> {
  const vp = page.getViewport({ scale });
  const c = new OffscreenCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: ctx, canvas: c, viewport: vp }).promise;
  return c.transferToImageBitmap();
}

export const browserDoc: DocPlatform = { open, loadPdfjs, render };
