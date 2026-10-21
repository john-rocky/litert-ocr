// Serve demo/ the way GitHub Pages does: plain static files, no Cross-Origin-Opener-Policy / -Embedder-Policy headers
// (coi-serviceworker.js turns on cross-origin isolation from a service worker), and Pages' caching headers
// (Cache-Control: max-age=600, ETag, Last-Modified).
//   node demo/record/serve.mjs [--port 8080] [--host 127.0.0.1] [--isolation-headers]
// --isolation-headers adds the two headers instead (for comparing the two ways). Open http://localhost:<port>/ —
// localhost is a secure context, which a service worker needs; a LAN address over plain http is not.
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const PORT = Number(opt('--port', process.env.PORT ?? 8080));
const HOST = opt('--host', '127.0.0.1');
const ISOLATION = args.includes('--isolation-headers');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
};

export function startServer({ port = PORT, host = HOST, isolation = ISOLATION, root = ROOT } = {}) {
  const server = createServer((req, res) => {
    let p;
    try {
      p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    } catch {
      return res.writeHead(400).end();
    }
    let file = normalize(join(root, p));
    if (!file.startsWith(root)) return res.writeHead(403).end();
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    if (!existsSync(file)) return res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
    const st = statSync(file);
    const etag = `"${st.mtimeMs.toString(16).split('.')[0]}-${st.size.toString(16)}"`;
    const headers = {
      'Content-Type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': 'max-age=600',
      ETag: etag,
      'Last-Modified': st.mtime.toUTCString(),
    };
    if (isolation) {
      headers['Cross-Origin-Opener-Policy'] = 'same-origin';
      headers['Cross-Origin-Embedder-Policy'] = 'require-corp';
    }
    if (req.headers['if-none-match'] === etag) return res.writeHead(304, headers).end();
    res.writeHead(200, { ...headers, 'Content-Length': st.size });
    if (req.method === 'HEAD') return res.end();
    createReadStream(file).pipe(res);
  });
  return new Promise((ok) => server.listen(port, host, () => ok({ server, port: server.address().port, close: () => new Promise((r) => server.close(r)) })));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { port } = await startServer();
  console.log(`serving ${ROOT} on http://localhost:${port}/ (${ISOLATION ? 'with' : 'without'} the cross-origin isolation headers)`);
}
