// Browser tests in headless Chrome (Playwright). Modes:
//   webgpu  Google Chrome (channel 'chrome', new headless): detector on WebGPU, recognizer on WebAssembly
//   wasm    Chrome with the GPU disabled (no WebGPU adapter): everything on WebAssembly (the fallback path)
// usage: node test/browser.mjs <webgpu|wasm> [outfile.json]
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { startServer } from './server.mjs';

const mode = process.argv[2] ?? 'webgpu';
const outFile = process.argv[3];
// optional: a rewritten 320-wide recognizer for the WebGPU-recognizer case (not published; see README)
const REC320 = process.env.LITERT_OCR_TEST_REC320;
// optional: the layout model files (not published yet) and the LLM file of extract() (2.0 GB), served locally
const LAYOUT = process.env.LITERT_OCR_LAYOUT_BASE;
const LLM = process.env.LITERT_OCR_TEST_LLM;
const extraRoots = {};
if (REC320) extraRoots['/extra/'] = REC320.replace(/[^/]+$/, '');
if (LAYOUT) extraRoots['/layout/'] = LAYOUT.replace(/\/?$/, '/');
if (LLM) extraRoots['/llm/'] = LLM.replace(/[^/]+$/, '');
const S = await startServer(0, { extraRoots });
const S2 = await startServer(0); // a second origin for the cross-origin cases
const origin = `http://127.0.0.1:${S.port}`;
const otherOrigin = `http://127.0.0.1:${S2.port}`;
const args = mode === 'wasm' ? ['--disable-gpu', '--disable-blink-features=WebGPU', '--disable-features=WebGPU,Vulkan', '--mute-audio'] : ['--mute-audio'];
const browser = await chromium.launch({ channel: 'chrome', headless: true, args });
const results = [];
const chromeVersion = browser.version();
const consoleLog = {};
const t0 = Date.now();

async function open(prefix, setup, file = 'page.html') {
  const context = await browser.newContext();
  const page = await context.newPage();
  const consoleLines = [];
  page.on('console', (m) => consoleLines.push(`${m.type()}: ${m.text()}`.slice(0, 400)));
  page.on('pageerror', (e) => consoleLines.push(`pageerror: ${e.message}`));
  if (setup) await setup(context, page);
  await page.goto(`${origin}/${prefix}/test/browser/${file}`);
  await page.waitForFunction(() => window.testsReady === true, null, { timeout: 30000 });
  return { context, page, consoleLines };
}

async function run(page, name, cfg = {}, timeout = 180000) {
  const start = Date.now();
  let r;
  try {
    let timer;
    r = await Promise.race([
      page.evaluate(({ name, cfg }) => window.tests[name](cfg), { name, cfg }),
      new Promise((_, bad) => { timer = setTimeout(() => bad(new Error(`case timed out after ${timeout} ms`)), timeout); }),
    ]);
    clearTimeout(timer);
  } catch (e) {
    r = { ok: false, error: String(e?.message ?? e).slice(0, 1500) };
  }
  // keep the case name (an expected error carries its own name: OcrError)
  r = { ...r, errorName: r.name, name, mode, ms: Date.now() - start };
  results.push(r);
  console.log(`${r.ok ? 'PASS' : 'FAIL'} ${mode} ${name} (${r.ms} ms)${r.ok ? '' : ' ' + JSON.stringify(r).slice(0, 600)}`);
  return r;
}

try {
  // cross-origin isolated page: the main cases
  const main = await open('coi');
  const env = await run(main.page, 'env');
  const wantDet = mode === 'webgpu' ? 'webgpu' : 'wasm';
  // wasm mode: the WebGPU fallback is a logger notice, not an error
  const fallbackNoticed = mode === 'webgpu' || (env.notices ?? []).some((n) => /WebGPU/.test(n) && /WebAssembly/.test(n));
  results.push({ name: 'backend', mode, ok: env.info?.detector === wantDet && env.info?.threads > 1 && fallbackNoticed && /threads/.test(env.initialized ?? ''), want: wantDet, info: env.info, initialized: env.initialized, notices: env.notices });
  console.log(`${results.at(-1).ok ? 'PASS' : 'FAIL'} ${mode} backend detector=${env.info?.detector} threads=${env.info?.threads}`);
  await run(main.page, 'moduleWorkerProbe');
  for (const name of ['fixtures', 'outputs', 'inputs', 'rectangle', 'whitelist', 'singleLine', 'bigImage', 'scheduler', 'oldRecognize', 'langs', 'logger']) await run(main.page, name);
  for (const name of ['failModel404', 'failSha256', 'failWasm404', 'failDecode', 'failType', 'failImage404', 'failRectangle', 'failTerminated', 'failErrorHandler', 'failDetectAndOutputs', 'forcedWasm']) await run(main.page, name);
  await run(main.page, 'failCrossOriginFetch', { otherOrigin });
  await run(main.page, 'webgpuRecognizer', REC320 ? { mode, rec320Url: `${origin}/coi/extra/${REC320.split('/').pop()}`, rec320Sha: process.env.LITERT_OCR_TEST_REC320_SHA256 } : { mode });
  // documents (convert) and extract
  const layoutBase = LAYOUT ? `${origin}/coi/layout/` : null;
  for (const name of ['docLayer', 'docScanPdf', 'docFailures', 'docPdfjsMissing', 'docInputs', 'docLayoutMissing']) await run(main.page, name);
  await run(main.page, 'docImageAuto', { mode, layoutBase });
  await run(main.page, 'docModelForced', { mode, layoutBase }, 300000);
  await run(main.page, 'extractSchemaInvalid');
  if (mode === 'wasm') await run(main.page, 'extractNoWebGPU');
  else {
    await run(main.page, 'extractModel404');
    await run(main.page, 'extractReceipt', { llmUrl: LLM ? `${origin}/coi/llm/${LLM.split('/').pop()}` : null }, 600000);
  }
  consoleLog.main = main.consoleLines.slice(0, 160);
  await main.context.close();

  if (mode === 'webgpu') {
    // extract() without @litert-lm/core in the page's import map
    const nollm = await open('coi', null, 'page-nollm.html');
    await run(nollm.page, 'extractNoLiteRtLm');
    await nollm.context.close();
  }

  // blocked defaults (Hugging Face and jsDelivr unreachable)
  const blocked = await open('coi', async (ctx) => {
    await ctx.route(/huggingface\.co|jsdelivr\.net/, (r) => r.abort('blockedbyclient'));
  });
  await run(blocked.page, 'failDefaultBlocked');
  await blocked.context.close();

  // offline
  const off = await open('coi');
  await off.context.setOffline(true);
  await run(off.page, 'failOffline');
  await off.context.close();

  // not cross-origin isolated: 1 thread and the notice; a tainted cross-origin <img>
  const plain = await open('plain');
  await run(plain.page, 'noCoi');
  await run(plain.page, 'failTaintedImage', { otherOrigin });
  await plain.context.close();

  // CSP without blob: workers
  const csp = await open('csp');
  await run(csp.page, 'cspBlob');
  await csp.context.close();
} finally {
  await browser.close();
  await S.close();
  await S2.close();
}

const pass = results.filter((r) => r.ok).length;
const summary = { mode, pass, total: results.length, seconds: Math.round((Date.now() - t0) / 1000), chrome: chromeVersion };
console.log(`BROWSER ${mode}: ${pass}/${results.length} PASS`);
if (outFile) writeFileSync(outFile, JSON.stringify({ summary, results, console: consoleLog }, null, 1));
process.exit(pass === results.length ? 0 : 1);
