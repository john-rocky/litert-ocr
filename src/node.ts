// Node.js / Deno / Bun entry: the same API as the browser build; the engine runs in a worker thread.

import { makeApi } from './api.js';
import { nodeMain } from './node/main.js';

export type * from './core/types.js';
export type { OcrErrorCode } from './core/errors.js';
export { OcrError } from './core/errors.js';
export { modelInfo } from './core/models.js';
export type { StartupInfo } from './api.js';

const api = makeApi(nodeMain);

export const { createWorker, recognize, detect, createScheduler, setLogging, OEM, PSM, languages } = api;
export default api;
