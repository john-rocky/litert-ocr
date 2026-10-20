// Static server for the browser tests and examples.
//   /coi/...    with COOP / COEP (cross-origin isolated: WebAssembly threads)
//   /plain/...  without them (1 thread)
//   /csp/...    COOP / COEP plus a CSP that forbids blob: workers
// Paths after the prefix map to the repository root, except:
//   /models/<file>      the five model files from .models/ (fetched by test/fetch-models.mjs)
//   /models-bad/<file>  the same files, the detector with one byte flipped (sha256 mismatch test)
//   /wasm/<file>        node_modules/@litertjs/core/wasm/
import { createServer } from 'node:http';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.wasm': 'application/wasm', '.tflite': 'application/octet-stream', '.txt': 'text/plain', '.css': 'text/css', '.pdf': 'application/pdf' };

function mapPath(p) {
  if (p.startsWith('/models/')) return join(ROOT, '.models', p.slice(8));
  if (p.startsWith('/models-bad/')) return join(ROOT, '.models', p.slice(12));
  if (p.startsWith('/wasm/')) return join(ROOT, 'node_modules/@litertjs/core/wasm', p.slice(6));
  return join(ROOT, p);
}

export function startServer(port = 0, { extraRoots = {} } = {}) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let p = decodeURIComponent(url.pathname);
    const mode = p.split('/')[1];
    const headers = { 'Cache-Control': 'no-store' };
    if (mode === 'coi' || mode === 'csp') {
      headers['Cross-Origin-Opener-Policy'] = 'same-origin';
      headers['Cross-Origin-Embedder-Policy'] = 'require-corp';
      headers['Cross-Origin-Resource-Policy'] = 'same-origin';
    }
    if (mode === 'csp') headers['Content-Security-Policy'] = "worker-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:";
    if (['coi', 'plain', 'csp'].includes(mode)) p = p.slice(mode.length + 1);
    if (url.searchParams.has('cors')) headers['Access-Control-Allow-Origin'] = '*';
    for (const [prefix, dir] of Object.entries(extraRoots)) {
      if (p.startsWith(prefix)) p = '\0' + join(dir, p.slice(prefix.length));
    }
    const file = p.startsWith('\0') ? p.slice(1) : normalize(mapPath(p));
    if (!p.startsWith('\0') && !file.startsWith(ROOT)) {
      res.writeHead(403, headers).end();
      return;
    }
    let f = file;
    if (existsSync(f) && statSync(f).isDirectory()) f = join(f, 'index.html');
    if (!existsSync(f)) {
      res.writeHead(404, { ...headers, 'Content-Type': 'text/plain' }).end('not found');
      return;
    }
    headers['Content-Type'] = TYPES[extname(f)] ?? 'application/octet-stream';
    if (p.startsWith('/models-bad/') && f.endsWith('_det_640_fp32.tflite')) {
      const b = readFileSync(f);
      b[b.length >> 1] ^= 0xff;
      res.writeHead(200, { ...headers, 'Content-Length': b.length }).end(b);
      return;
    }
    res.writeHead(200, { ...headers, 'Content-Length': statSync(f).size });
    createReadStream(f).pipe(res);
  });
  return new Promise((ok) => server.listen(port, '127.0.0.1', () => ok({ server, port: server.address().port, close: () => new Promise((r) => server.close(r)) })));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { port } = await startServer(Number(process.argv[2] ?? 8080));
  console.log(`serving ${ROOT} on http://127.0.0.1:${port}/coi/ (isolated) and /plain/`);
}
