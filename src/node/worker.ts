// Entry of the Node.js worker thread (also used by Deno and Bun). LiteRT.js is made for browsers: its
// loader reaches for importScripts() and `self`. Two shims, kept inside this thread so they never touch
// the caller's globals: importScripts evaluates the Emscripten glue as the CommonJS script it is, and the
// threaded glue runs from a .cjs copy so its pthread workers load it as CommonJS too.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { availableParallelism, homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parentPort } from 'node:worker_threads';
import * as litert from '@litertjs/core';
import { CUT_HINT, cutShort } from '../core/cutshort.js';
import { OcrError, errText } from '../core/errors.js';
import { createHandler, type Platform, type Prepared } from '../core/handler.js';
import { LITERT_FILES, PKG_NAME, litertPrint, type RuntimeVariant } from '../core/models.js';
import type { InitOptions, WireImage } from '../core/protocol.js';
import type { Rectangle } from '../core/types.js';
import { decodeBytes } from './decode.js';
import { cropScale, jsDocOps, jsOps, type Raster } from './raster.js';

const g = globalThis as unknown as Record<string, unknown>;
const runtimeName = g.Deno ? 'deno' : g.Bun ? 'bun' : 'node';
const require = createRequire(import.meta.url);
const MAX_THREADS = 12;

export function cacheDir(o: Pick<InitOptions, 'cachePath'>): string {
  if (o.cachePath) return resolve(o.cachePath);
  const xdg = process.env.XDG_CACHE_HOME;
  // the package name without an npm scope: one directory
  return join(xdg && isAbsolute(xdg) ? xdg : join(homedir(), '.cache'), PKG_NAME.replace(/^@[^/]+\//, ''));
}

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

function isLocal(u: string): boolean {
  return u.startsWith('file:') || !/^[a-z][a-z0-9+.-]*:/i.test(u);
}

const platform: Platform<Raster> = {
  name: runtimeName,

  async loadRuntime(o, io) {
    const wasmDir = join(dirname(require.resolve('@litertjs/core/package.json')), 'wasm');
    let relaxed = false;
    try { relaxed = await litert.supportsFeature('relaxedSimd'); } catch { /* old runtime */ }
    // Bun 1.4: the threaded glue starts but its pthread workers never run (0 % CPU) -> 1 thread there.
    let threads = relaxed && runtimeName !== 'bun';
    if (runtimeName === 'bun') io.notice('Bun runs LiteRT.js on 1 thread (its worker threads do not start the threaded build); Node.js and Deno use several.', 'warn');
    const dir = join(cacheDir(o), 'runtime', 'litert-2.5.3');
    const attempt = async (variant: RuntimeVariant, useThreads: boolean) => {
      const f = LITERT_FILES[variant];
      const js = await io.fetch({ name: f.js.file, url: join(wasmDir, f.js.file), bytes: f.js.bytes, sha256: f.js.sha256, origin: 'npm @litertjs/core 2.5.3' }, 'loading runtime');
      const wasm = await io.fetch({ name: f.wasm.file, url: join(wasmDir, f.wasm.file), bytes: f.wasm.bytes, sha256: f.wasm.sha256, origin: 'npm @litertjs/core 2.5.3' }, 'loading runtime');
      // @litertjs/core is "type": "module", so its .js glue would load as an ES module; run a .cjs copy.
      mkdirSync(dir, { recursive: true });
      const cjs = join(dir, f.js.file.replace(/\.js$/, '.cjs'));
      if (!existsSync(cjs) || sha256(readFileSync(cjs)) !== f.js.sha256) {
        const tmp = `${cjs}.${process.pid}.tmp`;
        writeFileSync(tmp, js);
        renameSync(tmp, cjs);
      }
      g.importScripts = () => {
        const module = { exports: {} as unknown };
        new Function('module', 'exports', 'require', '__filename', '__dirname', new TextDecoder().decode(js))(module, module.exports, require, cjs, dir);
        g.ModuleFactory = module.exports;
      };
      if (g.self === undefined) g.self = globalThis;
      g.Module = { ...litertPrint, wasmBinary: wasm, locateFile: (p: string) => join(wasmDir, p) };
      try {
        await litert.loadLiteRt(pathToFileURL(wasmDir + '/').href, useThreads ? { threads: true } : {});
      } finally {
        delete g.importScripts;
        g.Module = undefined;
      }
    };
    const origWarn = console.warn;
    console.warn = (...a: unknown[]) => { if (!String(a[0]).startsWith('Failed to create default WebGPU device')) origWarn(...a); };
    try {
      await attempt(relaxed ? (threads ? 'threaded' : 'plain') : 'compat', threads);
    } catch (e) {
      if (e instanceof OcrError) throw e;
      if (!threads) throw new OcrError('RUNTIME_LOAD_FAILED', `LiteRT.js could not start in ${runtimeName} ${process.version}: ${errText(e)}.`, { cause: e });
      io.notice(`The threaded LiteRT.js runtime could not start (${errText(e)}); using 1 thread.`, 'warn');
      threads = false;
      try {
        await attempt('plain', false);
      } catch (e2) {
        if (e2 instanceof OcrError) throw e2;
        throw new OcrError('RUNTIME_LOAD_FAILED', `LiteRT.js could not start in ${runtimeName}: ${errText(e2)}.`, { cause: e2 });
      }
    } finally {
      console.warn = origWarn;
    }
    const n = threads ? Math.max(1, Math.min(availableParallelism(), MAX_THREADS)) : 1;
    return { litert, threads: n };
  },

  async cache(o) {
    if (o.cacheMethod === 'none') return null;
    const dir = join(cacheDir(o), 'files');
    const name = (key: string) => join(dir, `${createHash('sha256').update(key).digest('hex').slice(0, 16)}-${key.split(/[\\/]/).pop()!.replace(/[^\w.-]/g, '_')}`);
    return {
      async get(key) {
        if (isLocal(key)) return null; // local files are read in place, never copied
        try {
          return new Uint8Array(await readFile(name(key)));
        } catch {
          return null;
        }
      },
      async put(key, bytes) {
        if (isLocal(key)) return;
        mkdirSync(dir, { recursive: true });
        const f = name(key);
        const tmp = `${f}.${process.pid}.${Date.now()}.tmp`;
        writeFileSync(tmp, bytes);
        renameSync(tmp, f);
      },
      async has(key, bytes) {
        if (isLocal(key)) return false;
        try {
          return !bytes || statSync(name(key)).size === bytes;
        } catch {
          return false;
        }
      },
    };
  },

  sha256: async (b) => sha256(b),

  readLocal(url) {
    if (!isLocal(url)) return null;
    const p = url.startsWith('file:') ? fileURLToPath(url) : url;
    return readFile(p).then((b) => new Uint8Array(b.buffer, b.byteOffset, b.byteLength));
  },

  async decode(image: WireImage, onCut) {
    let bytes: Uint8Array;
    switch (image.kind) {
      case 'pixels': {
        if (image.data.length !== image.width * image.height * 4) {
          throw new OcrError('IMAGE_DECODE_FAILED', `Raw pixels must be width * height * 4 RGBA bytes: got ${image.data.length} bytes for ${image.width} x ${image.height}.`);
        }
        return { src: { width: image.width, height: image.height, data: image.data }, release: () => {} };
      }
      case 'path':
        try {
          bytes = new Uint8Array(await readFile(image.path));
        } catch (e) {
          throw new OcrError('IMAGE_FETCH_FAILED', `Could not read the image file ${image.path} (${errText(e)}).`, { url: image.path });
        }
        break;
      case 'url': {
        let resp: Response;
        try {
          resp = await fetch(image.url);
        } catch (e) {
          throw new OcrError('IMAGE_FETCH_FAILED', `Could not fetch the image at ${image.url.slice(0, 80)} (${errText(e)}).`, { url: image.url });
        }
        if (!resp.ok) throw new OcrError('IMAGE_FETCH_FAILED', `Could not fetch the image at ${image.url}: HTTP ${resp.status}.`, { url: image.url, status: resp.status });
        bytes = new Uint8Array(await resp.arrayBuffer());
        break;
      }
      case 'blob':
        bytes = new Uint8Array(await image.blob.arrayBuffer());
        break;
      case 'bytes':
        bytes = image.bytes;
        break;
      case 'bitmap':
        throw new OcrError('IMAGE_UNSUPPORTED_TYPE', 'ImageBitmap is a browser type; in Node.js pass a file path, Buffer or { data, width, height }.');
    }
    const cut = cutShort(bytes);
    if (cut) onCut?.(`${cut} ${CUT_HINT}`);
    return { src: decodeBytes(bytes), release: () => {} };
  },

  async prepare(r: Raster, rect: Rectangle | null, maxSide: number): Promise<Prepared<Raster>> {
    const size = { width: r.width, height: r.height };
    let sx = 0, sy = 0, sw = r.width, sh = r.height;
    if (rect) {
      sx = Math.max(0, Math.floor(rect.left));
      sy = Math.max(0, Math.floor(rect.top));
      const ex = Math.min(r.width, Math.ceil(rect.left + rect.width)), ey = Math.min(r.height, Math.ceil(rect.top + rect.height));
      if (!(ex > sx && ey > sy)) throw new OcrError('INVALID_ARGUMENT', `options.rectangle ${JSON.stringify(rect)} does not overlap the ${r.width} x ${r.height} image.`);
      sw = ex - sx;
      sh = ey - sy;
    }
    const longer = Math.max(sw, sh);
    const scale = longer > maxSide ? maxSide / longer : 1;
    if (!rect && scale === 1) return { src: r, map: { scale: 1, dx: 0, dy: 0 }, size, release: () => {} };
    const out = cropScale(r, sx, sy, sw, sh, scale);
    return { src: out, map: { scale: sw / out.width, dx: sx, dy: sy }, size, release: () => {} };
  },

  ops: jsOps as Platform<Raster>['ops'],
  doc: jsDocOps,
};

if (!parentPort) throw new Error('litert-ocr: dist/node-worker.js runs as a worker thread; import the package instead.');
const port = parentPort;
const handler = createHandler(platform, (msg) => port.postMessage(msg));
port.on('message', handler);
port.postMessage({ type: 'hello' });
