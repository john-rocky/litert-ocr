// litert-ocr/extract in the browser: a document image (or PDF) and a JSON Schema -> a JSON object with those fields.
// OCR (this library) -> the lines laid out in rows -> Gemma 4 E2B (the web build) on LiteRT-LM JS (WebGPU) with the
// prompt below -> the answer repaired (R1-R3) and checked against the schema. Measured on CORD v2 receipts.
// LiteRT-LM JS is an optional peer dependency pinned to 0.19.0-nightly.20261018: the stable 0.18.1 cannot create an
// engine (google-ai-edge/LiteRT-LM#4051); move to the next stable release once it fixes that.

import { OcrError, convert, createWorker, type ImageLike, type LoggerMessage, type WorkerOptions } from 'litert-ocr';
import { answerProblems, buildPrompt, layoutText, repairJson, schemaProblems, type BoxedLine, type JsonSchema } from './core.js';

export { buildPrompt, layoutText, repairJson, schemaProblems, answerProblems, DEFAULT_INSTRUCTIONS } from './core.js';
export type { JsonSchema, BoxedLine } from './core.js';

export const LITERT_LM_VERSION = '0.19.0-nightly.20261018';
/** Gemma 4 E2B, the web build (text in, text out), from litert-community at a pinned commit. */
export const LLM_MODEL = {
  name: 'Gemma 4 E2B (gemma-4-E2B-it-web.litertlm)',
  url: 'https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/c9190371a5b7a1129af8da87e10b60e1ff9c8967/gemma-4-E2B-it-web.litertlm',
  bytes: 2008432640,
  sha256: '3a08e8d94e23b814ae5414469c370c503813949acb8ceaa17e4ebf8a35af35b5',
};
const LLM_CACHE = 'litert-ocr-llm-v1';

export interface LlmOptions {
  /** The @litert-lm/core module, when you import it yourself (a CDN or an import map); default: import('@litert-lm/core'). */
  module: unknown;
  /** Model file: a URL, Blob or ReadableStream. Default: LLM_MODEL.url (2.0 GB, downloaded once into the Cache API). */
  model: string | Blob | ReadableStream<Uint8Array>;
  /** Directory URL of the LiteRT-LM JS wasm files (default: the package's own pinned jsDelivr copy). */
  wasmPath: string;
  /** Keep the downloaded model in the Cache API (default true). false = stream it on every createExtractor(). */
  cache: boolean;
  /** Longest answer in tokens (default 1024). */
  maxOutputTokens: number;
  /** Give up on one answer after this many ms (default 120000). */
  timeoutMs: number;
}

export interface ExtractOptions {
  /** What the document is, for the prompt ("receipt", "invoice", "business card"); default "document". */
  documentType: string;
  /** Rules for the model after the schema; default: copy values as printed, leave out missing fields. */
  instructions: string;
  /** Model and runtime settings. */
  llm: Partial<LlmOptions>;
  /** createWorker options for the OCR (modelBase, wasmPath, ...), and the logger. */
  ocr: Partial<WorkerOptions>;
  logger: (m: LoggerMessage) => void;
}

export interface ExtractResult<T = Record<string, unknown>> {
  /** The answer as JSON (null when it could not be parsed even after the repair). */
  data: T | null;
  /** true when data parsed and follows the schema (types, required fields, enum values). */
  valid: boolean;
  /** Where data does not follow the schema, or why there is no data. */
  errors: string[];
  /** The model's answer as it came. */
  raw: string;
  /** 'R0' = parsed as is, 'R1-R3' = after removing a code fence / text around the object / trailing commas. */
  repaired: 'R0' | 'R1-R3' | null;
  /** The OCR text the model read. */
  text: string;
  timings: { ocrMs: number; llmMs: number };
}

export interface Extractor {
  extract<T = Record<string, unknown>>(input: ImageLike | URL, schema: JsonSchema, options?: Partial<Omit<ExtractOptions, 'llm'>>): Promise<ExtractResult<T>>;
  /** Free the model (GPU memory) and the OCR worker. */
  terminate(): Promise<void>;
}

type LiteRtLm = {
  loadLiteRtLm(path?: string): Promise<unknown>;
  Engine: { create(s: Record<string, unknown>): Promise<LmEngine> };
};
type LmEngine = { createConversation(c: Record<string, unknown>): Promise<LmConversation>; delete(): Promise<void> };
type LmConversation = { sendMessageStreaming(m: unknown): AsyncIterable<{ content?: { type?: string; text?: string }[] }>; cancel(): void; delete(): Promise<void> };

let runtime: Promise<LiteRtLm> | null = null;

async function loadRuntime(o: Partial<LlmOptions>): Promise<LiteRtLm> {
  runtime ??= (async () => {
    let mod: LiteRtLm;
    try {
      mod = (o.module ?? (await import('@litert-lm/core'))) as LiteRtLm;
    } catch (e) {
      throw new OcrError('LLM_UNAVAILABLE', `extract() needs LiteRT-LM JS, which could not be imported (${(e as Error)?.message ?? e}). Install the optional peer dependency: npm install @litert-lm/core@${LITERT_LM_VERSION} (or import it yourself and pass { llm: { module } }).`, { cause: e });
    }
    if (!mod || typeof mod.loadLiteRtLm !== 'function' || !mod.Engine) throw new OcrError('LLM_UNAVAILABLE', `{ llm: { module } } is not the @litert-lm/core module (no loadLiteRtLm / Engine). Pass the module object of @litert-lm/core@${LITERT_LM_VERSION}.`);
    try {
      await mod.loadLiteRtLm(o.wasmPath);
    } catch (e) {
      throw new OcrError('LLM_UNAVAILABLE', `LiteRT-LM JS could not load its WebAssembly (${(e as Error)?.message ?? e}). Check wasmPath, or the page's Content-Security-Policy (connect-src and script-src for cdn.jsdelivr.net).`, { cause: e });
    }
    return mod;
  })();
  runtime.catch(() => { runtime = null; });
  return runtime;
}

async function modelSource(o: Partial<LlmOptions>, log: (m: Partial<LoggerMessage>) => void): Promise<string | Blob | ReadableStream<Uint8Array>> {
  const model = o.model ?? LLM_MODEL.url;
  if (typeof model !== 'string') return model;
  const pinned = model === LLM_MODEL.url;
  const useCache = o.cache !== false && typeof caches !== 'undefined';
  const cache = useCache ? await caches.open(LLM_CACHE).catch(() => null) : null;
  const hit = cache ? await cache.match(model).catch(() => undefined) : undefined;
  if (hit?.body) {
    log({ status: 'loading model', progress: 1, file: LLM_MODEL.name, fromCache: true });
    return hit.body;
  }
  log({ status: 'notice', message: cache
    ? `extract() downloads the ${pinned ? '2.0 GB Gemma 4 E2B ' : ''}model once (${model}); later calls read it from the browser cache.`
    : `extract() streams the ${pinned ? '2.0 GB Gemma 4 E2B ' : ''}model from ${model} (not cached: cache is off or the Cache API is missing).` });
  let resp: Response;
  try {
    resp = await fetch(model, { credentials: 'omit' });
  } catch (e) {
    throw new OcrError('LLM_MODEL_FETCH_FAILED', `Could not download the model from ${model} (${(e as Error)?.message ?? e}). The first extract() needs the network (2.0 GB); check that huggingface.co is allowed by the page's Content-Security-Policy connect-src, or serve the file yourself and pass { llm: { model: '<your URL>' } }.`, { url: model, cause: e });
  }
  if (!resp.ok || !resp.body) throw new OcrError('LLM_MODEL_FETCH_FAILED', `Could not download the model from ${model}: HTTP ${resp.status}. Check the URL, or serve the file yourself and pass { llm: { model } }.`, { url: model, status: resp.status });
  const total = Number(resp.headers.get('content-length')) || (pinned ? LLM_MODEL.bytes : 0);
  if (pinned && total && total !== LLM_MODEL.bytes) throw new OcrError('LLM_MODEL_FETCH_FAILED', `The model at ${model} is ${total} bytes, the pinned file is ${LLM_MODEL.bytes} bytes.`, { url: model });
  let loaded = 0, last = 0;
  const counted = resp.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, ctl) {
      loaded += chunk.byteLength;
      const now = Date.now();
      if (now - last > 250) { last = now; log({ status: 'loading model', progress: total ? loaded / total : 0, file: LLM_MODEL.name, loaded, total, fromCache: false }); }
      ctl.enqueue(chunk);
    },
  }));
  if (!cache) return counted;
  try {
    await cache.put(model, new Response(counted, { headers: { 'content-length': String(total) } }));
  } catch (e) {
    log({ status: 'notice', message: `The model could not be kept in the browser cache (${(e as Error)?.message ?? e}); it is streamed instead and downloads again next time.` });
    return model;
  }
  const again = await cache.match(model);
  return again?.body ?? model;
}

export function createExtractor(options: Partial<ExtractOptions> = {}): Extractor {
  const llm = options.llm ?? {};
  const logger = options.logger ?? options.ocr?.logger ?? null;
  const log = (m: Partial<LoggerMessage>) => { try { logger?.({ workerId: 'extract', jobId: 'extract', userJobId: 'extract', status: 'notice', progress: 1, ...m } as LoggerMessage); } catch { /* ignore */ } };
  let engine: Promise<LmEngine> | null = null;
  let worker: ReturnType<typeof createWorker> | null = null;
  let closed = false;

  const getEngine = () => {
    engine ??= (async () => {
      const gpu = (navigator as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
      const adapter = gpu ? await gpu.requestAdapter().catch(() => null) : null;
      if (!adapter) throw new OcrError('LLM_WEBGPU_UNAVAILABLE', `extract() runs Gemma 4 E2B on WebGPU, and ${gpu ? 'this browser found no WebGPU adapter' : 'this browser has no WebGPU (navigator.gpu)'}. Use a browser with WebGPU (Chrome or Edge 113+, Safari 26+); OCR and convert() work without it.`);
      const mod = await loadRuntime(llm);
      const source = await modelSource(llm, log);
      try {
        return await mod.Engine.create({ model: source });
      } catch (e) {
        const msg = (e as Error)?.message ?? String(e);
        if (/fetch|network|404|Failed to load/i.test(msg)) throw new OcrError('LLM_MODEL_FETCH_FAILED', `LiteRT-LM could not read the model (${msg}).`, { cause: e });
        throw new OcrError('LLM_FAILED', `LiteRT-LM could not create the engine (${msg}). extract() needs LiteRT-LM JS ${LITERT_LM_VERSION} and the web build of Gemma 4 E2B.`, { cause: e });
      }
    })();
    engine.catch(() => { engine = null; });
    return engine;
  };

  async function ocrText(input: ImageLike | URL): Promise<string> {
    // a PDF: the text convert() reads (text layer or OCR); an image: the OCR lines laid out in rows
    const bytesHead = await peekPdf(input);
    if (bytesHead) {
      const r = await convert(input as ImageLike, { ...(options.ocr ?? {}), to: 'text' });
      return r.content;
    }
    worker ??= createWorker('eng', 1, options.ocr ?? {});
    const w = await worker;
    const r = await w.recognize(input as ImageLike, {}, { text: true, blocks: true });
    const lines: BoxedLine[] = (r.data.blocks ?? []).flatMap((b) => b.paragraphs.flatMap((p) => p.lines.map((l) => ({ text: l.text.replace(/\n$/, ''), box: [l.bbox.x0, l.bbox.y0, l.bbox.x1, l.bbox.y1] as BoxedLine['box'] }))));
    return layoutText(lines);
  }

  return {
    async extract<T>(input: ImageLike | URL, schema: JsonSchema, o: Partial<Omit<ExtractOptions, 'llm'>> = {}): Promise<ExtractResult<T>> {
      if (closed) throw new OcrError('WORKER_TERMINATED', 'This extractor was terminated. Create a new one with createExtractor().');
      const problems = schemaProblems(schema);
      if (problems.length) throw new OcrError('SCHEMA_INVALID', `extract(input, schema): ${problems.join('; ')}.`);
      const e = await getEngine();
      const t0 = performance.now();
      const text = await ocrText(input);
      const ocrMs = performance.now() - t0;
      const prompt = buildPrompt(schema, text, o.documentType ?? options.documentType, o.instructions ?? options.instructions);
      const t1 = performance.now();
      const conv = await e.createConversation({ sessionConfig: { samplerParams: { type: 1, k: 1 }, maxOutputTokens: llm.maxOutputTokens ?? 1024 }, enableConstrainedDecoding: false });
      let raw = '';
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; try { conv.cancel(); } catch { /* ignore */ } }, llm.timeoutMs ?? 120000);
      try {
        for await (const chunk of conv.sendMessageStreaming({ role: 'user', content: [{ type: 'text', text: prompt }] })) {
          for (const part of chunk?.content ?? []) if (part?.type === 'text' && typeof part.text === 'string') raw += part.text;
        }
      } catch (err) {
        if (!timedOut) throw new OcrError('LLM_FAILED', `The model stopped while answering (${(err as Error)?.message ?? err}).`, { cause: err });
      } finally {
        clearTimeout(timer);
        await conv.delete().catch(() => {});
      }
      const llmMs = performance.now() - t1;
      const { value, stage } = repairJson(raw);
      const errors: string[] = [];
      if (timedOut) errors.push(`the answer was cut off after ${llm.timeoutMs ?? 120000} ms`);
      if (stage === null) errors.push('the answer is not JSON, even after removing a code fence, the text around the object and trailing commas');
      else errors.push(...answerProblems(value, schema));
      return { data: (stage === null ? null : value) as T | null, valid: stage !== null && errors.length === 0, errors, raw, repaired: stage, text, timings: { ocrMs, llmMs } };
    },
    async terminate() {
      closed = true;
      const e = engine;
      engine = null;
      if (e) await (await e.catch(() => null))?.delete().catch(() => {});
      const w = worker;
      worker = null;
      if (w) await (await w.catch(() => null))?.terminate();
    },
  };
}

/** One extraction with an extractor of its own (the model stays in the browser cache, not in memory). */
export async function extract<T = Record<string, unknown>>(input: ImageLike | URL, schema: JsonSchema, options: Partial<ExtractOptions> = {}): Promise<ExtractResult<T>> {
  const x = createExtractor(options);
  try {
    return await x.extract<T>(input, schema);
  } finally {
    await x.terminate();
  }
}

async function peekPdf(input: ImageLike | URL): Promise<boolean> {
  const isPdf = (b: Uint8Array) => b.length >= 5 && String.fromCharCode(...b.subarray(0, 1024)).includes('%PDF-');
  if (typeof Blob !== 'undefined' && input instanceof Blob) return input.type === 'application/pdf' || isPdf(new Uint8Array(await input.slice(0, 1024).arrayBuffer()));
  if (input instanceof ArrayBuffer) return isPdf(new Uint8Array(input.slice(0, 1024)));
  if (ArrayBuffer.isView(input)) return isPdf(new Uint8Array(input.buffer, input.byteOffset, Math.min(1024, input.byteLength)));
  const s = input instanceof URL ? input.href : typeof input === 'string' ? input : '';
  return /\.pdf($|[?#])/i.test(s) || /^data:application\/pdf/i.test(s);
}
