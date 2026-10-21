// Checks of the demo page in Chrome, driven the way a person uses it (the file button and the browser's file
// chooser), with the results written as JSON:
//   - start: cross-origin isolated through coi-serviceworker, WebAssembly threads, where the detector runs
//   - every example: the page's text, Markdown and JSON against the library called directly in the same browser
//     (record/direct.html): the same lines, the same Markdown, the same JSON (the per-page `ms` left out)
//   - --repeat N: the photo and the scanned page N more times each, the time the page shows
//   - --failures DIR: the failure inputs of make-inputs.mjs, each followed by an example (the next file still reads)
//   - --variants: Chrome without WebGPU, and a browser without service workers (no cross-origin isolation)
// usage: node demo/record/check.mjs --url http://localhost:8080/ --out DIR [--repeat 5] [--failures DIR] [--variants]
//        [--chrome PATH] (default: the Chrome Playwright finds as channel 'chrome')
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const DEMO = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const URL0 = opt('--url', 'http://localhost:8080/');
const OUT = opt('--out', join(DEMO, 'record/out/check'));
const REPEAT = Number(opt('--repeat', 0));
const FAILURES = opt('--failures', null);
const VARIANTS = args.includes('--variants');
const CHROME = opt('--chrome', null);
const EXAMPLES = [
  { file: 'receipt.jpg', kind: 'image' },
  { file: 'inventory-scan.pdf', kind: 'pdf' },
  { file: 'sign-ja.jpg', kind: 'image' },
  { file: 'screenshot.png', kind: 'image' },
];
mkdirSync(OUT, { recursive: true });

const report = { when: new Date().toISOString(), url: URL0, checks: [], runs: [], errors: [] };
const check = (name, ok, detail) => {
  report.checks.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail).slice(0, 240)}` : ''}`);
};
const launch = (extra = []) => chromium.launch({ ...(CHROME ? { executablePath: CHROME } : { channel: 'chrome' }), headless: true, args: ['--mute-audio', ...extra] });

async function openPage(context, tag) {
  const page = await context.newPage();
  page.on('pageerror', (e) => report.errors.push(`${tag} pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') report.errors.push(`${tag} console: ${m.text().slice(0, 300)}`); });
  await page.goto(URL0);
  await page.waitForFunction(() => window.demoState?.phase === 'ready' && window.demoState?.converter !== 'starting' && window.demoState?.converter !== 'waiting', null, { timeout: 240000 });
  return page;
}

const runCount = (page) => page.evaluate(() => window.demoRuns.length);
async function waitRun(page, n) {
  await page.waitForFunction((k) => window.demoRuns.length >= k && window.demoRuns[k - 1].done, n, { timeout: 240000 });
  return page.evaluate((k) => window.demoRuns[k - 1], n);
}
/** The file button, then the browser's file chooser, as a person picks a file. */
async function pick(page, path) {
  const n = await runCount(page);
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#pick-label')]);
  await chooser.setFiles(path);
  return waitRun(page, n + 1);
}
/** The Markdown tab of an image: convert() runs when it is first opened. */
async function openMarkdown(page) {
  await page.click('.tab[data-tab="md"]');
  await page.waitForFunction(() => {
    const runs = window.demoRuns;
    const j = runs[runs.length - 1];
    return j.markdown !== undefined || j.convertError !== undefined;
  }, null, { timeout: 240000 });
  return page.evaluate(() => window.demoRuns[window.demoRuns.length - 1]);
}
const visibleText = (page) => page.evaluate(() => {
  const vis = (id) => { const e = document.getElementById(id); return e && !e.hidden ? e.textContent.trim() : null; };
  return {
    status: vis('status-text'),
    took: vis('took'),
    tookDetail: vis('took-detail'),
    errorTitle: document.getElementById('error').hidden ? null : vis('error-title'),
    errorText: document.getElementById('error').hidden ? null : vis('error-text'),
    resultNotes: [...document.querySelectorAll('.result-note')].map((e) => e.textContent),
    notes: [...document.querySelectorAll('#notes li')].map((e) => e.textContent),
    passwordField: !document.getElementById('password-form').hidden,
  };
});
const lines = (s) => (s ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
const withoutMs = (json) => {
  const d = JSON.parse(json);
  for (const p of d.pages ?? []) delete p.ms;
  return JSON.stringify(d);
};
const median = (v) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const record = (label, job, extra = {}) => {
  const r = { label, name: job.name, kind: job.kind, api: job.api, ms: job.ms, convertMs: job.convertMs, lines: job.lines?.length ?? null, error: job.error ?? null, notes: job.notes ?? [], partial: job.partial ?? false, pages: job.pages ?? null, ...extra };
  report.runs.push(r);
  return r;
};

const browser = await launch();
report.chrome = browser.version();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await openPage(context, 'page');
const state = await page.evaluate(() => ({ ...window.demoState, crossOriginIsolated: self.crossOriginIsolated, ua: navigator.userAgent }));
report.state = state;
check('start: cross-origin isolated (coi-serviceworker, no headers from the server)', state.crossOriginIsolated, state.isolated);
check('start: WebAssembly threads >= 8', state.info?.threads >= 8, state.info);
check('start: the PDF reader ready', state.converter === 'ready', { converter: state.converter, ms: state.converterMs });
await page.screenshot({ path: join(OUT, 'ready.png') });

// the examples through the page
const pageOut = {};
for (const ex of EXAMPLES) {
  let job = await pick(page, join(DEMO, 'examples', ex.file));
  if (ex.kind === 'image' && !job.error) job = await openMarkdown(page);
  pageOut[ex.file] = job;
  record(`example ${ex.file}`, job, { visible: await visibleText(page) });
  await page.screenshot({ path: join(OUT, `page-${ex.file}.png`) });
}

// the same files through the library directly
const direct = await context.newPage();
direct.on('pageerror', (e) => report.errors.push(`direct pageerror: ${e.message}`));
await direct.goto(new URL('record/direct.html', URL0).href);
await direct.waitForFunction(() => typeof window.direct === 'function', null, { timeout: 240000 });
for (const ex of EXAMPLES) {
  const d = await direct.evaluate(([u, k]) => window.direct(u, k), [new URL(`examples/${ex.file}`, URL0).href, ex.kind]);
  const p = pageOut[ex.file];
  if (ex.kind === 'image') {
    const a = lines(p.text), b = lines(d.ocrText);
    check(`same text as recognize(): ${ex.file}`, a.length > 0 && JSON.stringify(a) === JSON.stringify(b), { page: a.length, direct: b.length, firstDiff: a.findIndex((l, i) => l !== b[i]) });
  } else {
    check(`same text as convert(to 'text'): ${ex.file}`, p.text === d.text, { page: lines(p.text).length, direct: lines(d.text).length });
  }
  check(`same Markdown as convert(): ${ex.file}`, !!p.markdown && p.markdown === d.md, { page: lines(p.markdown).length, direct: lines(d.md).length });
  check(`same JSON as convert(to 'json') apart from ms: ${ex.file}`, !!p.json && !!d.json && withoutMs(p.json) === withoutMs(d.json));
  report.runs.push({ label: `direct ${ex.file}`, threads: d.threads, detector: d.detector, ocrText: d.ocrText, text: d.text, md: d.md, errors: [d.mdError, d.jsonError, d.textError].filter(Boolean) });
  writeFileSync(join(OUT, `page-${ex.file}.md`), p.markdown ?? '');
  writeFileSync(join(OUT, `page-${ex.file}.txt`), p.text ?? '');
}
await direct.close();

// the time the page shows, more runs of the photo and the scanned page
if (REPEAT > 0) {
  const times = {};
  for (const file of ['receipt.jpg', 'inventory-scan.pdf']) {
    times[file] = [];
    for (let i = 0; i < REPEAT; i++) {
      const job = await pick(page, join(DEMO, 'examples', file));
      times[file].push(job.ms);
      record(`repeat ${file} ${i + 1}`, job);
    }
  }
  report.repeat = Object.fromEntries(Object.entries(times).map(([f, v]) => [f, { ms: v, median: median(v) }]));
  console.log(`repeat medians: ${JSON.stringify(Object.fromEntries(Object.entries(report.repeat).map(([f, v]) => [f, Math.round(v.median)])))}`);
}

// failure paths: each failing file, then the next file
if (FAILURES) {
  const next = async (label) => {
    const job = await pick(page, join(DEMO, 'examples/receipt.jpg'));
    check(`after ${label}: the next file reads`, job.api === 'recognize' && !job.error && job.lines.length > 0, { lines: job.lines?.length });
  };
  const cases = [
    ['notes.txt', (j) => j.error?.code === 'DOC_UNSUPPORTED_TYPE'],
    ['broken.png', (j) => !!j.error || (j.notes ?? []).some((n) => /cut short/.test(n))],
    ['blank.jpg', (j) => !j.error && j.lines.length === 0],
    ['broken.pdf', (j) => j.error?.code === 'PDF_INVALID'],
    ['long.pdf', (j) => j.partial === true && j.pages?.read === 20 && j.pages?.total === 30],
  ];
  for (const [file, ok] of cases) {
    const job = await pick(page, join(FAILURES, file));
    const vis = await visibleText(page);
    record(`failure ${file}`, job, { visible: vis });
    check(`failure ${file}: shown on the page`, ok(job) && (vis.errorTitle || vis.resultNotes.length || /No text/.test(await page.textContent('#pane-text'))), { error: job.error?.code, notes: job.notes, visible: vis });
    await page.screenshot({ path: join(OUT, `failure-${file}.png`) });
    await next(file);
  }
  // a password: the field, a wrong one, the right one
  let job = await pick(page, join(FAILURES, 'locked.pdf'));
  let vis = await visibleText(page);
  record('failure locked.pdf', job, { visible: vis });
  check('failure locked.pdf: the password field', job.error?.code === 'PDF_PASSWORD' && vis.passwordField, vis);
  await page.screenshot({ path: join(OUT, 'failure-locked.pdf.png') });
  let n = await runCount(page);
  await page.fill('#password', 'not-it');
  await page.click('#password-form button');
  job = await waitRun(page, n + 1);
  vis = await visibleText(page);
  record('failure locked.pdf wrong password', job, { visible: vis });
  check('failure locked.pdf: a wrong password is said', job.error?.code === 'PDF_PASSWORD' && /did not open/.test(vis.errorTitle ?? ''), vis);
  await page.screenshot({ path: join(OUT, 'failure-locked-wrong.png') });
  n = await runCount(page);
  await page.fill('#password', 'demo');
  await page.click('#password-form button');
  job = await waitRun(page, n + 1);
  record('failure locked.pdf right password', job, { visible: await visibleText(page) });
  check('failure locked.pdf: the right password opens it', job.api === 'convert' && !job.error && job.lines?.length > 0, { lines: job.lines?.length });
  await next('locked.pdf');
}
await context.close();
await browser.close();

if (VARIANTS) {
  // Chrome without WebGPU (the flags of a browser with WebGPU turned off)
  const nogpu = await launch(['--disable-gpu', '--disable-blink-features=WebGPU', '--disable-features=WebGPU,Vulkan']);
  const c1 = await nogpu.newContext({ viewport: { width: 1440, height: 900 } });
  const p1 = await openPage(c1, 'nogpu');
  const s1 = await p1.evaluate(() => window.demoState);
  const j1 = await pick(p1, join(DEMO, 'examples/receipt.jpg'));
  const v1 = await visibleText(p1);
  record('no WebGPU: receipt.jpg', j1, { visible: v1, info: s1.info });
  check('no WebGPU: the sentence and the detector on WebAssembly, the photo reads', s1.info?.detector === 'wasm' && v1.notes.some((t) => /WebGPU is not available/.test(t)) && j1.lines.length > 0, { detector: s1.info?.detector, notes: v1.notes, lines: j1.lines?.length });
  await p1.screenshot({ path: join(OUT, 'variant-nogpu.png') });
  await nogpu.close();

  // a browser without service workers: no cross-origin isolation, 1 thread
  const b2 = await launch();
  const c2 = await b2.newContext({ viewport: { width: 1440, height: 900 } });
  await c2.addInitScript(() => { Object.defineProperty(Navigator.prototype, 'serviceWorker', { get: () => undefined }); });
  const p2 = await openPage(c2, 'nosw');
  const s2 = await p2.evaluate(() => ({ ...window.demoState, coi: self.crossOriginIsolated }));
  const j2 = await pick(p2, join(DEMO, 'examples/receipt.jpg'));
  const v2 = await visibleText(p2);
  record('no service worker: receipt.jpg', j2, { visible: v2, info: s2.info });
  check('no service worker: the 1-thread sentence, the photo reads', !s2.coi && s2.info?.threads === 1 && v2.notes.some((t) => /1 thread/.test(t)) && j2.lines.length > 0, { threads: s2.info?.threads, notes: v2.notes, ms: j2.ms });
  await p2.screenshot({ path: join(OUT, 'variant-nosw.png') });
  await b2.close();
}

check('no page errors', report.errors.length === 0, report.errors.slice(0, 5));
writeFileSync(join(OUT, 'check.json'), JSON.stringify(report, null, 2));
const bad = report.checks.filter((c) => !c.ok);
console.log(`${report.checks.length - bad.length}/${report.checks.length} PASS -> ${join(OUT, 'check.json')}`);
process.exit(bad.length ? 1 : 0);
