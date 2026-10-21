# Demo: photo, scan or PDF to text, Markdown and JSON

A page that reads your own files with litert-ocr in the browser tab: https://john-rocky.github.io/litert-ocr/

- **Photos and screenshots**: every text line, framed on the image, in reading order (`worker.recognize()`).
- **PDFs and scans**: Markdown with headings, lists and tables (`convert()`). A page with a text layer is read from it; a scanned page is read by OCR.
- **JSON**: the document structure that `convert(file, { to: 'json' })` returns: pages, blocks with their type and box, tables as rows of cells.

Your files are read in the tab and are not uploaded. The page downloads the litert-ocr library and pdf.js from jsDelivr and the model files from Hugging Face, once; the browser keeps them for later visits.

## Use it with your own files

1. Open the page and wait for **Ready** (the first visit downloads the model; later visits read it from the browser's cache).
2. Choose a photo or a PDF with the button (on a phone: the camera, the gallery or your files), drop a file on the page, or paste a screenshot (Ctrl+V / ⌘V).
3. Read the result in the **Text**, **Markdown** and **JSON** tabs; **Copy** and **Download** take the tab you are on. For a photo, the Markdown and JSON tabs run `convert()` the first time you open them.

The time shown is from handing the file to the library to the result, with the model already loaded. This page reads up to 20 pages of a PDF (the library reads up to `maxPages`, 100 by default). The model reads Latin-script text (with accents), Greek, Chinese and Japanese; Korean, Cyrillic, Arabic, Hebrew, Thai and Indic scripts are not covered. The four examples under the button are described in [examples/SOURCES.md](examples/SOURCES.md).

When something cannot be read, the page says why and the next file still works: a file that is not a PDF or an image, an image cut short, an image with no text, a damaged PDF, a PDF with a password (the page asks for it), a PDF longer than 20 pages (the first 20 are read), a browser without WebGPU (the detector runs on WebAssembly), and a browser that does not allow cross-origin isolation (WebAssembly runs on 1 thread, several times slower).

## Run it on your machine

No build step. From the repository root:

```sh
node demo/record/serve.mjs          # http://localhost:8080/
```

`serve.mjs` serves `demo/` the way GitHub Pages does: no `Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy` headers and Pages' caching headers. [`coi-serviceworker.js`](coi-serviceworker.js) turns on cross-origin isolation from a service worker (it reloads the page once on the first visit), so WebAssembly runs with threads. A service worker needs a secure context: open the page on `localhost` or over https. Any other static server works the same way.

## How the page is made

- [`app.js`](app.js): the page. It loads `https://cdn.jsdelivr.net/npm/litert-ocr@0.1.0/+esm`, starts one worker with `createWorker('eng', 1, { eager: true })` for images (all five model files at start, so a read never waits for a recognizer to load) and one converter with `createConverter({ eager: true, layout: 'geometry' })` for documents (it finds the files in the cache, and reads a blank one-page PDF first, so pdf.js is loaded before the first PDF), and reads one file at a time.
- [`md.js`](md.js): draws the Markdown that `convert()` writes; every piece of text is set as text, never as HTML.
- [`coi-serviceworker.js`](coi-serviceworker.js): coi-serviceworker 0.1.7 (MIT), with one addition marked in the file: the service worker keeps a copy of the page's own files and of the pinned library module and answers from it when there is no network.

## Record tools

[`record/`](record) holds the tools that check the page and film it, driving it the way a person does (the file button and the browser's file chooser). Run them from the repository root after `npm install`; they write to `demo/record/out/` unless given `--out`.

| Tool | What it does |
|---|---|
| `make-inputs.mjs` | Draws `examples/inventory-scan.pdf` (with `--examples`) and the files of the failure checks |
| `serve.mjs` | Serves `demo/` without the isolation headers, as GitHub Pages does |
| `check.mjs` | Every example through the page against the library called directly (`direct.html`, same options): the same text lines, Markdown and JSON; `--repeat N` more runs of the photo and the scan; `--failures DIR` the failure paths, each followed by a file that must read; `--variants` Chrome without WebGPU and a browser without service workers |
| `visit.mjs` | First and second visit over the DevTools protocol: time to the first result and bytes over the network of every target (page, workers, service worker), the hosts contacted; `--offline` opens the page again on the same profile with no network |
| `mac-take.mjs` | Films the page in desktop Chrome (1440 x 900, the page only): screenshots of a rehearsal, then, after a go file, the take as an H.264 mp4 at 30 frames per second |
| `android-take.mjs` | The same two screens on an Android phone over adb: the files into the phone's storage, the page loaded once, `--airplane` (opened again with airplane mode on), the phone's file picker scouted without choosing, a wait for a rested phone, then taps on the file button and in the picker under the phone's own screen recording; `--failures DIR` the failure paths on the phone; afterwards the phone is put back as it was. The cut keeps the time from choosing a file to its result as recorded, shortens only the driver's waits to 1.5 s, and paints over the left half of the status bar (other apps' icons) |

Each tool writes a JSON file with every run and the checks it made.
