# litert-ocr

OCR for photos and screenshots in the browser and in Node.js, with the tesseract.js API; TODO-MEASURE-SEAT.

It runs PP-OCRv6-Small with LiteRT.js. In the browser the text detector runs on WebGPU when the browser has it and the recognizer on WebAssembly, inside a Web Worker; in Node.js, Deno and Bun everything runs on WebAssembly in a worker thread. Images never leave the device. Independent project, not affiliated with Google or PaddlePaddle.

```js
import { createWorker } from 'litert-ocr';

const worker = await createWorker('eng');
const { data } = await worker.recognize('https://example.com/receipt.jpg');
console.log(data.text);
await worker.terminate();
```

From a CDN, with no build step:

```html
<script type="module">
  import { createWorker } from 'https://cdn.jsdelivr.net/npm/litert-ocr@0.1.0/+esm';
</script>
```

## Switching from tesseract.js

Change the import; the calls and the result shape stay the same:

```diff
- import { createWorker } from 'tesseract.js';
+ import { createWorker } from 'litert-ocr';
```

`require('litert-ocr')` works too (Node.js 20.19+ / 22.12+ load this ES module from CommonJS).

What differs:

| | tesseract.js 7 | litert-ocr |
|---|---|---|
| Languages | one data file per language (`'eng'`, `'jpn'`, `'eng+jpn'`) | one model reads Latin-script, Greek, Chinese and Japanese text. `langs` is checked but picks nothing. Korean, Cyrillic, Arabic, Hebrew, Thai and Indic scripts are not covered: `createWorker('kor')` rejects with `LANG_NOT_SUPPORTED` |
| `oem`, `corePath`, `langPath`, `legacyCore`, `gzip` | engine and data options | accepted and ignored (a notice says so) |
| `setParameters` | every Tesseract parameter | `tessedit_char_whitelist`, `tessedit_char_blacklist`, and `tessedit_pageseg_mode` `SINGLE_LINE` / `SINGLE_WORD` / `RAW_LINE` / `SINGLE_CHAR` (read the image as one line, no detection). Others are ignored; the result lists them |
| Output | `text`, `blocks`, `hocr`, `tsv`, `box`, `unlv`, `osd`, `pdf`, images | `text`, `blocks`, `hocr`, `tsv`. The other formats are `null` |
| Layout | Tesseract's blocks and paragraphs | one block with one paragraph; one line per detected text line, in reading order (top to bottom, left to right). A table row or a label and its value can come out as separate lines |
| Word and symbol boxes | from Tesseract's segmentation | from the recognizer's output positions along the line (approximate) |
| Rotated text | `rotateAuto` | tall lines (vertical text) are turned and read; upside-down text is not. `rotateAuto` / `rotateRadians` are ignored |
| `detect()` | orientation and script detection | not supported (rejects with `INVALID_ARGUMENT`) |
| Node.js image formats | bmp, jpg, png, pbm, webp, gif | PNG and JPEG (decode others first, or pass `{ data, width, height }`). Browsers read every format they can decode |
| Files on first use | core WebAssembly and language data | the LiteRT.js runtime and the model (sizes below), cached |

## What it reads

PP-OCRv6-Small (Hugging Face [litert-community/PP-OCRv6-Small-LiteRT](https://huggingface.co/litert-community/PP-OCRv6-Small-LiteRT)): a text detector (640 x 640 input) and a recognizer whose vocabulary has 18,710 entries: Latin letters with Latin-1 and Latin Extended-A accents, Greek, kana and 15,565 Chinese characters. English and Japanese photos and screenshots are what was measured (below); other covered languages are not measured here.

Each detected line is read upright: the image is stretched to 640 x 640 for detection, each line is cut out along its box (tall lines are turned a quarter turn) and read at a height of 48 pixels. Lines the recognizer is not sure of (mean character probability under 0.5) are dropped.

## Speed and size

TODO-MEASURE-SPEED

The browser needs cross-origin isolation for WebAssembly threads: serve the page with

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Without these headers OCR still works, on one thread (several times slower), and the logger and the console say so. When you cannot set headers (GitHub Pages), [coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker) sets them from a service worker. `worker.info` reports where the worker runs: `{ detector, recognizer, recognizers, threads, runtime, model, platform }`.

Why the recognizer runs on WebAssembly: with LiteRT.js 2.5.3 on WebGPU its output differs from WebAssembly on many lines (376 of 496 test lines read the same on an Apple M4 Max in Chrome 155, 2026-10-19), the fault reported for PP-OCRv5 in [LiteRT issue #9661](https://github.com/google-ai-edge/LiteRT/issues/9661). The detector reads the same on both.

## Model and runtime files

All files are pinned: a fixed revision on Hugging Face and on jsDelivr, each checked by size and sha256 (`src/core/models.ts`, also exported as `modelInfo`). The browser keeps them in the Cache API, Node.js in `~/.cache/litert-ocr` (or `$XDG_CACHE_HOME/litert-ocr`, or `cachePath`).

| File | Bytes | When |
|---|---|---|
| LiteRT.js 2.5.3 runtime (`litert_wasm_threaded_internal.js` + `.wasm`) | 9,763,309 | at start (browser; Node.js reads it from `node_modules`) |
| `ppocrv6_small_det_640_fp32.tflite` (detector) | 12,380,664 | at start |
| `ppocrv6_small_rec_320_fp32.tflite` (recognizer, lines up to 320 px wide at height 48) | 21,477,068 | at start |
| `characters.json` | 168,510 | at start |
| `ppocrv6_small_rec_640_fp32.tflite` | 21,477,068 | the first time a line is wider than 320 px at height 48 |
| `ppocrv6_small_rec_960_fp32.tflite` | 21,476,976 | the first time a line is wider than 640 px |

Options for where the files come from:

- `modelBase`: a directory URL (browser) or path (Node.js) with the five model files under their Hub names. The files must match the pinned sha256.
- `wasmPath`: a directory URL with the LiteRT.js 2.5.3 `wasm/` files (`node_modules/@litertjs/core/wasm/`).
- `modelFiles`: replace single files, `{ rec320: { url, sha256 } }`; without `sha256` the file is used unverified (a notice says so). For trying other model files.
- `eager: true`: load all five model files at start (for offline use after the first visit).
- `cacheMethod`: `'write'` (default), `'readOnly'`, `'refresh'`, `'none'`, as in tesseract.js.

## API

```js
import { createWorker, createScheduler, recognize, PSM, OEM, OcrError, modelInfo } from 'litert-ocr';
```

- `createWorker(langs?, oem?, options?)` → `Promise<Worker>`. Options: `logger`, `errorHandler`, `modelBase`, `modelFiles`, `wasmPath`, `workerPath`, `backend` (`'auto'` = detector on WebGPU when it compiles, the browser default; `'wasm'`, the Node.js default), `recognizer` (below), `eager`, `cachePath`, `cacheMethod`.
- `recognizer: 'webgpu'` (experimental): the 640 and 960 recognizers run on WebGPU, where the published files read the same as on WebAssembly. The 320 one moves to WebGPU only when `modelFiles.rec320` replaces the published file (which misreads there) with one that does not; no such file is published yet, so by default it stays on WebAssembly and a notice says so. `worker.info.recognizers` shows where each width runs.
- `worker.recognize(image, options?, output?, jobId?)` → `{ jobId, data }`. `image`: a URL or data URL, `File`, `Blob`, `<img>`, `<canvas>`, `CanvasRenderingContext2D`, `OffscreenCanvas`, `ImageBitmap`, `ImageData`, an `ArrayBuffer` / `Uint8Array` / `Buffer` of an image file, `{ data, width, height }` (RGBA), and in Node.js a file path. `options.rectangle = { left, top, width, height }` reads only that region (boxes stay in whole-image pixels). `output` defaults to `{ text: true }`; add `blocks: true`, `hocr: true`, `tsv: true`.
- `data.text`: the lines, each ending in `"\n"`. `data.confidence`: mean word confidence, 0-100. `data.blocks` (when asked): `blocks[].paragraphs[].lines[].words[].symbols[]`, each with `text`, `confidence` (0-100) and `bbox { x0, y0, x1, y1 }`.
- `worker.setParameters(params)`, `worker.terminate()` (a second call resolves and does nothing), `worker.reinitialize()` (no-op), `worker.info`.
- `createScheduler()` with `addWorker`, `addJob('recognize', ...)`, `getQueueLen`, `getNumWorkers`, `terminate`. `recognize(image, langs, options)` creates, uses and terminates a worker (deprecated in tesseract.js, kept for old code).
- `logger` receives `{ workerId, jobId, userJobId, status, progress }` with `status` `'loading runtime'`, `'loading model'` (with `file`, `loaded`, `total`, `fromCache`), `'initializing model'`, `'initialized'` (its `message` names the backends and the thread count), `'recognizing text'`, and `'notice'` (with `message`: a fallback taken, an option ignored, an image resized).

Images whose longer side is over 4,096 pixels are scaled down to 4,096 before reading; boxes are still in the original pixels, and a notice says so.

## Errors

Every failure is an `OcrError` with a stable `code`; the message says what happened and what to do next.

| `code` | When | Next step in the message |
|---|---|---|
| `MODEL_FETCH_FAILED` | a model or runtime file did not download: HTTP status, offline, or blocked | the URL; offline: the first start needs the network once; blocked: allow the host in `connect-src`, or self-host with `modelBase` / `wasmPath` |
| `MODEL_SHA256_MISMATCH` | a file differs from the pinned one | copy the files again from the pinned source, or pass your own file with its sha256 in `modelFiles` |
| `MODEL_COMPILE_FAILED`, `RUNTIME_LOAD_FAILED` | LiteRT.js could not compile a model or start | the LiteRT.js message |
| `WORKER_START_FAILED` | the worker could not start (a CSP without `blob:` workers) | add `worker-src blob:`, or serve `dist/worker.js` and pass `workerPath` |
| `IMAGE_UNSUPPORTED_TYPE` | `recognize()` got something that is not an image | the accepted types |
| `IMAGE_FETCH_FAILED` | the image URL or file could not be read (404, CORS) | the `Access-Control-Allow-Origin` header, or pass a `Blob` / `File` |
| `IMAGE_DECODE_FAILED` | the bytes are not a readable image (truncated, PDF, HEIC; in Node.js anything but PNG and JPEG) | the formats that work; in Node.js how to convert or pass raw pixels |
| `IMAGE_CROSS_ORIGIN` | an `<img>` from another origin without CORS | load it with `crossOrigin="anonymous"` from a server that sends CORS headers |
| `LANG_NOT_SUPPORTED` | a language whose script the model cannot read, or an unknown code | keep tesseract.js for that language, or pass `'eng'` |
| `WORKER_TERMINATED` | `recognize()` after `terminate()` | create a new worker |
| `INVALID_ARGUMENT` | a malformed option (`rectangle`, `backend`, ...), or `detect()` | the expected form |

WebGPU missing or unable to compile the detector is not an error: the detector runs on WebAssembly and the logger gets a notice.

## Examples

- [`examples/html`](examples/html): plain HTML with the CDN import (`node serve.mjs` serves it with the two headers).
- [`examples/react-vite`](examples/react-vite): React with Vite.
- [`examples/nextjs`](examples/nextjs): Next.js App Router; the library is imported inside `useEffect` of a client component, never on the server.

## Tests

`npm install && npm run build && npm test` runs the Node.js tests, the browser tests in headless Chrome (WebGPU and WebAssembly modes, with the failure paths), the tesseract.js README example with the import changed (Node.js ESM and CommonJS, and the browser), and Deno and Bun smoke tests when they are installed. `node test/examples.mjs` builds the three examples and reads one image in each.

## License

Apache License 2.0. See [NOTICE](NOTICE) for the parts copied from google-ai-edge/litert-samples and for the model and runtime licenses.
