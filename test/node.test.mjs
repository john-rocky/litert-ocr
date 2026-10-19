// Node.js tests (node:test). Models download once into the default cache (~/.cache/litert-ocr).
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createScheduler, createWorker, OcrError, PSM, recognize, modelInfo } from 'litert-ocr';
import { startServer } from './server.mjs';

const FIX = fileURLToPath(new URL('./fixtures/', import.meta.url));
const MODELS = fileURLToPath(new URL('../.models/', import.meta.url));
const expected = JSON.parse(readFileSync(join(FIX, 'expected.json'), 'utf8'));
const THRESHOLD = 0.9; // Node resamples in JS (not canvas): a few lines may differ from the browser

function lineMatch(text, want) {
  const pool = new Map();
  for (const g of text.split('\n').map((s) => s.trim()).filter(Boolean)) pool.set(g, (pool.get(g) ?? 0) + 1);
  let hit = 0;
  const missed = [];
  for (const w of want) {
    if (pool.get(w)) { pool.set(w, pool.get(w) - 1); hit++; } else missed.push(w);
  }
  return { rate: hit / want.length, hit, n: want.length, missed };
}

async function rejects(fn, code, includes = []) {
  let err;
  try { await fn(); } catch (e) { err = e; }
  assert.ok(err, `expected ${code}, got no error`);
  assert.ok(err instanceof OcrError, `expected OcrError, got ${err?.name}: ${err?.message}`);
  assert.equal(err.code, code, err.message);
  for (const s of includes) assert.ok(err.message.includes(s), `message lacks "${s}": ${err.message}`);
  return err;
}

let worker;
const log = [];
let server;
const report = {};

before(async () => {
  server = await startServer(0);
  worker = await createWorker('eng', 1, { logger: (m) => log.push(m) });
});
after(async () => {
  await worker?.terminate();
  await server?.close();
  const out = process.env.LITERT_OCR_REPORT;
  if (out) writeFileSync(out, JSON.stringify({ info: worker?.info, ...report }, null, 1));
});

describe('node: reading', () => {
  test('worker info: Node, WebAssembly, several threads', () => {
    assert.equal(worker.info.platform, process.versions.bun ? 'bun' : globalThis.Deno ? 'deno' : 'node');
    assert.equal(worker.info.detector, 'wasm');
    assert.ok(worker.info.threads >= 1);
    report.info = worker.info;
  });

  test('fixtures: expected lines are read', async () => {
    report.fixtures = {};
    for (const [file, e] of Object.entries(expected)) {
      const t0 = performance.now();
      const r = await worker.recognize(join(FIX, file));
      const m = lineMatch(r.data.text, e.lines);
      report.fixtures[file] = { ms: Math.round(performance.now() - t0), ...m };
      assert.ok(m.rate >= THRESHOLD, `${file}: ${m.hit}/${m.n} lines (missed ${JSON.stringify(m.missed)})`);
    }
  });

  test('outputs: blocks, hocr, tsv', async () => {
    const r = await worker.recognize(join(FIX, 'mobile.png'), {}, { blocks: true, hocr: true, tsv: true });
    const lines = r.data.blocks[0].paragraphs[0].lines;
    const words = lines.flatMap((l) => l.words);
    assert.equal(lines.map((l) => l.text).join(''), r.data.text);
    assert.ok(words.every((w) => w.bbox.x0 >= 0 && w.bbox.x1 <= 390 && w.bbox.y1 <= 800 && w.confidence >= 0 && w.confidence <= 100));
    assert.equal((r.data.hocr.match(/class='ocrx_word'/g) ?? []).length, words.length);
    assert.equal(r.data.tsv.trim().split('\n').length, 3 + lines.length + words.length);
    assert.equal(r.data.pdf, null);
    assert.equal((await worker.recognize(join(FIX, 'mobile.png'))).data.blocks, null);
  });

  test('inputs: path, file URL, Buffer, Uint8Array, ArrayBuffer, data URL, http URL, Blob, raw pixels', async () => {
    const file = join(FIX, 'mobile.png');
    const base = (await worker.recognize(file)).data.text;
    const buf = readFileSync(file);
    const cases = {
      'file URL': pathToFileURL(file).href,
      Buffer: buf,
      Uint8Array: new Uint8Array(buf),
      ArrayBuffer: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      'data URL': `data:image/png;base64,${buf.toString('base64')}`,
      'http URL': `http://127.0.0.1:${server.port}/plain/test/fixtures/mobile.png`,
      Blob: new Blob([buf], { type: 'image/png' }),
    };
    report.inputs = {};
    for (const [k, v] of Object.entries(cases)) {
      const t = (await worker.recognize(v)).data.text;
      report.inputs[k] = t === base ? 'same' : 'DIFFERENT';
      assert.equal(t, base, k);
    }
    // raw pixels: decode the PNG ourselves through the same path, expect the same text
    const { default: pngjs } = await import('pngjs');
    const png = pngjs.PNG.sync.read(buf);
    const t = (await worker.recognize({ data: new Uint8ClampedArray(png.data), width: png.width, height: png.height })).data.text;
    report.inputs['{data,width,height}'] = t === base ? 'same' : 'DIFFERENT';
    assert.equal(t, base, 'raw pixels');
  });

  test('rectangle, whitelist, single line', async () => {
    const r = await worker.recognize(join(FIX, 'settings-dark.png'), { rectangle: { left: 0, top: 0, width: 240, height: 450 } }, { blocks: true });
    const lines = r.data.blocks[0].paragraphs[0].lines;
    assert.ok(lines.length > 5 && lines.every((l) => l.bbox.x1 <= 242 && l.bbox.y1 <= 452));
    await worker.setParameters({ tessedit_char_whitelist: '0123456789' });
    const d = await worker.recognize(join(FIX, 'mobile.png'));
    await worker.setParameters({ tessedit_char_whitelist: '' });
    assert.match(d.data.text, /^[0-9\n]+$/);
    const one = await worker.recognize(join(FIX, 'dialog-shared.jpg'), { rectangle: { left: 280, top: 0, width: 600, height: 60 }, tessedit_pageseg_mode: PSM.SINGLE_LINE });
    report.singleLine = one.data.text;
    assert.ok(one.data.text.trim().length > 0);
  });

  test('an image over 4096 px is read scaled down, boxes in original pixels', async () => {
    const { default: pngjs } = await import('pngjs');
    const src = pngjs.PNG.sync.read(readFileSync(join(FIX, 'mobile.png')));
    const k = 6; // 390 x 800 -> 2340 x 4800 (nearest neighbour)
    const W = src.width * k, H = src.height * k;
    const data = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const s = (((y / k) | 0) * src.width + ((x / k) | 0)) * 4, t = (y * W + x) * 4;
        data[t] = src.data[s]; data[t + 1] = src.data[s + 1]; data[t + 2] = src.data[s + 2]; data[t + 3] = src.data[s + 3];
      }
    }
    const notices = [];
    const w = await createWorker('eng', 1, { logger: (m) => m.status === 'notice' && notices.push(m.message) });
    const r = await w.recognize({ data, width: W, height: H }, {}, { blocks: true });
    await w.terminate();
    const lines = r.data.blocks[0].paragraphs[0].lines;
    report.bigImage = { size: `${W}x${H}`, lines: lines.length, notices: notices.filter((n) => n.includes('4096')) };
    assert.match(r.data.text, /Electricity Bill/);
    assert.ok(lines.every((l) => l.bbox.x1 <= W && l.bbox.y1 <= H) && lines.some((l) => l.bbox.y1 > 4096), 'boxes in original pixels');
    assert.ok(notices.some((n) => n.includes('4096')), 'a notice says the image was scaled');
  });

  test('scheduler and the one-shot recognize()', async () => {
    const s = createScheduler();
    s.addWorker(await createWorker('eng'));
    s.addWorker(await createWorker('eng'));
    const rs = await Promise.all(['mobile.png', 'dialog-shared.jpg', 'mobile.png'].map((f) => s.addJob('recognize', join(FIX, f))));
    assert.equal(s.getNumWorkers(), 2);
    assert.ok(rs.every((r) => r.data.text.length > 20));
    await s.terminate();
    const one = await recognize(join(FIX, 'mobile.png'), 'eng');
    assert.match(one.data.text, /Electricity Bill/);
  });

  test('logger statuses', () => {
    const seen = new Set(log.map((m) => m.status));
    for (const s of ['loading runtime', 'loading model', 'initializing model', 'initialized', 'recognizing text']) assert.ok(seen.has(s), `no '${s}' in ${[...seen]}`);
    report.initialized = log.find((m) => m.status === 'initialized')?.message;
  });
});

describe('node: failure paths', () => {
  test('unsupported input types', async () => {
    await rejects(() => worker.recognize(42), 'IMAGE_UNSUPPORTED_TYPE', ['a number', 'file path']);
    await rejects(() => worker.recognize({ foo: 1 }), 'IMAGE_UNSUPPORTED_TYPE');
    await rejects(() => worker.recognize('ftp://example.com/x.png'), 'IMAGE_UNSUPPORTED_TYPE');
  });

  test('missing file, broken and unsupported images', async () => {
    await rejects(() => worker.recognize(join(FIX, 'nope.png')), 'IMAGE_FETCH_FAILED', ['nope.png']);
    const png = readFileSync(join(FIX, 'mobile.png'));
    await rejects(() => worker.recognize(png.subarray(0, 300)), 'IMAGE_DECODE_FAILED', ['PNG']);
    const gif = Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'binary');
    const e = await rejects(() => worker.recognize(gif), 'IMAGE_DECODE_FAILED', ['PNG and JPEG only', 'GIF', '{ data, width, height }']);
    report.gifMessage = e.message;
    await rejects(() => worker.recognize(`http://127.0.0.1:${server.port}/plain/test/fixtures/nope.png`), 'IMAGE_FETCH_FAILED', ['HTTP 404']);
    assert.match((await worker.recognize(join(FIX, 'mobile.png'))).data.text, /Electricity Bill/, 'worker still works');
  });

  test('model download fails / sha256 mismatch', async () => {
    const cachePath = mkdtempSync(join(tmpdir(), 'litert-ocr-test-'));
    const e1 = await rejects(() => createWorker('eng', 1, { modelBase: `http://127.0.0.1:${server.port}/coi/nope/`, cachePath }), 'MODEL_FETCH_FAILED', ['HTTP 404', 'modelBase']);
    report.model404 = e1.message;
    // a local copy with one byte changed in the detector
    const bad = mkdtempSync(join(tmpdir(), 'litert-ocr-bad-'));
    for (const f of modelInfo.files) copyFileSync(join(MODELS, f.file), join(bad, f.file));
    const det = join(bad, 'ppocrv6_small_det_640_fp32.tflite');
    const b = readFileSync(det);
    b[b.length >> 1] ^= 0xff;
    writeFileSync(det, b);
    const e2 = await rejects(() => createWorker('eng', 1, { modelBase: bad, cachePath }), 'MODEL_SHA256_MISMATCH', ['sha256', 'ppocrv6_small_det_640_fp32.tflite']);
    report.sha256 = e2.message;
    const e3 = await rejects(() => createWorker('eng', 1, { modelBase: 'http://127.0.0.1:9/', cachePath, cacheMethod: 'none' }), 'MODEL_FETCH_FAILED', ['did not complete']);
    report.unreachable = e3.message;
  });

  test('a model file from a local directory, verified (modelBase as a path)', async () => {
    const w = await createWorker('eng', 1, { modelBase: MODELS, cacheMethod: 'none' });
    assert.match((await w.recognize(join(FIX, 'mobile.png'))).data.text, /Electricity Bill/);
    await w.terminate();
  });

  test('terminate twice, recognize after terminate', async () => {
    const w = await createWorker('eng');
    assert.deepEqual((await w.terminate()).data, { terminated: true });
    assert.deepEqual((await w.terminate()).data, { terminated: true });
    await rejects(() => w.recognize(join(FIX, 'mobile.png')), 'WORKER_TERMINATED', ['createWorker()']);
  });

  test('languages', async () => {
    await rejects(() => createWorker('kor'), 'LANG_NOT_SUPPORTED', ['Hangul', 'tesseract.js']);
    await rejects(() => createWorker('rus+eng'), 'LANG_NOT_SUPPORTED', ['Cyrillic']);
    await rejects(() => createWorker('englsh'), 'LANG_NOT_SUPPORTED', ['Unknown language code']);
  });

  test('invalid arguments', async () => {
    await rejects(() => worker.recognize(join(FIX, 'mobile.png'), { rectangle: { left: 0, top: 0, width: 0, height: 5 } }), 'INVALID_ARGUMENT', ['rectangle']);
    await rejects(() => worker.detect(join(FIX, 'mobile.png')), 'INVALID_ARGUMENT', ['not supported']);
    await rejects(() => createWorker('eng', 1, { backend: 'gpu' }), 'INVALID_ARGUMENT', ['backend']);
  });
});

