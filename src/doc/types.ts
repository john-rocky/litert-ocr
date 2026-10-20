// Public types of the document API: convert(), toMarkdown(), createConverter().

import type { Box, BlockType } from './geom.js';
import type { ImageLike, WorkerOptions } from '../core/types.js';

/** A PDF or an image: a URL or path string, File, Blob, ArrayBuffer / Uint8Array / Buffer, or any image recognize() takes. */
export type DocInput = ImageLike | URL;

export type ConvertTo = 'md' | 'json' | 'text';

export interface ConvertOptions {
  /** 'md' (default): Markdown with GFM tables; 'json': the document structure as a JSON string; 'text': plain text. */
  to: ConvertTo;
  /** Pages to read: '1-3', '1,4,7-9', '5-' (to the end), a page number or an array of numbers (1-based). Default: all. */
  pages: string | number | number[];
  /**
   * 'auto' (default): pages with a text layer are read from it, pages without one (scans, images) by OCR.
   * 'layer': the text layer only (a page without one comes back empty). 'ocr': every page by OCR, the text layer ignored.
   */
  engine: 'auto' | 'layer' | 'ocr';
  /**
   * How OCR pages are cut into headings, paragraphs, lists and tables. 'geometry': from the text boxes alone.
   * 'model': the layout model (docling-layout-heron) on WebGPU when there is a device, else on WebAssembly.
   * 'auto' (default): the model where it is cheap (WebGPU in a browser; WebAssembly in Node.js) and geometry otherwise.
   * While the layout model is not published (upload pending), 'auto' and 'model' use geometry unless the converter
   * was created with layoutModelBase.
   */
  layout: 'auto' | 'model' | 'geometry';
  /** Password of an encrypted PDF. */
  password: string;
  /** Reject a document with more selected pages than this (default 100); pass `pages` to read a part. */
  maxPages: number;
}

export interface ConverterOptions extends Partial<WorkerOptions> {
  /** Default layout of convert() calls (see ConvertOptions.layout). */
  layout: 'auto' | 'model' | 'geometry';
  /** Directory URL (browser) or path (Node.js) of the layout model files (modelInfo.layout). */
  layoutModelBase: string;
  /** Browser: directory URL of pdfjs-dist 6.4.299 (with build/, cmaps/, standard_fonts/, wasm/). Default: jsDelivr. */
  pdfjsPath: string;
  /** Default page limit (see ConvertOptions.maxPages). */
  maxPages: number;
}

export interface DocBlock {
  type: BlockType;
  /** Headings: 1 = largest. */
  level?: number;
  text: string;
  /** [x0, y0, x1, y1] in page pixels. */
  bbox: Box;
  /** Tables: index into the page's `tables`. */
  table?: number;
  /** With the layout model: the region label (caption, footnote, formula, code, ...). */
  role?: string;
}

export interface DocTable {
  bbox: Box;
  /** Cell texts row by row; the first row is the header row of the Markdown table. */
  rows: string[][];
}

export interface PageResult {
  /** 1-based page number. */
  page: number;
  /** 'ok' = text found; 'empty' = read, nothing found (or no text layer with engine 'layer'); 'failed' = an error, see reason. */
  status: 'ok' | 'empty' | 'failed';
  reason: string | null;
  /** OcrError code of a failed page. */
  code: string | null;
  /** How the text was read: the PDF text layer or OCR. */
  engine: 'layer' | 'ocr' | null;
  /** OCR pages: what cut the page into blocks; why the model was not used. */
  layout: { used: 'model' | 'geometry'; backend: 'webgpu' | 'wasm' | null; reason: string | null } | null;
  /** Page size in pixels (PDF pages at 150 dpi). */
  width: number;
  height: number;
  dpi: number | null;
  /** OCR pages: degrees the page was turned back by before reading. */
  skew: number | null;
  /** 'ja' when kana / kanji are >= 30 % of the letters (pieces are joined without spaces), else 'en'. */
  lang: 'en' | 'ja';
  blocks: DocBlock[];
  tables: DocTable[];
  markdown: string;
  text: string;
  /** Milliseconds for this page (read, render, OCR, layout, blocks). */
  ms: number;
}

export interface DocumentResult {
  /** Library, model and runtime versions. */
  version: string;
  source: { name: string | null; type: 'pdf' | 'image'; pages: number };
  pages: PageResult[];
}

export interface ConvertResult {
  to: ConvertTo;
  /** Markdown (to 'md'), plain text (to 'text') or the JSON of `document` (to 'json'). */
  content: string;
  document: DocumentResult;
}

export interface Converter {
  convert(input: DocInput, options?: Partial<ConvertOptions>): Promise<ConvertResult>;
  toMarkdown(input: DocInput, options?: Partial<Omit<ConvertOptions, 'to'>>): Promise<string>;
  /** Stop the OCR worker. */
  terminate(): Promise<void>;
}
