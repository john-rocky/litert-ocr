// Build: dist/worker.js (classic browser worker, LiteRT.js inside), dist/index.js (browser ESM with that
// worker inlined as a blob source), dist/node.js + dist/node-worker.js (Node ESM), dist/extract.js (browser,
// litert-ocr/extract) + dist/extract-node.js (Node: explains that extract() runs in the browser), dist/cli.js (the
// litert-ocr command and its MCP server), dist/types (tsc).
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { chmodSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
rmSync(dist, { recursive: true, force: true });
const common = { bundle: true, logLevel: 'warning', target: 'es2022', legalComments: 'inline', absWorkingDir: root };

// 1. classic worker (IIFE): LiteRT.js loads its glue with importScripts(), which module workers forbid
await build({ ...common, entryPoints: ['src/browser/worker.ts'], outfile: 'dist/worker.js', format: 'iife', platform: 'browser', minify: true });
const workerSource = readFileSync(join(dist, 'worker.js'), 'utf8');

// 2. browser ESM: no imports at run time (pdf.js is fetched from a pinned URL when a PDF arrives); the worker
//    travels as a string and starts from a blob: URL
await build({ ...common, entryPoints: ['src/index.ts'], outfile: 'dist/index.js', format: 'esm', platform: 'browser', define: { __WORKER_SOURCE__: JSON.stringify(workerSource) } });

// 3. browser extract: imports litert-ocr (the browser build above) and @litert-lm/core at run time
await build({ ...common, entryPoints: ['src/extract/browser.ts'], outfile: 'dist/extract.js', format: 'esm', platform: 'browser', external: ['litert-ocr', '@litert-lm/core'] });

// 4. Node ESM: dependencies stay external (installed with the package)
const external = ['@litertjs/core', 'pngjs', 'jpeg-js', 'pdfjs-dist', '@napi-rs/canvas', '@modelcontextprotocol/sdk', 'zod', 'litert-ocr'];
await build({ ...common, entryPoints: ['src/node.ts'], outfile: 'dist/node.js', format: 'esm', platform: 'node', external });
await build({ ...common, entryPoints: ['src/node/worker.ts'], outfile: 'dist/node-worker.js', format: 'esm', platform: 'node', external });
await build({ ...common, entryPoints: ['src/extract/node.ts'], outfile: 'dist/extract-node.js', format: 'esm', platform: 'node', external });
// the CLI imports the Node build by its package name, so `litert-ocr` and the library share one copy
await build({ ...common, entryPoints: ['src/cli/main.ts'], outfile: 'dist/cli.js', format: 'esm', platform: 'node', external, banner: { js: '#!/usr/bin/env node' } });
chmodSync(join(dist, 'cli.js'), 0o755);

// 5. declarations + type check (tsc). A type error is printed and makes the exit code 2; dist/*.js is already built.
let typeErrors = false;
try {
  execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(root, 'tsconfig.json')], { stdio: 'inherit' });
} catch {
  typeErrors = true;
  console.error('tsc reported type errors (above); the JavaScript bundles were built.');
}
console.log('built dist/: worker.js', workerSource.length, 'bytes; index.js, extract.js, node.js, node-worker.js, extract-node.js, cli.js, types/');
if (typeErrors) process.exitCode = 2;
