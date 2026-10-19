// Public types. Names and shapes follow tesseract.js 7 (src/index.d.ts) so code written for it type-checks
// here; fields this library cannot measure are null and say so.

export interface Bbox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** The bottom edge of the detected text box (not the typographic baseline): has_baseline is false. */
export interface Baseline extends Bbox {
  has_baseline: boolean;
}

/** rowHeight = line box height in pixels. ascenders / descenders are not measured (null). */
export interface RowAttributes {
  ascenders: number | null;
  descenders: number | null;
  rowHeight: number;
}

export interface Symbol {
  text: string;
  /** 0-100: the recognizer's probability for this character. */
  confidence: number;
  /** Approximate: from the position of the character in the recognizer's output sequence. */
  bbox: Bbox;
  is_superscript: boolean;
  is_subscript: boolean;
  is_dropcap: boolean;
}

export interface Choice {
  text: string;
  confidence: number;
}

export interface Word {
  symbols: Symbol[];
  /** One entry: the word itself (the recognizer gives no alternatives). */
  choices: Choice[];
  text: string;
  /** 0-100: mean probability of the word's characters. */
  confidence: number;
  bbox: Bbox;
  font_name: string | null;
}

export interface Line {
  words: Word[];
  text: string;
  /** 0-100: mean probability of the line's characters (lines under 50 are dropped). */
  confidence: number;
  baseline: Baseline;
  rowAttributes: RowAttributes;
  bbox: Bbox;
}

export interface Paragraph {
  lines: Line[];
  text: string;
  confidence: number;
  bbox: Bbox;
  is_ltr: boolean;
}

export interface Block {
  paragraphs: Paragraph[];
  text: string;
  confidence: number;
  bbox: Bbox;
  /** Not classified (null): this library has no layout analysis yet. */
  blocktype: string | null;
}

/**
 * `data` of a recognize() result. Only `text` and `confidence` are filled by default; `blocks`, `hocr` and
 * `tsv` are filled when requested in the `output` argument (as in tesseract.js 6+). The other formats of
 * tesseract.js (box, unlv, osd, pdf, imageColor, imageGrey, imageBinary, layoutBlocks, debug) are always null.
 */
export interface Page {
  /** One detected line per text line, in reading order (top to bottom, left to right), each ending in "\n". */
  text: string;
  /** 0-100: mean word confidence (0 when nothing was read). */
  confidence: number;
  blocks: Block[] | null;
  hocr: string | null;
  tsv: string | null;
  box: null;
  unlv: null;
  osd: null;
  pdf: null;
  imageColor: null;
  imageGrey: null;
  imageBinary: null;
  layoutBlocks: null;
  debug: null;
  /** Always 0: the image is not rotated before reading (tall text lines are turned one by one). */
  rotateRadians: number;
  /** Not used by this engine (null). */
  psm: string | null;
  /** Not used by this engine (null). */
  oem: string | null;
  /** Library, model and runtime, e.g. "litert-ocr 0.1.0 (PP-OCRv6-Small @a9b2feb, LiteRT.js 2.5.3)". */
  version: string;
}

export interface RecognizeResult {
  jobId: string;
  data: Page;
}

export interface Rectangle {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface RecognizeOptions {
  /** Read only this region; boxes are still in whole-image coordinates. */
  rectangle?: Rectangle;
  /** Same keys as setParameters(); they apply to this call only. */
  [param: string]: unknown;
}

export interface OutputFormats {
  text: boolean;
  blocks: boolean;
  hocr: boolean;
  tsv: boolean;
  /** Accepted for tesseract.js compatibility; always null in the result. */
  layoutBlocks: boolean;
  box: boolean;
  unlv: boolean;
  osd: boolean;
  pdf: boolean;
  imageColor: boolean;
  imageGrey: boolean;
  imageBinary: boolean;
  debug: boolean;
}

/**
 * Logger messages. `status` is one of: 'loading runtime', 'loading model', 'initializing model',
 * 'initialized', 'recognizing text', 'notice'. A 'notice' carries `message` (a fallback taken, a
 * parameter ignored, an image resized). 'loading runtime' and 'loading model' carry byte counts.
 */
export interface LoggerMessage {
  workerId: string;
  jobId: string;
  userJobId: string;
  status: string;
  progress: number;
  message?: string;
  file?: string;
  loaded?: number;
  total?: number;
  fromCache?: boolean;
}

/** A file used in place of a pinned model file (local experiments with other model files). */
export interface ModelFileOverride {
  url: string;
  /** When given, the downloaded bytes must match it; when left out the file is used unverified (a notice says so). */
  sha256?: string;
}

export interface WorkerOptions {
  logger: (m: LoggerMessage) => void;
  /** Called with every error a job rejects with (the promise still rejects). */
  errorHandler: (e: Error) => void;
  /**
   * Directory URL (browser) or URL / directory path (Node) holding the five model files under their
   * Hub names. Default: Hugging Face, litert-community/PP-OCRv6-Small-LiteRT at a pinned commit. The
   * files must match the pinned sha256 (a mirror of the same files).
   */
  modelBase: string;
  /** Replace single model files: { rec320: { url, sha256 } } or { rec320: 'url' } (unverified). */
  modelFiles: Partial<Record<'det' | 'rec320' | 'rec640' | 'rec960' | 'characters', string | ModelFileOverride>>;
  /** Browser: directory URL of the LiteRT.js 2.5.3 wasm files. Default: jsDelivr (pinned version and sha256). */
  wasmPath: string;
  /** Browser: URL of this package's dist/worker.js to start instead of the built-in blob worker (CSP without blob:). */
  workerPath: string;
  /**
   * false (default): the 640 / 960 recognizers (about 21.5 MB each) load the first time a line needs them.
   * true: load all five model files at start (for offline use after the first visit).
   */
  eager: boolean;
  /**
   * 'auto': detector on WebGPU when it compiles, else WebAssembly (the browser default). 'wasm': WebAssembly only
   * (the default in Node.js, Deno and Bun; Deno has WebGPU, pass 'auto' to try it there).
   */
  backend: 'auto' | 'wasm';
  /** Node: cache directory (default: $XDG_CACHE_HOME/litert-ocr or ~/.cache/litert-ocr). */
  cachePath: string;
  /** 'write' (default) | 'readOnly' | 'refresh' | 'none' — as in tesseract.js. */
  cacheMethod: 'write' | 'readOnly' | 'refresh' | 'none';
  /** Accepted and ignored (tesseract.js paths): the model and runtime come from modelBase and wasmPath. */
  corePath: string;
  langPath: string;
  dataPath: string;
  workerBlobURL: boolean;
  gzip: boolean;
  legacyCore: boolean;
  legacyLang: boolean;
}

export interface WorkerInfo {
  /** Where the text detector runs: 'webgpu' or 'wasm'. */
  detector: 'webgpu' | 'wasm';
  /** The recognizer always runs on WebAssembly (see README: WebGPU misreads it, LiteRT issue #9661). */
  recognizer: 'wasm';
  /** WebAssembly threads used (1 when the page is not cross-origin isolated). */
  threads: number;
  runtime: string;
  model: string;
  platform: 'browser' | 'node' | 'deno' | 'bun';
}

export type ImageLike =
  | string
  | Blob
  | File
  | ArrayBuffer
  | ArrayBufferView
  | ImageData
  | ImageBitmap
  | OffscreenCanvas
  | HTMLImageElement
  | HTMLCanvasElement
  | HTMLVideoElement
  | CanvasRenderingContext2D
  | { data: Uint8ClampedArray | Uint8Array; width: number; height: number };

export interface Worker {
  /** Worker-<n>-<random>, as in tesseract.js (a scheduler keys on it). */
  readonly id: string;
  /** Where the engine runs (set when createWorker resolves). Not in tesseract.js. */
  readonly info: WorkerInfo;
  recognize(image: ImageLike, options?: RecognizeOptions, output?: Partial<OutputFormats>, jobId?: string): Promise<RecognizeResult>;
  /**
   * Used: tessedit_char_whitelist, tessedit_char_blacklist (limit the characters the recognizer may emit),
   * tessedit_pageseg_mode SINGLE_LINE / SINGLE_WORD / RAW_LINE / SINGLE_CHAR (read the whole image or
   * rectangle as one line, no detection). Every other parameter is accepted and ignored (a notice says which).
   */
  setParameters(params: Record<string, unknown>, jobId?: string): Promise<{ jobId: string; data: { ignored: string[] } }>;
  /** Accepted for tesseract.js compatibility: the languages do not change the model (see createWorker). */
  reinitialize(langs?: string | string[], oem?: number, config?: unknown, jobId?: string): Promise<{ jobId: string; data: null }>;
  /** Stops the worker. A second call resolves and does nothing (as in tesseract.js). */
  terminate(jobId?: string): Promise<{ jobId: string; data: { terminated: true } }>;
  /** Not supported (tesseract.js runs OSD here): rejects with INVALID_ARGUMENT. */
  detect(image: ImageLike, jobId?: string): Promise<never>;
  /** Deprecated in tesseract.js: no-op. */
  load(jobId?: string): Promise<{ jobId: string; data: null }>;
}

export interface Scheduler {
  addWorker(worker: Worker): string;
  addJob(action: 'recognize', ...args: Parameters<Worker['recognize']>): Promise<RecognizeResult>;
  terminate(): Promise<void>;
  getQueueLen(): number;
  getNumWorkers(): number;
}
