// One error class for every failure the library reports. `code` is stable (switch on it); `message`
// says what happened and what to do next, so a person or a coding agent can act on it as written.

export type OcrErrorCode =
  | 'WORKER_TERMINATED'
  | 'WORKER_START_FAILED'
  | 'RUNTIME_LOAD_FAILED'
  | 'MODEL_FETCH_FAILED'
  | 'MODEL_SHA256_MISMATCH'
  | 'MODEL_COMPILE_FAILED'
  | 'IMAGE_UNSUPPORTED_TYPE'
  | 'IMAGE_FETCH_FAILED'
  | 'IMAGE_DECODE_FAILED'
  | 'IMAGE_CROSS_ORIGIN'
  | 'LANG_NOT_SUPPORTED'
  | 'INVALID_ARGUMENT'
  | 'INTERNAL';

export interface SerializedError {
  name: string;
  code: OcrErrorCode;
  message: string;
  url?: string;
  status?: number;
}

export class OcrError extends Error {
  override name = 'OcrError';
  readonly code: OcrErrorCode;
  readonly url?: string;
  readonly status?: number;

  constructor(code: OcrErrorCode, message: string, extra: { url?: string; status?: number; cause?: unknown } = {}) {
    super(message, extra.cause !== undefined ? { cause: extra.cause } : undefined);
    this.code = code;
    if (extra.url !== undefined) this.url = extra.url;
    if (extra.status !== undefined) this.status = extra.status;
  }

  toJSON(): SerializedError {
    const out: SerializedError = { name: this.name, code: this.code, message: this.message };
    if (this.url !== undefined) out.url = this.url;
    if (this.status !== undefined) out.status = this.status;
    return out;
  }
}

export function serializeError(e: unknown): SerializedError {
  if (e instanceof OcrError) return e.toJSON();
  const message = e instanceof Error ? e.message : String(e);
  return { name: 'OcrError', code: 'INTERNAL', message: `Unexpected error: ${message}. Please report it with the image and the browser or Node.js version.` };
}

export function deserializeError(s: SerializedError): OcrError {
  const extra: { url?: string; status?: number } = {};
  if (s.url !== undefined) extra.url = s.url;
  if (s.status !== undefined) extra.status = s.status;
  return new OcrError(s.code, s.message, extra);
}

/** The message of an error, without a final period (callers add their own punctuation). */
export const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).replace(/\.+\s*$/, '');
