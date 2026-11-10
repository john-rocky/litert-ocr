# Where it runs, speed and files

## Where it runs

In the browser the text detector runs on WebGPU when the browser has it, inside a Web Worker. The recognizer runs on WebAssembly, and moves to WebGPU for each width whose check passes: one fixed line read both ways when that width loads ([below](#safari-and-webgpu)). In Node.js, Deno and Bun everything runs on WebAssembly in a worker thread. Images never leave the device. Independent project, not affiliated with Google or PaddlePaddle.

Try it on your own photo, scan or PDF: [the demo](https://mlboydaisuke-litert-ocr.static.hf.space/) (a Hugging Face Space, at its own address) reads it in the browser tab and shows the text with its line boxes, a PDF's page with a frame around each block, Markdown and JSON ([`demo/`](../demo)). The same page is on [the Space's page on huggingface.co](https://huggingface.co/spaces/mlboydaisuke/litert-ocr), inside a frame (there Chrome on a Galaxy S26 read more slowly), and on [GitHub Pages](https://john-rocky.github.io/litert-ocr/).

## Tested browsers

Status: v0. Tested in Node.js 24, Deno 2.9 and Bun 1.4, and in these browsers (2026-10-20, litert-ocr before 0.2.1; the 0.2.1 default is measured in [Safari and WebGPU](#safari-and-webgpu); 12 images: 6 English and Japanese screenshots, 3 photos of English text, 2 receipts and a 4032 x 3024 photo with Japanese text; time = from handing over the image file to the text, with the model already loaded; median of the 10 images that needed no extra model download):

| Browser, device | Detector / recognizer | WebAssembly threads | Time per image | Text lines identical to Chrome on the Mac |
|---|---|---|---|---|
| Chrome 155, Mac Studio (Apple M4 Max) | WebGPU / WebAssembly | 12 | 318 ms | 335 of 335 |
| WebKit 26.5 (Safari's engine, Playwright's build), same Mac | WebGPU / WebAssembly | 1 | 1,823 ms | 287 of 335 |
| WebKit 26.5, recognizer on WebGPU with the rewritten 320 file (`recognizer: 'webgpu'`, no check; `'auto'` reaches the same after its check: [below](#safari-and-webgpu)) | WebGPU / WebGPU | 1 | 249 ms | 287 of 335 |
| Chrome 155, Galaxy S26 | WebGPU / WebAssembly | 8 | 722 ms (CPU slowed by heat) | 335 of 335 |
| Chrome 155, Pixel 8a | WebGPU / WebAssembly | 9 | 3,563 ms (CPU slowed by heat) | 335 of 335 |

Both phones lowered their CPU clocks for heat while reading: the Galaxy S26 from the third image on, the Pixel 8a slightly from the second. WebKit differs from Chrome in 48 of the 335 lines (spacing or characters); the difference comes from how it turns the image file into pixels, not from the model (Chrome reads the same 335 lines with the 1-thread WebAssembly build WebKit uses). Safari itself (on a Mac or an iPhone) and Firefox are not tested yet; the WebKit rows use Playwright's WebKit build.

## What it reads

PP-OCRv6-Small (Hugging Face [litert-community/PP-OCRv6-Small-LiteRT](https://huggingface.co/litert-community/PP-OCRv6-Small-LiteRT)): a text detector (640 x 640 input) and a recognizer whose vocabulary has 18,710 entries: Latin letters with Latin-1 and Latin Extended-A accents, Greek, kana and 15,565 Chinese characters. English and Japanese photos and screenshots are what was measured (below); other covered languages are not measured here.

Each detected line is read upright: the image is stretched to 640 x 640 for detection, each line is cut out along its box (tall lines are turned a quarter turn) and read at a height of 48 pixels. Lines the recognizer is not sure of (mean character probability under 0.5) are dropped.

## Speed and accuracy

Measured on a Mac Studio (Apple M4 Max), Chrome 155 headless, with litert-ocr before 0.2.1: detector on WebGPU, recognizer on WebAssembly with 12 threads (with 0.2.1 the recognizer moves to WebGPU there when its check passes: [Safari and WebGPU](#safari-and-webgpu)). Time (2026-10-20) = from handing over the image file to the text, with the model loaded. Character error rate (2026-10-19, measured with the test harness this library was built from; the library returns the same lines and boxes on all 295 images, checked 2026-10-20) = the edits between the lines read and the reference lines, matched by their boxes, per reference character; lower is better.

| Images | Count | Median time | Character error rate |
|---|---|---|---|
| English photos (TextOCR validation set) | 68 | 84 ms | 0.267 |
| Japanese photos of signs (JaWildText) | 24 | 362 ms | 0.305 |
| English screenshots (rendered for this test) | 44 | 327 ms | 0.006 |
| Japanese screenshots (rendered for this test) | 50 | 338 ms | 0.014 |
| Receipts (CORD) | 74 | 133 ms | 0.100 |
| English book pages (typeset, A4 150 dpi) | 20 | 885 ms | 0.008 |
| Japanese book pages (typeset, A4 150 dpi) | 15 | 893 ms | 0.003 |

First and second visit (2026-10-20, litert-ocr before 0.2.1, same Mac and Chrome; the model from Hugging Face and the runtime from jsDelivr, as by default; time = from opening the page to the first text):

| Image | First visit (nothing cached) | Downloaded before the first text | Second visit (cached) |
|---|---|---|---|
| Phone screenshot, 390 x 800 | 5.5 s | 58 MB | 0.9 s |
| Chat screenshot, 900 x 800 (long lines: needs the 640 and 960 recognizers) | 6.2 s | 80 MB | 1.5 s |
| Same two with `eager: true` (all five model files at start) | 5.0 s / 5.1 s | 80 MB | 1.0 s / 1.2 s |

After the first text the browser downloads the recognizers it has not needed yet ([Offline](#offline)): for the phone screenshot the 960-wide one, 21.5 MB, and every model and runtime file was in the cache 1.5 s after the first text (Chrome 155 headless, one run, 2026-10-21).

### Cross-origin headers

The browser needs cross-origin isolation for WebAssembly threads: serve the page with

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Without these headers OCR still works, on one thread (several times slower), and the logger and the console say so. When you cannot set headers (GitHub Pages), [coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker) sets them from a service worker. `worker.info` reports where the worker runs: `{ detector, recognizer, recognizers, recognizerReason, recognizerCheck, recognizerChecks, threads, runtime, model, platform }`.

### Safari and WebGPU

Safari has no WebAssembly relaxed SIMD, which the threaded LiteRT.js build needs, so there WebAssembly runs on 1 thread (WebKit 26.5: 1,823 ms per image against 318 ms in Chrome on the same Mac, table above). The recognizer could run on WebGPU instead, but the plain 320-wide recognizer of the Hugging Face model repository (`ppocrv6_small_rec_320_fp32.tflite`) misreads lines there: with LiteRT.js 2.5.3, 376 of 496 test lines read the same as on WebAssembly (Apple M4 Max, Chrome 155, 2026-10-19), the fault reported for PP-OCRv5 in [LiteRT issue #9661](https://github.com/google-ai-edge/LiteRT/issues/9661). A rewritten 320-wide file (`modelInfo.rec320WebGpu`: the attention scores computed in two halves; on WebAssembly it gives the same numbers as that plain file on every test line) reads the same on WebGPU as on WebAssembly on an Apple M4 Max: all 295 test images in Chrome 155, and the 12 images of the table in WebKit 26.5, where it took 249 ms per image, 0.14 times the WebAssembly time. The 640 and 960 files read the same on WebGPU on that Mac. The rewritten file is in the same Hugging Face repository (`ppocrv6_small_rec_320_fp32_webgpu.tflite`).

`recognizer: 'auto'` (the default) moves a recognizer to WebGPU only after a check. In a browser with a WebGPU device, where that file is available (`modelInfo.rec320WebGpu`, or a file given as `modelFiles.rec320`), the worker reads one fixed text line with the 320-wide recognizer on WebAssembly and on WebGPU at start, and uses WebGPU only if every output step picks the same character and no output probability differs by more than 0.001. Each wider recognizer is checked the same way when it first loads; a width whose check fails stays on WebAssembly, and if the 320-wide check fails, every width does. Since 0.2.1 this includes Chrome with the two headers above (WebAssembly with threads); 0.2.0 checked only where WebAssembly ran on 1 thread. With `backend: 'wasm'` (the Node.js, Deno and Bun default) the recognizers stay on WebAssembly with no check. If WebGPU fails while reading (a lost device), that recognizer moves to WebAssembly and the worker goes on. `worker.info.recognizerReason`, `worker.info.recognizerChecks` and a logger notice say what was chosen and why.

Measured with the default (2026-11-10, litert-ocr 0.2.1):

| Browser | Recognizer 320 / 640 / 960 | Lines as with `recognizer: 'wasm'` | Time per image, default / `'wasm'` |
|---|---|---|---|
| Chrome 157 on a Mac Studio (Apple M4 Max), 281 of the 295 images of the table above | WebGPU / WebGPU / WebGPU | 6,876 of 6,876 | 173 / 276 ms |
| WebKit 26.5 on the same Mac, the 12 images of the table at the top | WebGPU / WebGPU / WebGPU | 333 of 333 | 291 / 1,977 ms |
| Chrome 156 on a Galaxy S26, the same 12 images | WebGPU / WebAssembly / WebGPU | 335 of 335 | 766 / 849 ms |
| Chrome 156 on a Pixel 8a, the same 12 images | WebGPU / WebGPU / WebGPU | 335 of 335 | 2,982 / 3,843 ms |

On the Galaxy S26 the 640-wide check failed all 7 times, so that width ran on WebAssembly there. The Galaxy S26's CPU clock was capped on every image, more in the later `'wasm'` run, so its two times per image are not a like-for-like comparison. A start with the files in the cache, the checks included, took about 0.8 s longer than with 0.2.0 on the two phones and no longer on the Mac. The check reads one line, so it is a coarse guard; the numbers behind this table are in [docs/recognizer-auto.md](https://github.com/john-rocky/litert-ocr/blob/main/docs/recognizer-auto.md).

## Offline

After the first result, the browser build downloads the model files it has not needed yet (the 640 and 960 recognizers, 21.5 MB each) into the cache in the background, so that a later visit reads any image without the network. The logger reports it as `'caching model'` and ends with a message that says whether every model and runtime file is in the cache. The download starts only after a result, so the first text is not delayed; it is skipped when the browser asks to save data (Save-Data) or has no cache, and `prefetch: false` turns it off. `eager: true` loads all five model files at start instead. Measured with the 12 images of the table and the phone screenshot, offline after one visit: 13 of 13 read in Chrome 155 and 13 of 13 in WebKit 26.5 (2026-10-21); before this background download, 7 of 13 in Chrome and 8 of 13 in WebKit (2026-10-20; the others needed the 960-wide recognizer, which had never been stored).

A recognizer file that is still missing offline rejects with `MODEL_FETCH_FAILED`, and the message says to call `createWorker()` once online with `eager: true`. Node.js, Deno and Bun download the 640 and 960 files when a line first needs them (a short process would stop a background download half-way); `prefetch: true` turns the background download on there.

## Model and runtime files

All files are pinned: a fixed revision on Hugging Face and on jsDelivr, each checked by size and sha256 (`src/core/models.ts`, also exported as `modelInfo`). The browser keeps them in the Cache API, Node.js in `~/.cache/litert-ocr` (or `$XDG_CACHE_HOME/litert-ocr`, or `cachePath`).

| File | Bytes | When |
|---|---|---|
| LiteRT.js 2.5.3 runtime (`litert_wasm_threaded_internal.js` + `.wasm`; jsDelivr sends it compressed, about 2.7 MB) | 9,763,309 | at start (browser; Node.js reads it from `node_modules`) |
| `ppocrv6_small_det_640_fp32.tflite` (detector) | 12,380,664 | at start |
| `ppocrv6_small_rec_320_fp32.tflite` (recognizer, lines up to 320 px wide at height 48) | 21,477,068 | at start |
| `characters.json` | 168,510 | at start |
| `ppocrv6_small_rec_640_fp32.tflite` | 21,477,068 | the first time a line is wider than 320 px at height 48; in a browser also in the background after the first result |
| `ppocrv6_small_rec_960_fp32.tflite` | 21,476,976 | the first time a line is wider than 640 px; in a browser also in the background after the first result |
| `ppocrv6_small_rec_320_fp32_webgpu.tflite` (the 320-wide recognizer for WebGPU, [above](#safari-and-webgpu)) | 21,517,364 | at start, in place of the 320 file above, where the recognizer may run on WebGPU: `recognizer: 'auto'` in a browser with a WebGPU device (unless `backend: 'wasm'` is given where WebAssembly has threads), or `'webgpu'` |
| pdf.js 6.4.299 (`build/pdf.min.mjs` + `build/pdf.worker.min.mjs`, from jsDelivr) | 1,723,246 | browser: the first PDF given to `convert()` (Node.js uses the installed package) |
| layout model, WebGPU form (`heronA_es_fp16w.tflite` + `heronB_es_fp16w.tflite` + `heron_host.bin`) | 87,698,160 | the first OCR page of `convert()` with the layout model on WebGPU (not published yet: `layoutModelBase`) |
| layout model, WebAssembly form (`heronA_es.tflite` + `heronB_es.tflite` + `heron_host.bin`) | 173,054,412 | the same on WebAssembly (Node.js, or `layout: 'model'` without WebGPU) |

Options for where the files come from:

- `modelBase`: a directory URL (browser) or path (Node.js) with the five model files under their Hub names (`modelInfo.files`, and `modelInfo.rec320WebGpu` for the browsers where the recognizer may run on WebGPU). The files must match the pinned sha256. A directory made for litert-ocr 0.1.0 has no `ppocrv6_small_rec_320_fp32_webgpu.tflite`: with `recognizer: 'auto'` the worker then reads with the plain 320 file on WebAssembly, and a `'warn'` notice says the WebGPU form could not be loaded; `recognizer: 'webgpu'` fails with `MODEL_FETCH_FAILED`. Add the file to let the recognizer run on WebGPU.
- `wasmPath`: a directory URL with the LiteRT.js 2.5.3 `wasm/` files (`node_modules/@litertjs/core/wasm/`).
- `modelFiles`: replace single files, `{ rec320: { url, sha256 } }`; without `sha256` the file is used unverified (a notice says so). For trying other model files.
- `eager: true`: load all five model files at start.
- `prefetch`: in a browser (default `true`) the model files not loaded yet go into the cache in the background after the first result ([Offline](#offline)); in Node.js, Deno and Bun the default is `false`.
- `cacheMethod`: `'write'` (default), `'readOnly'`, `'refresh'`, `'none'`, as in tesseract.js.
