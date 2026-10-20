// The documented public functions, shared by the browser and Node.js entries (src/index.ts, src/node.ts).

import type { makeApi } from './api.js';
import type { makeDocApi } from './doc/convert.js';

type Api = ReturnType<typeof makeApi>;
type DocApi = ReturnType<typeof makeDocApi>;

export function documentedDoc(api: DocApi) {
  return {
    /**
     * A PDF or an image -> Markdown (with GFM tables), JSON or plain text, on this device. Pages with a PDF text layer
     * are read from it (pdf.js); scans, image-only PDF pages and images are read by OCR with the page layout. Every
     * page comes back with a status: a page that fails is named with its reason and the other pages are returned.
     * @param input a file path (Node.js), URL, File, Blob, ArrayBuffer / Uint8Array / Buffer, or any image recognize() takes.
     * @param options to ('md' | 'json' | 'text'), pages ('1-3'), engine ('auto' | 'layer' | 'ocr'), layout ('auto' |
     *   'model' | 'geometry'), password, maxPages; and the createWorker options (modelBase, layoutModelBase, logger, ...).
     * @returns { to, content, document }: content = the Markdown / JSON / text; document = pages with status, blocks
     *   (type, text, bbox), tables (rows of cells), markdown and text per page.
     */
    convert: api.convert,
    /** convert(input, { ...options, to: 'md' }) -> the Markdown string. */
    toMarkdown: api.toMarkdown,
    /**
     * A converter that keeps its OCR worker (and the layout model) between documents: convert(), toMarkdown(),
     * terminate(). Use it for several files; convert() and toMarkdown() at the top level create and stop one per call.
     */
    createConverter: api.createConverter,
  };
}

export function documented(api: Api) {
  return {
    /**
     * Start a worker: it loads the LiteRT.js runtime and the model (downloaded once, then cached) and resolves
     * when it can read. Same call as tesseract.js 7.
     * @param langs tesseract language codes: 'eng', 'jpn', 'eng+jpn', ['eng', 'jpn']. One model reads every
     *   covered language, so the value does not choose a model. It is checked: a language whose script the
     *   model cannot read (Korean, Cyrillic, Arabic, Hebrew, Thai, Indic) or an unknown code rejects with
     *   LANG_NOT_SUPPORTED. Default 'eng'.
     * @param oem Accepted and ignored (one engine).
     * @param options logger, errorHandler, modelBase, modelFiles, wasmPath, workerPath, backend, eager,
     *   cachePath, cacheMethod; tesseract.js paths (corePath, langPath, ...) are accepted and ignored.
     */
    createWorker: api.createWorker,
    /** Deprecated in tesseract.js, kept for old code: create a worker, read one image, terminate the worker. */
    recognize: api.recognize,
    /** Not supported (orientation and script detection): rejects with INVALID_ARGUMENT. */
    detect: api.detect,
    /** A job queue over several workers: addWorker, addJob('recognize', image, options, output), getQueueLen, getNumWorkers, terminate. */
    createScheduler: api.createScheduler,
    /** true: log every worker message with console.debug. */
    setLogging: api.setLogging,
    /** tesseract.js OEM values; accepted and not used. */
    OEM: api.OEM,
    /** tesseract.js PSM values; SINGLE_LINE, SINGLE_WORD, RAW_LINE and SINGLE_CHAR read the image as one line, the rest are ignored. */
    PSM: api.PSM,
    /** tesseract language codes this library accepts (name -> code). */
    languages: api.languages,
  };
}
