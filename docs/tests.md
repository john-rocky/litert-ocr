# Tests

`npm install && npm run build && npm test` runs:

- the Node.js tests;
- the browser tests with the failure paths in headless Chrome (with WebGPU and without it) and in WebKit, the engine of Safari (Playwright's build: WebAssembly on 1 thread);
- the tesseract.js README example with the import changed (Node.js ESM and CommonJS, and the browser);
- Deno and Bun smoke tests when they are installed;
- the document tests: `convert()` in Node.js and in the browser, the `litert-ocr` command, and the MCP server driven by the MCP SDK client (the document inputs are made by `test/fixtures/make-pdfs.mjs`).

Optional environment variables add cases: `LITERT_OCR_TEST_REC320` and `LITERT_OCR_TEST_REC320_SHA256` (another WebGPU form of the 320-wide recognizer for the recognizer cases; without them they use the pinned one), `LITERT_OCR_LAYOUT_BASE` (a directory with the layout model files, which are not published yet) and `LITERT_OCR_TEST_LLM` (the Gemma 4 E2B web model file, for one `extract()` run).

`node test/examples.mjs` builds the examples and reads one image in each (a PDF and a scan in `pdf-to-markdown`), and starts the MCP example's configuration and converts a PDF through it.
