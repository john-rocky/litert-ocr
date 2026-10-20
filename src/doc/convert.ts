// convert() / toMarkdown() / createConverter(): a PDF or an image -> pages -> blocks -> Markdown, JSON or text.
// Per page: a PDF page with a text layer is read from it with pdf.js; a page without one (a scan) and any image go
// to the OCR worker (skew, text lines, ruled lines, the layout model or geometry); both end in the same geometry.
// A page that fails is reported with its reason and the other pages are still returned.

import { OcrError, errText } from '../core/errors.js';
import { LAYOUT_NAME, MODEL_NAME, MODEL_REVISION, LITERT_VERSION, PDFJS_VERSION, PKG_NAME, PKG_VERSION } from '../core/models.js';
import type { DocPageData } from '../core/handler.js';
import type { DocPageOptions } from '../core/protocol.js';
import type { ImageLike, LoggerMessage, WorkerOptions } from '../core/types.js';
import { LAYER_GEOMETRY, OCR_GEOMETRY, blocksMarkdown, blocksText, layoutGeometry, layoutRegions, pageLang, type Block, type PageSize, type Unit } from './geom.js';
import { PDF_DPI, PDF_SCALE, imageCover, needsOcr, openPdf, pageItems, type PdfJs, type PdfPage } from './pdf.js';
import type { ConvertOptions, ConvertResult, Converter, ConverterOptions, DocBlock, DocInput, DocTable, DocumentResult, PageResult } from './types.js';

export type Opened = { kind: 'pdf'; bytes: Uint8Array; name: string | null } | { kind: 'image'; image: ImageLike; name: string | null };

/** What the browser and Node.js builds supply: reading an input, pdf.js, drawing a PDF page for OCR. */
export interface DocPlatform {
  open(input: DocInput): Promise<Opened>;
  loadPdfjs(o: { pdfjsPath?: string; cacheMethod?: WorkerOptions['cacheMethod'] }): Promise<{ pdfjs: PdfJs; params: Record<string, unknown> }>;
  /** The page drawn at `scale` on white, as an image the OCR worker takes. */
  render(page: PdfPage, scale: number): Promise<ImageLike>;
}

/** The internal side of a worker that convert() uses. */
export interface DocWorker {
  _docPage(image: ImageLike, options: DocPageOptions): Promise<DocPageData>;
  terminate(): Promise<unknown>;
}

const DEFAULT_MAX_PAGES = 100;
const TO = ['md', 'json', 'text'];
const ENGINES = ['auto', 'layer', 'ocr'];
const LAYOUTS = ['auto', 'model', 'geometry'];

/** '1-3', '1,4,7-9', '5-', 3, [1, 2] -> sorted unique page numbers within 1..n. */
export function selectPages(spec: ConvertOptions['pages'] | undefined, n: number): number[] {
  if (spec === undefined || spec === null || spec === '') return Array.from({ length: n }, (_, i) => i + 1);
  const bad = (why: string) => new OcrError('INVALID_ARGUMENT', `options.pages ${JSON.stringify(spec)}: ${why}. Use '1-3', '1,4,7-9', '5-' (to the end), a page number or an array of page numbers; this document has ${n} page${n === 1 ? '' : 's'}.`);
  const out = new Set<number>();
  const add = (p: number) => {
    if (!Number.isInteger(p) || p < 1) throw bad(`${p} is not a page number`);
    if (p > n) throw bad(`page ${p} is past the last page`);
    out.add(p);
  };
  if (typeof spec === 'number') add(spec);
  else if (Array.isArray(spec)) spec.forEach((p) => add(Number(p)));
  else if (typeof spec === 'string') {
    for (const part of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
      const m = /^(\d+)\s*(?:-\s*(\d*))?$/.exec(part);
      if (!m) throw bad(`'${part}' is not a page or a range`);
      const a = Number(m[1]);
      const b = m[2] === undefined ? a : m[2] === '' ? n : Number(m[2]);
      if (b < a) throw bad(`'${part}' runs backwards`);
      for (let p = a; p <= b; p++) add(p);
    }
  } else throw bad('it is not a string, number or array');
  if (!out.size) throw bad('it selects no page');
  return [...out].sort((x, y) => x - y);
}

function pageFromBlocks(base: Omit<PageResult, 'status' | 'reason' | 'code' | 'blocks' | 'tables' | 'markdown' | 'text'>, blocks: Block[]): PageResult {
  const tables: DocTable[] = [];
  const docBlocks: DocBlock[] = blocks.map((b) => {
    const d: DocBlock = { type: b.type, text: b.text, bbox: b.bbox.map((v) => Math.round(v)) as DocBlock['bbox'] };
    if (b.level !== undefined) d.level = b.level;
    if (b.role !== undefined) d.role = b.role;
    if (b.type === 'table') {
      d.table = tables.length;
      tables.push({ bbox: d.bbox, rows: b.rows! });
    }
    return d;
  });
  const ok = blocks.length > 0;
  return {
    page: base.page,
    status: ok ? 'ok' : 'empty',
    reason: ok ? null : 'No text was found on this page.',
    code: null,
    engine: base.engine,
    layout: base.layout,
    width: base.width,
    height: base.height,
    dpi: base.dpi,
    skew: base.skew,
    lang: base.lang,
    blocks: docBlocks,
    tables,
    markdown: ok ? blocksMarkdown(blocks) : '',
    text: ok ? blocksText(blocks) : '',
    ms: base.ms,
  };
}

function failedPage(page: number, e: unknown, engine: PageResult['engine'], ms: number): PageResult {
  return {
    page, status: 'failed', reason: errText(e) + '.', code: e instanceof OcrError ? e.code : 'INTERNAL', engine, layout: null,
    width: 0, height: 0, dpi: null, skew: null, lang: 'en', blocks: [], tables: [], markdown: '', text: '', ms,
  };
}

/** Markdown of the whole document: one page as is; several pages each after a `<!-- page N -->` line. */
export function documentMarkdown(doc: DocumentResult): string {
  if (doc.source.pages <= 1 && doc.pages.length === 1) return doc.pages[0]!.markdown;
  return doc.pages
    .map((p) => (p.status === 'ok' ? `<!-- page ${p.page} -->\n\n${p.markdown}` : `<!-- page ${p.page}: ${p.status}: ${(p.reason ?? '').replace(/--/g, '- -')} -->\n`))
    .join('\n');
}

/** Plain text of the whole document: pages separated by a form feed. */
export function documentText(doc: DocumentResult): string {
  return doc.pages.map((p) => p.text).join('\f');
}

export function makeDocApi(
  createWorker: (langs?: string, oem?: number, options?: Partial<WorkerOptions>) => Promise<unknown>,
  platform: DocPlatform,
) {
  function createConverter(options: Partial<ConverterOptions> = {}): Converter {
    let worker: Promise<DocWorker> | null = null;
    let closed = false;
    const logger = typeof options.logger === 'function' ? options.logger : null;
    const log = (m: Omit<LoggerMessage, 'workerId' | 'jobId' | 'userJobId'>) => {
      try { logger?.({ workerId: 'converter', jobId: 'convert', userJobId: 'convert', ...m }); } catch { /* ignore */ }
    };
    const getWorker = () => {
      if (closed) throw new OcrError('WORKER_TERMINATED', 'This converter was terminated. Create a new one with createConverter().');
      if (!worker) {
        const { layout: _l, maxPages: _m, pdfjsPath: _p, ...workerOptions } = options;
        worker = createWorker('eng', 1, workerOptions) as Promise<DocWorker>;
        worker.catch(() => { worker = null; });
      }
      return worker;
    };
    const layoutDefault = options.layout ?? 'auto';

    async function ocrPage(image: ImageLike, o: ConvertOptions, page: number, dpi: number | null): Promise<PageResult> {
      const t0 = performance.now();
      const w = await getWorker();
      const d = await w._docPage(image, { layout: o.layout, deskew: true });
      const lang = pageLang(d.units.map((u) => u.text));
      const blocks = d.regions ? layoutRegions(d.units, d.page, d.regions, { ...OCR_GEOMETRY, lang }) : layoutGeometry(d.units, d.page, { ...OCR_GEOMETRY, lang, ruled: d.ruled });
      return pageFromBlocks({ page, engine: 'ocr', layout: d.layout, width: d.page.width, height: d.page.height, dpi, skew: d.skew, lang, ms: performance.now() - t0 }, blocks);
    }

    function layerPage(units: Unit[], size: PageSize, page: number, t0: number): PageResult {
      const lang = pageLang(units.map((u) => u.text));
      const blocks = layoutGeometry(units, size, { ...LAYER_GEOMETRY, lang });
      return pageFromBlocks({ page, engine: 'layer', layout: null, width: Math.round(size.width), height: Math.round(size.height), dpi: PDF_DPI, skew: null, lang, ms: performance.now() - t0 }, blocks);
    }

    async function convert(input: DocInput, opts: Partial<ConvertOptions> = {}): Promise<ConvertResult> {
      if (opts === null || typeof opts !== 'object') throw new OcrError('INVALID_ARGUMENT', `convert(input, options): options must be an object, got ${typeof opts}.`);
      // an option given as undefined keeps its default
      const given = Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)) as Partial<ConvertOptions>;
      const o: ConvertOptions = { to: 'md', engine: 'auto', layout: layoutDefault, maxPages: options.maxPages ?? DEFAULT_MAX_PAGES, pages: '', password: undefined as unknown as string, ...given };
      if (!TO.includes(o.to)) throw new OcrError('INVALID_ARGUMENT', `options.to must be 'md', 'json' or 'text', got ${JSON.stringify(o.to)}.`);
      if (!ENGINES.includes(o.engine)) throw new OcrError('INVALID_ARGUMENT', `options.engine must be 'auto', 'layer' or 'ocr', got ${JSON.stringify(o.engine)}.`);
      if (!LAYOUTS.includes(o.layout)) throw new OcrError('INVALID_ARGUMENT', `options.layout must be 'auto', 'model' or 'geometry', got ${JSON.stringify(o.layout)}.`);
      if (!Number.isInteger(o.maxPages) || o.maxPages < 1) throw new OcrError('INVALID_ARGUMENT', `options.maxPages must be a whole number of at least 1, got ${JSON.stringify(o.maxPages)}.`);
      const opened = await platform.open(input);
      const pages: PageResult[] = [];
      let total = 1;
      const versions = [`${MODEL_NAME} @${MODEL_REVISION.slice(0, 7)}`, `LiteRT.js ${LITERT_VERSION}`];
      if (opened.kind === 'image') {
        if (o.pages !== '' && o.pages !== undefined) selectPages(o.pages, 1);
        if (o.engine === 'layer') {
          pages.push({ ...failedPage(1, new Error('An image has no text layer; use engine "auto" or "ocr"'), null, 0), status: 'empty', code: null });
        } else {
          // an image that cannot be read is an unreadable input: it rejects (the CLI exits with 2)
          const p = await ocrPage(opened.image, o, 1, null);
          if (p.layout?.used === 'model') versions.push(LAYOUT_NAME);
          pages.push(p);
        }
      } else {
        log({ status: 'loading pdf.js', progress: 0 });
        const { pdfjs, params } = await platform.loadPdfjs({ pdfjsPath: options.pdfjsPath, cacheMethod: options.cacheMethod });
        versions.push(`pdf.js ${pdfjs.version ?? PDFJS_VERSION}`);
        const { doc, close } = await openPdf(pdfjs, opened.bytes, params, o.password);
        try {
          total = doc.numPages;
          const selected = selectPages(o.pages, total);
          if (selected.length > o.maxPages) {
            throw new OcrError(
              'DOC_TOO_MANY_PAGES',
              `This PDF has ${total} pages and ${selected.length} are selected; one call reads at most ${o.maxPages} (maxPages). Pass pages: '1-${o.maxPages}' to read a part (CLI: --pages 1-${o.maxPages}), or a larger maxPages.`,
            );
          }
          for (const [k, n] of selected.entries()) {
            log({ status: 'converting page', progress: k / selected.length, message: `page ${n} of ${total}` });
            const t0 = performance.now();
            let page: PdfPage | null = null;
            let route: PageResult['engine'] = null;
            try {
              page = await doc.getPage(n);
              let useLayer = false;
              let items: Awaited<ReturnType<typeof pageItems>> | null = null;
              if (o.engine !== 'ocr') {
                items = await pageItems(pdfjs, page, PDF_SCALE);
                useLayer = o.engine === 'layer' || !needsOcr(items.units, items.count, await imageCover(pdfjs, page));
              }
              if (useLayer) {
                route = 'layer';
                const p = layerPage(items!.units, { width: items!.width, height: items!.height }, n, t0);
                if (p.status === 'empty' && o.engine === 'layer') p.reason = 'This page has no text layer (a scan or an image); use engine "auto" or "ocr" to read it by OCR.';
                pages.push(p);
              } else {
                route = 'ocr';
                let image: ImageLike;
                try {
                  image = await platform.render(page, PDF_SCALE);
                } catch (e) {
                  throw e instanceof OcrError ? e : new OcrError('PDF_RENDER_FAILED', `pdf.js could not draw page ${n} for OCR (${errText(e)}).`, { cause: e });
                }
                try {
                  const p = await ocrPage(image, o, n, PDF_DPI);
                  p.ms = performance.now() - t0;
                  if (p.layout?.used === 'model' && !versions.includes(LAYOUT_NAME)) versions.push(LAYOUT_NAME);
                  pages.push(p);
                } finally {
                  // the worker got a copy; free the drawn page (an ImageBitmap in the browser)
                  (image as { close?: () => void }).close?.();
                }
              }
            } catch (e) {
              if (e instanceof OcrError && (e.code === 'WORKER_TERMINATED' || e.code === 'MODEL_FETCH_FAILED' || e.code === 'MODEL_SHA256_MISMATCH' || e.code === 'RUNTIME_LOAD_FAILED' || e.code === 'WORKER_START_FAILED')) throw e;
              pages.push(failedPage(n, e, route, performance.now() - t0));
            } finally {
              try { page?.cleanup(); } catch { /* ignore */ }
            }
          }
          log({ status: 'converting page', progress: 1, message: `${selected.length} page${selected.length === 1 ? '' : 's'}` });
        } finally {
          await close();
        }
      }
      const document: DocumentResult = {
        version: `${PKG_NAME} ${PKG_VERSION} (${versions.join(', ')})`,
        source: { name: opened.name, type: opened.kind, pages: total },
        pages,
      };
      const content = o.to === 'json' ? JSON.stringify(document, null, 2) : o.to === 'text' ? documentText(document) : documentMarkdown(document);
      return { to: o.to, content, document };
    }

    return {
      convert,
      async toMarkdown(input, opts = {}) {
        return (await convert(input, { ...opts, to: 'md' })).content;
      },
      async terminate() {
        closed = true;
        const w = worker;
        worker = null;
        if (w) await (await w.catch(() => null))?.terminate();
      },
    };
  }

  /** Convert one PDF or image with a converter of its own (created, used and terminated). */
  async function convert(input: DocInput, options: Partial<ConvertOptions & ConverterOptions> = {}): Promise<ConvertResult> {
    const { to, pages, engine, password, ...rest } = options;
    const c = createConverter(rest);
    try {
      const o: Partial<ConvertOptions> = {};
      if (to !== undefined) o.to = to;
      if (pages !== undefined) o.pages = pages;
      if (engine !== undefined) o.engine = engine;
      if (password !== undefined) o.password = password;
      if (rest.layout !== undefined) o.layout = rest.layout;
      if (rest.maxPages !== undefined) o.maxPages = rest.maxPages;
      return await c.convert(input, o);
    } finally {
      await c.terminate();
    }
  }

  async function toMarkdown(input: DocInput, options: Partial<Omit<ConvertOptions, 'to'> & ConverterOptions> = {}): Promise<string> {
    return (await convert(input, { ...options, to: 'md' })).content;
  }

  return { convert, toMarkdown, createConverter };
}
