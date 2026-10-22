// litert-ocr demo: a photo, screenshot, scan or PDF -> the text with its line boxes, Markdown with tables, and JSON.
// Everything runs in this tab. Photos and screenshots go to worker.recognize() (lines and their boxes); PDFs, and the
// Markdown and JSON tabs of an image, go to converter.convert(). One file is read at a time. A PDF's page is drawn
// with pdf.js (the files the library pins) before it is read, and the blocks convert() finds are framed on it.
// The record tools (record/) read window.demoState and window.demoRuns (one entry per file read).

import { renderMarkdown } from './md.js';

const LIBRARY = 'https://cdn.jsdelivr.net/npm/litert-ocr@0.1.0/+esm';
/** Pages read per PDF on this page; the library itself reads up to `maxPages` (default 100). */
const MAX_PAGES = 20;
/** convert() reads PDF pages at 150 dpi; block boxes are in pixels of that size. */
const PDF_SCALE = 150 / 72;
const SVG = 'http://www.w3.org/2000/svg';
/** Block types of convert() with the words of the legend. */
const KINDS = [['heading', 'heading', 'headings'], ['paragraph', 'paragraph', 'paragraphs'], ['list_item', 'list item', 'list items'], ['table', 'table', 'tables']];

const $ = (id) => document.getElementById(id);
const narrow = window.matchMedia('(max-width: 960px)');
const demoState = (window.demoState = { phase: 'starting', isolated: self.crossOriginIsolated === true, info: null, converter: 'waiting', pdfPages: 'waiting', notes: [], notKept: [], bytes: { network: 0, cache: 0 }, error: null });
const demoRuns = (window.demoRuns = []);
const ui = { tab: 'text', source: false };
let current = null;
let queue = Promise.resolve();
let pending = 0;
let jobNotes = null;
let lib = null;
let worker = null;
let converter = null;
let converterReady = null;
let pdfjsLoad = null;
/** The pdf.js document of the PDF shown (closed when the next file comes). */
let pdfOpen = null;
/** Coordinates of the boxes layer when a PDF page is shown: the page's size in convert()'s pixels. */
let pageSpace = null;

boot().catch((e) => {
  demoState.phase = 'failed';
  demoState.error = errorRecord(e);
  setStatus('failed', 'The page could not start');
  $('detail').textContent = e?.message ?? String(e);
});

async function boot() {
  showFramed();
  setStatus('busy', 'Starting…');
  const isolated = await isolation();
  demoState.isolated = isolated;
  if (!isolated) note('This browser did not let the page turn on WebAssembly threads (cross-origin isolation), so OCR runs on 1 thread: several times slower.');
  setStatus('busy', 'Loading the OCR library…');
  try {
    lib = await import(LIBRARY);
  } catch (e) {
    throw new Error(`The OCR library could not be loaded from jsDelivr (${e?.message ?? e}). Check the connection and reload the page.`);
  }
  setStatus('busy', 'Loading the model…');
  const t0 = performance.now();
  // all five model files at start (eager): a read never waits for a recognizer to load, and the converter below
  // finds every file in the cache (each file is downloaded once)
  worker = await lib.createWorker('eng', 1, { logger: logger('worker'), eager: true, prefetch: false });
  demoState.info = { ...worker.info, startMs: Math.round(performance.now() - t0) };
  demoState.readyAt = Date.now();
  demoState.phase = 'ready';
  setStatus('ready', 'Ready');
  showInfo();
  enableInput();
  // the first jobs in the line: a file given meanwhile waits for them instead of sharing the CPU with them
  converterReady = enqueue(startConverter);
  enqueue(startPdfPages);
}

/**
 * Inside a frame (as on the Space's page on huggingface.co) the page offers its own address, opened on its own: in a
 * frame Chrome on a Galaxy S26 read more slowly (2026-10-22).
 */
function showFramed() {
  if (window.self === window.top) return;
  const a = Object.assign(document.createElement('a'), { href: location.origin + location.pathname, target: '_blank', rel: 'noopener', textContent: 'Open this page on its own' });
  $('framed').replaceChildren(a, ': in a frame like this one, Chrome on a Galaxy S26 read more slowly.');
  $('framed').hidden = false;
}

/**
 * coi-serviceworker reloads the page once its service worker controls it: until then wait (instead of starting the
 * model twice). Resolves to whether the page is cross-origin isolated (WebAssembly threads).
 */
async function isolation() {
  if (self.crossOriginIsolated) {
    session('coi-wait', null);
    return true;
  }
  const sw = navigator.serviceWorker;
  if (!window.isSecureContext || !sw || sw.controller) return false;
  const tries = Number(session('coi-wait') ?? 0);
  if (tries >= 2) return false;
  session('coi-wait', String(tries + 1));
  setStatus('busy', 'Turning on WebAssembly threads…');
  await new Promise((r) => setTimeout(r, 5000));
  return self.crossOriginIsolated === true;
}

/** The converter keeps its own OCR worker: started here with a blank one-page PDF, so pdf.js and every model file are loaded (and cached) before the first PDF. */
async function startConverter() {
  demoState.converter = 'starting';
  showInfo();
  const t0 = performance.now();
  converter = lib.createConverter({ logger: logger('converter'), eager: true, prefetch: false, layout: 'geometry' });
  try {
    await converter.convert(blankPdf(), { to: 'json' });
    demoState.converterMs = Math.round(performance.now() - t0);
    demoState.converterReadyAt = Date.now();
    demoState.converter = 'ready';
  } catch (e) {
    demoState.converter = 'failed';
    demoState.converterError = errorRecord(e);
    note(`PDFs and the Markdown and JSON tabs are not available: ${e?.message ?? e}`);
  }
  showInfo();
}

/** pdf.js for drawing PDF pages, loaded once after the converter's start (so the first PDF does not wait for it). */
async function startPdfPages() {
  demoState.pdfPages = 'loading';
  try {
    await pdfReader();
    demoState.pdfPages = 'ready';
  } catch (e) {
    demoState.pdfPages = 'failed';
    demoState.pdfPagesError = errorRecord(e);
    note(`PDF pages cannot be shown here (${e?.message ?? e}); PDFs are still read.`);
  }
}

/** The page's own pdf.js: the two files the library pins (modelInfo.pdfjs: the same URLs, sizes and sha256), started
 * from blob: URLs as the library does, so its worker runs on this page's origin. A failed load is tried again later. */
function pdfReader() {
  pdfjsLoad ??= (async () => {
    const { base, files } = lib.modelInfo.pdfjs;
    const load = async (f) => {
      const url = new URL(f.file, base).href;
      const resp = await fetch(url, { credentials: 'omit' });
      if (!resp.ok) throw new Error(`${url}: HTTP ${resp.status}`);
      const bytes = new Uint8Array(await resp.arrayBuffer());
      const sha = crypto.subtle ? Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) => b.toString(16).padStart(2, '0')).join('') : f.sha256;
      if (bytes.byteLength !== f.bytes || sha !== f.sha256) throw new Error(`${url} is not the file the library pins`);
      return URL.createObjectURL(new Blob([bytes], { type: 'text/javascript' }));
    };
    const [main, work] = await Promise.all([files.find((f) => !f.file.includes('worker')), files.find((f) => f.file.includes('worker'))].map(load));
    const mod = await import(main);
    mod.GlobalWorkerOptions.workerSrc = work;
    return { mod, params: { cMapUrl: new URL('cmaps/', base).href, cMapPacked: true, standardFontDataUrl: new URL('standard_fonts/', base).href, wasmUrl: new URL('wasm/', base).href, iccUrl: new URL('iccs/', base).href } };
  })().catch((e) => {
    pdfjsLoad = null;
    throw e;
  });
  return pdfjsLoad;
}

function logger(source) {
  const seen = new Map();
  return (m) => {
    if (typeof m.loaded === 'number') {
      // bytes per step: 'loading runtime' counts each file on its own, 'loading model' the files of a step together
      // (the start files are one step; a recognizer loaded later is a step of its own), fromCache = the file whose
      // bytes just arrived
      const key = `${m.status}|${m.jobId}|${m.status === 'loading runtime' ? m.file : m.total}`;
      const d = m.loaded - (seen.get(key) ?? 0);
      if (d > 0) {
        seen.set(key, m.loaded);
        demoState.bytes[m.fromCache ? 'cache' : 'network'] += d;
      }
    }
    if (source === 'worker' && demoState.phase === 'starting') {
      if (m.status === 'loading model') setStatus('busy', `Loading the model… ${Math.round(m.progress * 100)} %`);
      else if (m.status === 'initializing model') setStatus('busy', 'Preparing the model…');
    }
    if (m.status === 'notice' && m.message) {
      if (/^Recognizer on /.test(m.message)) return;
      if (/not cross-origin isolated/.test(m.message)) return; // said above in this page's words
      // a file the browser would not store: the status line must not say the files are kept
      const notKept = /^Could not cache (\S+)/.exec(m.message)?.[1];
      if (notKept && !demoState.notKept.includes(notKept)) {
        demoState.notKept.push(notKept);
        showInfo();
      }
      if (jobNotes) jobNotes.add(m.message);
      else note(m.message);
    }
  };
}

function showInfo() {
  const i = demoState.info;
  if (!i) return;
  const where = `Detector on ${i.detector === 'webgpu' ? 'WebGPU' : 'WebAssembly'}, recognizer on ${i.recognizer === 'webgpu' ? 'WebGPU' : i.recognizer === 'mixed' ? 'WebGPU and WebAssembly' : 'WebAssembly'}, ${i.threads} thread${i.threads === 1 ? '' : 's'}`;
  const mb = (b) => (b / 1e6).toFixed(1);
  const n = demoState.notKept.length;
  const kept = n ? `this browser did not keep ${n} of them, so the next visit downloads ${n === 1 ? 'it' : 'them'} again` : 'kept for later visits';
  const files = demoState.bytes.network > 0 ? `files: ${mb(demoState.bytes.network)} MB from the network, ${kept}` : 'files: from this browser’s cache';
  const pdf = demoState.converter === 'ready' ? '' : demoState.converter === 'failed' ? ' · PDF reader: not available' : ' · getting the PDF reader ready…';
  $('detail').textContent = `${where} · ${files}${pdf}`;
}

function enableInput() {
  const input = $('file');
  input.disabled = false;
  for (const b of document.querySelectorAll('.example')) b.disabled = false;
  input.addEventListener('change', () => {
    const f = input.files?.[0];
    input.value = '';
    if (f) read(f, 'picker');
  });
  const drop = $('drop');
  let depth = 0;
  document.addEventListener('dragenter', (e) => { if (hasFiles(e)) { depth++; drop.classList.add('over'); } });
  document.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; drop.classList.remove('over'); } });
  document.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  document.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    drop.classList.remove('over');
    const f = e.dataTransfer.files[0];
    if (f) read(f, 'drop');
  });
  document.addEventListener('paste', (e) => {
    const f = [...(e.clipboardData?.files ?? [])][0];
    if (f) {
      e.preventDefault();
      read(f, 'paste');
    }
  });
  for (const b of document.querySelectorAll('.example')) {
    b.addEventListener('click', async () => {
      const name = b.dataset.file;
      const resp = await fetch(`examples/${name}`);
      if (!resp.ok) return showError({ name }, new Error(`The example ${name} could not be loaded (HTTP ${resp.status}).`));
      const blob = await resp.blob();
      read(new File([blob], name, { type: blob.type }), 'example');
    });
  }
  for (const t of document.querySelectorAll('.tab')) t.addEventListener('click', () => selectTab(t.dataset.tab));
  $('source').addEventListener('change', (e) => { ui.source = e.target.checked; paint(); });
  $('copy').addEventListener('click', copyTab);
  $('download').addEventListener('click', downloadTab);
  $('prev').addEventListener('click', () => turnPage(-1));
  $('next').addEventListener('click', () => turnPage(1));
  narrow.addEventListener('change', () => {
    if (!current?.pdf) return;
    placeFigure();
    fitBoxes();
  });
}

const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');

/** Queue a file: one read at a time, so two reads never share the CPU and every time shown is a time on its own. */
function read(file, how) {
  const job = { id: demoRuns.length + 1, name: file.name || 'file', bytes: file.size, type: file.type, how };
  demoRuns.push(job);
  setStatus('busy', `Reading ${job.name}…`);
  return enqueue(() => run(file, job));
}

function enqueue(fn) {
  pending++;
  paintPager();
  const p = queue.then(fn);
  queue = p.catch(() => {}).finally(() => {
    pending--;
    paintPager();
  });
  return p;
}

async function run(file, job) {
  job.startedAt = Date.now();
  job.kind = await kindOf(file);
  current = { file, job, kind: job.kind };
  ui.tab = job.kind === 'pdf' ? 'md' : 'text';
  ui.source = false;
  $('source').checked = false;
  showFile(file, job);
  setStatus('busy', `Reading ${job.name}…`);
  try {
    if (job.kind === 'image') await readImage(file, job);
    else {
      // the page on screen first, then the file to the library: the two never share the CPU, and the time shown
      // stays the library's own
      if (job.kind === 'pdf') await showPdf(current);
      await readDocument(file, job);
    }
  } finally {
    job.endedAt = Date.now();
    job.done = true;
    $('reading').hidden = true;
    if (demoState.phase === 'ready') setStatus('ready', 'Ready');
    reveal();
  }
}

async function kindOf(file) {
  const h = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
  const s = String.fromCharCode(...h.subarray(0, 1024));
  if (file.type === 'application/pdf' || s.includes('%PDF-')) return 'pdf';
  if (file.type.startsWith('image/')) return 'image';
  const png = h[0] === 0x89 && h[1] === 0x50 && h[2] === 0x4e && h[3] === 0x47;
  const jpeg = h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff;
  const gif = s.startsWith('GIF8');
  const webp = s.startsWith('RIFF') && s.slice(8, 12) === 'WEBP';
  const bmp = s.startsWith('BM');
  return png || jpeg || gif || webp || bmp ? 'image' : 'other';
}

async function readImage(file, job) {
  jobNotes = new Set();
  const t0 = performance.now();
  let r;
  try {
    r = await worker.recognize(file, {}, { text: true, blocks: true }, `demo-${job.id}`);
  } catch (e) {
    job.ms = performance.now() - t0;
    finishNotes(job);
    return showError(job, e);
  }
  job.ms = performance.now() - t0;
  finishNotes(job);
  job.api = 'recognize';
  job.text = r.data.text;
  job.lines = r.data.text.split('\n').filter((l) => l.length);
  const lines = r.data.blocks?.[0]?.paragraphs?.[0]?.lines ?? [];
  current.lines = lines;
  current.text = r.data.text;
  drawBoxes(lines);
  showTime(job.ms, `${lines.length} line${lines.length === 1 ? '' : 's'} · ${job.name}`);
  paint();
}

async function readDocument(file, job, password) {
  if (converterReady) await converterReady;
  if (demoState.converter !== 'ready') return showError(job, demoState.converterError ?? new Error('The PDF reader is not available.'));
  jobNotes = new Set();
  const t0 = performance.now();
  const options = { to: 'md', maxPages: MAX_PAGES };
  if (password !== undefined) options.password = password;
  let r;
  try {
    try {
      r = await converter.convert(file, options);
    } catch (e) {
      if (e?.code !== 'DOC_TOO_MANY_PAGES') throw e;
      r = await converter.convert(file, { ...options, pages: `1-${MAX_PAGES}` });
      job.partial = true;
    }
  } catch (e) {
    job.ms = performance.now() - t0;
    finishNotes(job);
    if (e?.code === 'PDF_PASSWORD') return askPassword(file, job, e, password !== undefined);
    return showError(job, e);
  }
  job.ms = performance.now() - t0;
  finishNotes(job);
  job.api = 'convert';
  setDoc(current, r, job.ms);
  job.markdown = current.doc.md;
  job.lines = current.doc.md.split('\n').filter((l) => l.length);
  const pages = r.document.pages;
  const total = r.document.source.pages;
  job.pages = { read: pages.length, total, status: pages.map((p) => p.status), engine: pages.map((p) => p.engine) };
  const how = [...new Set(pages.map((p) => (p.engine === 'layer' ? 'text layer' : p.engine === 'ocr' ? 'OCR' : p.status)))].join(' and ');
  const what = r.document.source.type === 'pdf' ? `${pages.length} page${pages.length === 1 ? '' : 's'} (${how})` : how;
  showTime(job.ms, `${what} · ${job.name}`);
  if (current.pdf) {
    current.pdf.pages = pages;
    framePage(current);
  }
  if (job.partial) addResultNote(`This PDF has ${total} pages; this page reads the first ${MAX_PAGES}. The library reads up to its maxPages option (100 by default), and any range with pages.`);
  const bad = pages.filter((p) => p.status === 'failed');
  for (const p of bad) addResultNote(`Page ${p.page} could not be read: ${p.reason}`);
  if (pages.every((p) => p.status !== 'ok')) addResultNote(pages.length === 1 ? 'No text was found in this file.' : 'No text was found on these pages.');
  paint();
}

function setDoc(cur, r, ms) {
  cur.doc = {
    md: r.content,
    // the same string as convert(file, { to: 'json' }).content
    json: JSON.stringify(r.document, null, 2),
    // the same string as convert(file, { to: 'text' }).content: the pages' text, separated by a form feed
    text: r.document.pages.map((p) => p.text).join('\f'),
    ms,
  };
  cur.job.json = cur.doc.json;
  if (cur.kind !== 'image') cur.job.text = cur.doc.text;
}

/** The Markdown and JSON tabs of an image: convert() reads it once, when one of them is first opened. */
function ensureDoc(cur) {
  if (cur.kind !== 'image' || cur.doc || cur.docError || cur.docPending) return;
  cur.docPending = enqueue(async () => {
    if (converterReady) await converterReady;
    if (demoState.converter !== 'ready') {
      cur.docError = demoState.converterError ?? new Error('The Markdown reader is not available.');
      return;
    }
    jobNotes = new Set();
    const t0 = performance.now();
    try {
      const r = await converter.convert(cur.file, { to: 'md' });
      setDoc(cur, r, performance.now() - t0);
      cur.job.convertMs = cur.doc.ms;
      cur.job.markdown = cur.doc.md;
    } catch (e) {
      cur.docError = e;
      cur.job.convertError = errorRecord(e);
    } finally {
      cur.job.convertNotes = [...jobNotes];
      jobNotes = null;
    }
  }).finally(() => {
    cur.docPending = null;
    if (cur === current) paint();
  });
  paint();
}

function askPassword(file, job, e, wrong) {
  job.error = errorRecord(e);
  showResult();
  setError(wrong ? 'That password did not open this PDF' : 'This PDF needs a password', `Type it to open the file; it is used only in this tab.\n\nlitert-ocr: ${e.message}`, 'info');
  const form = $('password-form');
  form.hidden = false;
  const input = $('password');
  input.value = '';
  input.focus();
  form.onsubmit = (ev) => {
    ev.preventDefault();
    const pw = input.value;
    form.hidden = true;
    const again = { id: demoRuns.length + 1, name: job.name, bytes: job.bytes, type: job.type, how: 'password', kind: 'pdf' };
    demoRuns.push(again);
    enqueue(async () => {
      current = { file, job: again, kind: 'pdf' };
      showFile(file, again);
      setStatus('busy', `Reading ${again.name}…`);
      again.startedAt = Date.now();
      try {
        await showPdf(current, pw);
        await readDocument(file, again, pw);
      } finally {
        again.endedAt = Date.now();
        again.done = true;
        $('reading').hidden = true;
        setStatus('ready', 'Ready');
        reveal();
      }
    });
  };
}

const TITLES = {
  IMAGE_DECODE_FAILED: 'This image could not be opened',
  IMAGE_UNSUPPORTED_TYPE: 'This file is not an image',
  DOC_UNSUPPORTED_TYPE: 'This kind of file is not read here',
  PDF_INVALID: 'This PDF could not be read',
  PDF_UNAVAILABLE: 'The PDF reader could not be loaded',
  MODEL_FETCH_FAILED: 'A model file could not be downloaded',
  MODEL_SHA256_MISMATCH: 'A model file did not match',
  WORKER_START_FAILED: 'The OCR engine could not start',
  RUNTIME_LOAD_FAILED: 'The OCR engine could not start',
  MODEL_COMPILE_FAILED: 'The OCR engine could not start',
};

function showError(job, e) {
  job.error = errorRecord(e);
  showResult();
  setError(TITLES[e?.code] ?? 'This file could not be read', e?.code ? `${e.message}\n\n(${e.code})` : (e?.message ?? String(e)));
}

function setError(title, text, kind = 'bad') {
  $('error').hidden = false;
  $('error').className = kind === 'info' ? 'error info' : 'error';
  $('error-title').textContent = title;
  $('error-text').textContent = text;
  $('output').hidden = true;
}

function errorRecord(e) {
  return { code: e?.code ?? null, message: e?.message ?? String(e) };
}

function finishNotes(job) {
  job.notes = [...(jobNotes ?? [])];
  jobNotes = null;
  for (const n of job.notes) addResultNote(n);
}

// ---- drawing ----

function showFile(file, job) {
  $('result').hidden = true;
  $('error').hidden = true;
  $('password-form').hidden = true;
  $('took').textContent = '';
  $('took-detail').textContent = '';
  for (const n of document.querySelectorAll('.result-note')) n.remove();
  closePdf();
  placeFigure();
  const fig = $('figure');
  const img = $('image');
  $('boxes').replaceChildren();
  $('page').hidden = true;
  $('legend').hidden = true;
  pageSpace = null;
  paintPager();
  if (img.dataset.url) URL.revokeObjectURL(img.dataset.url);
  if (job.kind === 'image') {
    const url = URL.createObjectURL(file);
    img.dataset.url = url;
    img.onerror = () => { fig.hidden = true; };
    img.src = url;
    img.hidden = false;
    fig.hidden = false;
    $('caption').textContent = `${job.name} · ${(file.size / 1e6).toFixed(file.size < 1e5 ? 2 : 1)} MB`;
  } else {
    img.removeAttribute('src');
    delete img.dataset.url;
    fig.hidden = true;
  }
}

/**
 * A PDF's first page in the figure before the library reads the file, drawn by the page's own pdf.js; the frames come
 * with the result. When pdf.js cannot open the file (damaged, or a password not given or not right) no figure is
 * shown and the read goes on as before.
 */
async function showPdf(cur, password) {
  const t0 = performance.now();
  let task = null;
  try {
    const { mod, params } = await pdfReader();
    task = mod.getDocument({ data: new Uint8Array(await cur.file.arrayBuffer()), isEvalSupported: false, verbosity: 0, ...params, ...(password !== undefined ? { password } : {}) });
    const doc = await task.promise;
    cur.pdf = pdfOpen = { task, doc, total: doc.numPages, index: 0, pages: null };
    // laid out but not painted until the page is in it (the room it gets decides how sharp the page is drawn)
    const shell = placeFigure() ? $('result') : $('figure');
    shell.style.visibility = 'hidden';
    if (shell === $('result')) $('result').hidden = false;
    $('figure').hidden = false;
    $('image').hidden = true;
    $('page').hidden = false;
    try {
      await drawPdfPage(cur, 1);
    } finally {
      shell.style.visibility = '';
    }
    if (shell === $('result')) {
      // the whole page on screen while it is read, the time to come beside it
      $('reading').textContent = `Reading ${cur.job.name}…`;
      $('reading').hidden = false;
      $('result').scrollIntoView({ block: 'start' });
    }
    cur.job.pdfPage = { ms: performance.now() - t0, ...cur.pdf.drawn };
  } catch (e) {
    task?.destroy().catch(() => {});
    if (pdfOpen?.task === task) pdfOpen = null;
    cur.pdf = null;
    cur.job.pdfPage = { ms: performance.now() - t0, error: errorRecord(e) };
    $('figure').hidden = true;
    $('page').hidden = true;
    placeFigure();
    $('result').hidden = true;
  }
}

/** Page n (1-based) of the open PDF into the figure, as sharp as this screen shows it, at most convert()'s 150 dpi. */
async function drawPdfPage(cur, n) {
  const page = await cur.pdf.doc.getPage(n);
  try {
    const one = page.getViewport({ scale: 1 });
    const canvas = $('page');
    const room = $('result').classList.contains('with-page') ? canvas.parentElement.clientWidth : $('figure').parentElement.clientWidth;
    const css = Math.min(room / one.width, (parseFloat(getComputedStyle(canvas).maxHeight) || Infinity) / one.height);
    const scale = Math.max(0.25, Math.min(PDF_SCALE, css * (window.devicePixelRatio || 1)));
    const vp = page.getViewport({ scale });
    const off = document.createElement('canvas');
    off.width = Math.ceil(vp.width);
    off.height = Math.ceil(vp.height);
    const ctx = off.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, off.width, off.height);
    await page.render({ canvasContext: ctx, canvas: off, viewport: vp }).promise;
    // into the shown canvas in one step: a page never shows half drawn
    canvas.width = off.width;
    canvas.height = off.height;
    canvas.getContext('2d').drawImage(off, 0, 0);
    watchSize();
    cur.pdf.drawn = { page: n, scale, width: off.width, height: off.height };
    $('caption').textContent = `Page ${n} of ${cur.pdf.total}`;
  } finally {
    page.cleanup();
  }
}

function closePdf() {
  pdfOpen?.task.destroy().catch(() => {});
  pdfOpen = null;
}

/** Frames of the blocks convert() found on the page shown, colored by block type, and the legend under the page. */
function framePage(cur) {
  const p = cur.pdf.pages[cur.pdf.index];
  const g = document.createElementNS(SVG, 'g');
  // an OCR page is read after it is turned back by its skew: the frames turn with the page as drawn
  if (p.skew) g.setAttribute('transform', `rotate(${p.skew} ${p.width / 2} ${p.height / 2})`);
  const count = {};
  for (const b of p.blocks) {
    const [x0, y0, x1, y1] = b.type === 'table' && p.tables[b.table] ? p.tables[b.table].bbox : b.bbox;
    g.append(rect(x0, y0, x1, y1, `block ${b.type}`));
    count[b.type] = (count[b.type] ?? 0) + 1;
  }
  $('boxes').replaceChildren(g);
  pageSpace = { width: p.width, height: p.height };
  fitBoxes();
  const keys = KINDS.filter(([t]) => count[t]).map(([t, one, many]) => Object.assign(document.createElement('span'), { className: `key ${t}`, textContent: `${count[t]} ${count[t] === 1 ? one : many}` }));
  $('legend').replaceChildren(...keys);
  $('legend').hidden = !keys.length;
  paintPager();
}

/** Previous and next page, for a PDF with more than one page read; not while a job runs (no page is drawn during a read). */
function paintPager() {
  const pdf = current?.pdf;
  const n = pdf?.pages?.length ?? 0;
  $('pager').hidden = n < 2;
  if (n < 2) return;
  $('prev').disabled = pending > 0 || pdf.index === 0;
  $('next').disabled = pending > 0 || pdf.index >= n - 1;
}

function turnPage(step) {
  const cur = current;
  const i = (cur?.pdf?.index ?? 0) + step;
  if (!cur?.pdf?.pages || i < 0 || i >= cur.pdf.pages.length) return;
  const n = cur.pdf.pages[i].page;
  enqueue(async () => {
    if (cur !== current || !cur.pdf) return;
    await drawPdfPage(cur, n);
    cur.pdf.index = i;
    framePage(cur);
  }).catch((e) => {
    if (cur === current) addResultNote(`Page ${n} could not be drawn: ${e?.message ?? e}`);
  });
}

/**
 * On a narrow screen a PDF's page sits in the result, beside the time, so the page, the time and the top of the
 * result fit one phone screen; otherwise the figure stays under the input. Returns whether the page is beside the time.
 */
function placeFigure() {
  const fig = $('figure');
  const side = narrow.matches && !!current?.pdf;
  $('result').classList.toggle('with-page', side);
  if (side && fig.parentElement !== $('result')) $('result').prepend(fig);
  if (!side && fig.parentElement === $('result')) document.querySelector('.examples').after(fig);
  return side;
}

function showResult() {
  $('result').hidden = false;
}

/** On a narrow screen, bring the image (or the result) to the top once the job has drawn everything. */
function reveal() {
  if (!narrow.matches || $('result').hidden) return;
  const top = $('figure').hidden || $('result').classList.contains('with-page') ? $('result') : $('figure');
  requestAnimationFrame(() => top.scrollIntoView({ block: 'start' }));
}

function showTime(ms, detail) {
  showResult();
  $('error').hidden = true;
  $('output').hidden = false;
  const t = $('took');
  const v = ms < 1000 ? `${Math.round(ms)}` : (ms / 1000).toFixed(ms < 10000 ? 2 : 1);
  // the number and its unit stay together (a narrow column puts them under "Read in")
  const value = Object.assign(document.createElement('span'), { className: 'value' });
  value.append(`${v} `, Object.assign(document.createElement('span'), { className: 'unit', textContent: ms < 1000 ? 'ms' : 's' }));
  t.replaceChildren('Read in ', value);
  $('took-detail').textContent = detail;
}

function addResultNote(text) {
  const p = document.createElement('p');
  p.className = 'tab-note result-note';
  p.textContent = text;
  $('output').before(p);
}

/**
 * The boxes layer takes the file's own pixels as its coordinates (an image's natural size; a PDF page's size in
 * convert()'s pixels) and the shown size as its size.
 */
function fitBoxes() {
  const onPage = !$('page').hidden;
  const shown = onPage ? $('page') : $('image');
  const space = onPage ? pageSpace : { width: shown.naturalWidth, height: shown.naturalHeight };
  const svg = $('boxes');
  if (!space?.width) return;
  svg.setAttribute('viewBox', `0 0 ${space.width} ${space.height}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.style.width = `${shown.clientWidth}px`;
  svg.style.height = `${shown.clientHeight}px`;
}
let resizeWatch = null;
function watchSize() {
  if (resizeWatch) return;
  resizeWatch = new ResizeObserver(fitBoxes);
  resizeWatch.observe($('image'));
  resizeWatch.observe($('page'));
}

function rect(x0, y0, x1, y1, cls) {
  const r = document.createElementNS(SVG, 'rect');
  r.setAttribute('x', x0);
  r.setAttribute('y', y0);
  r.setAttribute('width', Math.max(1, x1 - x0));
  r.setAttribute('height', Math.max(1, y1 - y0));
  r.setAttribute('rx', 2);
  if (cls) r.setAttribute('class', cls);
  return r;
}

function drawBoxes(lines) {
  const img = $('image');
  const svg = $('boxes');
  svg.replaceChildren(...lines.map((l, i) => {
    const b = l.bbox;
    const r = rect(b.x0, b.y0, b.x1, b.y1);
    r.dataset.i = i;
    return r;
  }));
  if (img.complete) fitBoxes();
  img.onload = fitBoxes;
  watchSize();
}

function selectTab(tab) {
  ui.tab = tab;
  if (tab !== 'text' && current) ensureDoc(current);
  paint();
}

/** Fill the selected tab from the current result. */
function paint() {
  if (!current) return;
  for (const t of document.querySelectorAll('.tab')) t.setAttribute('aria-selected', String(t.dataset.tab === ui.tab));
  const cur = current;
  const panes = { text: $('pane-text'), md: $('pane-md'), mdSource: $('pane-md-source'), json: $('pane-json') };
  for (const p of Object.values(panes)) p.hidden = true;
  $('source-toggle').hidden = ui.tab !== 'md';
  const note = $('tab-note');
  note.hidden = true;
  const content = tabContent(cur);
  if (content === null) {
    note.hidden = false;
    note.textContent = cur.docError ? `Markdown and JSON could not be made: ${cur.docError.message}` : 'Reading the layout for Markdown and JSON…';
    return;
  }
  if (cur.kind === 'image' && ui.tab !== 'text' && cur.doc) {
    note.hidden = false;
    note.textContent = `Markdown and JSON from convert(): ${formatMs(cur.doc.ms)}.`;
  }
  if (ui.tab === 'text') {
    panes.text.hidden = false;
    if (cur.kind === 'image') {
      const lines = cur.lines ?? [];
      if (!lines.length) panes.text.replaceChildren(Object.assign(document.createElement('p'), { className: 'empty', textContent: 'No text was found in this image.' }));
      else panes.text.replaceChildren(...lines.map((l, i) => lineEl(l.text.replace(/\n$/, ''), i)));
    } else {
      const pages = content.split('\f');
      const out = [];
      pages.forEach((t, k) => {
        if (pages.length > 1) out.push(Object.assign(document.createElement('p'), { className: 'page-mark', textContent: `Page ${k + 1}` }));
        for (const line of t.split('\n')) out.push(Object.assign(document.createElement('div'), { className: 'line', textContent: line || ' ' }));
      });
      panes.text.replaceChildren(...out);
    }
  } else if (ui.tab === 'md') {
    if (ui.source) {
      panes.mdSource.hidden = false;
      panes.mdSource.textContent = content;
    } else {
      panes.md.hidden = false;
      renderMarkdown(content, panes.md);
    }
  } else {
    panes.json.hidden = false;
    panes.json.textContent = content;
  }
}

/** The text of the selected tab, or null while it is being made. */
function tabContent(cur) {
  if (ui.tab === 'text') return cur.kind === 'image' ? (cur.text ?? '') : (cur.doc?.text ?? '');
  if (!cur.doc) return null;
  return ui.tab === 'md' ? cur.doc.md : cur.doc.json;
}

function lineEl(text, i) {
  const d = document.createElement('div');
  d.className = 'line';
  d.textContent = text;
  const rect = () => $('boxes').querySelector(`rect[data-i="${i}"]`);
  d.addEventListener('mouseenter', () => rect()?.classList.add('hot'));
  d.addEventListener('mouseleave', () => rect()?.classList.remove('hot'));
  return d;
}

async function copyTab() {
  const text = current && tabContent(current);
  if (text === null || text === undefined) return;
  try {
    await navigator.clipboard.writeText(text);
    flash($('copy'), 'Copied');
  } catch {
    flash($('copy'), 'Not allowed');
  }
}

function downloadTab() {
  const text = current && tabContent(current);
  if (text === null || text === undefined) return;
  const ext = ui.tab === 'json' ? 'json' : ui.tab === 'md' ? 'md' : 'txt';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: ui.tab === 'json' ? 'application/json' : 'text/plain' }));
  a.download = `${current.job.name.replace(/\.[^.]+$/, '') || 'result'}.${ext}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function flash(button, text) {
  const was = button.textContent;
  button.textContent = text;
  setTimeout(() => { button.textContent = was; }, 1200);
}

// ---- small helpers ----

function setStatus(kind, text) {
  $('status').className = `status ${kind}`;
  $('status-text').textContent = text;
  demoState.status = text;
}

function note(text) {
  if (demoState.notes.includes(text)) return;
  demoState.notes.push(text);
  const li = document.createElement('li');
  li.textContent = text;
  $('notes').append(li);
}

const formatMs = (ms) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`);

function session(key, value) {
  try {
    if (value === undefined) return sessionStorage.getItem(key);
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch {
    return null;
  }
  return null;
}

/** A one-page PDF with nothing on it (1 x 1 inch): reading it loads pdf.js and the OCR models. */
function blankPdf() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 72 72] /Resources << >> /Contents 4 0 R >>',
    '<< /Length 0 >>\nstream\n\nendstream',
  ];
  let s = '%PDF-1.4\n';
  const offsets = objects.map((o, i) => {
    const at = s.length;
    s += `${i + 1} 0 obj\n${o}\nendobj\n`;
    return at;
  });
  const xref = s.length;
  s += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  s += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(s);
}
