# Documents, forms and agents

It also turns PDFs, scans and photos into Markdown with tables, JSON or text ([`convert`](#documents--markdown)), fills a JSON Schema from a document with an on-device language model in the browser ([`extract`](#extract-json)), and runs from the command line ([`npx litert-ocr`](#cli)) and as an MCP server for coding agents ([`npx litert-ocr mcp`](#mcp)).

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
- Needs the optional peer dependency `@litert-lm/core@0.19.0`: `npm install @litert-lm/core@0.19.0`, or pass `{ llm: { module } }`. The CORD v2 numbers below were measured with 0.19.0-nightly.20261018. On 0.19.0 the browser tests pass (Chrome on a Mac, 2026-11-11). 0.18.1 cannot create an engine ([LiteRT-LM issue #4051](https://github.com/google-ai-edge/LiteRT-LM/issues/4051)).
- The first call downloads the model, 2.0 GB (2,008,432,640 bytes, `gemma-4-E2B-it-web.litertlm` from Hugging Face litert-community/gemma-4-E2B-it-litert-lm at a pinned commit), into the browser cache; the logger says so, and later calls read the cache. `createExtractor()` keeps the model loaded for several documents.
- On a phone, memory is the limit. In Chrome on a Pixel 8a (8 GB, 2026-11-11, one call in a fresh tab) a test receipt came back as valid JSON in 3 of 8 runs on LiteRT-LM JS 0.19.0 and 6 of 6 on the earlier 0.19.0-nightly.20261018. In the other 5 runs no answer came back: 3 times the page died, once `extract()` rejected with `LLM_FAILED` (a WebGPU error), and once nothing had come back when the run was stopped after 15 minutes. If the tab's own process dies, the page is gone and no error can reach it.

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

Claude Desktop and project `.mcp.json` files take the same `mcpServers` entry: [`examples/mcp`](../examples/mcp).
