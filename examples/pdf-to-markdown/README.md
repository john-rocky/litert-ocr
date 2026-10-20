# PDF, scan or photo to Markdown

- `index.html`: pick a PDF or an image in the browser, get Markdown, JSON or text, and save it. Run `node serve.mjs` here and open http://localhost:8080 (the server adds the two headers that let WebAssembly use threads; any static server works, on 1 thread). Add `?layout=<directory URL>` to use the layout model files while they are not published.
- `convert.mjs`: the same in Node.js for files named on the command line: `node convert.mjs report.pdf scan.jpg` writes `report.md` and `scan.md`.

The CDN URL and the `litert-ocr` import work once the package is published; until then the repository's tests serve `dist/index.js` at that URL (`node test/examples.mjs pdf`).
