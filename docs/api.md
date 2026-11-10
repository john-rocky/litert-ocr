# Reference

## API

```js
import { createWorker, createScheduler, recognize, PSM, OEM, OcrError, modelInfo } from 'litert-ocr';
```

- `createWorker(langs?, oem?, options?)` → `Promise<Worker>`. Options: `logger`, `errorHandler`, `modelBase`, `modelFiles`, `wasmPath`, `workerPath`, `backend` (`'auto'` = detector on WebGPU when it compiles, the browser default; `'wasm'`, the Node.js default), `recognizer` (below), `eager`, `prefetch`, `cachePath`, `cacheMethod`.
- `recognizer`: `'auto'` (default; [Safari and WebGPU](speed-and-files.md#safari-and-webgpu)), `'wasm'` (always WebAssembly), or `'webgpu'` (experimental: every recognizer on WebGPU, the 320 one with its WebGPU form, no check). `worker.info.recognizers` shows where each width runs, `worker.info.recognizerReason` why, `worker.info.recognizerCheck` the start check of `'auto'` (`{ width, steps, differing, maxDiff, limit, ms, text }`, or `null`), `worker.info.recognizerChecks` the check of each width (`null` where none ran yet). The 640 and 960 recognizers load on first use, so after each `recognize()` these fields show where every loaded width runs.
- `worker.recognize(image, options?, output?, jobId?)` → `{ jobId, data }`. `image`: a URL or data URL, `File`, `Blob`, `<img>`, `<canvas>`, `CanvasRenderingContext2D`, `OffscreenCanvas`, `ImageBitmap`, `ImageData`, an `ArrayBuffer` / `Uint8Array` / `Buffer` of an image file, `{ data, width, height }` (RGBA), and in Node.js a file path. `options.rectangle = { left, top, width, height }` reads only that region (boxes stay in whole-image pixels). `output` defaults to `{ text: true }`; add `blocks: true`, `hocr: true`, `tsv: true`.
- `data.text`: the lines, each ending in `"\n"`. `data.confidence`: mean word confidence, 0-100. `data.blocks` (when asked): `blocks[].paragraphs[].lines[].words[].symbols[]`, each with `text`, `confidence` (0-100) and `bbox { x0, y0, x1, y1 }`.
- `worker.setParameters(params)`, `worker.terminate()` (a second call resolves and does nothing), `worker.reinitialize()` (no-op), `worker.info`.
- `createScheduler()` with `addWorker`, `addJob('recognize', ...)`, `getQueueLen`, `getNumWorkers`, `terminate`. `recognize(image, langs, options)` creates, uses and terminates a worker (deprecated in tesseract.js, kept for old code).
- `logger` receives `{ workerId, jobId, userJobId, status, progress }` with `status` `'loading runtime'`, `'loading model'`, `'initializing model'`, `'initialized'` (its `message` names the backends and the thread count), `'recognizing text'`, `'caching model'` ([Offline](speed-and-files.md#offline)), and `'notice'` (with `message`: a fallback taken, an option ignored, an image resized, an image file cut short, where the recognizer runs). The loading and caching messages carry `file`, `loaded`, `total` and `fromCache`: `file` is the file whose bytes just arrived. In `'loading model'` and `'caching model'`, `loaded` and `total` count all the files of that step together (the three model files loaded at start are one step, 34 MB), so `progress` moves once from 0 to 1 per step; `'loading runtime'` counts each runtime file on its own.

Images whose longer side is over 4,096 pixels are scaled down to 4,096 before reading; boxes are still in the original pixels, and a notice says so.

## Errors

Every failure is an `OcrError` with a stable `code`; the message says what happened and what to do next.

| `code` | When | Next step in the message |
|---|---|---|
| `MODEL_FETCH_FAILED` | a model or runtime file did not download: HTTP status, offline, or blocked | the URL; offline: the first start needs the network once, and a recognizer loaded later that is not in the cache needs `createWorker()` once online with `eager: true`; blocked: allow the host in `connect-src`, or self-host with `modelBase` / `wasmPath` |
| `MODEL_SHA256_MISMATCH` | a file differs from the pinned one | copy the files again from the pinned source, or pass your own file with its sha256 in `modelFiles` |
| `MODEL_COMPILE_FAILED`, `RUNTIME_LOAD_FAILED` | LiteRT.js could not compile a model or start | the LiteRT.js message |
| `WORKER_START_FAILED` | the worker could not start (a CSP without `blob:` workers) | add `worker-src blob:`, or serve `dist/worker.js` and pass `workerPath` |
| `IMAGE_UNSUPPORTED_TYPE` | `recognize()` got something that is not an image | the accepted types |
| `IMAGE_FETCH_FAILED` | the image URL or file could not be read (404, CORS) | the `Access-Control-Allow-Origin` header, or pass a `Blob` / `File` |
| `IMAGE_DECODE_FAILED` | the bytes are not a readable image (cut short, PDF, HEIC; in Node.js anything but PNG and JPEG) | the formats that work; for a file cut short, pass the complete file; in Node.js how to convert or pass raw pixels |
| `IMAGE_CROSS_ORIGIN` | an `<img>` from another origin without CORS | load it with `crossOrigin="anonymous"` from a server that sends CORS headers |
| `LANG_NOT_SUPPORTED` | a language whose script the model cannot read, or an unknown code | keep tesseract.js for that language, or pass `'eng'` |
| `WORKER_TERMINATED` | `recognize()` after `terminate()` | create a new worker |
| `INVALID_ARGUMENT` | a malformed option (`rectangle`, `backend`, `pages`, `to`, ...), or `detect()` | the expected form |
| `DOC_UNSUPPORTED_TYPE` | `convert()` got a file that is neither a PDF nor an image (text, a ZIP such as DOCX) | convert it to PDF first |
| `DOC_TOO_MANY_PAGES` | more pages selected than `maxPages` (default 100) | pass `pages` to read a part, or a larger `maxPages` |
| `PDF_INVALID` | the file starts like a PDF but pdf.js cannot read it (truncated, damaged) | check it in a PDF viewer, or pass the pages as images |
| `PDF_PASSWORD` | the PDF is encrypted, or the password is wrong | pass `password` (CLI: `--password`) |
| `PDF_UNAVAILABLE` | pdf.js could not load (blocked download in the browser; Node.js older than 22.13) | `pdfjsPath`, or a newer Node.js |
| `PDF_RENDER_FAILED` | a page without a text layer could not be drawn for OCR (Node.js without `@napi-rs/canvas`) | `npm install @napi-rs/canvas`; the page is reported as failed, the others come back |
| `LLM_UNAVAILABLE` | `extract()` in Node.js, or `@litert-lm/core` is not installed | run it in a browser; install `@litert-lm/core@0.19.0-nightly.20261018` |
| `LLM_WEBGPU_UNAVAILABLE` | `extract()` in a browser without WebGPU | a browser with WebGPU; `convert()` and OCR work without it |
| `LLM_MODEL_FETCH_FAILED` | the 2.0 GB model did not download | the URL, the network, or `{ llm: { model } }` for your own copy |
| `LLM_FAILED` | LiteRT-LM could not create the engine or stopped while answering | the LiteRT-LM message |
| `SCHEMA_INVALID` | the schema of `extract()` is not an object schema with properties | the problems, listed in the message |

`IMAGE_FETCH_FAILED` also covers a PDF file or URL that cannot be read. With `convert()`, an error on one page (a page that cannot be drawn, a page OCR fails on) does not reject: that page has `status: 'failed'` with `reason` and `code`.

WebGPU missing or unable to compile the detector is not an error: the detector runs on WebAssembly and the logger gets a notice.

A PNG or JPEG file that ends before its end marker (a download cut short) gets a notice before it is decoded, in every browser and in Node.js: "This PNG file ends before its IEND chunk (32622 bytes): it was cut short, as by an interrupted download. ..." What happens next depends on the decoder: Chrome 155 rejects such a PNG with `IMAGE_DECODE_FAILED`, while WebKit 26.5 reads the part that arrived (the first half of the bytes of a 1280 x 800 screenshot: 10 lines, 2026-10-20); in Node.js the decoders rejected a PNG and a JPEG cut in half.
