// Tests of the litert-ocr command (dist/cli.js) and its MCP server (litert-ocr mcp, called through the MCP SDK
// client over stdio). Inputs: test/out/fixtures/; OCR models from .models/; layout model from
// $LITERT_OCR_LAYOUT_BASE when set.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const F = join(ROOT, 'test/out/fixtures');
const CLI = join(ROOT, 'dist/cli.js');
const MODELS = join(ROOT, '.models');
const LAYOUT = process.env.LITERT_OCR_LAYOUT_BASE || null;
const base = ['--model-base', MODELS, ...(LAYOUT ? ['--layout-model-base', LAYOUT] : [])];
const report = { cli: {}, mcp: {} };

function cli(args, timeout = 300000) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout, maxBuffer: 64 << 20 });
  return { code: r.status, out: r.stdout, err: r.stderr, ms: Date.now() - t0 };
}

after(() => {
  const out = process.env.LITERT_OCR_CLI_REPORT;
  if (out) writeFileSync(out, JSON.stringify({ layoutBase: LAYOUT, ...report }, null, 1));
});

describe('cli', () => {
  test('a PDF with a text layer -> Markdown on stdout, exit 0', () => {
    const r = cli([join(F, 'report.pdf'), '--md', ...base]);
    report.cli.reportPdf = { code: r.code, ms: r.ms, head: r.out.slice(0, 400), err: r.err.slice(0, 600) };
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^# Harbor Library Monthly Report$/m);
    assert.match(r.out, /^\| Branch \| Visitors \| Loans \|$/m);
  });

  test('an image -> JSON with --timings, exit 0', () => {
    const r = cli([join(F, 'scan.jpg'), '--json', '--timings', ...base]);
    report.cli.scanJpg = { code: r.code, ms: r.ms, err: r.err.slice(0, 1500) };
    assert.equal(r.code, 0, r.err);
    const d = JSON.parse(r.out);
    assert.equal(d.pages[0].status, 'ok');
    assert.equal(d.pages[0].engine, 'ocr');
    report.cli.scanJpg.layout = d.pages[0].layout;
    assert.match(r.err, /^timing .*scan\.jpg page 1 ocr\/(model|geometry)/m);
  });

  test('an image-only PDF with --layout geometry and --pages, --out DIR', () => {
    const out = mkdtempSync(join(tmpdir(), 'litert-ocr-cli-'));
    const r = cli([join(F, 'scan.pdf'), join(F, 'report.pdf'), '--text', '--pages', '1', '--layout', 'geometry', '--out', out, ...base]);
    report.cli.outDir = { code: r.code, err: r.err.slice(0, 600) };
    assert.equal(r.code, 0, r.err);
    assert.ok(existsSync(join(out, 'scan.txt')) && existsSync(join(out, 'report.txt')));
    assert.match(readFileSync(join(out, 'scan.txt'), 'utf8'), /Harbor Library/);
  });

  test('exit 3 when a page comes back empty, naming it on stderr', () => {
    const r = cli([join(F, 'blank.pdf'), ...base]);
    report.cli.blank = { code: r.code, err: r.err.slice(0, 400) };
    assert.equal(r.code, 3);
    assert.match(r.err, /page 1 empty/);
  });

  test('exit 2 when an input cannot be read; exit 1 on a usage error', () => {
    for (const [f, msg] of [['notes.txt', /DOC_UNSUPPORTED_TYPE/], ['broken.pdf', /PDF_INVALID/], ['locked.pdf', /PDF_PASSWORD/], ['long.pdf', /DOC_TOO_MANY_PAGES/], ['nope.pdf', /IMAGE_FETCH_FAILED/]]) {
      const r = cli([join(F, f), ...base]);
      report.cli[f] = { code: r.code, err: r.err.trim().slice(0, 300) };
      assert.equal(r.code, 2, `${f}: ${r.err}`);
      assert.match(r.err, msg);
    }
    const pw = cli([join(F, 'locked.pdf'), '--password', 'open-sesame', ...base]);
    assert.equal(pw.code, 0, pw.err);
    assert.match(pw.out, /protected by a password/);
    const u = cli(['--engine', 'magic', join(F, 'report.pdf')]);
    assert.equal(u.code, 1);
    assert.match(u.err, /--engine must be one of/);
    const none = cli([]);
    assert.equal(none.code, 1);
    assert.match(none.out, /usage: litert-ocr/);
  });
});

describe('mcp', () => {
  test('the four tools over stdio (MCP SDK client)', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, 'mcp', ...base], stderr: 'pipe' });
    const errLines = [];
    transport.stderr?.on('data', (d) => errLines.push(String(d)));
    const client = new Client({ name: 'litert-ocr-test', version: '0.0.0' });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      report.mcp.tools = tools.map((t) => ({ name: t.name, annotations: t.annotations, local: /never sent anywhere/.test(t.description ?? '') }));
      assert.deepEqual(tools.map((t) => t.name).sort(), ['convert', 'convert_to_markdown', 'list_input_formats', 'ocr_image']);
      assert.ok(tools.every((t) => t.annotations?.readOnlyHint === true && /never sent anywhere/.test(t.description ?? '')));

      const md = await client.callTool({ name: 'convert_to_markdown', arguments: { uri: pathToFileURL(join(F, 'report.pdf')).href } });
      report.mcp.convert_to_markdown = md.content[0].text.slice(0, 300);
      assert.ok(!md.isError);
      assert.match(md.content[0].text, /^# Harbor Library Monthly Report$/m);

      const js = await client.callTool({ name: 'convert', arguments: { uri: pathToFileURL(join(F, 'scan.pdf')).href, to: 'json', options: { layout: 'geometry' } } });
      assert.ok(!js.isError, js.content?.[0]?.text);
      const d = JSON.parse(js.content[0].text);
      report.mcp.convert = { status: d.pages[0].status, engine: d.pages[0].engine, layout: d.pages[0].layout };
      assert.equal(d.pages[0].engine, 'ocr');

      const data = `data:image/jpeg;base64,${readFileSync(join(F, 'scan.jpg')).toString('base64')}`;
      const o = await client.callTool({ name: 'ocr_image', arguments: { uri: data, lang: 'eng' } });
      assert.ok(!o.isError, o.content?.[0]?.text);
      const ocr = JSON.parse(o.content[0].text);
      report.mcp.ocr_image = { lines: ocr.lines.length, first: ocr.lines[0] };
      assert.ok(ocr.lines.some((l) => /Harbor Library/.test(l.text) && l.bbox.length === 4));
      const kor = await client.callTool({ name: 'ocr_image', arguments: { uri: data, lang: 'kor' } });
      assert.ok(kor.isError && /LANG_NOT_SUPPORTED/.test(kor.content[0].text));

      const f = await client.callTool({ name: 'list_input_formats', arguments: {} });
      report.mcp.list_input_formats = JSON.parse(f.content[0].text);
      assert.ok(JSON.parse(f.content[0].text).formats.some((x) => x.extension === '.pdf'));

      const http = await client.callTool({ name: 'convert_to_markdown', arguments: { uri: 'https://example.com/a.pdf' } });
      report.mcp.httpOff = http.content[0].text;
      assert.ok(http.isError && /--allow-http/.test(http.content[0].text));
      const bad = await client.callTool({ name: 'convert_to_markdown', arguments: { uri: pathToFileURL(join(F, 'broken.pdf')).href } });
      assert.ok(bad.isError && /PDF_INVALID/.test(bad.content[0].text));
    } finally {
      await client.close();
      report.mcp.stderr = errLines.join('').slice(0, 2000);
    }
  });
});
