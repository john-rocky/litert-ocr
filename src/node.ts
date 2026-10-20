// Node.js / Deno / Bun entry: the same API as the browser build; the engine runs in a worker thread.

import { makeApi } from './api.js';
import { makeDocApi } from './doc/convert.js';
import { nodeDoc } from './node/doc.js';
import { nodeMain } from './node/main.js';

export type * from './core/types.js';
export type * from './doc/types.js';
export type { Block, BlockType, Box } from './doc/geom.js';
export type { OcrErrorCode } from './core/errors.js';
export { OcrError } from './core/errors.js';
export { modelInfo } from './core/models.js';
export type { StartupInfo } from './api.js';

import { documented, documentedDoc } from './exports.js';

const api = documented(makeApi({ ...nodeMain, doc: nodeDoc }));
const docApi = documentedDoc(makeDocApi(api.createWorker, nodeDoc));

export const { createWorker, recognize, detect, createScheduler, setLogging, OEM, PSM, languages } = api;
export const { convert, toMarkdown, createConverter } = docApi;
export default { ...api, ...docApi };
