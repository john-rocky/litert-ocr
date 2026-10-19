// Build: dist/worker.js (classic browser worker, LiteRT.js inside), dist/index.js (browser ESM with that
// worker inlined as a blob source), dist/node.js + dist/node-worker.js (Node ESM), dist/types (tsc).
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
rmSync(dist, { recursive: true, force: true });
const common = { bundle: true, logLevel: 'warning', target: 'es2022', legalComments: 'inline', absWorkingDir: root };

// 1. classic worker (IIFE): LiteRT.js loads its glue with importScripts(), which module workers forbid
await build({ ...common, entryPoints: ['src/browser/worker.ts'], outfile: 'dist/worker.js', format: 'iife', platform: 'browser', minify: true });
const workerSource = readFileSync(join(dist, 'worker.js'), 'utf8');

// 2. browser ESM: no imports at run time; the worker travels as a string and starts from a blob: URL
await build({ ...common, entryPoints: ['src/index.ts'], outfile: 'dist/index.js', format: 'esm', platform: 'browser', define: { __WORKER_SOURCE__: JSON.stringify(workerSource) } });

// 3. Node ESM: @litertjs/core, pngjs and jpeg-js stay external (installed with the package)
const external = ['@litertjs/core', 'pngjs', 'jpeg-js'];
await build({ ...common, entryPoints: ['src/node.ts'], outfile: 'dist/node.js', format: 'esm', platform: 'node', external });
await build({ ...common, entryPoints: ['src/node/worker.ts'], outfile: 'dist/node-worker.js', format: 'esm', platform: 'node', external });

// 4. declarations + type check (tsc). A type error is printed and makes the exit code 2; dist/*.js is already built.
let typeErrors = false;
try {
  execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(root, 'tsconfig.json')], { stdio: 'inherit' });
} catch {
  typeErrors = true;
  console.error('tsc reported type errors (above); the JavaScript bundles were built.');
}
console.log('built dist/: worker.js', workerSource.length, 'bytes; index.js, node.js, node-worker.js, types/');
if (typeErrors) process.exitCode = 2;
