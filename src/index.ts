// Browser entry. `import { createWorker } from 'litert-ocr'` gives the same API as tesseract.js; convert() and
// toMarkdown() turn PDFs and images into Markdown, JSON or text.

import { makeApi } from './api.js';
import { browserDoc } from './browser/doc.js';
import { browserMain } from './browser/main.js';
import { makeDocApi } from './doc/convert.js';

export type * from './core/types.js';
export type * from './doc/types.js';
export type { Block, BlockType, Box } from './doc/geom.js';
export type { OcrErrorCode } from './core/errors.js';
export { OcrError } from './core/errors.js';
export { modelInfo } from './core/models.js';
export type { StartupInfo } from './api.js';

import { documented, documentedDoc } from './exports.js';

const api = documented(makeApi({ ...browserMain, doc: browserDoc }));
const docApi = documentedDoc(makeDocApi(api.createWorker, browserDoc));

export const { createWorker, recognize, detect, createScheduler, setLogging, OEM, PSM, languages } = api;
export const { convert, toMarkdown, createConverter } = docApi;
export default { ...api, ...docApi };
