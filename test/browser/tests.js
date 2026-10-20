// Browser test cases. The runner (test/browser.mjs) opens page.html under /coi/, /plain/ or /csp/ and
// calls window.tests[name](cfg); each case returns { ok, ...details } or throws.
import * as ocr from '../../dist/index.js';

const MODELS = new URL('../../models/', location.href).href;
const WASM = new URL('../../wasm/', location.href).href;
const FIX = new URL('../fixtures/', location.href).href;
const DOCS = new URL('../out/fixtures/', location.href).href; // node test/fixtures/make-pdfs.mjs
const PDFJS = new URL('../../node_modules/pdfjs-dist/', location.href).href;
const LLM_WASM = new URL('../../node_modules/@litert-lm/core/wasm/', location.href).href;
const local = (extra = {}) => ({ modelBase: MODELS, wasmPath: WASM, ...extra });
const RECEIPT_SCHEMA = {
  type: 'object',
  properties: {
    store_name: { type: 'string', description: 'Merchant name as printed' },
    items: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, quantity: { type: 'string' }, price: { type: 'string' } }, required: ['name', 'price'] } },
    total: { type: 'string', description: 'Total amount to pay as printed' },
  },
  required: ['items', 'total'],
};
const converters = new Map();
/** One converter per layout setting for the whole page (local model files, local pdf.js). */
function converter({ layoutBase = null } = {}) {
  const key = String(layoutBase);
  if (!converters.has(key)) converters.set(key, ocr.createConverter({ ...local(), pdfjsPath: PDFJS, ...(layoutBase ? { layoutModelBase: layoutBase } : {}) }));
  return converters.get(key);
}
let expected = null;
let shared = null;
const log = [];

async function fixtures() {
  expected ??= await (await fetch(FIX + 'expected.json')).json();
  return expected;
}

async function worker(extra) {
  if (extra) return ocr.createWorker('eng', 1, local({ logger: (m) => log.push(m), ...extra }));
  shared ??= await ocr.createWorker('eng', 1, local({ logger: (m) => log.push(m) }));
  return shared;
}

/** Share of expected lines found exactly among the output lines (each output line used once). */
function lineMatch(text, want) {
  const got = text.split('\n').map((s) => s.trim()).filter(Boolean);
  const pool = new Map();
  for (const g of got) pool.set(g, (pool.get(g) ?? 0) + 1);
  let hit = 0;
  const missed = [];
  for (const w of want) {
    if (pool.get(w)) { pool.set(w, pool.get(w) - 1); hit++; } else missed.push(w);
  }
  return { rate: hit / want.length, hit, n: want.length, got: got.length, missed };
}

async function expectError(fn, code, mustInclude = []) {
  try {
    await fn();
  } catch (e) {
    const okCode = e?.code === code;
    const okText = mustInclude.every((s) => String(e?.message).includes(s));
    return { ok: okCode && okText, code: e?.code, name: e?.name, message: e?.message };
  }
  return { ok: false, message: 'no error' };
}

function canvasWithText(w, h, lines, font) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const x = c.getContext('2d');
  x.fillStyle = '#fff'; x.fillRect(0, 0, w, h);
  x.fillStyle = '#111'; x.font = font; x.textBaseline = 'middle';
  lines.forEach((t, i) => x.fillText(t, Math.round(w * 0.04), Math.round(((i + 0.5) * h) / lines.length)));
  return c;
}

const loadImg = (src, cross) => new Promise((ok, bad) => {
  const i = new Image();
  if (cross) i.crossOrigin = cross;
  i.onload = () => ok(i);
  i.onerror = () => bad(new Error('img load failed: ' + src));
  i.src = src;
});

window.tests = {
  async env() {
    const w = await worker();
    const notices = log.filter((m) => m.status === 'notice').map((m) => m.message);
    const initialized = log.find((m) => m.status === 'initialized')?.message;
    return { ok: true, info: w.info, initialized, notices, crossOriginIsolated: self.crossOriginIsolated, ua: navigator.userAgent, hc: navigator.hardwareConcurrency };
  },

  // threshold: share of the expected lines read exactly (the runner passes 0.85 for WebKit, which draws image pixels
  // differently from Chrome: r4 measured 287 of 335 lines identical to Chrome on 12 images, the WebAssembly code is the same)
  async fixtures({ threshold = 0.95 } = {}) {
    const exp = await fixtures();
    const w = await worker();
    const out = {};
    let ok = true;
    for (const [file, e] of Object.entries(exp)) {
      const t0 = performance.now();
      const r = await w.recognize(FIX + file);
      const m = lineMatch(r.data.text, e.lines);
      out[file] = { ms: Math.round(performance.now() - t0), ...m, confidence: r.data.confidence };
      if (m.rate < threshold) ok = false;
    }
    return { ok, threshold, info: w.info, out };
  },

  async outputs() {
    const w = await worker();
    const exp = await fixtures();
    const r = await w.recognize(FIX + 'settings-dark.png', {}, { blocks: true, hocr: true, tsv: true });
    const d = r.data;
    const lines = d.blocks?.[0]?.paragraphs?.[0]?.lines ?? [];
    const words = lines.flatMap((l) => l.words);
    const syms = words.flatMap((x) => x.symbols);
    const W = exp['settings-dark.png'].width, H = exp['settings-dark.png'].height;
    const inImg = (b) => b.x0 >= 0 && b.y0 >= 0 && b.x1 <= W && b.y1 <= H && b.x1 >= b.x0 && b.y1 >= b.y0;
    const conf = (c) => c >= 0 && c <= 100;
    const tsvRows = d.tsv.trim().split('\n');
    const checks = {
      jobId: typeof r.jobId === 'string' && r.jobId.length > 0,
      blocks: Array.isArray(d.blocks) && d.blocks.length === 1,
      lineTextsMatchText: lines.map((l) => l.text).join('') === d.text,
      wordsJoinToLine: lines.every((l) => l.words.map((x) => x.text).join(' ') === l.text.trim().replace(/\s+/g, ' ')),
      bboxesInside: [...lines, ...words, ...syms].every((x) => inImg(x.bbox)),
      confidences: [...lines, ...words, ...syms].every((x) => conf(x.confidence)) && conf(d.confidence),
      symbolsPerWord: words.every((x) => x.symbols.length === [...x.text].length),
      hocr: /class='ocr_page'/.test(d.hocr) && (d.hocr.match(/class='ocrx_word'/g) ?? []).length === words.length,
      tsv: tsvRows.length === 3 + lines.length + words.length && tsvRows.every((row) => row.split('\t').length === 12),
      nullFormats: [d.box, d.unlv, d.osd, d.pdf, d.imageColor, d.imageGrey, d.imageBinary].every((v) => v === null),
      defaultOutputHasNoBlocks: (await w.recognize(FIX + 'mobile.png')).data.blocks === null,
    };
    return { ok: Object.values(checks).every(Boolean), checks, nLines: lines.length, nWords: words.length, firstWord: words[0], version: d.version };
  },

  async inputs({ close = 0.95 } = {}) {
    const w = await worker();
    const url = FIX + 'mobile.png';
    const base = (await w.recognize(url)).data.text;
    const blob = await (await fetch(url)).blob();
    const buf = await blob.arrayBuffer();
    const img = await loadImg(url);
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const off = new OffscreenCanvas(canvas.width, canvas.height);
    off.getContext('2d').drawImage(img, 0, 0);
    const bitmap = await createImageBitmap(blob);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const dataUrl = await new Promise((ok) => { const fr = new FileReader(); fr.onload = () => ok(fr.result); fr.readAsDataURL(blob); });
    const blobUrl = URL.createObjectURL(blob);
    const cases = {
      'relative URL': '../fixtures/mobile.png', 'data URL': dataUrl, 'blob: URL': blobUrl, Blob: blob, File: new File([blob], 'mobile.png', { type: 'image/png' }),
      ArrayBuffer: buf, Uint8Array: new Uint8Array(buf), HTMLImageElement: img, HTMLCanvasElement: canvas, CanvasRenderingContext2D: ctx,
      OffscreenCanvas: off, ImageBitmap: bitmap, ImageData: imageData, '{data,width,height}': { data: imageData.data, width: imageData.width, height: imageData.height },
    };
    const out = {};
    const diffs = {};
    const want = (await fixtures())['mobile.png'].lines;
    for (const [k, v] of Object.entries(cases)) {
      try {
        const t = (await w.recognize(v)).data.text;
        if (t === base) out[k] = 'same';
        else {
          // a GPU-backed canvas can hand over slightly different pixels than the decoded file: then the
          // expected lines must still be read (>= 95 %), and the differing lines are recorded
          const m = lineMatch(t, want);
          out[k] = m.rate >= close ? 'close' : 'DIFFERENT';
          const a = base.split('\n'), b = t.split('\n');
          diffs[k] = { rate: m.rate, onlyBase: a.filter((x) => !b.includes(x)), onlyThis: b.filter((x) => !a.includes(x)) };
        }
      } catch (e) {
        out[k] = `ERROR ${e.code}: ${e.message}`;
      }
    }
    out['ImageBitmap still usable'] = bitmap.width > 0 ? 'same' : 'DETACHED';
    return { ok: Object.values(out).every((v) => v === 'same' || v === 'close'), out, diffs };
  },

  async rectangle() {
    const w = await worker();
    const full = await w.recognize(FIX + 'settings-dark.png', {}, { blocks: true });
    const rect = { left: 0, top: 0, width: 240, height: 450 };
    const r = await w.recognize(FIX + 'settings-dark.png', { rectangle: rect }, { blocks: true });
    const lines = r.data.blocks[0].paragraphs[0].lines;
    const inside = lines.every((l) => l.bbox.x1 <= rect.width + 2 && l.bbox.y1 <= rect.height + 2);
    const fullLeft = full.data.blocks[0].paragraphs[0].lines.filter((l) => l.bbox.x1 <= 240 && l.bbox.y1 <= 450).map((l) => l.text);
    const same = JSON.stringify(lines.map((l) => l.text)) === JSON.stringify(fullLeft);
    return { ok: inside && lines.length > 5, inside, sameAsFullLeftColumn: same, lines: lines.map((l) => l.text.trim()) };
  },

  async whitelist() {
    const w = await worker();
    await w.setParameters({ tessedit_char_whitelist: '0123456789' });
    const r = await w.recognize(FIX + 'mobile.png');
    await w.setParameters({ tessedit_char_whitelist: '' });
    const after = await w.recognize(FIX + 'mobile.png');
    const set = await w.setParameters({ preserve_interword_spaces: '1' });
    return { ok: /^[0-9\n]+$/.test(r.data.text) && /[A-Za-z]/.test(after.data.text) && set.data.ignored.includes('preserve_interword_spaces'), digitsOnly: r.data.text, ignored: set.data.ignored };
  },

  async singleLine() {
    const w = await worker();
    const c = canvasWithText(700, 64, ['Invoice 2026-0412 total 84.15'], '32px Arial');
    const r = await w.recognize(c, { tessedit_pageseg_mode: ocr.PSM.SINGLE_LINE });
    const auto = await w.recognize(c);
    return { ok: r.data.text.trim() === 'Invoice 2026-0412 total 84.15', singleLine: r.data.text, auto: auto.data.text };
  },

  async bigImage() {
    const w = await worker();
    // 6000 x 4000: read at 4096 x 2731 (a moderate aspect ratio: the detector input is the image stretched to 640 x 640)
    const c = canvasWithText(6000, 4000, ['Large image test line one', 'Second line of large text', 'Third line at the bottom'], '220px Arial');
    const notices = [];
    const big = await ocr.createWorker('eng', 1, local({ logger: (m) => m.status === 'notice' && notices.push(m.message) }));
    const r = await big.recognize(c, {}, { blocks: true });
    await big.terminate();
    const lines = r.data.blocks?.[0]?.paragraphs[0].lines ?? [];
    const inside = lines.every((l) => l.bbox.x1 <= 6000 && l.bbox.y1 <= 4000);
    const wide = lines.some((l) => l.bbox.x1 - l.bbox.x0 > 1500);
    void w;
    return { ok: /Large image test line one/.test(r.data.text) && inside && wide && notices.some((n) => n.includes('4096')), text: r.data.text, boxes: lines.map((l) => l.bbox), notices };
  },

  async scheduler() {
    const s = ocr.createScheduler();
    const w1 = await ocr.createWorker('eng', 1, local());
    const w2 = await ocr.createWorker('eng', 1, local());
    s.addWorker(w1); s.addWorker(w2);
    const files = ['mobile.png', 'dialog-shared.jpg', 'mobile.png', 'settings-dark.png'];
    const rs = await Promise.all(files.map((f) => s.addJob('recognize', FIX + f)));
    const out = { n: s.getNumWorkers(), queue: s.getQueueLen(), lengths: rs.map((r) => r.data.text.length) };
    await s.terminate();
    const after = await expectError(() => w1.recognize(FIX + 'mobile.png'), 'WORKER_TERMINATED');
    return { ok: out.n === 2 && out.queue === 0 && rs.every((r) => r.data.text.length > 20) && after.ok, ...out };
  },

  async oldRecognize() {
    const r = await ocr.recognize(FIX + 'mobile.png', 'eng', local());
    return { ok: /Electricity Bill/.test(r.data.text), jobId: r.jobId };
  },

  async logger() {
    const seen = new Set(log.map((m) => m.status));
    const keys = log.every((m) => typeof m.workerId === 'string' && typeof m.jobId === 'string' && typeof m.progress === 'number');
    const init = log.find((m) => m.status === 'initialized');
    return { ok: keys && ['loading runtime', 'loading model', 'initializing model', 'initialized', 'recognizing text'].every((s) => seen.has(s)), statuses: [...seen], initialized: init?.message, notices: log.filter((m) => m.status === 'notice').map((m) => m.message) };
  },

  async langs() {
    const both = await ocr.createWorker('eng+jpn', 1, local());
    const arr = await ocr.createWorker(['jpn', 'eng'], 1, local());
    await both.terminate();
    await arr.terminate();
    const kor = await expectError(() => ocr.createWorker('kor', 1, local()), 'LANG_NOT_SUPPORTED', ['Hangul']);
    const typo = await expectError(() => ocr.createWorker('englsh', 1, local()), 'LANG_NOT_SUPPORTED', ['Unknown language code']);
    return { ok: kor.ok && typo.ok, kor: kor.message, typo: typo.message };
  },

  // Why the worker is classic: a module worker cannot call importScripts(), which LiteRT.js 2.5.3's loader uses.
  async moduleWorkerProbe() {
    const imported = URL.createObjectURL(new Blob(['0'], { type: 'text/javascript' }));
    const src = `try { importScripts(${JSON.stringify(imported)}); postMessage('importScripts worked'); } catch (e) { postMessage(String(e)); }`;
    const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    const run = (type) => new Promise((ok) => { const w = new Worker(url, { type }); w.onmessage = (e) => { ok(e.data); w.terminate(); }; w.onerror = (e) => ok('error event: ' + e.message); });
    const moduleResult = await run('module');
    const classicResult = await run('classic');
    return { ok: classicResult === 'importScripts worked' && moduleResult !== 'importScripts worked', module: moduleResult, classic: classicResult };
  },

  // recognizer: 'webgpu' with a 320 file that has no #9661 fault (given by the runner): every fixture must read
  // the same as the WebAssembly recognizer; without that file the 320 recognizer must stay on WebAssembly.
  async webgpuRecognizer({ rec320Url, rec320Sha, mode }) {
    if (!rec320Url) return { ok: true, skipped: 'set LITERT_OCR_TEST_REC320 (and _SHA256) to a rewritten 320 file to run this case' };
    const exp = await fixtures();
    const wasm = await worker();
    const gpu = await ocr.createWorker('eng', 1, local({ recognizer: 'webgpu', modelFiles: { rec320: { url: rec320Url, sha256: rec320Sha } } }));
    const out = {};
    let same = true;
    for (const file of Object.keys(exp)) {
      const a = (await wasm.recognize(FIX + file)).data.text;
      const t0 = performance.now();
      const b = (await gpu.recognize(FIX + file)).data.text;
      out[file] = { same: a === b, ms: Math.round(performance.now() - t0) };
      if (a !== b) {
        same = false;
        const al = a.split('\n'), bl = b.split('\n');
        out[file].onlyWasm = al.filter((x) => !bl.includes(x));
        out[file].onlyWebgpu = bl.filter((x) => !al.includes(x));
      }
    }
    const info = gpu.info;
    await gpu.terminate();
    const plain = await ocr.createWorker('eng', 1, local({ recognizer: 'webgpu' }));
    const plainInfo = plain.info;
    await plain.terminate();
    const want = mode === 'wasm' ? 'wasm' : 'webgpu';
    return { ok: same && info.recognizers['320'] === want && info.recognizers['640'] === want && plainInfo.recognizers['320'] === 'wasm', info, plainInfo, out };
  },

  // recognizer 'auto' (the default). The runner names what this browser and page must choose (`expect`):
  //   'webgpu'      WebAssembly has 1 thread, a WebGPU device exists and the WebGPU form of the 320 file is given
  //                 (rec320Url): the check line reads the same, every fixture and a long line (640 / 960) read the same
  //                 text as recognizer 'wasm'
  //   'threads'     WebAssembly has several threads: WebAssembly, no check
  //   'nogpu'       1 thread, no WebGPU device: WebAssembly, no check
  //   'unpublished' 1 thread, WebGPU, no WebGPU form of the 320 file: WebAssembly, no check
  async recognizerAuto({ rec320Url, rec320Sha, expect }) {
    const notices = [];
    const opts = rec320Url ? { modelFiles: { rec320: { url: rec320Url, sha256: rec320Sha } } } : {};
    const auto = await ocr.createWorker('eng', 1, local({ ...opts, logger: (m) => m.status === 'notice' && notices.push(m.message) }));
    const info = auto.info;
    const said = notices.filter((n) => n.startsWith('Recognizer on'));
    const reasonOk = { webgpu: /read the check line exactly as WebAssembly/, threads: /runs on \d+ threads here/, nogpu: /no WebGPU device/, unpublished: /not published yet/ }[expect];
    let ok = said.length === 1 && reasonOk.test(info.recognizerReason) && said[0].includes(info.recognizerReason);
    const out = { expect, info, notice: said[0] ?? null };
    if (expect === 'webgpu') {
      ok &&= info.recognizer === 'webgpu' && info.recognizerCheck?.differing === 0 && /Total|8,415|合計/.test(info.recognizerCheck.text);
      const wasm = await ocr.createWorker('eng', 1, local({ recognizer: 'wasm' }));
      const long = canvasWithText(2100, 80, ['The quick brown fox jumps over the lazy dog while 12 bakers count 3,456 loaves of bread'], '44px Arial');
      const images = { ...Object.fromEntries(Object.keys(await fixtures()).map((f) => [f, FIX + f])), 'long line (640 and 960)': long };
      out.same = {};
      for (const [k, img] of Object.entries(images)) {
        const a = (await wasm.recognize(img)).data.text;
        const b = (await auto.recognize(img)).data.text;
        out.same[k] = a === b ? true : { wasm: a.split('\n').filter((x) => !b.includes(x)), webgpu: b.split('\n').filter((x) => !a.includes(x)) };
      }
      await wasm.terminate();
      out.laterNotices = notices.filter((n) => /recognizer read the check line differently|could not run the \d+-wide recognizer/.test(n));
      ok &&= Object.values(out.same).every((v) => v === true) && out.laterNotices.length === 0;
    } else {
      ok &&= info.recognizer === 'wasm' && info.recognizerCheck === null;
      ok &&= /Electricity Bill/.test((await auto.recognize(FIX + 'mobile.png')).data.text);
    }
    await auto.terminate();
    return { ok, ...out };
  },
  // the check made to see a differing output (a test hook): the recognizer stays on WebAssembly and says why
  async recognizerAutoMismatch({ rec320Url, rec320Sha }) {
    const w = await ocr.createWorker('eng', 1, local({ modelFiles: { rec320: { url: rec320Url, sha256: rec320Sha } }, _recognizerCheck: 'mismatch' }));
    const info = w.info;
    const text = (await w.recognize(FIX + 'mobile.png')).data.text;
    await w.terminate();
    const ok = info.recognizer === 'wasm' && info.recognizerCheck?.differing >= 1 && /read the check line differently/.test(info.recognizerReason) && /Electricity Bill/.test(text);
    return { ok, info };
  },

  // ---- a PNG or JPEG cut short: a notice in every browser; the browser decides whether it reads the part that arrived
  async cutShortNotice() {
    const notices = [];
    const w = await ocr.createWorker('eng', 1, local({ logger: (m) => m.status === 'notice' && notices.push(m.message) }));
    const png = new Uint8Array(await (await fetch(FIX + 'mobile.png')).arrayBuffer());
    const jpg = new Uint8Array(await (await fetch(FIX + 'dialog-shared.jpg')).arrayBuffer());
    const cases = {
      'PNG, first half': [new Blob([png.slice(0, png.length >> 1)], { type: 'image/png' }), true],
      'JPEG, first half': [new Blob([jpg.slice(0, jpg.length >> 1)], { type: 'image/jpeg' }), true],
      'PNG, whole': [new Blob([png], { type: 'image/png' }), false],
      'JPEG with 4 KB after its end marker': [new Blob([jpg, new Uint8Array(4096).fill(7)], { type: 'image/jpeg' }), false],
    };
    const out = {};
    for (const [k, [blob, cut]] of Object.entries(cases)) {
      const n0 = notices.length;
      let result;
      try {
        const r = await w.recognize(blob);
        result = { read: true, lines: r.data.text.split('\n').filter(Boolean).length };
      } catch (e) {
        result = { read: false, code: e.code, message: e.message };
      }
      const said = notices.slice(n0).filter((m) => /cut short/.test(m));
      const ok = cut
        ? said.length === 1 && (result.read || (result.code === 'IMAGE_DECODE_FAILED' && /cut short/.test(result.message)))
        : said.length === 0 && result.read && result.lines > 3;
      out[k] = { ok, ...result, notice: said[0] ?? null };
    }
    const still = /Electricity Bill/.test((await w.recognize(FIX + 'mobile.png')).data.text);
    await w.terminate();
    return { ok: Object.values(out).every((x) => x.ok) && still, out, workerStillWorks: still };
  },

  // ---- model files cached in the background after the first result, then a visit with the network gone ------
  // (r4: after one image online, 7 of 13 images failed offline because the 960-wide recognizer was never stored)
  async cacheReset() {
    const names = await caches.keys();
    for (const n of names) await caches.delete(n);
    return { ok: true, deleted: names };
  },
  async prefetchFirst({ prefetch }) {
    const log = [];
    let settled;
    const cached = new Promise((r) => { settled = r; });
    const w = await ocr.createWorker('eng', 1, local({ ...(prefetch ? {} : { prefetch: false }), logger: (m) => { log.push(m); if (m.status === 'caching model' && m.progress === 1) settled(m); } }));
    const t0 = performance.now();
    const r = await w.recognize(FIX + 'mobile.png');
    const firstMs = Math.round(performance.now() - t0);
    let final = null;
    if (prefetch) final = await Promise.race([cached, new Promise((ok) => setTimeout(() => ok(null), 90000))]);
    const cachingMs = Math.round(performance.now() - t0);
    await w.terminate();
    const caching = log.filter((m) => m.status === 'caching model');
    const files = [...new Set(caching.map((m) => m.file).filter(Boolean))];
    const ok = /Electricity Bill/.test(r.data.text) && (prefetch ? !!final && /^All \d+ model and runtime files are in the cache/.test(final.message) && files.includes('ppocrv6_small_rec_960_fp32.tflite') : caching.length === 0);
    return { ok, prefetch, firstMs, cachingMs, final: final?.message ?? null, cachedInBackground: files };
  },
  async offlinePrepare() {
    const exp = await fixtures();
    window.__blobs = {};
    for (const f of Object.keys(exp)) window.__blobs[f] = await (await fetch(FIX + f)).blob();
    return { ok: true, files: Object.keys(window.__blobs) };
  },
  async prefetchSecond({ expectAll }) {
    // the runner took the network away; the images were fetched before (offlinePrepare)
    const images = { ...window.__blobs, 'long line (640 and 960)': canvasWithText(2100, 80, ['The quick brown fox jumps over the lazy dog while 12 bakers count 3,456 loaves of bread'], '44px Arial') };
    const w = await ocr.createWorker('eng', 1, local());
    const out = {};
    for (const [k, img] of Object.entries(images)) {
      try {
        const r = await w.recognize(img);
        out[k] = { read: true, lines: r.data.text.split('\n').filter(Boolean).length };
      } catch (e) {
        out[k] = { read: false, code: e.code, message: e.message };
      }
    }
    await w.terminate();
    const read = Object.values(out).filter((x) => x.read).length;
    const long = out['long line (640 and 960)'];
    const ok = expectAll
      ? read === Object.keys(images).length
      : !long.read && long.code === 'MODEL_FETCH_FAILED' && /eager: true/.test(long.message) && /not in the cache/.test(long.message);
    return { ok, read, of: Object.keys(images).length, out, onLine: navigator.onLine };
  },

  // ---- failure paths ----------------------------------------------------------------------------------
  async failModel404() {
    return expectError(() => ocr.createWorker('eng', 1, { modelBase: '../../nope/', wasmPath: WASM }), 'MODEL_FETCH_FAILED', ['HTTP 404', 'modelBase']);
  },
  async failSha256() {
    return expectError(() => ocr.createWorker('eng', 1, { modelBase: '../../models-bad/', wasmPath: WASM, cacheMethod: 'none' }), 'MODEL_SHA256_MISMATCH', ['ppocrv6_small_det_640_fp32.tflite', 'sha256']);
  },
  async failWasm404() {
    return expectError(() => ocr.createWorker('eng', 1, { modelBase: MODELS, wasmPath: '../../nope/' }), 'MODEL_FETCH_FAILED', ['HTTP 404', 'wasmPath']);
  },
  async failDefaultBlocked() {
    // the runner aborts every request to huggingface.co and cdn.jsdelivr.net for this case
    return expectError(() => ocr.createWorker('eng', 1, { cacheMethod: 'none' }), 'MODEL_FETCH_FAILED', ['did not complete', 'connect-src']);
  },
  async failOffline() {
    // the runner switches the context offline before this case
    return expectError(() => ocr.createWorker('eng', 1, local({ cacheMethod: 'none' })), 'MODEL_FETCH_FAILED', ['offline']);
  },
  async failDecode() {
    const w = await worker();
    const png = new Uint8Array(await (await fetch(FIX + 'mobile.png')).arrayBuffer());
    // the first 200 bytes of a PNG: no image data at all
    const a = await expectError(() => w.recognize(new Blob([png.slice(0, 200)], { type: 'image/png' })), 'IMAGE_DECODE_FAILED', ['could not decode']);
    const b = await expectError(() => w.recognize(new Blob(['hello, not an image'], { type: 'text/plain' })), 'IMAGE_DECODE_FAILED', ['PNG, JPEG']);
    const still = (await w.recognize(FIX + 'mobile.png')).data.text.length > 20;
    return { ok: a.ok && b.ok && still, truncated: a.message, text: b.message, workerStillWorks: still };
  },
  async failType() {
    const w = await worker();
    const a = await expectError(() => w.recognize(42), 'IMAGE_UNSUPPORTED_TYPE', ['a number']);
    const b = await expectError(() => w.recognize({ foo: 1 }), 'IMAGE_UNSUPPORTED_TYPE', ['Pass a URL']);
    const c = await expectError(() => w.recognize(null), 'IMAGE_UNSUPPORTED_TYPE');
    return { ok: a.ok && b.ok && c.ok, number: a.message, object: b.message };
  },
  async failImage404() {
    const w = await worker();
    return expectError(() => w.recognize('../fixtures/nope.png'), 'IMAGE_FETCH_FAILED', ['HTTP 404']);
  },
  async failCrossOriginFetch({ otherOrigin }) {
    const w = await worker();
    return expectError(() => w.recognize(`${otherOrigin}/plain/test/fixtures/mobile.png`), 'IMAGE_FETCH_FAILED', ['Access-Control-Allow-Origin']);
  },
  async failTaintedImage({ otherOrigin }) {
    const w = await worker();
    const img = await loadImg(`${otherOrigin}/plain/test/fixtures/mobile.png`);
    return expectError(() => w.recognize(img), 'IMAGE_CROSS_ORIGIN', ['crossOrigin']);
  },
  async failRectangle() {
    const w = await worker();
    const a = await expectError(() => w.recognize(FIX + 'mobile.png', { rectangle: { left: 5000, top: 0, width: 10, height: 10 } }), 'INVALID_ARGUMENT', ['does not overlap']);
    const b = await expectError(() => w.recognize(FIX + 'mobile.png', { rectangle: { left: 0, top: 0, width: 'x', height: 10 } }), 'INVALID_ARGUMENT', ['rectangle']);
    return { ok: a.ok && b.ok, outside: a.message, malformed: b.message };
  },
  async failTerminated() {
    const w = await ocr.createWorker('eng', 1, local());
    const t1 = await w.terminate();
    const again = await w.terminate();
    const r = await expectError(() => w.recognize(FIX + 'mobile.png'), 'WORKER_TERMINATED', ['createWorker()']);
    return { ok: t1.data.terminated && again.data.terminated && r.ok, second: again, message: r.message };
  },
  async failErrorHandler() {
    const got = [];
    const w = await ocr.createWorker('eng', 1, local({ errorHandler: (e) => got.push(e.code) }));
    const r = await expectError(() => w.recognize(42), 'IMAGE_UNSUPPORTED_TYPE');
    await w.terminate();
    return { ok: r.ok && got.length === 1 && got[0] === 'IMAGE_UNSUPPORTED_TYPE', got };
  },
  async failDetectAndOutputs() {
    const w = await worker();
    const d = await expectError(() => w.detect(FIX + 'mobile.png'), 'INVALID_ARGUMENT', ['not supported']);
    const warns = [];
    const ow = console.warn;
    console.warn = (...a) => { warns.push(a.join(' ')); };
    const r = await w.recognize(FIX + 'mobile.png', {}, { pdf: true });
    console.warn = ow;
    return { ok: d.ok && r.data.pdf === null && warns.some((x) => x.includes('pdf')), detect: d.message, warns };
  },
  async noCoi() {
    const w = await ocr.createWorker('eng', 1, local({ logger: (m) => log.push(m) }));
    const r = await w.recognize(FIX + 'mobile.png');
    await w.terminate();
    const n = log.filter((m) => m.status === 'notice').map((m) => m.message);
    return { ok: w.info.threads === 1 && n.some((x) => x.includes('Cross-Origin-Opener-Policy') && x.includes('coi-serviceworker')) && /Electricity Bill/.test(r.data.text), info: w.info, notices: n };
  },
  // allowUnblocked (WebKit): a browser that does not apply worker-src 'self' to blob: workers starts the worker
  async cspBlob({ allowUnblocked = false } = {}) {
    let a;
    try {
      const w0 = await ocr.createWorker('eng', 1, local());
      await w0.terminate();
      a = { ok: allowUnblocked, message: 'the blob: worker started (this browser does not apply worker-src to it)' };
    } catch (e) {
      a = { ok: e?.code === 'WORKER_START_FAILED' && ['worker-src', 'workerPath'].every((s) => String(e?.message).includes(s)), code: e?.code, message: e?.message };
    }
    const w = await ocr.createWorker('eng', 1, local({ workerPath: '../../dist/worker.js' }));
    const r = await w.recognize(FIX + 'mobile.png');
    await w.terminate();
    return { ok: a.ok && /Electricity Bill/.test(r.data.text), blocked: a.message, withWorkerPath: w.info };
  },
  async forcedWasm() {
    const w = await ocr.createWorker('eng', 1, local({ backend: 'wasm' }));
    const r = await w.recognize(FIX + 'mobile.png');
    await w.terminate();
    return { ok: w.info.detector === 'wasm' && /Electricity Bill/.test(r.data.text), info: w.info };
  },

  // ---- documents: convert() ---------------------------------------------------------------------------
  async docLayer() {
    const c = converter();
    const r = await c.convert(DOCS + 'report.pdf', { to: 'json' });
    const md = r.document.pages.map((p) => p.markdown).join('\n');
    const ok = r.document.pages.length === 2 && r.document.pages.every((p) => p.status === 'ok' && p.engine === 'layer')
      && /^# Harbor Library Monthly Report$/m.test(md) && /^\| Branch \| Visitors \| Loans \|$/m.test(md) && /Repair the lift at the Hilltop branch\.$/m.test(md)
      && JSON.stringify(r.document.pages[1].tables[0].rows[0]) === '["Day","Hours"]';
    return { ok, version: r.document.version, ms: r.document.pages.map((p) => p.ms), md: md.slice(0, 500) };
  },
  async docScanPdf() {
    const r = await converter().convert(DOCS + 'scan.pdf', { to: 'json', layout: 'geometry' });
    const p = r.document.pages[0];
    return { ok: p.status === 'ok' && p.engine === 'ocr' && /Harbor Library Monthly Report/.test(p.markdown) && /Riverside/.test(p.markdown), layout: p.layout, skew: p.skew, ms: p.ms, md: p.markdown.slice(0, 400) };
  },
  async docImageAuto({ mode, layoutBase }) {
    const c = converter({ layoutBase });
    const r = await c.convert(DOCS + 'scan.jpg', { to: 'json' });
    const p = r.document.pages[0];
    let want;
    if (!layoutBase) want = p.layout.used === 'geometry' && /not published/.test(p.layout.reason ?? '');
    else if (mode === 'webgpu') want = p.layout.used === 'model' && p.layout.backend === 'webgpu' && p.blocks.some((b) => b.type === 'table');
    else want = p.layout.used === 'geometry' && /No WebGPU/.test(p.layout.reason ?? '');
    return { ok: p.status === 'ok' && want && /Old Town/.test(p.markdown), layout: p.layout, blocks: p.blocks.map((b) => `${b.type}${b.role ? ':' + b.role : ''}`), ms: p.ms };
  },
  async docModelForced({ mode, layoutBase }) {
    if (!layoutBase) return { ok: true, skipped: 'no layout model files ($LITERT_OCR_LAYOUT_BASE unset)' };
    const r = await converter({ layoutBase }).convert(DOCS + 'scan.jpg', { to: 'json', layout: 'model' });
    const p = r.document.pages[0];
    const backend = mode === 'webgpu' ? 'webgpu' : 'wasm';
    return { ok: p.status === 'ok' && p.layout.used === 'model' && p.layout.backend === backend && p.blocks.some((b) => b.type === 'heading'), layout: p.layout, ms: p.ms };
  },
  async docLayoutMissing() {
    const seen = [];
    const c = ocr.createConverter({ ...local(), pdfjsPath: PDFJS, layoutModelBase: '../../nope/', logger: (m) => m.status === 'notice' && seen.push(m.message) });
    try {
      const r = await c.convert(DOCS + 'scan.jpg', { to: 'json', layout: 'model' });
      const p = r.document.pages[0];
      return { ok: p.status === 'ok' && p.layout.used === 'geometry' && /could not be used/.test(p.layout.reason ?? '') && seen.some((m) => /layout model could not be used/.test(m)), layout: p.layout, notices: seen };
    } finally {
      await c.terminate();
    }
  },
  async docFailures() {
    const c = converter();
    const out = {
      broken: await expectError(() => c.convert(DOCS + 'broken.pdf'), 'PDF_INVALID', ['damaged']),
      locked: await expectError(() => c.convert(DOCS + 'locked.pdf'), 'PDF_PASSWORD', ['password']),
      long: await expectError(() => c.convert(DOCS + 'long.pdf'), 'DOC_TOO_MANY_PAGES', ["pages: '1-100'"]),
      text: await expectError(() => c.convert(DOCS + 'notes.txt'), 'DOC_UNSUPPORTED_TYPE', ['plain text']),
      zip: await expectError(() => c.convert(DOCS + 'slides.pptx'), 'DOC_UNSUPPORTED_TYPE', ['ZIP']),
      pages: await expectError(() => c.convert(DOCS + 'report.pdf', { pages: 'x' }), 'INVALID_ARGUMENT', ['pages']),
      missing: await expectError(() => c.convert(DOCS + 'nope.pdf'), 'IMAGE_FETCH_FAILED', ['HTTP 404']),
    };
    const pw = await c.convert(DOCS + 'locked.pdf', { password: 'open-sesame' });
    const part = await c.convert(DOCS + 'long.pdf', { pages: '119-', to: 'json' });
    const blank = await c.convert(DOCS + 'blank.pdf', { to: 'json' });
    const extra = /protected by a password/.test(pw.content) && part.document.pages.length === 2 && blank.document.pages[0].status === 'empty';
    return { ok: Object.values(out).every((x) => x.ok) && extra, ...out, blank: blank.document.pages[0] };
  },
  async docPdfjsMissing() {
    const c = ocr.createConverter({ ...local(), pdfjsPath: '../../nope/' });
    try {
      return await expectError(() => c.convert(DOCS + 'report.pdf'), 'PDF_UNAVAILABLE', ['pdf.js', 'HTTP 404']);
    } finally {
      await c.terminate();
    }
  },
  async docInputs() {
    const c = converter();
    const pdf = await (await fetch(DOCS + 'report.pdf')).blob();
    const jpg = await (await fetch(DOCS + 'scan.jpg')).blob();
    const file = new File([pdf], 'report.pdf', { type: 'application/pdf' });
    const a = await c.convert(file, { pages: '2', to: 'json' });
    const b = await c.convert(await pdf.arrayBuffer(), { pages: '2' });
    const bm = await createImageBitmap(jpg);
    const cv = document.createElement('canvas');
    cv.width = bm.width; cv.height = bm.height;
    cv.getContext('2d').drawImage(bm, 0, 0);
    const d = await c.convert(cv, { layout: 'geometry' });
    const ok = a.document.source.name === 'report.pdf' && /Opening hours/.test(a.content) && /Opening hours/.test(b.content) && /Harbor Library/.test(d.content);
    return { ok, name: a.document.source.name };
  },

  // ---- extract() (litert-ocr/extract) -----------------------------------------------------------------
  async extractSchemaInvalid() {
    const x = await import('litert-ocr/extract');
    const a = await expectError(() => x.extract(DOCS + 'scan.jpg', { type: 'array' }), 'SCHEMA_INVALID', ["type 'object'"]);
    const b = await expectError(() => x.extract(DOCS + 'scan.jpg', { type: 'object', properties: { d: { type: 'date' } } }), 'SCHEMA_INVALID', ['date']);
    return { ok: a.ok && b.ok, a: a.message, b: b.message };
  },
  async extractNoWebGPU() {
    const x = await import('litert-ocr/extract');
    return expectError(() => x.extract(DOCS + 'scan.jpg', RECEIPT_SCHEMA, { ocr: local() }), 'LLM_WEBGPU_UNAVAILABLE', ['WebGPU']);
  },
  async extractNoLiteRtLm() {
    // page-nollm.html: its import map has no @litert-lm/core
    const x = await import('litert-ocr/extract');
    return expectError(() => x.extract(DOCS + 'scan.jpg', RECEIPT_SCHEMA, { ocr: local() }), 'LLM_UNAVAILABLE', ['@litert-lm/core@0.19.0-nightly.20261018']);
  },
  async extractModel404() {
    const x = await import('litert-ocr/extract');
    return expectError(() => x.extract(DOCS + 'scan.jpg', RECEIPT_SCHEMA, { ocr: local(), llm: { model: '../../nope.litertlm', wasmPath: LLM_WASM, cache: false } }), 'LLM_MODEL_FETCH_FAILED', ['HTTP 404']);
  },
  async extractReceipt({ llmUrl }) {
    if (!llmUrl) return { ok: true, skipped: 'no model file ($LITERT_OCR_TEST_LLM unset)' };
    const x = await import('litert-ocr/extract');
    const img = canvasWithText(560, 520, ['CORNER CAFE', '12 Pier Road', 'Latte 2 x 3.50 7.00', 'Bagel 1 x 2.90 2.90', 'Orange juice 1 x 4.10 4.10', 'Subtotal 14.00', 'Tax 1.12', 'Total 15.12'], '28px Helvetica, Arial, sans-serif');
    const r = await x.extract(img, RECEIPT_SCHEMA, { documentType: 'receipt', ocr: local(), llm: { model: llmUrl, wasmPath: LLM_WASM, cache: false } });
    const total = String(r.data?.total ?? '');
    return { ok: r.valid && /15\.12/.test(total) && Array.isArray(r.data?.items), valid: r.valid, errors: r.errors, data: r.data, raw: r.raw.slice(0, 600), text: r.text, timings: r.timings };
  },
};
window.testsReady = true;
