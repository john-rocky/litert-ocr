# litert-ocr

OCR for photos and screenshots in the browser and in Node.js, with the tesseract.js API. It runs PP-OCRv6-Small on LiteRT.js. On a Mac Studio (Apple M4 Max) in Chrome 155 an image takes 318 ms (median of 10 English and Japanese screenshots, photos and receipts, 2026-10-20).

In the browser the text detector runs on WebGPU when the browser has it and the recognizer on WebAssembly, inside a Web Worker. (In Safari, where WebAssembly has one thread, the recognizer can move to WebGPU once the rewritten 320-wide recognizer is published or given as a file: [below](#safari-and-webgpu).) In Node.js, Deno and Bun everything runs on WebAssembly in a worker thread. Images never leave the device. Independent project, not affiliated with Google or PaddlePaddle.

It also turns PDFs, scans and photos into Markdown with tables, JSON or text ([`convert`](#documents--markdown)), fills a JSON Schema from a document with an on-device language model in the browser ([`extract`](#extract-json)), and runs from the command line ([`npx litert-ocr`](#cli)) and as an MCP server for coding agents ([`npx litert-ocr mcp`](#mcp)).

Try it on your own photo, scan or PDF: [the demo](https://mlboydaisuke-litert-ocr.static.hf.space/) (a Hugging Face Space, at its own address) reads it in the browser tab and shows the text with its line boxes, a PDF's page with a frame around each block, Markdown and JSON ([`demo/`](demo)). The same page is on [the Space's page on huggingface.co](https://huggingface.co/spaces/mlboydaisuke/litert-ocr), inside a frame (there Chrome on a Galaxy S26 read more slowly and Safari on an iPhone could not keep the model files), and on [GitHub Pages](https://john-rocky.github.io/litert-ocr/).

Status: v0. Tested in Node.js 24, Deno 2.9 and Bun 1.4, and in these browsers (2026-10-20; 12 images: 6 English and Japanese screenshots, 3 photos of English text, 2 receipts and a 4032 x 3024 photo with Japanese text; time = from handing over the image file to the text, with the model already loaded; median of the 10 images that needed no extra model download):

| Browser, device | Detector / recognizer | WebAssembly threads | Time per image | Text lines identical to Chrome on the Mac |
|---|---|---|---|---|
| Chrome 155, Mac Studio (Apple M4 Max) | WebGPU / WebAssembly | 12 | 318 ms | 335 of 335 |
| WebKit 26.5 (Safari's engine, Playwright's build), same Mac | WebGPU / WebAssembly | 1 | 1,823 ms | 287 of 335 |
| WebKit 26.5, recognizer on WebGPU with the rewritten 320 file ([below](#safari-and-webgpu); not the default until it is published) | WebGPU / WebGPU | 1 | 249 ms | 287 of 335 |
| Chrome 155, Galaxy S26 | WebGPU / WebAssembly | 8 | 722 ms (CPU slowed by heat) | 335 of 335 |
| Chrome 155, Pixel 8a | WebGPU / WebAssembly | 9 | 3,563 ms (CPU slowed by heat) | 335 of 335 |

Both phones lowered their CPU clocks for heat while reading: the Galaxy S26 from the third image on, the Pixel 8a slightly from the second. WebKit differs from Chrome in 48 of the 335 lines (spacing or characters); the difference comes from how it turns the image file into pixels, not from the model (Chrome reads the same 335 lines with the 1-thread WebAssembly build WebKit uses). Safari itself (on a Mac or an iPhone) and Firefox are not tested yet; the WebKit rows use Playwright's WebKit build.

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

`require('litert-ocr')` works too (tested with Node.js 24; Node.js loads ES modules from CommonJS since 20.19 and 22.12).

What differs:

| | tesseract.js 7 | litert-ocr |
|---|---|---|
| Languages | one data file per language (`'eng'`, `'jpn'`, `'eng+jpn'`) | one model reads Latin-script, Greek, Chinese and Japanese text. `langs` is checked (a script the model cannot read rejects) but does not change the model. Korean, Cyrillic, Arabic, Hebrew, Thai and Indic scripts are not covered: `createWorker('kor')` rejects with `LANG_NOT_SUPPORTED` |
| `oem`, `corePath`, `langPath`, `legacyCore`, `gzip` | engine and data options | accepted and ignored (the path options get a notice) |
| `setParameters` | every Tesseract parameter | `tessedit_char_whitelist`, `tessedit_char_blacklist`, and `tessedit_pageseg_mode` `SINGLE_LINE` / `SINGLE_WORD` / `RAW_LINE` / `SINGLE_CHAR` (read the image as one line, no detection). Others are ignored; the result lists them |
| Output | `text`, `blocks`, `hocr`, `tsv`, `box`, `unlv`, `osd`, `pdf`, images | `text`, `blocks`, `hocr`, `tsv`. The other formats are `null` |
| Layout | Tesseract's blocks and paragraphs | one block with one paragraph; one line per detected text line, in reading order (top to bottom, left to right). A table row or a label and its value can come out as separate lines |
| Word and symbol boxes | from Tesseract's segmentation | from the recognizer's output positions along the line (approximate) |
| Rotated text | `rotateAuto` | tall lines (vertical text) are turned and read; upside-down text is not. `rotateAuto` / `rotateRadians` are ignored |
| `detect()` | orientation and script detection | not supported (rejects with `INVALID_ARGUMENT`) |
| Node.js image formats | bmp, jpg, png, pbm, webp, gif | PNG and JPEG (decode others first, or pass `{ data, width, height }`). Browsers read every format they can decode |
| Files on first use | core WebAssembly and language data | the LiteRT.js runtime and the model (sizes below), cached |

## Documents → Markdown

```js
import { convert } from 'litert-ocr';

const { content, document } = await convert(file, { to: 'md' }); // 'md' (default), 'json' or 'text'
```

`file` is a PDF (a URL, `File` / `Blob`, `ArrayBuffer` / `Uint8Array`, or a path in Node.js) or any image `recognize()` takes. Each page is read the cheapest way that works:

- A page with a text layer is read from it with pdf.js. No model is loaded.
- A page without one (a scan, an image-only PDF page) and an image are read by OCR: the page is turned straight (skew up to 2 degrees), its text lines are read, and the lines are cut into headings, paragraphs, lists and tables, by a page layout model (docling-layout-heron) or by the geometry of the lines alone.
- Both end in the same Markdown: `#` headings, paragraphs, `- ` list items, GFM tables. Several pages are separated by `<!-- page N -->` lines.
- A list item is a line that starts with a bullet or a number. Bullets that a PDF draws as shapes rather than text (Chrome's print does) are not in its text layer, so such a list comes out as one paragraph.

`document` holds every page with a `status`: `'ok'`, `'empty'` (nothing found) or `'failed'` (with `reason` and `code`). A page that fails does not stop the others: the rest of the document comes back. Per page also `engine` (`'layer'` or `'ocr'`), `layout` (`used`: `'model'` or `'geometry'`, and why the model was not used), `blocks` (`type`: heading, paragraph, list_item or table; `text`; `bbox` in page pixels; heading `level`), `tables` (`rows` of cell texts), `markdown`, `text` and `ms`. PDF pages are measured in pixels at 150 dpi.

Options: `pages` (`'1-3'`, `'1,4,7-9'`, `'5-'`), `engine` (`'auto'`: the text layer where a page has one, else OCR; `'layer'`; `'ocr'`), `layout` (`'auto'`, `'model'`, `'geometry'`), `password`, `maxPages` (default 100; a longer selection rejects with `DOC_TOO_MANY_PAGES`). `toMarkdown(file, options)` returns the Markdown string. `createConverter(options)` keeps its OCR worker and models between files: `convert`, `toMarkdown`, `terminate`.

The layout model is not published yet (its files are listed in `modelInfo.layout`, status `upload pending`): until it is, pages are laid out by geometry unless you pass `layoutModelBase`, a directory URL (browser) or path (Node.js) holding its files. With it, `layout: 'auto'` runs the model where it is cheap: on WebGPU in a browser that has it (87.7 MB of fp16 weights), on WebAssembly in Node.js (173.1 MB of fp32 weights); a browser without WebGPU uses geometry, or the WebAssembly form with `layout: 'model'`. `layoutBackend: 'wasm'` keeps the model on WebAssembly in any browser.

PDFs are read by pdf.js (pdfjs-dist 6.4.299). The browser build loads it from jsDelivr when the first PDF arrives (pinned and checked by sha256; `pdfjsPath` to serve it yourself). In Node.js it is a dependency and needs Node.js 22.13 or newer; drawing a page without a text layer needs `@napi-rs/canvas` (an optional dependency, installed by default).

Measured on a test set made for this (2026-10-20; Mac Studio, Apple M4 Max; Chrome 155 headless; the layout model from local files): 24 A4 pages written for the test (11 in English, 13 in Japanese; one and two columns; tables with full rules, top and bottom rules, or none; headings and lists; public-domain prose), each as a printed PDF, a 150 dpi image of it and a scan of that image (turned up to 2 degrees, uneven light, noise, JPEG), and 20 pages of DocLayNet (manuals, patents, laws).

- Text error = edit distance between the page's text and the reference, divided by the longer length (0 = exact).
- Tables = how many of the 8 tables per language came out with the right number of rows and columns, and the share of cells read exactly.
- DocLayNet = share of its reference text not found in the output, order ignored (it has no reading order or table structure; a page without a text layer counts as empty on the text-layer row).
- Time = from handing over the file to the result, with the model loaded; median per page.

| Path | Input | Text error EN / JA | Tables right shape EN / JA | Exact cells EN / JA | DocLayNet text missed | Time per page |
|---|---|---|---|---|---|---|
| text layer | printed PDF | 0.003 / 0.096 | 7 / 7 of 8 | 95 % / 85 % | 0.122 | 43 ms |
| OCR + geometry | 150 dpi image | 0.007 / 0.059 | 7 / 7 of 8 | 93 % / 83 % | 0.186 | 359 ms |
| OCR + geometry | scan | 0.010 / 0.055 | 7 / 7 of 8 | 92 % / 83 % | | 398 ms |
| OCR + layout model on WebGPU | 150 dpi image | 0.064 / 0.004 | 4 / 7 of 8 | 65 % / 93 % | 0.193 | 430 ms |
| OCR + layout model on WebGPU | scan | 0.020 / 0.003 | 5 / 7 of 8 | 81 % / 93 % | | 465 ms |
| OCR + layout model on WebAssembly (Chrome without WebGPU) | scan | 0.016 / 0.003 | 5 / 7 of 8 | 80 % / 93 % | 0.193 | 688 ms |

Where pages went wrong: on a short Japanese two-column page geometry did not find the columns (column detection wants columns over a quarter of the page height) and read both columns as one table (text error 0.62 to 0.75), on the text layer also on a second Japanese two-column page (0.59); on a short English two-column page, table cells that wrap onto two lines in the narrow column came out out of order. The layout model separated the Japanese columns (0.004), but on one English letter its overlapping regions put the paragraphs out of order (0.55 on that page), and it lost the shape of all three borderless key-and-value tables (and of one ruled table on one image). So on this test geometry was the better choice for the English pages and the tables, the layout model for the Japanese two-column page; `layout` picks per call. The first time, the text-layer path downloads 1.9 MB (pdf.js and this library), OCR with geometry 86.9 MB (runtime and all five OCR model files), OCR with the layout model 174.6 MB on WebGPU and 259.9 MB on WebAssembly (counted from a local server, uncompressed).

## Extract JSON

```js
import { extract } from 'litert-ocr/extract';

const schema = {
  type: 'object',
  properties: { store_name: { type: 'string' }, items: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, price: { type: 'string' } } } }, total: { type: 'string' } },
  required: ['items', 'total'],
};
const { data, valid, errors } = await extract(receiptImage, schema, {
  documentType: 'receipt',
  instructions: 'Copy every value exactly as printed on the receipt. Use one entry in "items" per purchased item line. Leave out a field that is not on the receipt.',
});
```

The document is read by OCR (a PDF: its text), the lines are laid out in rows, and Gemma 4 E2B (its web build) on LiteRT-LM JS answers with a JSON object for the schema. The answer is repaired only by removing a code fence, the text around the object and trailing commas, then checked against the schema (types, required fields, `enum`): `valid` and `errors` say how it went, `raw` holds the answer as it came.

- Browser only, with WebGPU. In Node.js `extract()` rejects with `LLM_UNAVAILABLE`.
- Needs the optional peer dependency `@litert-lm/core@0.19.0-nightly.20261018`: `npm install @litert-lm/core@0.19.0-nightly.20261018`, or pass `{ llm: { module } }`. It is a nightly because the current stable release, 0.18.1, cannot create an engine ([LiteRT-LM issue #4051](https://github.com/google-ai-edge/LiteRT-LM/issues/4051)); this moves to the stable release that fixes it.
- The first call downloads the model, 2.0 GB (2,008,432,640 bytes, `gemma-4-E2B-it-web.litertlm` from Hugging Face litert-community/gemma-4-E2B-it-litert-lm at a pinned commit), into the browser cache; the logger says so, and later calls read the cache. `createExtractor()` keeps the model loaded for several documents.

On 74 receipts of the CORD v2 test set, with `documentType: 'receipt'` and the `instructions` shown above (the default instructions are shorter and were not measured), the answer parsed as JSON for 74 of 74 and 440 of 687 fields (64.0 %) matched the reference (item names, quantities and prices, subtotal, tax, total). The model took 2.0 s per receipt, 2.1 s with the OCR (medians; Mac Studio, Apple M4 Max, Chrome 155 headless, LiteRT-LM JS 0.19.0-nightly.20261018, 2026-10-20).

## CLI

```sh
npx litert-ocr report.pdf > report.md
npx litert-ocr scan.jpg invoice.pdf --json --out converted/
```

| Option | |
|---|---|
| `--md`, `--json`, `--text` | output format (default `--md`) |
| `--pages 1-3` | pages to read (`1-3`, `1,4,7-9`, `5-`) |
| `--engine auto\|layer\|ocr` | as `engine` above |
| `--layout auto\|model\|geometry` | as `layout` above (Node.js runs the model on WebAssembly) |
| `--out DIR` | write `<name>.md` / `.json` / `.txt` into DIR instead of stdout |
| `--timings` | per-page milliseconds on stderr |
| `--password P`, `--max-pages N` | an encrypted PDF; the page limit (default 100) |
| `--model-base DIR`, `--layout-model-base DIR` | model files from a directory |

Exit code: `0` every page read, `2` an input could not be read, `3` some page came back empty or failed (named on stderr and in the JSON `pages[].status`), `1` a usage error. Models download once into `~/.cache/litert-ocr` (or `$XDG_CACHE_HOME/litert-ocr`). Files never leave the machine.

On the same Mac with Node.js 24.4.1 (2026-10-20, the 24 test pages above, one process per format, median per file of one page): a printed PDF (text layer) 18 ms; an image-only PDF 532 ms with `--layout geometry` and 821 ms with the layout model on WebAssembly; a scanned JPEG with the layout model 800 ms. Text error and tables as in the table above for the same path (image-only PDF with the layout model: 0.019 / 0.009). The first run downloads the model files and the runtime, 77.3 MB, into the cache; the layout model adds 173.1 MB once it is published (read from `--layout-model-base` here). The first page of that run took 8.7 s, downloads included.

## MCP

`npx litert-ocr mcp` is an MCP server over stdio with four read-only tools:

| Tool | Arguments | Returns |
|---|---|---|
| `convert_to_markdown` | `uri` (`file:`, `data:` or a path; `http(s):` only when started with `--allow-http`) | Markdown; the same name and contract as MarkItDown's MCP tool |
| `convert` | `uri`, `to` (`md` / `json` / `text`), `options` (`pages`, `engine`, `layout`, `password`) | the document as Markdown, JSON or text |
| `ocr_image` | `uri`, `lang` | `{ text, lines: [{ text, bbox }] }` |
| `list_input_formats` | none | the formats and URI schemes the tools read |

```sh
claude mcp add litert-ocr -- npx -y litert-ocr mcp
```

Claude Desktop and project `.mcp.json` files take the same `mcpServers` entry: [`examples/mcp`](examples/mcp).

## What it reads

PP-OCRv6-Small (Hugging Face [litert-community/PP-OCRv6-Small-LiteRT](https://huggingface.co/litert-community/PP-OCRv6-Small-LiteRT)): a text detector (640 x 640 input) and a recognizer whose vocabulary has 18,710 entries: Latin letters with Latin-1 and Latin Extended-A accents, Greek, kana and 15,565 Chinese characters. English and Japanese photos and screenshots are what was measured (below); other covered languages are not measured here.

Each detected line is read upright: the image is stretched to 640 x 640 for detection, each line is cut out along its box (tall lines are turned a quarter turn) and read at a height of 48 pixels. Lines the recognizer is not sure of (mean character probability under 0.5) are dropped.

## Speed and accuracy

Measured on a Mac Studio (Apple M4 Max), Chrome 155 headless, detector on WebGPU, recognizer on WebAssembly with 12 threads. Time (2026-10-20) = from handing over the image file to the text, with the model loaded. Character error rate (2026-10-19, measured with the test harness this library was built from; the library returns the same lines and boxes on all 295 images, checked 2026-10-20) = the edits between the lines read and the reference lines, matched by their boxes, per reference character; lower is better.

| Images | Count | Median time | Character error rate |
|---|---|---|---|
| English photos (TextOCR validation set) | 68 | 84 ms | 0.267 |
| Japanese photos of signs (JaWildText) | 24 | 362 ms | 0.305 |
| English screenshots (rendered for this test) | 44 | 327 ms | 0.006 |
| Japanese screenshots (rendered for this test) | 50 | 338 ms | 0.014 |
| Receipts (CORD) | 74 | 133 ms | 0.100 |
| English book pages (typeset, A4 150 dpi) | 20 | 885 ms | 0.008 |
| Japanese book pages (typeset, A4 150 dpi) | 15 | 893 ms | 0.003 |

First and second visit (2026-10-20, same Mac and Chrome; the model from Hugging Face and the runtime from jsDelivr, as by default; time = from opening the page to the first text):

| Image | First visit (nothing cached) | Downloaded before the first text | Second visit (cached) |
|---|---|---|---|
| Phone screenshot, 390 x 800 | 5.5 s | 58 MB | 0.9 s |
| Chat screenshot, 900 x 800 (long lines: needs the 640 and 960 recognizers) | 6.2 s | 80 MB | 1.5 s |
| Same two with `eager: true` (all five model files at start) | 5.0 s / 5.1 s | 80 MB | 1.0 s / 1.2 s |

After the first text the browser downloads the recognizers it has not needed yet ([Offline](#offline)): for the phone screenshot the 960-wide one, 21.5 MB, and every model and runtime file was in the cache 1.5 s after the first text (Chrome 155 headless, one run, 2026-10-21).

The browser needs cross-origin isolation for WebAssembly threads: serve the page with

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Without these headers OCR still works, on one thread (several times slower), and the logger and the console say so. When you cannot set headers (GitHub Pages), [coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker) sets them from a service worker. `worker.info` reports where the worker runs: `{ detector, recognizer, recognizers, recognizerReason, recognizerCheck, threads, runtime, model, platform }`.

### Safari and WebGPU

Safari has no WebAssembly relaxed SIMD, which the threaded LiteRT.js build needs, so there WebAssembly runs on 1 thread (WebKit 26.5: 1,823 ms per image against 318 ms in Chrome on the same Mac, table above). The recognizer could run on WebGPU instead, but the published 320-wide recognizer misreads lines there: with LiteRT.js 2.5.3, 376 of 496 test lines read the same as on WebAssembly (Apple M4 Max, Chrome 155, 2026-10-19), the fault reported for PP-OCRv5 in [LiteRT issue #9661](https://github.com/google-ai-edge/LiteRT/issues/9661). A rewritten 320-wide file (`modelInfo.rec320WebGpu`: the attention scores computed in two halves; on WebAssembly it gives exactly the numbers of the published file) reads the same on WebGPU as on WebAssembly on an Apple M4 Max: all 295 test images in Chrome 155, and the 12 images of the table in WebKit 26.5, where it took 249 ms per image, 0.14 times the WebAssembly time. The published 640 and 960 files read the same on WebGPU on that Mac. The rewritten file is not on Hugging Face yet.

`recognizer: 'auto'` (the default) uses it. Where WebAssembly has 1 thread, a WebGPU device exists and that file is available (published, or given as `modelFiles.rec320`), the worker reads one fixed text line on WebAssembly and on WebGPU at start and moves the recognizer to WebGPU only if every output step is the same; each wider recognizer is checked the same way when it first loads. With that file given, WebKit 26.5 chose WebGPU this way and read the 12 images in 267 ms per image, with the same text as on WebAssembly (2026-10-21). The check reads one line, so it is a coarse guard: given the published 320 file instead (which misreads lines on WebGPU), it saw the difference in Chrome 155 on the Mac (2 of 40 output steps) but not in WebKit 26.5, where that line read the same. Where WebAssembly has threads (Chrome with the two headers above) the recognizer stays on WebAssembly. `worker.info.recognizerReason` and a logger notice say what was chosen and why. On phones WebGPU is not always the better place: in Chrome 155 on a Galaxy S26 the WebGPU recognizer read 13 of 335 lines differently and took longer (843 against 722 ms per image), on a Pixel 8a it read the same text in 0.70 times the time (2026-10-20). The detector reads the same on WebGPU and WebAssembly.

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
| `ppocrv6_small_rec_320_fp32_webgpu.tflite` (the 320-wide recognizer for WebGPU, [above](#safari-and-webgpu)) | 21,517,364 | in place of the published 320 file where `recognizer: 'auto'` may use WebGPU (not published yet: `modelFiles.rec320`) |
| pdf.js 6.4.299 (`build/pdf.min.mjs` + `build/pdf.worker.min.mjs`, from jsDelivr) | 1,723,246 | browser: the first PDF given to `convert()` (Node.js uses the installed package) |
| layout model, WebGPU form (`heronA_es_fp16w.tflite` + `heronB_es_fp16w.tflite` + `heron_host.bin`) | 87,698,160 | the first OCR page of `convert()` with the layout model on WebGPU (not published yet: `layoutModelBase`) |
| layout model, WebAssembly form (`heronA_es.tflite` + `heronB_es.tflite` + `heron_host.bin`) | 173,054,412 | the same on WebAssembly (Node.js, or `layout: 'model'` without WebGPU) |

Options for where the files come from:

- `modelBase`: a directory URL (browser) or path (Node.js) with the five model files under their Hub names (`modelInfo.files`; once published, also `modelInfo.rec320WebGpu` for the browsers where the recognizer may run on WebGPU). The files must match the pinned sha256.
- `wasmPath`: a directory URL with the LiteRT.js 2.5.3 `wasm/` files (`node_modules/@litertjs/core/wasm/`).
- `modelFiles`: replace single files, `{ rec320: { url, sha256 } }`; without `sha256` the file is used unverified (a notice says so). For trying other model files.
- `eager: true`: load all five model files at start.
- `prefetch`: in a browser (default `true`) the model files not loaded yet go into the cache in the background after the first result ([Offline](#offline)); in Node.js, Deno and Bun the default is `false`.
- `cacheMethod`: `'write'` (default), `'readOnly'`, `'refresh'`, `'none'`, as in tesseract.js.

## API

```js
import { createWorker, createScheduler, recognize, PSM, OEM, OcrError, modelInfo } from 'litert-ocr';
```

- `createWorker(langs?, oem?, options?)` → `Promise<Worker>`. Options: `logger`, `errorHandler`, `modelBase`, `modelFiles`, `wasmPath`, `workerPath`, `backend` (`'auto'` = detector on WebGPU when it compiles, the browser default; `'wasm'`, the Node.js default), `recognizer` (below), `eager`, `prefetch`, `cachePath`, `cacheMethod`.
- `recognizer`: `'auto'` (default; [Safari and WebGPU](#safari-and-webgpu)), `'wasm'` (always WebAssembly), or `'webgpu'` (experimental: the 640 and 960 recognizers on WebGPU, the 320 one only with `modelFiles.rec320`, no check). `worker.info.recognizers` shows where each width runs, `worker.info.recognizerReason` why, `worker.info.recognizerCheck` the start check of `'auto'` (`{ width, steps, differing, ms, text }`, or `null`).
- `worker.recognize(image, options?, output?, jobId?)` → `{ jobId, data }`. `image`: a URL or data URL, `File`, `Blob`, `<img>`, `<canvas>`, `CanvasRenderingContext2D`, `OffscreenCanvas`, `ImageBitmap`, `ImageData`, an `ArrayBuffer` / `Uint8Array` / `Buffer` of an image file, `{ data, width, height }` (RGBA), and in Node.js a file path. `options.rectangle = { left, top, width, height }` reads only that region (boxes stay in whole-image pixels). `output` defaults to `{ text: true }`; add `blocks: true`, `hocr: true`, `tsv: true`.
- `data.text`: the lines, each ending in `"\n"`. `data.confidence`: mean word confidence, 0-100. `data.blocks` (when asked): `blocks[].paragraphs[].lines[].words[].symbols[]`, each with `text`, `confidence` (0-100) and `bbox { x0, y0, x1, y1 }`.
- `worker.setParameters(params)`, `worker.terminate()` (a second call resolves and does nothing), `worker.reinitialize()` (no-op), `worker.info`.
- `createScheduler()` with `addWorker`, `addJob('recognize', ...)`, `getQueueLen`, `getNumWorkers`, `terminate`. `recognize(image, langs, options)` creates, uses and terminates a worker (deprecated in tesseract.js, kept for old code).
- `logger` receives `{ workerId, jobId, userJobId, status, progress }` with `status` `'loading runtime'`, `'loading model'`, `'initializing model'`, `'initialized'` (its `message` names the backends and the thread count), `'recognizing text'`, `'caching model'` ([Offline](#offline)), and `'notice'` (with `message`: a fallback taken, an option ignored, an image resized, an image file cut short, where the recognizer runs). The loading and caching messages carry `file`, `loaded`, `total` and `fromCache`: `file` is the file whose bytes just arrived. In `'loading model'` and `'caching model'`, `loaded` and `total` count all the files of that step together (the three model files loaded at start are one step, 34 MB), so `progress` moves once from 0 to 1 per step; `'loading runtime'` counts each runtime file on its own.

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

## Examples

- [`examples/html`](examples/html): plain HTML with the CDN import (`node serve.mjs` serves it with the two headers).
- [`examples/react-vite`](examples/react-vite): React with Vite.
- [`examples/nextjs`](examples/nextjs): Next.js App Router; the library is imported inside `useEffect` of a client component, never on the server.
- [`examples/pdf-to-markdown`](examples/pdf-to-markdown): a PDF, scan or photo to Markdown, JSON or text in the browser (`index.html`), and the same for files in Node.js (`convert.mjs`).
- [`examples/mcp`](examples/mcp): the MCP server's configuration for Claude Code and Claude Desktop.

## Tests

`npm install && npm run build && npm test` runs:

- the Node.js tests;
- the browser tests with the failure paths in headless Chrome (with WebGPU and without it) and in WebKit, the engine of Safari (Playwright's build: WebAssembly on 1 thread);
- the tesseract.js README example with the import changed (Node.js ESM and CommonJS, and the browser);
- Deno and Bun smoke tests when they are installed;
- the document tests: `convert()` in Node.js and in the browser, the `litert-ocr` command, and the MCP server driven by the MCP SDK client (the document inputs are made by `test/fixtures/make-pdfs.mjs`).

Optional environment variables add the cases that need files not published yet: `LITERT_OCR_TEST_REC320` and `LITERT_OCR_TEST_REC320_SHA256` (the WebGPU form of the 320-wide recognizer, for the recognizer cases), `LITERT_OCR_LAYOUT_BASE` (a directory with the layout model files) and `LITERT_OCR_TEST_LLM` (the Gemma 4 E2B web model file, for one `extract()` run).

`node test/examples.mjs` builds the examples and reads one image in each (a PDF and a scan in `pdf-to-markdown`), and starts the MCP example's configuration and converts a PDF through it.

## License

Apache License 2.0. See [NOTICE](NOTICE) for the parts copied from google-ai-edge/litert-samples and for the model and runtime licenses.
