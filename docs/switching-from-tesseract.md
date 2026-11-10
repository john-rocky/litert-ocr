# Switching from tesseract.js

Change the import; the calls and the result shape stay the same:

```diff
- import { createWorker } from 'tesseract.js';
+ import { createWorker } from 'litert-ocr';
```

`require('litert-ocr')` works too (tested with Node.js 24; Node.js loads ES modules from CommonJS since 20.19 and 22.12).

What differs:

| | tesseract.js 7 | litert-ocr |
|---|---|---|
| Languages | one data file per language (`'eng'`, `'jpn'`, `'eng+jpn'`) | one model reads Latin-script, Greek, Chinese and Japanese text. `langs` is checked (a script the model cannot read rejects) but does not change the model. Korean, Cyrillic, Arabic, Hebrew, Thai and Indic scripts are not covered: `createWorker('kor')` rejects with `LANG_NOT_SUPPORTED` |
| `oem`, `corePath`, `langPath`, `legacyCore`, `gzip` | engine and data options | accepted and ignored (the path options get a notice) |
| `setParameters` | every Tesseract parameter | `tessedit_char_whitelist`, `tessedit_char_blacklist`, and `tessedit_pageseg_mode` `SINGLE_LINE` / `SINGLE_WORD` / `RAW_LINE` / `SINGLE_CHAR` (read the image as one line, no detection). Others are ignored; the result lists them |
| Output | `text`, `blocks`, `hocr`, `tsv`, `box`, `unlv`, `osd`, `pdf`, images | `text`, `blocks`, `hocr`, `tsv`. The other formats are `null` |
| Layout | Tesseract's blocks and paragraphs | one block with one paragraph; one line per detected text line, in reading order (top to bottom, left to right). A table row or a label and its value can come out as separate lines |
| Word and symbol boxes | from Tesseract's segmentation | from the recognizer's output positions along the line (approximate) |
| Rotated text | `rotateAuto` | tall lines (vertical text) are turned and read; upside-down text is not. `rotateAuto` / `rotateRadians` are ignored |
| `detect()` | orientation and script detection | not supported (rejects with `INVALID_ARGUMENT`) |
| Node.js image formats | bmp, jpg, png, pbm, webp, gif | PNG and JPEG (decode others first, or pass `{ data, width, height }`). Browsers read every format they can decode |
| Files on first use | core WebAssembly and language data | the LiteRT.js runtime and the model ([sizes](speed-and-files.md#model-and-runtime-files)), cached |
