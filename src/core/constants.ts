import { OcrError } from './errors.js';

/** tesseract.js OEM values. Accepted and not used: there is one engine. */
export const OEM = {
  TESSERACT_ONLY: 0,
  LSTM_ONLY: 1,
  TESSERACT_LSTM_COMBINED: 2,
  DEFAULT: 3,
} as const;

/** tesseract.js PSM values. SINGLE_LINE, SINGLE_WORD, RAW_LINE and SINGLE_CHAR skip detection; the rest are ignored. */
export const PSM = {
  OSD_ONLY: '0',
  AUTO_OSD: '1',
  AUTO_ONLY: '2',
  AUTO: '3',
  SINGLE_COLUMN: '4',
  SINGLE_BLOCK_VERT_TEXT: '5',
  SINGLE_BLOCK: '6',
  SINGLE_LINE: '7',
  SINGLE_WORD: '8',
  CIRCLE_WORD: '9',
  SINGLE_CHAR: '10',
  SPARSE_TEXT: '11',
  SPARSE_TEXT_OSD: '12',
  RAW_LINE: '13',
} as const;

export const SINGLE_LINE_PSM = new Set(['7', '8', '10', '13']);

// tesseract language codes whose script the model's vocabulary has: Latin (with Latin-1 and Latin
// Extended-A), Greek, Chinese and Japanese. Accuracy is measured for eng and jpn only (README).
const COVERED = [
  'eng', 'jpn', 'jpn_vert', 'chi_sim', 'chi_sim_vert', 'chi_tra', 'chi_tra_vert',
  'afr', 'aze', 'bos', 'cat', 'ceb', 'ces', 'cym', 'dan', 'deu', 'ell', 'enm', 'epo', 'est', 'eus', 'fin',
  'fra', 'frk', 'frm', 'gle', 'glg', 'grc', 'hat', 'hrv', 'hun', 'ind', 'isl', 'ita', 'ita_old', 'jav', 'lat',
  'lav', 'lit', 'mlt', 'msa', 'nld', 'nor', 'pol', 'por', 'ron', 'slk', 'slv', 'spa', 'spa_old', 'sqi',
  'srp_latn', 'swa', 'swe', 'tgl', 'tur', 'uzb', 'vie',
];
// Scripts the vocabulary has no characters for.
const NOT_COVERED: Record<string, string> = {
  amh: 'Ethiopic', ara: 'Arabic', asm: 'Bengali', aze_cyrl: 'Cyrillic', bel: 'Cyrillic', ben: 'Bengali',
  bod: 'Tibetan', bul: 'Cyrillic', chr: 'Cherokee', dzo: 'Tibetan', fas: 'Arabic', guj: 'Gujarati',
  heb: 'Hebrew', hin: 'Devanagari', iku: 'Canadian syllabics', kan: 'Kannada', kat: 'Georgian',
  kat_old: 'Georgian', kaz: 'Cyrillic', khm: 'Khmer', kir: 'Cyrillic', kor: 'Hangul', kor_vert: 'Hangul',
  kur: 'Arabic', lao: 'Lao', mal: 'Malayalam', mar: 'Devanagari', mkd: 'Cyrillic', mya: 'Myanmar',
  nep: 'Devanagari', ori: 'Odia', pan: 'Gurmukhi', pus: 'Arabic', rus: 'Cyrillic', san: 'Devanagari',
  sin: 'Sinhala', srp: 'Cyrillic', syr: 'Syriac', tam: 'Tamil', tel: 'Telugu', tgk: 'Cyrillic',
  tha: 'Thai', tir: 'Ethiopic', uig: 'Arabic', ukr: 'Cyrillic', urd: 'Arabic', uzb_cyrl: 'Cyrillic',
  yid: 'Hebrew', osd: 'orientation data', equ: 'equation data',
};

export const COVERED_LANGS: readonly string[] = COVERED;

/** tesseract.js `languages` map (name → code) for the codes this library accepts. */
export const languages: Record<string, string> = Object.fromEntries(COVERED.map((c) => [c.toUpperCase(), c]));

/**
 * Normalize and check `langs` the way createWorker receives them ('eng', 'eng+jpn', ['eng', 'jpn'], or
 * { code } objects). One model reads every covered language, so the value never changes the model; it
 * is only checked, so that a language the model cannot read fails here instead of returning wrong text.
 */
export function checkLangs(langs: unknown): string[] {
  if (langs === undefined || langs === null || langs === '') return ['eng'];
  const list: unknown[] = Array.isArray(langs) ? langs : typeof langs === 'string' ? langs.split('+') : [langs];
  const codes = list.map((l) => (typeof l === 'string' ? l : (l as { code?: unknown })?.code)).map((c) => (typeof c === 'string' ? c.trim() : c));
  for (const c of codes) {
    if (typeof c !== 'string' || !c) {
      throw new OcrError('INVALID_ARGUMENT', `createWorker(langs): expected a language code such as 'eng', 'jpn' or 'eng+jpn', got ${JSON.stringify(c)}.`);
    }
    if (COVERED.includes(c)) continue;
    const script = NOT_COVERED[c];
    if (script) {
      throw new OcrError(
        'LANG_NOT_SUPPORTED',
        `'${c}' is written in ${script}, which this model cannot read (it reads Latin, Greek, Chinese and Japanese text). Keep tesseract.js for '${c}', or pass 'eng' if your images are in English.`,
      );
    }
    throw new OcrError(
      'LANG_NOT_SUPPORTED',
      `Unknown language code '${c}'. Use a tesseract language code such as 'eng', 'jpn', 'chi_sim' or 'fra'; one model reads all of them, so 'eng' works for any Latin-script text.`,
    );
  }
  return codes as string[];
}
