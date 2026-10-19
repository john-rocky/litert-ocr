// Download one pinned file with progress, check its sha256, and keep it in the platform cache.

import { OcrError, errText } from './errors.js';

export interface FileSpec {
  /** Label used in messages: the role or file name. */
  name: string;
  url: string;
  bytes?: number;
  /** Expected sha256 (hex); undefined = used unverified (a notice says so). */
  sha256?: string;
  /** Where the default files live, for the "serve them yourself" hint. */
  origin: string;
}

export interface FileCache {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, bytes: Uint8Array): Promise<void>;
}

export type CacheMethod = 'write' | 'readOnly' | 'refresh' | 'none';

export interface FetchContext {
  cache: FileCache | null;
  cacheMethod: CacheMethod;
  sha256: (bytes: Uint8Array) => Promise<string>;
  /** Called with bytes received so far for this file. */
  onBytes: (loaded: number, total: number, fromCache: boolean) => void;
  notice: (message: string) => void;
  /** Platform reader for non-http locations (Node file paths); null = use fetch. */
  readLocal?: (url: string) => Promise<Uint8Array> | null;
  /** The option to name in messages for serving the file yourself. */
  selfHostOption: 'modelBase' | 'wasmPath';
}

const isOffline = () => typeof navigator !== 'undefined' && (navigator as { onLine?: boolean }).onLine === false;

export async function fetchVerified(spec: FileSpec, ctx: FetchContext): Promise<Uint8Array> {
  const { url } = spec;
  const total = spec.bytes ?? 0;
  if (ctx.cache && (ctx.cacheMethod === 'write' || ctx.cacheMethod === 'readOnly')) {
    const hit = await ctx.cache.get(url).catch(() => null);
    if (hit && (!spec.bytes || hit.byteLength === spec.bytes)) {
      ctx.onBytes(hit.byteLength, hit.byteLength, true);
      return hit;
    }
  }
  let bytes: Uint8Array;
  const local = ctx.readLocal?.(url);
  if (local) {
    try {
      bytes = await local;
    } catch (e) {
      throw new OcrError('MODEL_FETCH_FAILED', `Could not read ${spec.name} from ${url}: ${errText(e)}. Check the path given in ${ctx.selfHostOption}.`, { url, cause: e });
    }
    ctx.onBytes(bytes.byteLength, bytes.byteLength, false);
  } else {
    bytes = await download(spec, ctx, total);
  }
  if (spec.bytes && bytes.byteLength !== spec.bytes) {
    throw new OcrError(
      'MODEL_SHA256_MISMATCH',
      `${spec.name} from ${url} is ${bytes.byteLength} bytes, the pinned file is ${spec.bytes} bytes. ${mismatchHint(spec, ctx)}`,
      { url },
    );
  }
  if (spec.sha256) {
    const got = await ctx.sha256(bytes);
    if (got !== spec.sha256) {
      throw new OcrError(
        'MODEL_SHA256_MISMATCH',
        `${spec.name} from ${url} does not match the pinned file (sha256 ${got}, expected ${spec.sha256}). ${mismatchHint(spec, ctx)}`,
        { url },
      );
    }
  } else {
    ctx.notice(`${spec.name} from ${url} is used without a sha256 check (none was given).`);
  }
  if (ctx.cache && (ctx.cacheMethod === 'write' || ctx.cacheMethod === 'refresh')) {
    await ctx.cache.put(url, bytes).catch((e) => ctx.notice(`Could not cache ${spec.name} (${errText(e)}); it will be downloaded again next time.`));
  }
  return bytes;
}

function mismatchHint(spec: FileSpec, ctx: FetchContext): string {
  return `If ${ctx.selfHostOption} points at your own copy, copy the files again from ${spec.origin}. To use a different file on purpose, pass it in modelFiles with its own sha256.`;
}

async function download(spec: FileSpec, ctx: FetchContext, total: number): Promise<Uint8Array> {
  const { url } = spec;
  const host = (() => {
    try { return new URL(url).host; } catch { return url; }
  })();
  let resp: Response;
  try {
    resp = await fetch(url, { credentials: 'omit' });
  } catch (e) {
    if (isOffline()) {
      throw new OcrError(
        'MODEL_FETCH_FAILED',
        `Could not download ${spec.name} from ${url}: this device is offline. The first createWorker() needs the network once; later runs read the cache. To serve the files yourself, pass { ${ctx.selfHostOption}: '<your URL>/' }.`,
        { url, cause: e },
      );
    }
    throw new OcrError(
      'MODEL_FETCH_FAILED',
      `Could not download ${spec.name} from ${url}: the request did not complete (${errText(e)}). Either this device is offline (the first createWorker() needs the network once; later runs read the cache) or the request was blocked: check that ${host} is allowed by the page's Content-Security-Policy connect-src, a firewall or an extension. To serve the files yourself, copy them from ${spec.origin} and pass { ${ctx.selfHostOption}: '<your URL>/' }.`,
      { url, cause: e },
    );
  }
  if (!resp.ok) {
    throw new OcrError(
      'MODEL_FETCH_FAILED',
      `Could not download ${spec.name} from ${url}: HTTP ${resp.status}${resp.statusText ? ' ' + resp.statusText : ''}. ${resp.status === 404 ? 'The file is not at that address' : 'The server refused the request'}; check ${ctx.selfHostOption}, or copy the files from ${spec.origin}.`,
      { url, status: resp.status },
    );
  }
  const len = Number(resp.headers.get('content-length')) || total;
  if (!resp.body) {
    const b = new Uint8Array(await resp.arrayBuffer());
    ctx.onBytes(b.byteLength, b.byteLength, false);
    return b;
  }
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  let last = 0;
  for (;;) {
    let r: ReadableStreamReadResult<Uint8Array>;
    try {
      r = await reader.read();
    } catch (e) {
      throw new OcrError('MODEL_FETCH_FAILED', `The download of ${spec.name} from ${url} broke off after ${loaded} bytes (${errText(e)}). Retry createWorker(); a partial file is never cached.`, { url, cause: e });
    }
    if (r.done) break;
    chunks.push(r.value);
    loaded += r.value.byteLength;
    const now = Date.now();
    if (now - last > 100) {
      last = now;
      ctx.onBytes(loaded, len || loaded, false);
    }
  }
  const out = new Uint8Array(loaded);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  ctx.onBytes(loaded, loaded, false);
  return out;
}
