// convert() in Node.js: read the input (path, URL, bytes; sniff PDF or image), pdf.js from the pdfjs-dist package
// (its legacy build, which Node.js needs), and PDF pages drawn with @napi-rs/canvas (an optional dependency; without
// it, text-layer pages still work and a page that needs OCR reports how to install it).

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OcrError, errText } from '../core/errors.js';
import { PDFJS_VERSION } from '../core/models.js';
import type { ImageLike } from '../core/types.js';
import type { DocPlatform, Opened } from '../doc/convert.js';
import type { PdfJs, PdfPage } from '../doc/pdf.js';
import { isPdf, sniffOther } from '../doc/sniff.js';
import type { DocInput } from '../doc/types.js';

const require = createRequire(import.meta.url);

function describe(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (typeof v !== 'object') return `a ${typeof v} (${String(v).slice(0, 40)})`;
  const name = (v as object).constructor?.name;
  return !name || name === 'Object' ? 'a plain object' : `a ${name}`;
}

function fromBytes(b: Uint8Array, name: string | null): Opened {
  if (isPdf(b)) return { kind: 'pdf', bytes: b, name };
  const kind = sniffOther(b.subarray(0, 1024));
  if (kind) throw new OcrError('DOC_UNSUPPORTED_TYPE', `convert() reads PDF files and images; ${name ? `${name} ` : 'this file '}looks like ${kind}. Convert it to PDF first.`);
  return { kind: 'image', image: b, name };
}

async function open(input: DocInput): Promise<Opened> {
  if (input instanceof URL) input = input.href;
  if (typeof input === 'string') {
    if (/^(https?|data):/i.test(input)) {
      let resp: Response;
      try {
        resp = await fetch(input);
      } catch (e) {
        throw new OcrError('IMAGE_FETCH_FAILED', `Could not fetch ${input.slice(0, 80)} (${errText(e)}).`, { url: input, cause: e });
      }
      if (!resp.ok) throw new OcrError('IMAGE_FETCH_FAILED', `Could not fetch ${input}: HTTP ${resp.status}.`, { url: input, status: resp.status });
      const name = input.startsWith('data:') ? null : decodeURIComponent(new URL(input).pathname.split('/').pop() || '') || null;
      return fromBytes(new Uint8Array(await resp.arrayBuffer()), name);
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(input) && !/^file:/i.test(input) && !/^[a-z]:[\\/]/i.test(input)) {
      throw new OcrError('DOC_UNSUPPORTED_TYPE', `convert() cannot open ${input.slice(0, 60)}: use an http(s), data or file URL, a file path, or the file's bytes.`);
    }
    const path = /^file:/i.test(input) ? fileURLToPath(input) : input;
    let b: Buffer;
    try {
      b = await readFile(path);
    } catch (e) {
      throw new OcrError('IMAGE_FETCH_FAILED', `Could not read the file ${path} (${errText(e)}).`, { url: path, cause: e });
    }
    return fromBytes(new Uint8Array(b.buffer, b.byteOffset, b.byteLength), basename(path));
  }
  if (typeof Blob !== 'undefined' && input instanceof Blob) return fromBytes(new Uint8Array(await input.arrayBuffer()), (input as File).name ?? null);
  if (input instanceof ArrayBuffer) return fromBytes(new Uint8Array(input.slice(0)), null);
  if (ArrayBuffer.isView(input)) {
    const v = input as ArrayBufferView;
    return fromBytes(new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer), null);
  }
  if (input && typeof input === 'object' && 'data' in input && 'width' in input && 'height' in input) return { kind: 'image', image: input as ImageLike, name: null };
  throw new OcrError('DOC_UNSUPPORTED_TYPE', `convert() cannot read ${describe(input)}. In Node.js pass a file path, an http(s) or data URL, a Buffer / Uint8Array / ArrayBuffer of a PDF or PNG / JPEG file, a Blob, or raw pixels { data, width, height }.`);
}

let loaded: Promise<{ pdfjs: PdfJs; params: Record<string, unknown> }> | null = null;

function loadPdfjs() {
  loaded ??= (async () => {
    let mod: PdfJs;
    try {
      mod = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as PdfJs;
    } catch (e) {
      loaded = null;
      throw new OcrError('PDF_UNAVAILABLE', `pdf.js (pdfjs-dist ${PDFJS_VERSION}), which reads PDFs, could not load in Node.js ${process.version}: ${errText(e)}. It needs Node.js 22.13 or newer; reinstall the package if pdfjs-dist is missing.`, { cause: e });
    }
    const dir = dirname(require.resolve('pdfjs-dist/package.json'));
    // pdf.js in Node.js reads these as file paths (trailing separator)
    const params = { cMapUrl: join(dir, 'cmaps') + '/', cMapPacked: true, standardFontDataUrl: join(dir, 'standard_fonts') + '/', wasmUrl: join(dir, 'wasm') + '/', iccUrl: join(dir, 'iccs') + '/' };
    return { pdfjs: mod, params };
  })();
  return loaded;
}

type Canvas = { getContext(t: '2d'): { fillStyle: string; fillRect(x: number, y: number, w: number, h: number): void; getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray } }; width: number; height: number };

let canvasModule: Promise<{ createCanvas(w: number, h: number): Canvas }> | null = null;

async function render(page: PdfPage, scale: number): Promise<ImageLike> {
  canvasModule ??= (import('@napi-rs/canvas') as Promise<{ createCanvas(w: number, h: number): Canvas }>).catch((e) => {
    canvasModule = null;
    throw new OcrError('PDF_RENDER_FAILED', `Reading a PDF page without a text layer needs @napi-rs/canvas to draw it, and it could not load (${errText(e)}). Install it: npm install @napi-rs/canvas`, { cause: e });
  });
  const { createCanvas } = await canvasModule;
  const vp = page.getViewport({ scale });
  const w = Math.ceil(vp.width), h = Math.ceil(vp.height);
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  await page.render({ canvasContext: ctx, viewport: vp, canvas }).promise;
  const data = ctx.getImageData(0, 0, w, h).data;
  return { data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength), width: w, height: h };
}

export const nodeDoc: DocPlatform = { open, loadPdfjs, render };
