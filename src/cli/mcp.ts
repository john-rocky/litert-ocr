// `litert-ocr mcp`: an MCP server over stdio for coding agents. Four read-only tools; documents are read on this
// machine and never sent anywhere. convert_to_markdown has the name and contract of MarkItDown's MCP tool (one uri
// in, Markdown out), so an agent set up for that tool can use this one as is.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createConverter, createWorker, OcrError, type ConverterOptions, type Worker } from 'litert-ocr';

const LOCAL = 'Runs on this machine: the document is read locally and never sent anywhere.';

export interface McpOptions {
  allowHttp: boolean;
  converter: Partial<ConverterOptions>;
}

/** A tool's uri -> what convert() / recognize() take: a path, the bytes of a data: URI, or an http(s) URL when allowed. */
export async function resolveUri(uri: string, allowHttp: boolean): Promise<string | Uint8Array> {
  if (typeof uri !== 'string' || !uri.trim()) throw new OcrError('INVALID_ARGUMENT', 'uri must be a file:, data:, http: or https: URI, or a file path.');
  const u = uri.trim();
  if (/^file:/i.test(u)) return fileURLToPath(u);
  if (/^data:/i.test(u)) {
    const m = /^data:([^,]*?)(;base64)?,(.*)$/is.exec(u);
    if (!m) throw new OcrError('INVALID_ARGUMENT', 'This data: URI is malformed (expected data:<type>;base64,<data>).');
    return m[2] ? new Uint8Array(Buffer.from(m[3]!, 'base64')) : new TextEncoder().encode(decodeURIComponent(m[3]!));
  }
  if (/^https?:/i.test(u)) {
    if (!allowHttp) throw new OcrError('INVALID_ARGUMENT', 'http(s) URIs are turned off in this server. Download the file and pass a file: URI, or start the server with --allow-http.');
    return u;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(u) && !/^[a-z]:[\\/]/i.test(u)) throw new OcrError('INVALID_ARGUMENT', `Unsupported URI scheme in ${u.slice(0, 40)}; use file:, data:, http: or https:.`);
  return u; // a plain path
}

export async function runMcp(o: McpOptions): Promise<void> {
  // stdout carries the protocol: everything else goes to stderr
  console.log = console.info = console.debug = (...a: unknown[]) => console.error(...a);
  let McpServer: typeof import('@modelcontextprotocol/sdk/server/mcp.js').McpServer;
  let StdioServerTransport: typeof import('@modelcontextprotocol/sdk/server/stdio.js').StdioServerTransport;
  let z: typeof import('zod').z;
  try {
    ({ McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js'));
    ({ StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js'));
    ({ z } = await import('zod'));
  } catch (e) {
    process.stderr.write(`litert-ocr mcp: the MCP SDK could not load (${(e as Error)?.message ?? e}). It is an optional dependency: npm install @modelcontextprotocol/sdk zod\n`);
    process.exitCode = 2;
    return;
  }
  const converter = createConverter(o.converter);
  let ocrWorker: Promise<Worker> | null = null;
  const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: o.allowHttp };
  const fail = (e: unknown) => ({
    content: [{ type: 'text' as const, text: `Error${e instanceof OcrError ? ` (${e.code})` : ''}: ${(e as Error)?.message ?? e}` }],
    isError: true,
  });
  const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

  const server = new McpServer({ name: 'litert-ocr', version: '0.1.0' });

  server.registerTool(
    'convert_to_markdown',
    {
      title: 'Convert a document to Markdown',
      description: `Convert a resource described by an http:, https:, file: or data: URI to markdown. Reads PDFs (the text layer where a page has one, OCR for scanned pages) and images (PNG, JPEG): headings, paragraphs, lists and tables as GFM tables. ${LOCAL}${o.allowHttp ? '' : ' http(s) URIs are turned off in this server.'}`,
      inputSchema: { uri: z.string().describe('file:, data:, http: or https: URI (or a file path) of a PDF or an image') },
      annotations,
    },
    async ({ uri }) => {
      try {
        return text((await converter.convert(await resolveUri(uri, o.allowHttp), { to: 'md' })).content);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'convert',
    {
      title: 'Convert a document to Markdown, JSON or text',
      description: `Convert a PDF or an image to Markdown, JSON (pages with status, blocks with type, text and box, tables as rows of cells) or plain text. Options: pages ('1-3'), engine ('auto' = text layer where a page has one, OCR elsewhere; 'layer'; 'ocr'), layout ('auto' | 'model' | 'geometry'), password. A page that cannot be read is named with its reason in the JSON; the other pages are still returned. ${LOCAL}`,
      inputSchema: {
        uri: z.string().describe('file:, data:, http: or https: URI (or a file path) of a PDF or an image'),
        to: z.enum(['md', 'json', 'text']).optional().describe("output format, default 'md'"),
        options: z
          .object({
            pages: z.string().optional().describe("pages to read: '1-3', '1,4,7-9', '5-'"),
            engine: z.enum(['auto', 'layer', 'ocr']).optional(),
            layout: z.enum(['auto', 'model', 'geometry']).optional(),
            password: z.string().optional(),
          })
          .optional(),
      },
      annotations,
    },
    async ({ uri, to, options }) => {
      try {
        const r = await converter.convert(await resolveUri(uri, o.allowHttp), { to: to ?? 'md', ...(options ?? {}) });
        return text(r.content);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'ocr_image',
    {
      title: 'Read the text in an image',
      description: `OCR of a photo, screenshot or scan (PNG or JPEG): the text lines in reading order with their boxes, as JSON { text, lines: [{ text, bbox: [x0, y0, x1, y1] }] }. One model reads Latin-script, Greek, Chinese and Japanese text; lang is a tesseract code ('eng', 'jpn', ...) and is checked, not used to pick a model. ${LOCAL}`,
      inputSchema: {
        uri: z.string().describe('file:, data:, http: or https: URI (or a file path) of a PNG or JPEG image'),
        lang: z.string().optional().describe("tesseract language code, default 'eng'"),
      },
      annotations,
    },
    async ({ uri, lang }) => {
      try {
        const src = await resolveUri(uri, o.allowHttp);
        ocrWorker ??= createWorker('eng', 1, o.converter);
        ocrWorker.catch(() => { ocrWorker = null; });
        const w = await ocrWorker;
        if (lang) await w.reinitialize(lang);
        const r = await w.recognize(typeof src === 'string' && !/^https?:/i.test(src) ? await readFile(src) : src, {}, { text: true, blocks: true });
        const lines = (r.data.blocks ?? []).flatMap((b) => b.paragraphs.flatMap((p) => p.lines.map((l) => ({ text: l.text.replace(/\n$/, ''), bbox: [l.bbox.x0, l.bbox.y0, l.bbox.x1, l.bbox.y1] }))));
        return text(JSON.stringify({ text: r.data.text, lines }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'list_input_formats',
    {
      title: 'List the input formats',
      description: `The file formats convert_to_markdown, convert and ocr_image read. ${LOCAL}`,
      annotations,
    },
    async () =>
      text(JSON.stringify({
        formats: [
          { extension: '.pdf', mime: 'application/pdf', tools: ['convert_to_markdown', 'convert'], note: 'text layer read directly; pages without one (scans) by OCR' },
          { extension: '.png', mime: 'image/png', tools: ['convert_to_markdown', 'convert', 'ocr_image'] },
          { extension: '.jpg', mime: 'image/jpeg', tools: ['convert_to_markdown', 'convert', 'ocr_image'] },
          { extension: '.jpeg', mime: 'image/jpeg', tools: ['convert_to_markdown', 'convert', 'ocr_image'] },
        ],
        uri_schemes: o.allowHttp ? ['file', 'data', 'http', 'https'] : ['file', 'data'],
      })),
  );

  const transport = new StdioServerTransport();
  const closed = new Promise<void>((done) => {
    transport.onclose = () => done();
    process.stdin.on('end', () => done());
  });
  await server.connect(transport);
  await closed;
  await converter.terminate().catch(() => {});
  if (ocrWorker) await (await (ocrWorker as Promise<Worker>).catch(() => null))?.terminate();
}
