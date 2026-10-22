# Demo: photo, scan or PDF to text, Markdown and JSON

A page that reads your own files with litert-ocr in the browser tab: https://huggingface.co/spaces/mlboydaisuke/litert-ocr (a Hugging Face Space, which sends the isolation headers itself), and the same page on GitHub Pages: https://john-rocky.github.io/litert-ocr/

- **Photos and screenshots**: every text line, framed on the image, in reading order (`worker.recognize()`).
- **PDFs and scans**: Markdown with headings, lists and tables (`convert()`). A page with a text layer is read from it; a scanned page is read by OCR.
- **JSON**: the document structure that `convert(file, { to: 'json' })` returns: pages, blocks with their type and box, tables as rows of cells.

Your files are read in the tab and are not uploaded. The page downloads the litert-ocr library, its LiteRT.js runtime and pdf.js from jsDelivr, and the model files from Hugging Face, once, and the browser keeps them. Measured in Chrome 155 (headless) on a Mac Studio (Apple M4 Max), 2026-10-22, three fresh Chrome profiles: the first visit downloaded 80.2 MB and showed the first result 5.7 s after the page was opened (median); a second visit downloaded nothing and took 1.3 s; with the network gone (no host name resolving, the page's server stopped), the page opened again and read a photo and a PDF.

In Chrome 155 on a Galaxy S26 (Android 16, 2026-10-22), a page opened while online went on reading a photo and a PDF after airplane mode was turned on. Opening the page again in airplane mode did not work there: Chrome served its stored copy of the page without the service worker, so WebAssembly threads were off, and the single-thread runtime file, which the first visit never needed, could not be downloaded (`MODEL_FETCH_FAILED`).

## Use it with your own files

1. Open the page and wait for **Ready** (the first visit downloads the model; later visits read it from the browser's cache).
2. Choose a photo or a PDF with the button (on a phone: the camera, the gallery or your files), drop a file on the page, or paste a screenshot (Ctrl+V / ⌘V).
3. Read the result in the **Text**, **Markdown** and **JSON** tabs; **Copy** and **Download** take the tab you are on. For a photo, the Markdown and JSON tabs run `convert()` the first time you open them.

The time shown is from handing the file to the library to the result, with the model already loaded. This page reads up to 20 pages of a PDF (the library reads up to `maxPages`, 100 by default). The model reads Latin-script text (with accents), Greek, Chinese and Japanese; Korean, Cyrillic, Arabic, Hebrew, Thai and Indic scripts are not covered. The four examples under the button are described in [examples/SOURCES.md](examples/SOURCES.md).

When something cannot be read, the page says why and the next file still works:

- a file that is not a PDF or an image
- an image cut short
- an image with no text
- a damaged PDF
- a PDF with a password: the page asks for it
- a PDF longer than 20 pages: the first 20 are read
- a browser without WebGPU: the detector runs on WebAssembly
- a browser that does not allow cross-origin isolation: WebAssembly runs on 1 thread, several times slower

## Run it on your machine

No build step. From the repository root:

```sh
node demo/record/serve.mjs          # http://localhost:8080/
```

`serve.mjs` serves `demo/` the way GitHub Pages does: no `Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy` headers and Pages' caching headers. [`coi-serviceworker.js`](coi-serviceworker.js) turns on cross-origin isolation from a service worker (it reloads the page once on the first visit), so WebAssembly runs with threads. A service worker needs a secure context: open the page on `localhost` or over https. Any static server that serves the files as they are should work the same way.

## How the page is made

- [`app.js`](app.js): the page. It loads `https://cdn.jsdelivr.net/npm/litert-ocr@0.1.0/+esm`, starts one worker with `createWorker('eng', 1, { eager: true })` for images (all five model files at start, so a read never waits for a recognizer to load) and one converter with `createConverter({ eager: true, layout: 'geometry' })` for documents (it finds the files in the cache, and reads a blank one-page PDF first, so pdf.js is loaded before the first PDF), and reads one file at a time.
- [`md.js`](md.js): draws the Markdown that `convert()` writes; every piece of text is set as text, never as HTML.
- [`coi-serviceworker.js`](coi-serviceworker.js): coi-serviceworker 0.1.7 (MIT) with one addition, marked [litert-ocr demo] in the file: the service worker keeps a copy of the page's own files and of the pinned library module and answers from it when there is no network (the original's header-setting code is moved into a function the addition shares).

## Record tools

[`record/`](record) holds the tools that check the page and film it, driving it the way a person does (the file button and the browser's file chooser). Run them from the repository root after `npm install`; they write to `demo/record/out/` unless given `--out`.

| Tool | What it does |
|---|---|
| `make-inputs.mjs` | Draws `examples/inventory-scan.pdf` (with `--examples`) and the files of the failure checks |
| `serve.mjs` | Serves `demo/` without the isolation headers, as GitHub Pages does |
| `picker.mjs` | The phone picker's steps read from its UI tree (used by `android-take.mjs`; pure functions, so the steps can be checked against saved trees without a phone) |
| `check.mjs` | Every example through the page against the library called directly (`direct.html`, same options): the same text lines, Markdown and JSON; `--repeat N` more runs of the photo and the scan; `--failures DIR` the failure paths, each followed by a file that must read; `--variants` Chrome without WebGPU and a browser without service workers |
| `visit.mjs` | First and second visit over the DevTools protocol: time to the first result and bytes over the network of every target (page, workers, service worker), the hosts contacted; `--offline` opens the page again on the same profile with no network |
| `mac-take.mjs` | Films the page in desktop Chrome (1440 x 900, the page only): screenshots of a rehearsal, then, after a go file, the take as an H.264 mp4 at 30 frames per second |
| `android-take.mjs` | The same two screens on an Android phone over adb. Setup: the files go into the phone's storage (with `--folder NAME`, into `Download/NAME/` only, so the picker shows just them) and the page is opened while online (`--url`: the published page, or one served on this machine with `--reverse PORT`); `--airplane` turns airplane mode on under the open page and checks that Wi-Fi is off and there is no network (at the end the page is opened again in airplane mode and what it shows is recorded). Take: the phone's file picker is scouted without choosing (Chrome's camera prompt answered "only this time"), the tool waits for a rested phone, then taps the file button and the file in the picker under the phone's own screen recording; `--failures DIR` runs the failure paths on the phone; afterwards the phone is put back as it was. Cut: the time from choosing a file to its result stays as recorded, only the driver's waits are shortened to 1.5 s, and the left half of the status bar (other apps' icons) is painted over |

`check.mjs`, `visit.mjs`, `mac-take.mjs` and `android-take.mjs` each write a JSON file with every run and the checks they made.
