// Build the three examples against a packed tarball of this repository and read one image in each with
// headless Chrome (file picker driven by Playwright). Logs go to $LOG_DIR (default test/out/).
//   node test/examples.mjs [html|react-vite|nextjs ...]
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startServer } from './server.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const LOG = process.env.LOG_DIR ?? join(ROOT, 'test/out');
mkdirSync(LOG, { recursive: true });
const which = process.argv.slice(2).length ? process.argv.slice(2) : ['html', 'react-vite', 'nextjs'];
const FIXTURE = join(ROOT, 'test/fixtures/dialog-shared.jpg');
const results = [];

function sh(name, cmd, args, cwd) {
  const t0 = Date.now();
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 64 << 20, timeout: 900000, env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' } });
  writeFileSync(join(LOG, `example-${name}.log`), `### ${cmd} ${args.join(' ')} (in ${cwd})\n${r.stdout ?? ''}${r.stderr ?? ''}\n### exit ${r.status} ${Date.now() - t0} ms\n`);
  if (r.status !== 0) throw new Error(`${name}: ${cmd} ${args.join(' ')} exited ${r.status} (see example-${name}.log)`);
}

async function readOne(url, label, route) {
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-webgpu', '--mute-audio'] });
  const t0 = Date.now();
  try {
    const context = await browser.newContext();
    if (route) await route(context);
    const page = await context.newPage();
    const lines = [];
    page.on('console', (m) => lines.push(`${m.type()}: ${m.text()}`.slice(0, 300)));
    page.on('pageerror', (e) => lines.push(`pageerror: ${e.message}`));
    await page.goto(url);
    await page.waitForFunction(() => /Ready/.test(document.getElementById('status')?.textContent ?? ''), null, { timeout: 600000 });
    const ready = await page.textContent('#status');
    await page.setInputFiles('input[type=file]', FIXTURE);
    await page.waitForFunction(() => (document.getElementById('out')?.textContent ?? '').length > 20, null, { timeout: 120000 });
    const text = await page.textContent('#out');
    const status = await page.textContent('#status');
    const coi = await page.evaluate(() => self.crossOriginIsolated);
    const ok = /Save changes/.test(text) && /Edit profile/.test(text);
    const r = { example: label, ok, ready, status, crossOriginIsolated: coi, chrome: browser.version(), seconds: Math.round((Date.now() - t0) / 1000), text: text.split('\n').slice(0, 8), console: lines.slice(0, 30) };
    results.push(r);
    console.log(`${ok ? 'PASS' : 'FAIL'} example ${label}: ${ready} | ${status}`);
    return r;
  } finally {
    await browser.close();
  }
}

sh('pack', 'npm', ['pack', '--pack-destination', 'examples/.pack'], ROOT);
const S = await startServer(0, { extraRoots: { '/ex-react/': join(ROOT, 'examples/react-vite/dist/') } });
try {
  if (which.includes('html')) {
    // the CDN URL of the unpublished package is answered with dist/index.js; everything else is real
    await readOne(`http://127.0.0.1:${S.port}/coi/examples/html/index.html`, 'html (CDN)', (ctx) =>
      ctx.route('https://cdn.jsdelivr.net/npm/litert-ocr@0.1.0/+esm', (route) =>
        route.fulfill({ status: 200, contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*', 'cross-origin-resource-policy': 'cross-origin' }, body: readFileSync(join(ROOT, 'dist/index.js')) })),
    );
  }
  if (which.includes('react-vite')) {
    const dir = join(ROOT, 'examples/react-vite');
    sh('react-vite-install', 'npm', ['install', '--no-audit', '--no-fund'], dir);
    sh('react-vite-build', 'npm', ['run', 'build'], dir);
    await readOne(`http://127.0.0.1:${S.port}/coi/ex-react/index.html`, 'react-vite (vite build, served with COOP/COEP)');
  }
  if (which.includes('nextjs')) {
    const dir = join(ROOT, 'examples/nextjs');
    sh('nextjs-install', 'npm', ['install', '--no-audit', '--no-fund'], dir);
    sh('nextjs-build', 'npx', ['next', 'build'], dir);
    const port = 3000 + Math.floor(Math.random() * 1000);
    const srv = spawn('npx', ['next', 'start', '-p', String(port)], { cwd: dir, env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' } });
    let out = '';
    srv.stdout.on('data', (d) => (out += d));
    srv.stderr.on('data', (d) => (out += d));
    try {
      for (let i = 0; i < 120 && !/Ready|started server|Local:/i.test(out); i++) await new Promise((r) => setTimeout(r, 500));
      await readOne(`http://127.0.0.1:${port}/`, 'nextjs (next build + next start)');
    } finally {
      srv.kill('SIGTERM');
      writeFileSync(join(LOG, 'example-nextjs-start.log'), out);
    }
  }
} catch (e) {
  results.push({ ok: false, error: String(e.message ?? e) });
  console.log(`FAIL examples: ${e.message}`);
} finally {
  await S.close();
}
writeFileSync(join(LOG, 'examples.json'), JSON.stringify(results, null, 1));
const pass = results.filter((r) => r.ok).length;
console.log(`EXAMPLES ${pass}/${which.length} PASS`);
process.exit(pass === which.length ? 0 : 1);
