// Smoke test for Deno and Bun (and Node): read one fixture through the Node build.
//   deno run -A test/runtimes.mjs     bun test/runtimes.mjs     node test/runtimes.mjs
import { createWorker } from '../dist/node.js';

const file = new URL('./fixtures/mobile.png', import.meta.url).pathname;
const runtime = globalThis.Deno ? `deno ${Deno.version.deno}` : globalThis.Bun ? `bun ${Bun.version}` : `node ${process.version}`;
const notices = [];
const t0 = performance.now();
const tryWebgpu = process.argv[2] === 'webgpu'; // Deno: try the WebGPU detector once (not the default)
const worker = await createWorker('eng', 1, { backend: tryWebgpu ? 'auto' : undefined, logger: (m) => m.status === 'notice' && notices.push(m.message) });
const initMs = performance.now() - t0;
const t1 = performance.now();
const { data } = await worker.recognize(file);
const ms = performance.now() - t1;
const ok = /Electricity Bill/.test(data.text) && /Morning Run/.test(data.text);
console.log(JSON.stringify({ runtime, ok, info: worker.info, initMs: Math.round(initMs), recognizeMs: Math.round(ms), lines: data.text.split('\n').filter(Boolean).length, notices }));
await worker.terminate();
console.log(ok ? `RUNTIME PASS ${runtime}` : `RUNTIME FAIL ${runtime}`);
process.exit(ok ? 0 : 1);
