# AGENTS.md — for coding agents adding OCR to a web page or a Node.js script

Read this if someone asked you to "read the text in an image", "add OCR", or "replace tesseract.js". This
file routes; the README has the details.

**What this is.** An OCR library with the tesseract.js 7 API (`createWorker` → `worker.recognize` →
`worker.terminate`), running PP-OCRv6-Small with LiteRT.js in the browser (WebGPU or WebAssembly, in a Web
Worker) and in Node.js / Deno / Bun (WebAssembly, in a worker thread). Images never leave the device.
Independent project, not affiliated with Google or PaddlePaddle.

## Route

| Task | Do | Where |
|---|---|---|
| Replace tesseract.js | Change the import: `import { createWorker } from 'litert-ocr'`; the rest of the code stays | README "Switching from tesseract.js" (what differs) |
| Read text from an image in the browser | `const worker = await createWorker('eng'); const { data } = await worker.recognize(fileOrUrl); data.text` | `src/api.ts` `createWorker`, `examples/html` |
| Words and boxes | `worker.recognize(img, {}, { blocks: true })` → `data.blocks[].paragraphs[].lines[].words[]` with `text`, `confidence` (0-100), `bbox {x0,y0,x1,y1}`; also `hocr: true`, `tsv: true` | `src/core/output.ts` |
| Read part of an image | `worker.recognize(img, { rectangle: { left, top, width, height } })` (boxes stay in whole-image pixels) | README "API" |
| Digits only, or a single text line | `worker.setParameters({ tessedit_char_whitelist: '0123456789' })`; `{ tessedit_pageseg_mode: PSM.SINGLE_LINE }` skips detection | `src/core/ctc.ts`, `src/core/constants.ts` |
| React / Vite | create the worker in `useEffect`, terminate in its cleanup | `examples/react-vite/src/App.jsx` |
| Next.js (App Router) | a `'use client'` component that does `await import('litert-ocr')` inside `useEffect` (never on the server) | `examples/nextjs/app/ocr.jsx` |
| Node.js script | same API; pass a file path, Buffer, URL or `{ data, width, height }`; PNG and JPEG only | `test/compat/readme.mjs`, `src/node/` |
| Make WebAssembly use threads (several times faster) | serve the page with `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`; check `worker.info.threads` | `examples/*/` configs, README "Speed and accuracy" |
| Run offline / self-host the files | copy the model files (`modelInfo.files`) and LiteRT.js wasm files (`modelInfo.runtime`) to your server; pass `modelBase` and `wasmPath`; `eager: true` loads everything at start | README "Model and runtime files" |
| Check where it runs | `worker.info` = `{ detector, recognizer, recognizers, threads, runtime, model, platform }`; the logger's `'initialized'` message says the same | `src/core/handler.ts` |
| Recognizer on WebGPU (experimental, faster) | `recognizer: 'webgpu'`: 640 / 960 on WebGPU with the published files; the published 320 file misreads on WebGPU, so it stays on WebAssembly unless `modelFiles.rec320` gives a fixed file | `src/core/engine.ts` `compileRec` |
| A page with a strict Content-Security-Policy | allow `worker-src blob:`, or serve `node_modules/litert-ocr/dist/worker.js` and pass `workerPath` | `src/browser/main.ts` |
| An error | every error is an `OcrError` with a stable `code` and a message that names the next step | README "Errors", `src/core/errors.ts` |
| Several images in parallel | `createScheduler()`, `addWorker`, `addJob('recognize', image)` | `src/api.ts` `createScheduler` |
| Run the tests | `npm install && npm run build && npm test` (headless Chrome via Playwright; Node; Deno and Bun when installed) | `test/run.mjs` |

## Rules

- One model reads Latin-script, Greek, Chinese and Japanese text; `langs` does not choose a model. Korean,
  Cyrillic, Arabic, Hebrew, Thai and Indic scripts are not covered: `createWorker('kor')` rejects with
  `LANG_NOT_SUPPORTED`. Keep tesseract.js for those.
- Accuracy and speed numbers in the README carry a device, a browser and a date; do not repeat them for
  another device.
- Every downloaded file is pinned by sha256 (`src/core/models.ts`); a mirror must serve the same bytes.
- `data.text` holds one detected line per line, in reading order. There is no paragraph or table
  analysis yet (one block, one paragraph).
