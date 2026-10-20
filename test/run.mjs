// npm test: Node tests, browser tests (Chrome with and without WebGPU, and WebKit = Safari's engine), the tesseract.js
// README example with one line changed (Node ESM, Node CommonJS, browser), the blocks example, Deno / Bun smoke runs,
// and the document tests (convert / toMarkdown in Node, the litert-ocr command and its MCP server).
//   node test/run.mjs [node|doc|cli|browser|chrome|webkit|compat|runtimes ...]   (default: all; browser = the three
//   browser modes, chrome = the two Chrome modes, webkit = WebKit only)
// Logs go to $LOG_DIR (default test/out/). Optional: $LITERT_OCR_LAYOUT_BASE = a directory with the layout model
// files (not published yet), $LITERT_OCR_TEST_LLM = the Gemma 4 E2B web model file for the extract() case,
// $LITERT_OCR_TEST_REC320 (+ _SHA256) = the WebGPU form of the 320-wide recognizer (not published yet) for the
// recognizer cases.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startServer } from './server.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const LOG = process.env.LOG_DIR ?? join(ROOT, 'test/out');
mkdirSync(LOG, { recursive: true });
const parts = process.argv.slice(2).length ? process.argv.slice(2) : ['node', 'doc', 'cli', 'compat', 'browser', 'runtimes'];
const summary = [];
const stamp = () => new Date().toISOString();

function step(name, cmd, args, { env = {}, check = null, timeout = 900000 } = {}) {
  const t0 = Date.now();
  const r = spawnSync(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8', timeout, maxBuffer: 64 << 20 });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  writeFileSync(join(LOG, `${name}.log`), `### ${stamp()} ${cmd} ${args.join(' ')}\n${out}\n### exit ${r.status} signal ${r.signal ?? ''} ${Date.now() - t0} ms\n`);
  let ok = r.status === 0;
  let note = '';
  if (ok && check) [ok, note] = check(out);
  summary.push({ name, ok, ms: Date.now() - t0, note });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} (${Date.now() - t0} ms) ${note}`);
  return out;
}

execFileSync(process.execPath, ['test/fetch-models.mjs'], { cwd: ROOT, stdio: 'inherit' });
execFileSync(process.execPath, ['test/fixtures/make-pdfs.mjs'], { cwd: ROOT, stdio: 'inherit' });

const nodeTestCheck = (out) => {
  const pass = Number(/ℹ pass (\d+)/.exec(out)?.[1] ?? 0), fail = Number(/ℹ fail (\d+)/.exec(out)?.[1] ?? 1);
  return [fail === 0 && pass > 0, `${pass} pass, ${fail} fail`];
};
if (parts.includes('doc')) {
  step('doc-tests', process.execPath, ['--test', '--test-reporter=spec', '--test-concurrency=1', 'test/doc.test.mjs'], {
    env: { LITERT_OCR_DOC_REPORT: join(LOG, 'doc-report.json') },
    check: nodeTestCheck,
  });
}
if (parts.includes('cli')) {
  step('cli-mcp-tests', process.execPath, ['--test', '--test-reporter=spec', '--test-concurrency=1', 'test/cli.test.mjs'], {
    env: { LITERT_OCR_CLI_REPORT: join(LOG, 'cli-report.json') },
    check: nodeTestCheck,
  });
}

if (parts.includes('node')) {
  step('node-tests', process.execPath, ['--test', '--test-reporter=spec', '--test-concurrency=1', 'test/node.test.mjs'], {
    env: { LITERT_OCR_REPORT: join(LOG, 'node-report.json') },
    check: (out) => {
      const pass = Number(/ℹ pass (\d+)/.exec(out)?.[1] ?? 0), fail = Number(/ℹ fail (\d+)/.exec(out)?.[1] ?? 1);
      return [fail === 0 && pass > 0, `${pass} pass, ${fail} fail`];
    },
  });
}

if (parts.includes('compat')) {
  const poem = (out) => [/Night/.test(out) && out.length > 200, out.split('\n').find((l) => /Night/.test(l))?.trim() ?? ''];
  step('compat-readme-esm', process.execPath, ['test/compat/readme.mjs'], { check: poem });
  step('compat-readme-cjs', process.execPath, ['test/compat/readme.cjs'], { check: poem });
  step('compat-blocks-node', process.execPath, ['test/compat/blocks.mjs'], {
    check: (out) => [/^Settings \d+ \{"x0":/m.test(out), `${out.trim().split('\n').length} words`],
  });
  // browser: the CDN import is served from dist/ (the package is not published), everything else is real:
  // Hugging Face for the model, jsDelivr for the LiteRT.js runtime, the README's image URL.
  const S = await startServer(0);
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--mute-audio'] });
  try {
    for (const name of ['readme', 'blocks']) {
      const t0 = Date.now();
      const context = await browser.newContext();
      await context.route('https://cdn.jsdelivr.net/npm/litert-ocr@0.1.0/+esm', (route) =>
        route.fulfill({ status: 200, contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*', 'cross-origin-resource-policy': 'cross-origin' }, body: readFileSync(join(ROOT, 'dist/index.js')) }),
      );
      const page = await context.newPage();
      const lines = [];
      page.on('console', (m) => lines.push(`${m.type()}: ${m.text()}`.slice(0, 300)));
      await page.goto(`http://127.0.0.1:${S.port}/coi/test/compat/${name}.html`);
      await page.waitForFunction(() => window.__result, null, { timeout: 600000 });
      const r = await page.evaluate(() => window.__result);
      const ok = !r.error && (name === 'readme' ? /Night/.test(r.text) : r.words > 30) && r.info?.threads > 1;
      writeFileSync(join(LOG, `compat-${name}-browser.log`), `### ${stamp()} ${name}.html (Chrome ${browser.version()}, cross-origin isolated)\n${JSON.stringify(r, null, 1)}\n### console\n${lines.join('\n')}\n`);
      summary.push({ name: `compat-${name}-browser`, ok, ms: Date.now() - t0, note: `threads ${r.info?.threads}, detector ${r.info?.detector}` });
      console.log(`${ok ? 'PASS' : 'FAIL'} compat-${name}-browser threads=${r.info?.threads} detector=${r.info?.detector} ${r.error ?? ''}`);
      await context.close();
    }
  } finally {
    await browser.close();
    await S.close();
  }
}

if (parts.includes('browser') || parts.includes('chrome') || parts.includes('webkit')) {
  // Chrome with WebGPU, Chrome without it, and WebKit (Safari's engine: WebAssembly on 1 thread)
  const modes = [...(parts.includes('browser') || parts.includes('chrome') ? ['webgpu', 'wasm'] : []), ...(parts.includes('browser') || parts.includes('webkit') ? ['webkit'] : [])];
  for (const mode of modes) {
    step(`browser-${mode}`, process.execPath, ['test/browser.mjs', mode, join(LOG, `browser-${mode}.json`)], {
      check: (out) => [/BROWSER \w+: (\d+)\/\1 PASS/.test(out), /BROWSER \w+: (\d+\/\d+ PASS)/.exec(out)?.[1] ?? ''],
    });
  }
}

if (parts.includes('runtimes')) {
  for (const [name, cmd, args] of [['runtime-node', process.execPath, ['test/runtimes.mjs']], ['runtime-deno', 'deno', ['run', '-A', 'test/runtimes.mjs']], ['runtime-bun', 'bun', ['test/runtimes.mjs']]]) {
    const has = spawnSync(cmd, ['--version'], { encoding: 'utf8' }).status === 0;
    if (!has) {
      summary.push({ name, ok: true, ms: 0, note: `${cmd} not installed: skipped` });
      console.log(`SKIP ${name} (${cmd} not installed)`);
      continue;
    }
    step(name, cmd, args, { timeout: 600000, check: (out) => [/RUNTIME PASS/.test(out), (/\{"runtime".*\}/.exec(out)?.[0] ?? '').slice(0, 300)] });
  }
  // Deno's WebGPU, tried once (not the default there): recorded, not counted
  if (spawnSync('deno', ['--version'], { encoding: 'utf8' }).status === 0) {
    const out = step('runtime-deno-webgpu-try', 'deno', ['run', '-A', 'test/runtimes.mjs', 'webgpu'], { timeout: 600000, check: (o) => [true, (/\{"runtime".*\}/.exec(o)?.[0] ?? '').slice(0, 300)] });
    summary.at(-1).ok = true;
    summary.at(-1).note = `try (not counted): ${/RUNTIME PASS/.test(out) ? 'read the fixture' : 'did not read the fixture'}; ${summary.at(-1).note}`;
  }
}

writeFileSync(join(LOG, 'summary.json'), JSON.stringify({ at: stamp(), parts, summary }, null, 1));
const failed = summary.filter((s) => !s.ok);
console.log(`\nTOTAL ${summary.length - failed.length}/${summary.length} PASS${failed.length ? ' — failed: ' + failed.map((f) => f.name).join(', ') : ''}`);
process.exit(failed.length ? 1 : 0);
