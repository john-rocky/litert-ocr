// Node.js tests of the document API: convert() / toMarkdown() / createConverter() on PDFs and images, and the
// failure paths. Inputs: test/out/fixtures/ (node test/fixtures/make-pdfs.mjs). The OCR model files come from
// .models/ (test/fetch-models.mjs); the layout model files from $LITERT_OCR_LAYOUT_BASE when it is set (the layout
// model is not published yet), otherwise the layout cases check the geometry fallback.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { convert, createConverter, modelInfo, OcrError, toMarkdown } from 'litert-ocr';

const F = fileURLToPath(new URL('./out/fixtures/', import.meta.url));
const MODELS = fileURLToPath(new URL('../.models/', import.meta.url));
const LAYOUT = process.env.LITERT_OCR_LAYOUT_BASE || null;
const report = {};

async function rejects(fn, code, includes = []) {
  let err;
  try { await fn(); } catch (e) { err = e; }
  assert.ok(err, `expected ${code}, got no error`);
  assert.ok(err instanceof OcrError, `expected OcrError, got ${err?.name}: ${err?.message}`);
  assert.equal(err.code, code, err.message);
  for (const s of includes) assert.ok(err.message.includes(s), `message lacks "${s}": ${err.message}`);
  return err;
}

let conv;
const notices = [];
before(() => {
  conv = createConverter({ modelBase: MODELS, ...(LAYOUT ? { layoutModelBase: LAYOUT } : {}), logger: (m) => m.status === 'notice' && notices.push(m.message) });
});
after(async () => {
  await conv?.terminate();
  const out = process.env.LITERT_OCR_DOC_REPORT;
  if (out) writeFileSync(out, JSON.stringify({ layoutBase: LAYOUT, notices: [...new Set(notices)], ...report }, null, 1));
});

describe('documents: PDFs with a text layer', () => {
  test('report.pdf -> Markdown with headings, a table and a list, page markers', async () => {
    const r = await conv.convert(join(F, 'report.pdf'));
    report.reportMd = r.content;
    assert.equal(r.to, 'md');
    assert.match(r.content, /^<!-- page 1 -->/);
    assert.match(r.content, /^# Harbor Library Monthly Report$/m);
    assert.match(r.content, /^\| Branch \| Visitors \| Loans \|$/m);
    assert.match(r.content, /^\| Old Town \| 5,517 \| 3,408 \|$/m);
    // Chrome's print draws the list bullets as shapes, so the text layer has no bullet: the items read as one paragraph
    assert.match(r.content, /^Extend the Thursday evening hours to Friday\. Order forty new chairs for the reading room\. Repair the lift at the Hilltop branch\.$/m);
    assert.match(r.content, /^<!-- page 2 -->/m);
    assert.deepEqual(r.document.pages.map((p) => [p.status, p.engine]), [['ok', 'layer'], ['ok', 'layer']]);
  });

  test('to json: blocks with type, text and box; tables as rows; pages option', async () => {
    const r = await conv.convert(join(F, 'report.pdf'), { to: 'json', pages: '2' });
    const d = JSON.parse(r.content);
    assert.equal(d.pages.length, 1);
    const p = d.pages[0];
    assert.equal(p.page, 2);
    assert.equal(p.dpi, 150);
    assert.deepEqual(p.tables[0].rows[0], ['Day', 'Hours']);
    assert.ok(p.blocks.some((b) => b.type === 'table' && b.table === 0 && b.bbox.length === 4));
    assert.equal(d.source.type, 'pdf');
    assert.equal(d.source.pages, 2);
  });

  test('to text: tab-separated table rows; toMarkdown()', async () => {
    const t = await conv.convert(join(F, 'report.pdf'), { to: 'text', pages: [2] });
    assert.match(t.content, /^Day\tHours$/m);
    const md = await toMarkdown(join(F, 'report.pdf'), { pages: '1', modelBase: MODELS });
    assert.match(md, /^# Harbor Library Monthly Report$/m);
  });

  test('a password-protected PDF', async () => {
    await rejects(() => conv.convert(join(F, 'locked.pdf')), 'PDF_PASSWORD', ['password']);
    await rejects(() => conv.convert(join(F, 'locked.pdf'), { password: 'wrong' }), 'PDF_PASSWORD', ['did not open']);
    const r = await conv.convert(join(F, 'locked.pdf'), { password: 'open-sesame' });
    assert.match(r.content, /protected by a password/);
  });

  test('a long PDF: the page limit and pages', async () => {
    const e = await rejects(() => conv.convert(join(F, 'long.pdf')), 'DOC_TOO_MANY_PAGES', ['120 pages', "pages: '1-100'"]);
    report.tooMany = e.message;
    const r = await conv.convert(join(F, 'long.pdf'), { pages: '1-3,118-' , to: 'json' });
    assert.deepEqual(r.document.pages.map((p) => p.page), [1, 2, 3, 118, 119, 120]);
    await rejects(() => conv.convert(join(F, 'long.pdf'), { pages: '1-10', maxPages: 5 }), 'DOC_TOO_MANY_PAGES');
  });

  test('broken, not a PDF, missing, bad options', async () => {
    report.broken = (await rejects(() => conv.convert(join(F, 'broken.pdf')), 'PDF_INVALID', ['damaged'])).message;
    await rejects(() => conv.convert(join(F, 'notes.txt')), 'DOC_UNSUPPORTED_TYPE', ['plain text']);
    await rejects(() => conv.convert(join(F, 'slides.pptx')), 'DOC_UNSUPPORTED_TYPE', ['ZIP']);
    await rejects(() => conv.convert(join(F, 'nope.pdf')), 'IMAGE_FETCH_FAILED', ['nope.pdf']);
    await rejects(() => conv.convert(42), 'DOC_UNSUPPORTED_TYPE');
    await rejects(() => conv.convert(join(F, 'report.pdf'), { pages: '0-1' }), 'INVALID_ARGUMENT', ['pages']);
    await rejects(() => conv.convert(join(F, 'report.pdf'), { pages: '3' }), 'INVALID_ARGUMENT', ['past the last page']);
    await rejects(() => conv.convert(join(F, 'report.pdf'), { to: 'html' }), 'INVALID_ARGUMENT', ['to']);
    await rejects(() => conv.convert(join(F, 'report.pdf'), { engine: 'magic' }), 'INVALID_ARGUMENT', ['engine']);
    await rejects(() => conv.convert(join(F, 'report.pdf'), { layout: 'neural' }), 'INVALID_ARGUMENT', ['layout']);
  });
});

describe('documents: OCR pages', () => {
  test('an image-only PDF goes to OCR; engine layer leaves it empty', async () => {
    const r = await conv.convert(join(F, 'scan.pdf'), { to: 'json' });
    const p = r.document.pages[0];
    report.scanPdf = { status: p.status, engine: p.engine, layout: p.layout, skew: p.skew, ms: p.ms, md: p.markdown };
    assert.equal(p.engine, 'ocr');
    assert.equal(p.status, 'ok');
    assert.match(p.markdown, /Harbor Library Monthly Report/);
    assert.match(p.markdown, /Riverside/);
    const l = await conv.convert(join(F, 'scan.pdf'), { engine: 'layer', to: 'json' });
    assert.equal(l.document.pages[0].status, 'empty');
    assert.match(l.document.pages[0].reason, /no text layer/);
  });

  test('a mixed PDF: page 1 from the text layer, page 2 by OCR', async () => {
    const r = await conv.convert(join(F, 'mixed.pdf'), { to: 'json' });
    assert.deepEqual(r.document.pages.map((p) => p.engine), ['layer', 'ocr']);
    assert.match(r.document.pages[0].markdown, /east gate opens at seven/);
    assert.match(r.document.pages[1].markdown, /Old Town/);
  });

  test('engine ocr reads a text-layer page by OCR', async () => {
    const r = await conv.convert(join(F, 'report.pdf'), { engine: 'ocr', pages: '2', to: 'json' });
    assert.equal(r.document.pages[0].engine, 'ocr');
    assert.match(r.document.pages[0].markdown, /Opening hours/);
  });

  test('an image (JPEG) and raw pixels; a blank page is empty', async () => {
    const r = await conv.convert(join(F, 'scan.jpg'), { layout: 'geometry', to: 'json' });
    const p = r.document.pages[0];
    report.scanJpg = { status: p.status, layout: p.layout, skew: p.skew, ms: p.ms };
    assert.equal(r.document.source.type, 'image');
    assert.equal(p.layout.used, 'geometry');
    assert.ok(Math.abs(p.skew) >= 0.5 && Math.abs(p.skew) <= 1.1, `skew ${p.skew}`);
    assert.match(p.markdown, /\| Branch \| Visitors \| Loans \|/);
    const b = await conv.convert(join(F, 'blank.pdf'), { to: 'json' });
    assert.equal(b.document.pages[0].status, 'empty');
  });

  test('layout model: used when its files are given (WebAssembly in Node.js), else geometry with the reason', async () => {
    const r = await conv.convert(join(F, 'scan.jpg'), { layout: 'model', to: 'json' });
    const p = r.document.pages[0];
    report.layoutModel = { layout: p.layout, blocks: p.blocks.map((x) => `${x.type}${x.role ? ':' + x.role : ''}`), ms: p.ms };
    if (LAYOUT) {
      assert.deepEqual([p.layout.used, p.layout.backend], ['model', 'wasm']);
      assert.ok(p.blocks.some((x) => x.type === 'table'));
      assert.ok(p.blocks.some((x) => x.type === 'heading'));
    } else {
      assert.equal(p.layout.used, 'geometry');
      assert.match(p.layout.reason, /not published/);
    }
  });

  test('layout model files that cannot be read: geometry and a notice', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'litert-ocr-nolayout-'));
    const seen = [];
    const c = createConverter({ modelBase: MODELS, layoutModelBase: empty, logger: (m) => m.status === 'notice' && seen.push(m.message) });
    try {
      const r = await c.convert(join(F, 'scan.jpg'), { to: 'json' });
      const p = r.document.pages[0];
      report.layoutMissing = { layout: p.layout, notices: seen };
      assert.equal(p.status, 'ok');
      assert.equal(p.layout.used, 'geometry');
      assert.match(p.layout.reason, /could not be used/);
      assert.ok(seen.some((m) => /layout model could not be used/.test(m)));
    } finally {
      await c.terminate();
    }
  });

  test('convert() at the top level creates and stops its own worker; a terminated converter rejects', async () => {
    const r = await convert(join(F, 'scan.jpg'), { modelBase: MODELS, layout: 'geometry' });
    assert.match(r.content, /Harbor Library/);
    const c = createConverter({ modelBase: MODELS });
    await c.terminate();
    await rejects(() => c.convert(join(F, 'scan.jpg')), 'WORKER_TERMINATED');
  });

  test('modelInfo lists the layout files and their state', () => {
    assert.equal(modelInfo.layout.status, 'upload pending');
    assert.equal(modelInfo.layout.forms.webgpu.length, 3);
    assert.equal(modelInfo.pdfjs.version, '6.4.299');
  });
});

describe('extract in Node.js', () => {
  test('extract() explains that it runs in a browser; the prompt and repair helpers work', async () => {
    const x = await import('litert-ocr/extract');
    await rejects(() => x.extract('a.png', { type: 'object', properties: { total: { type: 'string' } } }), 'LLM_UNAVAILABLE', ['browser', 'WebGPU']);
    // the measured receipt prompt (r2s P1): documentType 'receipt' and the receipt instructions
    const schema = { type: 'object', properties: { total: { type: 'string', description: 'Total amount to pay as printed' } }, required: ['total'] };
    const p = x.buildPrompt(schema, 'TOTAL 11.34', 'receipt', 'Copy every value exactly as printed on the receipt.');
    assert.equal(p, `Extract the fields of this receipt from its OCR text.\nReturn only a JSON object that follows this JSON Schema:\n${JSON.stringify(schema)}\nCopy every value exactly as printed on the receipt.\n\nOCR text:\nTOTAL 11.34`);
    assert.deepEqual(x.repairJson('```json\n{"total": "11.34",}\n```'), { value: { total: '11.34' }, stage: 'R1-R3' });
    assert.deepEqual(x.repairJson('{"total": "1"}'), { value: { total: '1' }, stage: 'R0' });
    assert.equal(x.repairJson('no json here').stage, null);
    assert.ok(x.schemaProblems({ type: 'array' }).length > 0);
    assert.ok(x.schemaProblems({ type: 'object', properties: { a: { type: 'date' } } }).some((s) => /date/.test(s)));
    assert.deepEqual(x.schemaProblems(schema), []);
    assert.deepEqual(x.answerProblems({ total: 3 }, schema), ['answer.total is integer, the schema wants string']);
  });
});
