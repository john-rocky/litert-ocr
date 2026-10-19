// Turn the pipeline's lines into the tesseract.js result shape: text, confidence, and on request blocks
// (block -> paragraph -> line -> word -> symbol), hOCR and TSV. There is no layout analysis yet: one block
// with one paragraph holds every line, in reading order.

import type { Point, Quad } from './db.js';
import type { PlacedChar, ReadLine } from './pipeline.js';
import type { Bbox, Block, Line, OutputFormats, Page, Symbol, Word } from './types.js';

/** Maps pipeline coordinates to the caller's image coordinates (scale for a resized image, offset for a rectangle). */
export interface CoordMap {
  scale: number;
  dx: number;
  dy: number;
}

const r = (v: number) => Math.round(v);

/** Reading order: rows by vertical center (same row when |cy - cy_row| < 0.5 * min(h)), rows top to bottom, left to right within a row. */
export function readingOrder<T extends { box: [number, number, number, number] }>(units: T[]): T[] {
  const cy = (u: T) => (u.box[1] + u.box[3]) / 2;
  const h = (u: T) => u.box[3] - u.box[1];
  const sorted = units.slice().sort((a, b) => cy(a) - cy(b) || a.box[0] - b.box[0]);
  const rows: T[][] = [];
  for (const u of sorted) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(cy(u) - cy(row[0]!)) < 0.5 * Math.min(h(u), h(row[0]!))) row.push(u);
    else rows.push([u]);
  }
  const mean = (row: T[]) => row.reduce((s, u) => s + cy(u), 0) / row.length;
  rows.sort((a, b) => mean(a) - mean(b));
  return rows.flatMap((row) => row.sort((a, b) => a.box[0] - b.box[0]));
}

function lerp(a: Point, b: Point, f: number): Point {
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
}

/** Box of the part of a line between fractions f0..f1 of its reading length. */
function spanBox(quad: Quad, rotated: boolean, f0: number, f1: number, m: CoordMap): Bbox {
  const [p0, p1, p2, p3] = quad;
  // reading direction: along the top edge (p0 -> p1), or down the left edge (p0 -> p3) for a turned crop
  const pts = rotated
    ? [lerp(p0, p3, f0), lerp(p1, p2, f0), lerp(p1, p2, f1), lerp(p0, p3, f1)]
    : [lerp(p0, p1, f0), lerp(p0, p1, f1), lerp(p3, p2, f1), lerp(p3, p2, f0)];
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return mapBox([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], m);
}

function mapBox(b: [number, number, number, number], m: CoordMap): Bbox {
  return { x0: r(b[0] * m.scale + m.dx), y0: r(b[1] * m.scale + m.dy), x1: r(b[2] * m.scale + m.dx), y1: r(b[3] * m.scale + m.dy) };
}

function union(boxes: Bbox[]): Bbox {
  if (!boxes.length) return { x0: 0, y0: 0, x1: 0, y1: 0 };
  return {
    x0: Math.min(...boxes.map((b) => b.x0)),
    y0: Math.min(...boxes.map((b) => b.y0)),
    x1: Math.max(...boxes.map((b) => b.x1)),
    y1: Math.max(...boxes.map((b) => b.y1)),
  };
}

const mean = (v: number[]) => (v.length ? v.reduce((s, x) => s + x, 0) / v.length : 0);

function buildWords(line: ReadLine, m: CoordMap): Word[] {
  // character spans: halfway to the neighbouring characters; the ends reach half a neighbour gap outward
  const real = line.chars;
  const n = real.length;
  const gaps: number[] = [];
  for (let i = 1; i < n; i++) gaps.push(real[i]!.f - real[i - 1]!.f);
  const typical = gaps.length ? gaps.slice().sort((a, b) => a - b)[gaps.length >> 1]! : 0.5;
  const spans = real.map((c, i) => {
    const left = i > 0 ? (real[i - 1]!.f + c.f) / 2 : c.f - typical / 2;
    const right = i < n - 1 ? (c.f + real[i + 1]!.f) / 2 : c.f + typical / 2;
    return [Math.max(0, left), Math.min(1, right)] as [number, number];
  });
  const words: Word[] = [];
  let cur: { chars: PlacedChar[]; spans: [number, number][] } = { chars: [], spans: [] };
  const flush = () => {
    if (!cur.chars.length) return;
    const symbols: Symbol[] = cur.chars.map((c, k) => ({
      text: c.ch,
      confidence: c.prob * 100,
      bbox: spanBox(line.quad, line.rotated, cur.spans[k]![0], cur.spans[k]![1], m),
      is_superscript: false,
      is_subscript: false,
      is_dropcap: false,
    }));
    const text = cur.chars.map((c) => c.ch).join('');
    const confidence = mean(cur.chars.map((c) => c.prob)) * 100;
    words.push({
      symbols,
      choices: [{ text, confidence }],
      text,
      confidence,
      bbox: spanBox(line.quad, line.rotated, cur.spans[0]![0], cur.spans[cur.spans.length - 1]![1], m),
      font_name: null,
    });
    cur = { chars: [], spans: [] };
  };
  real.forEach((c, i) => {
    if (c.ch === ' ' || c.synthetic) {
      flush();
      return;
    }
    cur.chars.push(c);
    cur.spans.push(spans[i]!);
  });
  flush();
  return words;
}

export function buildPage(
  lines: ReadLine[],
  output: Partial<OutputFormats>,
  imageSize: { width: number; height: number },
  m: CoordMap,
  version: string,
): Page {
  const ordered = readingOrder(lines);
  const text = ordered.map((l) => l.text + '\n').join('');
  const built: Line[] = ordered.map((l) => {
    const bbox = mapBox(l.box, m);
    const words = buildWords(l, m);
    const [, , p2, p3] = l.quad;
    const b0 = mapBox([p3[0], p3[1], p2[0], p2[1]], m);
    return {
      words,
      text: l.text + '\n',
      confidence: l.score * 100,
      baseline: { x0: b0.x0, y0: b0.y0, x1: b0.x1, y1: b0.y1, has_baseline: false },
      rowAttributes: { ascenders: null, descenders: null, rowHeight: bbox.y1 - bbox.y0 },
      bbox,
    };
  });
  const allWords = built.flatMap((l) => l.words);
  const confidence = Math.round(mean(allWords.map((w) => w.confidence)));
  let blocks: Block[] | null = null;
  if (output.blocks) {
    if (built.length) {
      const bbox = union(built.map((l) => l.bbox));
      const conf = mean(allWords.map((w) => w.confidence));
      blocks = [{ paragraphs: [{ lines: built, text, confidence: conf, bbox, is_ltr: true }], text, confidence: conf, bbox, blocktype: null }];
    } else {
      blocks = [];
    }
  }
  return {
    text,
    confidence,
    blocks,
    hocr: output.hocr ? toHocr(built, imageSize) : null,
    tsv: output.tsv ? toTsv(built, imageSize) : null,
    box: null,
    unlv: null,
    osd: null,
    pdf: null,
    imageColor: null,
    imageGrey: null,
    imageBinary: null,
    layoutBlocks: null,
    debug: null,
    rotateRadians: 0,
    psm: null,
    oem: null,
    version,
  };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const bb = (b: Bbox) => `bbox ${b.x0} ${b.y0} ${b.x1} ${b.y1}`;

/** hOCR in the shape tesseract writes (page / carea / par / line / word), without the fields it cannot measure. */
function toHocr(lines: Line[], size: { width: number; height: number }): string {
  const out: string[] = [];
  out.push(`<div class='ocr_page' id='page_1' title='image ""; bbox 0 0 ${size.width} ${size.height}; ppageno 0'>`);
  if (lines.length) {
    const area = union(lines.map((l) => l.bbox));
    out.push(` <div class='ocr_carea' id='block_1_1' title="${bb(area)}">`);
    out.push(`  <p class='ocr_par' id='par_1_1' title="${bb(area)}">`);
    let w = 0;
    lines.forEach((l, i) => {
      out.push(`   <span class='ocr_line' id='line_1_${i + 1}' title="${bb(l.bbox)}">`);
      for (const word of l.words) {
        w++;
        out.push(`    <span class='ocrx_word' id='word_1_${w}' title='${bb(word.bbox)}; x_wconf ${Math.round(word.confidence)}'>${esc(word.text)}</span>`);
      }
      out.push('   </span>');
    });
    out.push('  </p>');
    out.push(' </div>');
  }
  out.push('</div>');
  return out.join('\n') + '\n';
}

/** TSV rows as tesseract's GetTSVText writes them (no header line): level page block par line word left top width height conf text. */
function toTsv(lines: Line[], size: { width: number; height: number }): string {
  const row = (level: number, block: number, par: number, line: number, word: number, b: Bbox, conf: number, text: string) =>
    [level, 1, block, par, line, word, b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0, conf, text].join('\t') + '\n';
  let s = row(1, 0, 0, 0, 0, { x0: 0, y0: 0, x1: size.width, y1: size.height }, -1, '');
  if (!lines.length) return s;
  const area = union(lines.map((l) => l.bbox));
  s += row(2, 1, 0, 0, 0, area, -1, '');
  s += row(3, 1, 1, 0, 0, area, -1, '');
  lines.forEach((l, i) => {
    s += row(4, 1, 1, i + 1, 0, l.bbox, -1, '');
    l.words.forEach((w, j) => {
      s += row(5, 1, 1, i + 1, j + 1, w.bbox, Number(w.confidence.toFixed(6)), w.text);
    });
  });
  return s;
}
