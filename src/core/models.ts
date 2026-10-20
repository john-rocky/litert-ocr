// Pinned model and runtime files. Every byte the library downloads is listed here with its size and
// sha256; a file that does not match is rejected (MODEL_SHA256_MISMATCH), so a moved or edited file on
// the Hub or the CDN can never change what the library computes.

export const PKG_NAME = 'litert-ocr';
export const PKG_VERSION = '0.1.0';

/** Hugging Face repository and the commit the files are read from. */
export const MODEL_REPO = 'litert-community/PP-OCRv6-Small-LiteRT';
export const MODEL_REVISION = 'a9b2febf2022fdd48ac2b5522115d6db3f8e214e';
export const MODEL_BASE = `https://huggingface.co/${MODEL_REPO}/resolve/${MODEL_REVISION}/`;
export const MODEL_NAME = 'PP-OCRv6-Small';

export type ModelRole = 'det' | 'rec320' | 'rec640' | 'rec960' | 'characters';

export interface PinnedFile {
  file: string;
  bytes: number;
  sha256: string;
}

// sha256 = the Hub's LFS oid for the .tflite files and the repository's SHA256SUMS for all five.
export const MODEL_FILES: Record<ModelRole, PinnedFile> = {
  det: { file: 'ppocrv6_small_det_640_fp32.tflite', bytes: 12380664, sha256: 'ec9430b6e592ffb28e83b6bab539262a30d267d2475c136b193926ad83835768' },
  rec320: { file: 'ppocrv6_small_rec_320_fp32.tflite', bytes: 21477068, sha256: '569bae77214a57476106ae66996f4ba4ef3ac66f81d150966c44e31a8fb0ae36' },
  rec640: { file: 'ppocrv6_small_rec_640_fp32.tflite', bytes: 21477068, sha256: '904c9a589763123d8a4c01d205c78669cfe3723b2a23b2221bdeb26fccc66a5d' },
  rec960: { file: 'ppocrv6_small_rec_960_fp32.tflite', bytes: 21476976, sha256: 'cc72f0f41729e0e5d66194ff657d25cdd10646a2066a780e01b13357135e553e' },
  characters: { file: 'characters.json', bytes: 168510, sha256: '9c89db8aa95ad30c83ee305d53d366c6bba3f85ff2eab0375ef345fd50b0674a' },
};

export const MODEL_ROLES: ModelRole[] = ['det', 'rec320', 'rec640', 'rec960', 'characters'];
export const VOCAB_SIZE = 18710;

/** LiteRT.js runtime (npm @litertjs/core). The browser build fetches these from jsDelivr by default. */
export const LITERT_VERSION = '2.5.3';
export const LITERT_WASM_BASE = `https://cdn.jsdelivr.net/npm/@litertjs/core@${LITERT_VERSION}/wasm/`;

export type RuntimeVariant = 'threaded' | 'plain' | 'compat';

// sha256 of the npm 2.5.3 files; jsDelivr serves the same bytes (checked 2026-10-20).
export const LITERT_FILES: Record<RuntimeVariant, { js: PinnedFile; wasm: PinnedFile }> = {
  threaded: {
    js: { file: 'litert_wasm_threaded_internal.js', bytes: 317475, sha256: '92fe7a720c6deedaa1194c011c79a005ea4f6fc98f533b661cf7900760ab4849' },
    wasm: { file: 'litert_wasm_threaded_internal.wasm', bytes: 9445834, sha256: 'b5e54eca10f043497edf9a02186332707cae260c550d7ea22b2cae55669596cf' },
  },
  plain: {
    js: { file: 'litert_wasm_internal.js', bytes: 273035, sha256: '68efb69f770e3f76aff36a377de629ca496c131b86ac0f0f4b592a1543a898eb' },
    wasm: { file: 'litert_wasm_internal.wasm', bytes: 9367934, sha256: '7280cf4471774867e385e6c3cd53e2b45e2975b80fea338fff4ef359b0865614' },
  },
  compat: {
    js: { file: 'litert_wasm_compat_internal.js', bytes: 273246, sha256: '4d8f894b7883654fd6e8439730aa41e79ceaab7d19184fc4f1f0b0f1a2a2c8a5' },
    wasm: { file: 'litert_wasm_compat_internal.wasm', bytes: 9334181, sha256: '5255c8ad06eabdbd2522cdebf6b22fc10faf74625c23a49b9e072570cd1fa41c' },
  },
};

/** Total bytes a first visit downloads (models + the runtime variant). */
export function firstVisitBytes(variant: RuntimeVariant): number {
  const m = MODEL_ROLES.reduce((s, r) => s + MODEL_FILES[r].bytes, 0);
  return m + LITERT_FILES[variant].js.bytes + LITERT_FILES[variant].wasm.bytes;
}

/**
 * The page layout model of convert(): docling-layout-heron (Apache-2.0, docling-project/docling-layout-heron
 * @8f39ad3c) converted to two LiteRT graphs (Graph A = backbone + encoder, Graph B = decoder; the top-300 query
 * selection runs in JS between them). Two forms: fp16 weights for WebGPU, fp32 for WebAssembly (fp16 weights are
 * slow on WebAssembly). Not on Hugging Face yet (upload pending): while LAYOUT_SOURCE is null the default layout
 * is geometry, and `layoutModelBase` points at a directory that holds these files. Publishing = filling this one
 * line with the Hub repository and its commit; the files below keep their names, sizes and sha256.
 */
export const LAYOUT_SOURCE: { repo: string; revision: string } | null = null; // upload pending
export const LAYOUT_BASE: string | null = LAYOUT_SOURCE ? `https://huggingface.co/${(LAYOUT_SOURCE as { repo: string }).repo}/resolve/${(LAYOUT_SOURCE as { revision: string }).revision}/` : null;
export const LAYOUT_NAME = 'docling-layout-heron';

export type LayoutForm = 'webgpu' | 'wasm';
export type LayoutRole = 'a' | 'b' | 'host';

export const LAYOUT_FILES: Record<LayoutForm, Record<LayoutRole, PinnedFile>> = {
  webgpu: {
    a: { file: 'heronA_es_fp16w.tflite', bytes: 72561808, sha256: '28689bb02d46c26942535e0c88f5dc8ac3a159032f4b6a2e0af501f820037661' },
    b: { file: 'heronB_es_fp16w.tflite', bytes: 14968352, sha256: '23e003458b553d80446c8adab976d8e99a96bbb4296a1d4e17270293ab8064e8' },
    host: { file: 'heron_host.bin', bytes: 168000, sha256: '30fa346260bed6a85747473df8e24fd958e976326b0ed6c278233d4b938a3836' },
  },
  wasm: {
    a: { file: 'heronA_es.tflite', bytes: 143798916, sha256: 'd277c01ed3131232fe87b3dcb6ce174b7c2aa40c1b637d2fe2153447d3fa8870' },
    b: { file: 'heronB_es.tflite', bytes: 29087496, sha256: '30983cd39513cb1b1290f554206a762d8eb10a5b9baef7764a42f448f284ee78' },
    host: { file: 'heron_host.bin', bytes: 168000, sha256: '30fa346260bed6a85747473df8e24fd958e976326b0ed6c278233d4b938a3836' },
  },
};

/** pdf.js (npm pdfjs-dist), which reads PDFs for convert(). The browser build loads it from jsDelivr by default. */
export const PDFJS_VERSION = '6.4.299';
export const PDFJS_BASE = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/`;
// sha256 of the npm files; jsDelivr serves the same bytes (checked 2026-10-20).
export const PDFJS_FILES: Record<'main' | 'worker', PinnedFile> = {
  main: { file: 'build/pdf.min.mjs', bytes: 458904, sha256: '57456c8e0c81e46be31174b499ef77f2b9f5ee46d04412ba627320a36755d4c2' },
  worker: { file: 'build/pdf.worker.min.mjs', bytes: 1264342, sha256: '9536359f1b8367850d485731ca1d5e45c159a7b7a0912325e539937aa21ceb18' },
};

/** The pinned files, for copying them to your own server (modelBase / wasmPath / layoutModelBase / pdfjsPath). */
export const modelInfo = {
  repo: MODEL_REPO,
  revision: MODEL_REVISION,
  base: MODEL_BASE,
  files: MODEL_ROLES.map((role) => ({ role, ...MODEL_FILES[role] })),
  runtime: { package: '@litertjs/core', version: LITERT_VERSION, base: LITERT_WASM_BASE, files: Object.values(LITERT_FILES).flatMap((v) => [v.js, v.wasm]) },
  layout: {
    model: LAYOUT_NAME,
    status: LAYOUT_BASE ? ('published' as const) : ('upload pending' as const),
    base: LAYOUT_BASE,
    forms: { webgpu: Object.values(LAYOUT_FILES.webgpu), wasm: Object.values(LAYOUT_FILES.wasm) },
  },
  pdfjs: { package: 'pdfjs-dist', version: PDFJS_VERSION, base: PDFJS_BASE, files: Object.values(PDFJS_FILES) },
};

/** Emscripten print hooks: drop LiteRT's start-up INFO lines and the NPU registry warning, keep the rest. */
export const litertPrint = {
  print: (s: string) => { if (!/^(INFO|VERBOSE):/.test(s)) console.log(s); },
  printErr: (s: string) => { if (!/^(INFO|VERBOSE):/.test(s) && !s.includes('NPU accelerator could not be loaded')) console.warn(s); },
};
