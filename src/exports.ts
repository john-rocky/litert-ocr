// The documented public functions, shared by the browser and Node.js entries (src/index.ts, src/node.ts).

import type { makeApi } from './api.js';

type Api = ReturnType<typeof makeApi>;

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
