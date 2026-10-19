// Browser test cases. The runner (test/browser.mjs) opens page.html under /coi/, /plain/ or /csp/ and
// calls window.tests[name](cfg); each case returns { ok, ...details } or throws.
import * as ocr from '../../dist/index.js';

const MODELS = new URL('../../models/', location.href).href;
const WASM = new URL('../../wasm/', location.href).href;
const FIX = new URL('../fixtures/', location.href).href;
const local = (extra = {}) => ({ modelBase: MODELS, wasmPath: WASM, ...extra });
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

  async inputs() {
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
          out[k] = m.rate >= 0.95 ? 'close' : 'DIFFERENT';
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
    const src = "try { importScripts('data:text/javascript,0'); postMessage('importScripts worked'); } catch (e) { postMessage(String(e)); }";
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
    const want = mode === 'webgpu' ? 'webgpu' : 'wasm';
    return { ok: same && info.recognizers['320'] === want && info.recognizers['640'] === want && plainInfo.recognizers['320'] === 'wasm', info, plainInfo, out };
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
  async cspBlob() {
    const a = await expectError(() => ocr.createWorker('eng', 1, local()), 'WORKER_START_FAILED', ['worker-src', 'workerPath']);
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
};
window.testsReady = true;
