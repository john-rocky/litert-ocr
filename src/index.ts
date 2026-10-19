// Browser entry. `import { createWorker } from 'litert-ocr'` gives the same API as tesseract.js.

import { makeApi } from './api.js';
import { browserMain } from './browser/main.js';

export type * from './core/types.js';
export type { OcrErrorCode } from './core/errors.js';
export { OcrError } from './core/errors.js';
export { modelInfo } from './core/models.js';
export type { StartupInfo } from './api.js';

import { documented } from './exports.js';

const api = documented(makeApi(browserMain));

export const { createWorker, recognize, detect, createScheduler, setLogging, OEM, PSM, languages } = api;
export default api;
