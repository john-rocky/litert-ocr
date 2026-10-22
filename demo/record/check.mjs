// Checks of the demo page in Chrome, driven the way a person uses it (the file button and the browser's file
// chooser), with the results written as JSON:
//   - start: cross-origin isolated through coi-serviceworker, WebAssembly threads, where the detector runs
//   - every example: the page's text, Markdown and JSON against the library called directly in the same browser
//     (record/direct.html): the same lines, the same Markdown, the same JSON (the per-page `ms` left out)
//   - every example, and a PDF with a text layer (test/fixtures/report.pdf, 2 pages): what the figure shows: a photo's
//     box per line; a PDF's page drawn with one frame per block of convert() inside the page, the next page with its
//     own frames
//   - --repeat N: the photo and the scanned page N more times each, the time the page shows
//   - --failures DIR: the failure inputs of make-inputs.mjs, each followed by an example (the next file still reads);
//     a PDF that cannot be opened shows no page; long.pdf's pages turn up to the 20th
//   - --variants: Chrome without WebGPU, and a browser without service workers (no cross-origin isolation)
//   - --phone: the photo and the scanned PDF in phone-sized pages (412 x 915; and 360 x 638, the CSS size of a Galaxy
//     S26's Chrome, where the whole page, the time, the table's header and 3 rows must fit one screen)
//   - --cache-refused: the browser refuses to store the files (Cache API put rejected, as Safari did in a Hugging Face
//     Space frame): the status line must not say the files are kept
// usage: node demo/record/check.mjs --url http://localhost:8080/ --out DIR [--browser chrome|webkit] [--repeat 5]
//        [--failures DIR] [--variants] [--phone] [--cache-refused]
//        [--chrome PATH] (default: the Chrome Playwright finds as channel 'chrome')
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';

const DEMO = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const URL0 = opt('--url', 'http://localhost:8080/');
const OUT = opt('--out', join(DEMO, 'record/out/check'));
const REPEAT = Number(opt('--repeat', 0));
const FAILURES = opt('--failures', null);
const VARIANTS = args.includes('--variants');
const PHONE = args.includes('--phone');
const CACHE_REFUSED = args.includes('--cache-refused');
const BROWSER = opt('--browser', 'chrome');
const CHROME = opt('--chrome', null);
const REPORT_PDF = join(DEMO, '../test/fixtures/report.pdf');
const EXAMPLES = [
  { file: 'receipt.jpg', kind: 'image' },
  { file: 'inventory-scan.pdf', kind: 'pdf' },
  { file: 'sign-ja.jpg', kind: 'image' },
  { file: 'screenshot.png', kind: 'image' },
];
mkdirSync(OUT, { recursive: true });

const report = { when: new Date().toISOString(), url: URL0, browser: BROWSER, checks: [], runs: [], errors: [], figures: {} };
const check = (name, ok, detail) => {
  report.checks.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail).slice(0, 240)}` : ''}`);
};
const launch = (extra = []) => (BROWSER === 'webkit'
  ? webkit.launch({ headless: true })
  : chromium.launch({ ...(CHROME ? { executablePath: CHROME } : { channel: 'chrome' }), headless: true, args: ['--mute-audio', ...extra] }));

async function openPage(context, tag) {
  const page = await context.newPage();
  page.on('pageerror', (e) => report.errors.push(`${tag} pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') report.errors.push(`${tag} console: ${m.text().slice(0, 300)}`); });
  await page.goto(URL0);
  await page.waitForFunction(() => window.demoState?.phase === 'ready' && ['ready', 'failed'].includes(window.demoState?.converter) && ['ready', 'failed'].includes(window.demoState?.pdfPages), null, { timeout: 240000 });
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
/** The same, looking at the screen while the file is read (a PDF once its page is drawn): the previous file's result. */
async function pickWatching(page, path) {
  const n = await runCount(page);
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#pick-label')]);
  await chooser.setFiles(path);
  const during = await (await page.waitForFunction((k) => {
    const j = window.demoRuns[k];
    if (!j) return null;
    if (j.done) return { done: true };
    if (j.kind === undefined || (j.kind === 'pdf' && j.pdfPage === undefined)) return null;
    const vis = (id) => !document.getElementById(id).hidden;
    return { done: false, result: vis('result'), output: vis('output'), error: vis('error'), took: document.getElementById('took').textContent };
  }, n, { timeout: 240000 })).jsonValue();
  return { job: await waitRun(page, n + 1), during };
}
const previousHidden = (d) => !d.done && !(d.result && (d.output || d.error)) && !d.took;
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
/** What the figure shows: the image or the PDF page (and whether it has ink), the frames and their coordinates. */
const figureState = (page) => page.evaluate(() => {
  const fig = document.getElementById('figure');
  const svg = document.getElementById('boxes');
  const cv = document.getElementById('page');
  let ink = 0;
  if (!fig.hidden && !cv.hidden && cv.width) {
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    for (let i = 0; i < d.length; i += 16) if (d[i] < 128 && d[i + 1] < 128 && d[i + 2] < 128) ink++;
  }
  const rects = [...svg.querySelectorAll('rect')].map((r) => [+r.getAttribute('x'), +r.getAttribute('y'), +r.getAttribute('width'), +r.getAttribute('height'), r.getAttribute('class')]);
  return {
    shown: !fig.hidden, image: !document.getElementById('image').hidden, pdfPage: !cv.hidden, ink, canvas: [cv.width, cv.height],
    viewBox: (svg.getAttribute('viewBox') ?? '').split(' ').map(Number), turn: svg.querySelector('g')?.getAttribute('transform') ?? null, rects,
    caption: document.getElementById('caption').textContent, legend: document.getElementById('legend').hidden ? null : [...document.querySelectorAll('#legend .key')].map((k) => k.textContent),
    pager: document.getElementById('pager').hidden ? null : { prev: !document.getElementById('prev').disabled, next: !document.getElementById('next').disabled },
  };
});
const inPage = (f) => f.rects.every(([x, y, w, h]) => x >= 0 && y >= 0 && x + w <= f.viewBox[2] + 0.5 && y + h <= f.viewBox[3] + 0.5);
/** The page shown (an index into the pages read) and its blocks, from the run's JSON. */
const pageOf = (job, i) => JSON.parse(job.json).pages[i];
/** A photo: one box per line. A PDF: its page drawn, one frame per block of the page shown, inside the page. */
function checkFigure(label, job, f, i = 0) {
  report.figures[label] = { ...f, rects: f.rects.length };
  if (job.kind === 'image') {
    check(`figure ${label}: the image and one box per line`, f.shown && f.image && !f.pdfPage && f.rects.length === job.lines.length && !f.legend, { boxes: f.rects.length, lines: job.lines.length });
    return;
  }
  const p = pageOf(job, i);
  check(`figure ${label}: page ${p.page} drawn, one frame per block (${p.blocks.length}), all inside the page`, f.shown && f.pdfPage && f.ink > 50 && f.rects.length === p.blocks.length && inPage(f) && f.viewBox[2] === p.width && f.viewBox[3] === p.height && f.caption.startsWith(`Page ${p.page} of `) && (p.skew ? f.turn === `rotate(${p.skew} ${p.width / 2} ${p.height / 2})` : f.turn === null), { frames: f.rects.length, blocks: p.blocks.length, ink: f.ink, viewBox: f.viewBox, turn: f.turn, skew: p.skew, caption: f.caption, legend: f.legend });
}
const settle = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 200)))));
/** Turn the page with the pager (as a person clicks it) and wait for it to be drawn. */
async function turnPage(page, dir, expectPage) {
  await page.waitForFunction((d) => !document.getElementById(d).disabled, dir, { timeout: 60000 });
  await page.click(`#${dir}`);
  await page.waitForFunction((p) => document.getElementById('caption').textContent.startsWith(`Page ${p} of`), expectPage, { timeout: 60000 });
  await page.waitForFunction(() => !document.getElementById('prev').disabled || !document.getElementById('next').disabled, null, { timeout: 60000 });
  await settle(page);
}
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
const state = await page.evaluate(() => ({ ...window.demoState, crossOriginIsolated: self.crossOriginIsolated, ua: navigator.userAgent, detail: document.getElementById('detail').textContent }));
report.state = state;
check('start: cross-origin isolated (coi-serviceworker, no headers from the server)', state.crossOriginIsolated, state.isolated);
check(BROWSER === 'webkit' ? 'start: WebAssembly threads >= 1' : 'start: WebAssembly threads >= 8', state.info?.threads >= (BROWSER === 'webkit' ? 1 : 8), state.info);
check('start: the PDF reader ready', state.converter === 'ready', { converter: state.converter, ms: state.converterMs });
check('start: pdf.js for drawing PDF pages ready', state.pdfPages === 'ready', { pdfPages: state.pdfPages, error: state.pdfPagesError ?? null });
check('start: the status line says the files are kept (a new profile, every file cached)', /kept for later visits/.test(state.detail) && state.notKept.length === 0, { detail: state.detail, notKept: state.notKept });
await page.screenshot({ path: join(OUT, 'ready.png') });

// the examples through the page
const pageOut = {};
for (const [i, ex] of EXAMPLES.entries()) {
  let job;
  if (i === 0) job = await pick(page, join(DEMO, 'examples', ex.file));
  else {
    // a file after another one: while it is read, nothing of the previous file's result is on the screen
    const w = await pickWatching(page, join(DEMO, 'examples', ex.file));
    job = w.job;
    check(`while ${ex.file} is read, the previous file's result is not shown`, previousHidden(w.during), w.during);
  }
  if (ex.kind === 'image' && !job.error) job = await openMarkdown(page);
  pageOut[ex.file] = job;
  record(`example ${ex.file}`, job, { visible: await visibleText(page) });
  await settle(page);
  checkFigure(ex.file, job, await figureState(page));
  await page.screenshot({ path: join(OUT, `page-${ex.file}.png`) });
}

// a PDF with a text layer and two pages: page 1, then page 2 with its own frames
{
  const job = await pick(page, REPORT_PDF);
  record('text-layer PDF report.pdf', job, { visible: await visibleText(page) });
  await settle(page);
  const f1 = await figureState(page);
  checkFigure('report.pdf page 1', job, f1, 0);
  check('report.pdf: read from the text layer, 2 pages, the pager on page 1 (back off, next on)', job.pages?.engine?.every((e) => e === 'layer') && job.pages?.read === 2 && f1.pager && !f1.pager.prev && f1.pager.next, { pages: job.pages, pager: f1.pager });
  await page.screenshot({ path: join(OUT, 'page-report.pdf-1.png') });
  await turnPage(page, 'next', 2);
  const f2 = await figureState(page);
  checkFigure('report.pdf page 2', job, f2, 1);
  check('report.pdf: the frames changed with the page', JSON.stringify(f2.rects) !== JSON.stringify(f1.rects) && f2.pager && f2.pager.prev && !f2.pager.next, { page1: f1.rects.length, page2: f2.rects.length });
  await page.screenshot({ path: join(OUT, 'page-report.pdf-2.png') });
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
    await settle(page);
    const f = await figureState(page);
    if (file === 'notes.txt' || file === 'broken.pdf') check(`failure ${file}: no page or image shown`, !f.shown, { shown: f.shown });
    await page.screenshot({ path: join(OUT, `failure-${file}.png`) });
    if (file === 'long.pdf') {
      // the pages read turn up to the 20th; the page says why the rest is not read
      checkFigure('long.pdf page 1', job, f, 0);
      check('long.pdf: page 1 of 30, the pager on', f.caption === 'Page 1 of 30' && f.pager && f.pager.next && !f.pager.prev, { caption: f.caption, pager: f.pager });
      for (let p = 2; p <= 20; p++) await turnPage(page, 'next', p);
      const f20 = await figureState(page);
      checkFigure('long.pdf page 20', job, f20, 19);
      check('long.pdf: the pager stops at page 20 of 30 (the pages read)', f20.caption === 'Page 20 of 30' && f20.pager && !f20.pager.next && f20.pager.prev, { caption: f20.caption, pager: f20.pager });
    }
    await next(file);
  }
  // a password: the field, a wrong one, the right one; the page only after the right one
  let job = await pick(page, join(FAILURES, 'locked.pdf'));
  let vis = await visibleText(page);
  record('failure locked.pdf', job, { visible: vis });
  check('failure locked.pdf: the password field', job.error?.code === 'PDF_PASSWORD' && vis.passwordField, vis);
  check('failure locked.pdf: no page shown before the password', !(await figureState(page)).shown);
  await page.screenshot({ path: join(OUT, 'failure-locked.pdf.png') });
  let n = await runCount(page);
  await page.fill('#password', 'not-it');
  await page.click('#password-form button');
  job = await waitRun(page, n + 1);
  vis = await visibleText(page);
  record('failure locked.pdf wrong password', job, { visible: vis });
  check('failure locked.pdf: a wrong password is said', job.error?.code === 'PDF_PASSWORD' && /did not open/.test(vis.errorTitle ?? ''), vis);
  check('failure locked.pdf: no page shown after a wrong password', !(await figureState(page)).shown);
  await page.screenshot({ path: join(OUT, 'failure-locked-wrong.png') });
  n = await runCount(page);
  await page.fill('#password', 'demo');
  await page.click('#password-form button');
  job = await waitRun(page, n + 1);
  record('failure locked.pdf right password', job, { visible: await visibleText(page) });
  check('failure locked.pdf: the right password opens it', job.api === 'convert' && !job.error && job.lines?.length > 0, { lines: job.lines?.length });
  await settle(page);
  checkFigure('locked.pdf after the right password', job, await figureState(page), 0);
  await page.screenshot({ path: join(OUT, 'failure-locked-right.png') });
  await next('locked.pdf');
}
await context.close();
await browser.close();

if (VARIANTS && BROWSER === 'chrome') {
  // Chrome without WebGPU (the flags of a browser with WebGPU turned off)
  const nogpu = await launch(['--disable-gpu', '--disable-blink-features=WebGPU', '--disable-features=WebGPU,Vulkan']);
  const c1 = await nogpu.newContext({ viewport: { width: 1440, height: 900 } });
  const p1 = await openPage(c1, 'nogpu');
  const s1 = await p1.evaluate(() => window.demoState);
  const j1 = await pick(p1, join(DEMO, 'examples/receipt.jpg'));
  const v1 = await visibleText(p1);
  record('no WebGPU: receipt.jpg', j1, { visible: v1, info: s1.info });
  check('no WebGPU: the sentence and the detector on WebAssembly, the photo reads', s1.info?.detector === 'wasm' && v1.notes.some((t) => /WebGPU is not available/.test(t)) && j1.lines.length > 0, { detector: s1.info?.detector, notes: v1.notes, lines: j1.lines?.length });
  checkFigure('no WebGPU: receipt.jpg', j1, await figureState(p1));
  await p1.screenshot({ path: join(OUT, 'variant-nogpu.png') });
  const k1 = await pick(p1, join(DEMO, 'examples/inventory-scan.pdf'));
  record('no WebGPU: inventory-scan.pdf', k1, { visible: await visibleText(p1) });
  await settle(p1);
  checkFigure('no WebGPU: inventory-scan.pdf', k1, await figureState(p1));
  await p1.screenshot({ path: join(OUT, 'variant-nogpu-pdf.png') });
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
  checkFigure('no service worker: receipt.jpg', j2, await figureState(p2));
  await p2.screenshot({ path: join(OUT, 'variant-nosw.png') });
  const k2 = await pick(p2, join(DEMO, 'examples/inventory-scan.pdf'));
  record('no service worker: inventory-scan.pdf', k2, { visible: await visibleText(p2) });
  await settle(p2);
  checkFigure('no service worker: inventory-scan.pdf', k2, await figureState(p2));
  await p2.screenshot({ path: join(OUT, 'variant-nosw-pdf.png') });
  await b2.close();
}

if (PHONE && BROWSER === 'chrome') {
  // phone-sized pages: the photo as before; the scanned PDF with its page beside the time
  const UA = 'Mozilla/5.0 (Linux; Android 16; SM-S942Q) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Mobile Safari/537.36';
  const b3 = await launch();
  for (const [tag, viewport, deviceScaleFactor] of [['phone412', { width: 412, height: 915 }, 2.625], ['s26', { width: 360, height: 638 }, 3]]) {
    const c3 = await b3.newContext({ viewport, deviceScaleFactor, isMobile: true, hasTouch: true, userAgent: UA });
    const p3 = await openPage(c3, tag);
    const j = await pick(p3, join(DEMO, 'examples/receipt.jpg'));
    await settle(p3);
    checkFigure(`${tag}: receipt.jpg`, j, await figureState(p3));
    await p3.screenshot({ path: join(OUT, `${tag}-receipt.jpg.png`) });
    await p3.evaluate(() => window.scrollTo(0, 0));
    const { job: k, during } = await pickWatching(p3, join(DEMO, 'examples/inventory-scan.pdf'));
    check(`${tag}: while the PDF is read after the photo, the photo's result is not shown (the page beside it)`, previousHidden(during), during);
    await settle(p3);
    checkFigure(`${tag}: inventory-scan.pdf`, k, await figureState(p3));
    const m = await p3.evaluate(() => {
      const box = (el) => { const b = el.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom) }; };
      return { vh: innerHeight, vw: innerWidth, scrollWidth: document.documentElement.scrollWidth, page: box(document.getElementById('page')), took: box(document.getElementById('took')), rows: [...document.querySelectorAll('#pane-md table tr')].slice(0, 4).map(box) };
    });
    report.figures[`${tag} layout`] = m;
    check(`${tag}: the PDF result in one screen: the whole page, the time, the table's header and 3 rows; no sideways scroll`, m.page.top >= 0 && m.page.bottom <= m.vh && m.took.top >= 0 && m.took.bottom <= m.vh && m.rows.length === 4 && m.rows[3].bottom <= m.vh && m.scrollWidth <= m.vw, m);
    await p3.screenshot({ path: join(OUT, `${tag}-inventory-scan.pdf.png`) });
    await c3.close();
  }
  await b3.close();
}

if (CACHE_REFUSED) {
  // every Cache API put rejected, in the page and in the workers it starts (their code comes from blob: URLs): the
  // library says "Could not cache …" for each file, and the status line must say they are not kept
  const b4 = await launch();
  const c4 = await b4.newContext({ viewport: { width: 1440, height: 900 } });
  await c4.addInitScript(() => {
    const refuse = `(() => { const open = CacheStorage.prototype.open; CacheStorage.prototype.open = async function (n) { const c = await open.call(this, n); c.put = () => Promise.reject(new DOMException('Internal error', 'UnknownError')); return c; }; })();\n`;
    (0, eval)(refuse);
    const blobUrl = URL.createObjectURL;
    URL.createObjectURL = (o) => blobUrl(o instanceof Blob && /javascript/.test(o.type) ? new Blob([refuse, o], { type: o.type }) : o);
  });
  const p4 = await openPage(c4, 'cacherefused');
  await p4.waitForTimeout(1500);
  const s4 = await p4.evaluate(() => ({ detail: document.getElementById('detail').textContent, notKept: window.demoState.notKept, notes: [...document.querySelectorAll('#notes li')].map((l) => l.textContent) }));
  report.cacheRefused = s4;
  check('cache refused: the status line says the files are not kept, with the library\'s notes', s4.notKept.length > 0 && new RegExp(`did not keep ${s4.notKept.length} of them`).test(s4.detail) && !/kept for later visits/.test(s4.detail) && s4.notes.some((t) => /^Could not cache /.test(t)), s4);
  const j4 = await pick(p4, join(DEMO, 'examples/receipt.jpg'));
  check('cache refused: the photo still reads', j4.lines?.length > 0 && !j4.error, { lines: j4.lines?.length });
  await p4.screenshot({ path: join(OUT, 'cache-refused.png') });
  await b4.close();
}

check('no page errors', report.errors.length === 0, report.errors.slice(0, 5));
writeFileSync(join(OUT, 'check.json'), JSON.stringify(report, null, 2));
const bad = report.checks.filter((c) => !c.ok);
console.log(`${report.checks.length - bad.length}/${report.checks.length} PASS -> ${join(OUT, 'check.json')}`);
process.exit(bad.length ? 1 : 0);
