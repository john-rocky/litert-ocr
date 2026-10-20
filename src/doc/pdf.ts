// PDF pages with pdf.js: open (password and damage mapped to errors), the text layer as page units, and the check
// whether a page needs OCR. The same calls in the browser (pdfjs-dist build/) and Node.js (legacy/build/).
// needsOcr follows the idea of anydoc's pdf-inspector check (read in its source for the r2d document map): a page is
// a text page when its text layer has >= 3 items and >= 5 distinct letters / digits and is not garbage (fewer than
// half of its characters are letters or digits once there are >= 50); otherwise, or when one image covers >= 50 % of
// the page and the layer holds < 50 items, the page needs OCR.

import { OcrError, errText } from '../core/errors.js';
import type { Unit } from './geom.js';

/** The part of the pdfjs-dist module this file uses (both builds export it). */
export interface PdfJs {
  getDocument(params: Record<string, unknown>): { promise: Promise<PdfDocument>; destroy(): Promise<void> };
  Util: { transform(m1: number[], m2: number[]): number[] };
  OPS: Record<string, number>;
  version?: string;
}

export interface PdfDocument {
  numPages: number;
  getPage(n: number): Promise<PdfPage>;
}

export interface PdfViewport {
  width: number;
  height: number;
  transform: number[];
}

export interface PdfPage {
  getViewport(o: { scale: number }): PdfViewport;
  getTextContent(): Promise<{ items: unknown[]; styles: Record<string, { fontFamily?: string }> }>;
  getOperatorList(): Promise<{ fnArray: number[]; argsArray: unknown[][] }>;
  render(o: Record<string, unknown>): { promise: Promise<void> };
  cleanup(): void;
}

/** OCR pages and text-layer coordinates are in pixels of a 150 dpi rendering (the measured setting). */
export const PDF_DPI = 150;
export const PDF_SCALE = PDF_DPI / 72;

export async function openPdf(pdfjs: PdfJs, bytes: Uint8Array, params: Record<string, unknown>, password?: string): Promise<{ doc: PdfDocument; close(): Promise<void> }> {
  // pdf.js transfers the buffer to its worker: hand it a copy, the caller's bytes stay usable
  const task = pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, verbosity: 0, ...params, ...(password !== undefined ? { password } : {}) });
  try {
    const doc = await task.promise;
    return { doc, close: () => task.destroy().catch(() => {}) };
  } catch (e) {
    await task.destroy().catch(() => {});
    const name = (e as { name?: string })?.name;
    const code = (e as { code?: number })?.code;
    if (name === 'PasswordException') {
      throw new OcrError(
        'PDF_PASSWORD',
        code === 2 || password !== undefined
          ? 'The password did not open this PDF. Pass the right one as { password } (CLI: --password).'
          : 'This PDF is encrypted with a password. Pass it as { password } (CLI: --password).',
        { cause: e },
      );
    }
    throw new OcrError('PDF_INVALID', `This file starts like a PDF but pdf.js could not read it (${errText(e)}). It may be truncated or damaged; open it in a PDF viewer to check, or pass the pages as images.`, { cause: e });
  }
}

export interface PageItems {
  units: Unit[];
  width: number;
  height: number;
  count: number;
}

/** Text items in page pixels (y down) at `scale`; each item = one unit with its box. */
export async function pageItems(pdfjs: PdfJs, page: PdfPage, scale = PDF_SCALE): Promise<PageItems> {
  const vp = page.getViewport({ scale });
  const tc = await page.getTextContent();
  const units: Unit[] = [];
  let count = 0;
  for (const raw of tc.items) {
    const it = raw as { str?: string; transform?: number[]; width?: number };
    if (typeof it.str !== 'string' || !it.transform) continue;
    count++;
    const m = pdfjs.Util.transform(vp.transform, it.transform);
    const size = Math.hypot(m[2]!, m[3]!);
    const x0 = m[4]!;
    const yBase = m[5]!;
    const w = (it.width ?? 0) * scale;
    units.push({ x0, y0: yBase - size, x1: x0 + w, y1: yBase + size * 0.25, text: it.str });
  }
  return { units, width: vp.width, height: vp.height, count };
}

/** Largest image on the page as a share of the page area (from the operator list's transform at paint time). */
export async function imageCover(pdfjs: PdfJs, page: PdfPage): Promise<{ images: number; cover: number }> {
  const ops = await page.getOperatorList();
  const vp = page.getViewport({ scale: 1 });
  const area = vp.width * vp.height;
  const O = pdfjs.OPS;
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack: number[][] = [];
  let best = 0;
  let images = 0;
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i] as number[];
    if (fn === O.save) stack.push(ctm.slice());
    else if (fn === O.restore) ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0];
    else if (fn === O.transform) ctm = pdfjs.Util.transform(ctm, args);
    else if (fn === O.paintImageXObject || fn === O.paintInlineImageXObject || fn === O.paintImageMaskXObject) {
      images++;
      const w = Math.hypot(ctm[0]!, ctm[1]!);
      const h = Math.hypot(ctm[2]!, ctm[3]!);
      best = Math.max(best, (w * h) / area);
    }
  }
  return { images, cover: Math.min(1, best) };
}

export function needsOcr(units: Unit[], count: number, cover: { cover: number }): boolean {
  const text = units.map((i) => i.text).join('');
  const alnum = [...text].filter((c) => /[\p{L}\p{N}]/u.test(c));
  const distinct = new Set(alnum).size;
  const nonSpace = [...text].filter((c) => !/\s/.test(c)).length;
  const garbage = nonSpace >= 50 && alnum.length * 2 < nonSpace;
  const textPage = count >= 3 && distinct >= 5 && !garbage;
  const scanLike = cover.cover >= 0.5 && count < 50;
  return !textPage || scanLike;
}
