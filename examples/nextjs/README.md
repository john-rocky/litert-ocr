# Next.js (App Router)

`npm install && npm run dev`, then open http://localhost:3000 and pick an image. `app/ocr.jsx` is a client component that imports the library inside `useEffect`, so server rendering never loads it.

Until the package is published, run `npm pack --pack-destination examples/.pack` in the repository root first (the dependency points at that tarball); after publication use `"litert-ocr": "^0.1.0"`.
