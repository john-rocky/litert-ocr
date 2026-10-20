// Browser tests (Playwright). Modes:
//   webgpu  Google Chrome (channel 'chrome', new headless): detector on WebGPU, recognizer on WebAssembly
//   wasm    Chrome with the GPU disabled (no WebGPU adapter): everything on WebAssembly (the fallback path)
//   webkit  Playwright's WebKit (the engine of Safari): no WebAssembly relaxed SIMD, so WebAssembly runs on 1 thread;
//           WebGPU is there. extract() is not run here (LiteRT-LM JS is tested in Chrome).
// usage: node test/browser.mjs <webgpu|wasm|webkit> [outfile.json]
import { writeFileSync } from 'node:fs';
import { chromium, webkit } from 'playwright';
import { startServer } from './server.mjs';

const mode = process.argv[2] ?? 'webgpu';
const outFile = process.argv[3];
const WEBKIT = mode === 'webkit';
// optional: the WebGPU form of the 320-wide recognizer (not published yet; README "Model and runtime files")
const REC320 = process.env.LITERT_OCR_TEST_REC320;
// optional: the layout model files (not published yet) and the LLM file of extract() (2.0 GB), served locally
const LAYOUT = WEBKIT ? null : process.env.LITERT_OCR_LAYOUT_BASE;
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
const browser = WEBKIT ? await webkit.launch({ headless: true }) : await chromium.launch({ channel: 'chrome', headless: true, args });
const results = [];
const browserVersion = browser.version();
const consoleLog = {};
const t0 = Date.now();
const rec320 = (prefix) => (REC320 ? { rec320Url: `${origin}/${prefix}/extra/${REC320.split('/').pop()}`, rec320Sha: process.env.LITERT_OCR_TEST_REC320_SHA256 } : {});
// WebKit draws image pixels differently from Chrome (r4: 287 of 335 lines identical on 12 images): a lower share of
// the expected lines (pre-registered in the r5 record before the first WebKit run)
const lineShare = WEBKIT ? 0.85 : 0.95;

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

// The network gone: Chrome = the context offline (navigator.onLine false). WebKit's offline mode also stops blob:
// workers from loading (r4), so there the test server drops the model and runtime requests instead (navigator.onLine
// stays true).
async function offline(context, on) {
  if (!WEBKIT) return context.setOffline(on);
  await fetch(`${origin}/__offline?on=${on ? 1 : 0}`);
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
  const wantDet = mode === 'wasm' ? 'wasm' : 'webgpu';
  // wasm mode: the WebGPU fallback is a logger notice, not an error; WebKit: 1 thread, said by a notice
  const fallbackNoticed = mode !== 'wasm' || (env.notices ?? []).some((n) => /WebGPU/.test(n) && /WebAssembly/.test(n));
  const threadsOk = WEBKIT ? env.info?.threads === 1 && (env.notices ?? []).some((n) => /relaxed SIMD/.test(n)) : env.info?.threads > 1;
  results.push({ name: 'backend', mode, ok: env.info?.detector === wantDet && threadsOk && fallbackNoticed && /threads?/.test(env.initialized ?? ''), want: wantDet, info: env.info, initialized: env.initialized, notices: env.notices });
  console.log(`${results.at(-1).ok ? 'PASS' : 'FAIL'} ${mode} backend detector=${env.info?.detector} threads=${env.info?.threads}`);
  await run(main.page, 'moduleWorkerProbe');
  await run(main.page, 'fixtures', { threshold: lineShare });
  await run(main.page, 'inputs', { close: lineShare });
  for (const name of ['outputs', 'rectangle', 'whitelist', 'singleLine', 'bigImage', 'scheduler', 'oldRecognize', 'langs', 'logger']) await run(main.page, name);
  for (const name of ['failModel404', 'failSha256', 'failWasm404', 'failDecode', 'failType', 'failImage404', 'failRectangle', 'failTerminated', 'failErrorHandler', 'failDetectAndOutputs', 'forcedWasm']) await run(main.page, name);
  await run(main.page, 'failCrossOriginFetch', { otherOrigin });
  await run(main.page, 'webgpuRecognizer', REC320 ? { mode, ...rec320('coi') } : { mode });
  // recognizer 'auto' (the default): cross-origin isolated = threads in Chrome, 1 thread in WebKit
  const autoCoi = WEBKIT ? (REC320 ? 'webgpu' : 'unpublished') : 'threads';
  await run(main.page, 'recognizerAuto', { ...rec320('coi'), expect: autoCoi }, 300000);
  if (autoCoi === 'webgpu') await run(main.page, 'recognizerAutoMismatch', rec320('coi'));
  if (WEBKIT) await run(main.page, 'recognizerAutoHub320', {}, 300000); // record only
  await run(main.page, 'cutShortNotice');
  // documents (convert) and extract
  const layoutBase = LAYOUT ? `${origin}/coi/layout/` : null;
  for (const name of ['docLayer', 'docScanPdf', 'docFailures', 'docPdfjsMissing', 'docInputs', 'docLayoutMissing']) await run(main.page, name);
  await run(main.page, 'docImageAuto', { mode, layoutBase });
  await run(main.page, 'docModelForced', { mode, layoutBase }, 300000);
  if (!WEBKIT) {
    await run(main.page, 'extractSchemaInvalid');
    if (mode === 'wasm') await run(main.page, 'extractNoWebGPU');
    else {
      await run(main.page, 'extractModel404');
      await run(main.page, 'extractReceipt', { llmUrl: LLM ? `${origin}/coi/llm/${LLM.split('/').pop()}` : null }, 600000);
    }
  }
  consoleLog.main = main.consoleLines.slice(0, 160);
  await main.context.close();

  if (mode === 'webgpu') {
    // extract() without @litert-lm/core in the page's import map
    const nollm = await open('coi', null, 'page-nollm.html');
    await run(nollm.page, 'extractNoLiteRtLm');
    await nollm.context.close();
  }

  // the model files cached in the background after the first result, then the network gone (the same page, a new
  // worker); with prefetch: false the long line needs the 960-wide recognizer, which was never stored
  for (const prefetch of [true, false]) {
    const pf = await open('coi');
    await run(pf.page, 'cacheReset');
    await run(pf.page, 'prefetchFirst', { prefetch }, 240000);
    await run(pf.page, 'offlinePrepare');
    await offline(pf.context, true);
    await run(pf.page, 'prefetchSecond', { expectAll: prefetch }, 300000);
    await offline(pf.context, false);
    consoleLog[`prefetch-${prefetch}`] = pf.consoleLines.slice(0, 60);
    await pf.context.close();
  }

  // blocked defaults (Hugging Face and jsDelivr unreachable)
  const blocked = await open('coi', async (ctx) => {
    await ctx.route(/huggingface\.co|jsdelivr\.net/, (r) => r.abort('blockedbyclient'));
  });
  await run(blocked.page, 'failDefaultBlocked');
  await blocked.context.close();

  // offline
  const off = await open('coi');
  await offline(off.context, true);
  await run(off.page, 'failOffline');
  await off.context.close();

  // not cross-origin isolated: 1 thread and the notice; a tainted cross-origin <img>; recognizer 'auto' with 1 thread
  const plain = await open('plain');
  await run(plain.page, 'noCoi');
  await run(plain.page, 'failTaintedImage', { otherOrigin });
  const autoPlain = mode === 'wasm' ? 'nogpu' : REC320 ? 'webgpu' : 'unpublished';
  await run(plain.page, 'recognizerAuto', { ...rec320('plain'), expect: autoPlain }, 300000);
  if (autoPlain === 'webgpu') await run(plain.page, 'recognizerAutoMismatch', rec320('plain'));
  if (mode === 'webgpu') await run(plain.page, 'recognizerAutoHub320', {}, 300000); // record only
  await plain.context.close();

  // CSP without blob: workers
  const csp = await open('csp');
  await run(csp.page, 'cspBlob', { allowUnblocked: WEBKIT });
  await csp.context.close();
} finally {
  await browser.close();
  await S.close();
  await S2.close();
}

const pass = results.filter((r) => r.ok).length;
const summary = { mode, pass, total: results.length, seconds: Math.round((Date.now() - t0) / 1000), browser: `${WEBKIT ? 'WebKit' : 'Chrome'} ${browserVersion}` };
console.log(`BROWSER ${mode}: ${pass}/${results.length} PASS`);
if (outFile) writeFileSync(outFile, JSON.stringify({ summary, results, console: consoleLog }, null, 1));
process.exit(pass === results.length ? 0 : 1);
