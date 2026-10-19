// Messages between the caller's thread and the worker (Web Worker or worker_threads).

import type { SerializedError } from './errors.js';
import type { CacheMethod } from './fetcher.js';
import type { ModelRole } from './models.js';
import type { OutputFormats, Rectangle } from './types.js';

export interface InitOptions {
  /** Absolute URL (browser) or URL / directory path (Node) of the model directory. */
  modelBase: string;
  modelFiles: Partial<Record<ModelRole, { url: string; sha256?: string }>>;
  /** Absolute URL of the LiteRT.js wasm directory (browser). */
  wasmPath: string;
  backend: 'auto' | 'wasm';
  /** Where the recognizers run (see WorkerOptions.recognizer); absent = 'wasm'. */
  recognizer?: 'wasm' | 'webgpu';
  cacheMethod: CacheMethod;
  cachePath?: string;
  /** Load the 640 and 960 recognizers at start instead of on first use. */
  eager: boolean;
}

/** An image in a form that can cross the thread boundary. */
export type WireImage =
  | { kind: 'url'; url: string }
  | { kind: 'path'; path: string }
  | { kind: 'blob'; blob: Blob }
  | { kind: 'bytes'; bytes: Uint8Array }
  | { kind: 'bitmap'; bitmap: ImageBitmap }
  | { kind: 'pixels'; data: Uint8ClampedArray; width: number; height: number };

export interface JobParams {
  whitelist: string | null;
  blacklist: string | null;
  singleLine: boolean;
}

export type Request =
  | { type: 'init'; id: string; options: InitOptions }
  | { type: 'recognize'; id: string; image: WireImage; rectangle: Rectangle | null; params: JobParams; output: Partial<OutputFormats> }
  | { type: 'terminate'; id: string };

export interface ProgressData {
  status: string;
  progress: number;
  message?: string;
  level?: 'info' | 'warn';
  file?: string;
  loaded?: number;
  total?: number;
  fromCache?: boolean;
}

export type Response =
  | { type: 'hello' }
  | { type: 'progress'; id: string; data: ProgressData }
  | { type: 'resolve'; id: string; data: unknown }
  | { type: 'reject'; id: string; error: SerializedError };
