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

/** The pinned files, for copying them to your own server (modelBase / wasmPath). */
export const modelInfo = {
  repo: MODEL_REPO,
  revision: MODEL_REVISION,
  base: MODEL_BASE,
  files: MODEL_ROLES.map((role) => ({ role, ...MODEL_FILES[role] })),
  runtime: { package: '@litertjs/core', version: LITERT_VERSION, base: LITERT_WASM_BASE, files: Object.values(LITERT_FILES).flatMap((v) => [v.js, v.wasm]) },
};

/** Emscripten print hooks: drop LiteRT's start-up INFO lines and the NPU registry warning, keep the rest. */
export const litertPrint = {
  print: (s: string) => { if (!/^(INFO|VERBOSE):/.test(s)) console.log(s); },
  printErr: (s: string) => { if (!/^(INFO|VERBOSE):/.test(s) && !s.includes('NPU accelerator could not be loaded')) console.warn(s); },
};
