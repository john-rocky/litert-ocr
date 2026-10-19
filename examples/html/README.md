# Plain HTML (CDN)

The tesseract.js CDN example with one line changed: the `import`. Run `node serve.mjs` here and open http://localhost:8080 (the server adds the two headers that let WebAssembly use threads; any static server works, on 1 thread).

The CDN URL works once the package is published; until then the repository's tests serve `dist/index.js` at that URL (`npm test`).
