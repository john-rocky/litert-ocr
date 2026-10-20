// litert-ocr/extract in Node.js, Deno and Bun: extract() runs Gemma 4 E2B with LiteRT-LM JS on WebGPU in a browser;
// there is no Node.js build of it yet, so these calls explain that and name what works here.

import { OcrError } from 'litert-ocr';

export { buildPrompt, layoutText, repairJson, schemaProblems, answerProblems, DEFAULT_INSTRUCTIONS } from './core.js';
export type { JsonSchema, BoxedLine } from './core.js';

export const LITERT_LM_VERSION = '0.19.0-nightly.20261018';

const why = () =>
  new OcrError(
    'LLM_UNAVAILABLE',
    'extract() runs in a browser with WebGPU (LiteRT-LM JS runs Gemma 4 E2B there); Node.js is not supported. In Node.js, convert() gives the text and tables (CLI: litert-ocr file --json), and buildPrompt() / repairJson() from this module work with a model of your choice.',
  );

export async function extract(): Promise<never> {
  throw why();
}

export function createExtractor(): never {
  throw why();
}
