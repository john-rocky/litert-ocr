// Page units (text with a box, from a PDF text layer or from OCR) -> blocks (heading, paragraph, list item,
// table) in reading order -> Markdown. Geometry only, or guided by layout regions from a model (heron).
// Ported from the measured prototype (the r2d / r3x document paths) with the same steps and thresholds, so the
// Markdown is the same string; the blocks add the type, the text and the box of each piece.
//   1. lines: units on one baseline that touch (gap < joinGap x height) become one line; wider gaps stay apart
//      (they are table cells or page columns).
//   2. tables: runs of >= minRows consecutive rows whose short units (width <= cellMaxW x page width) fall into
//      >= 2 shared columns (x-interval overlap); ruled-line boxes (optional) mark a table region directly.
//   3. reading order: page columns first (a gutter with >= 3 text lines on each side), then a recursive XY-cut
//      over the lines with each table as one block.
//   4. blocks: paragraphs split at vertical gaps > paraGap x line height, at a line-height change, or at an
//      indented first line; a heading = a block whose line height >= headRatio x the page's body height
//      (largest heading size -> '#', the next -> '##', '###'); a list item = a line starting with a bullet or
//      'N.' / 'N)'.

export interface Unit {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  text: string;
  score?: number;
}

export interface PageSize {
  width: number;
  height: number;
}

export interface Region {
  /** heron class index (0-16) or name. */
  cls: number | string;
  score: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface RuledBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export type Box = [number, number, number, number];

export type BlockType = 'heading' | 'paragraph' | 'list_item' | 'table';

export interface Block {
  type: BlockType;
  /** Headings: 1-3. */
  level?: number;
  /** Text of the block (a table: its cells row by row, joined with spaces). */
  text: string;
  /** [x0, y0, x1, y1] in page pixels. */
  bbox: Box;
  /** Tables: rows of cell texts, the first row is the header row of the Markdown table. */
  rows?: string[][];
  /** With layout regions: the region class (caption, footnote, formula, code, page_header, ...). */
  role?: string;
}

export interface GeomOptions {
  joinGap: number;
  rowTol: number;
  cellMaxW: number;
  minRows: number;
  colMinShare: number;
  rowGapMax: number;
  gutter: number;
  paraGap: number;
  headRatio: number;
  indent: number;
  sizeTol: number;
  cellShrink: number;
  /** false: no page-column detection. */
  columns?: boolean;
  /** 'ja': join pieces without spaces. */
  lang?: string;
  ruled?: RuledBox[];
}

export const DEFAULTS: GeomOptions = {
  joinGap: 0.9, rowTol: 0.5, cellMaxW: 0.38, minRows: 3, colMinShare: 0.6, rowGapMax: 2.6,
  gutter: 0.025, paraGap: 0.75, headRatio: 1.22, indent: 0.9,
  // PP-OCRv6 boxes are grown on all sides (DB unclip), so line heights vary for one body size and neighbouring
  // table cells nearly touch: sizeTol = how different two line heights may be inside one paragraph; cellShrink =
  // x-shrink (x height) of a line before column clustering
  sizeTol: 0.18, cellShrink: 0,
};

/** Settings chosen on the dev pages of the measured document paths (the r2d stage-2 dev sweeps). */
export const LAYER_GEOMETRY: Partial<GeomOptions> = { joinGap: 0.3, sizeTol: 0.18, headRatio: 1.1, paraGap: 0.5, cellShrink: 0, minRows: 2 };
export const OCR_GEOMETRY: Partial<GeomOptions> = { joinGap: 0.1, sizeTol: 0.18, headRatio: 1.1, paraGap: 0.5, cellShrink: 0, minRows: 2 };

/** heron's 17 labels, in its class order. */
export const HERON_LABELS = ['caption', 'footnote', 'formula', 'list_item', 'page_footer', 'page_header', 'picture', 'section_header',
  'table', 'text', 'title', 'document_index', 'code', 'checkbox_selected', 'checkbox_unselected', 'form', 'key_value_region'];

interface Line {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  text: string;
  n: number;
}

interface Row {
  ref: Line;
  lines: Line[];
  y0: number;
  y1: number;
}

interface Col {
  x0: number;
  x1: number;
  rows: Set<Row>;
}

interface Table {
  rows: Row[];
  cols: Col[];
  box: { x0: number; y0: number; x1: number; y1: number };
}

const CJK = /[぀-ヿ㐀-鿿＀-￯。、]/;
const BULLET = /^\s*([•·●○◦▪■□\-–*・]|\d{1,2}[.)])\s*/;

type HasBox = { x0: number; y0: number; x1: number; y1: number };
const H = (u: { y0: number; y1: number }) => u.y1 - u.y0;
const cy = (u: { y0: number; y1: number }) => (u.y0 + u.y1) / 2;
const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};

export function joinText(a: string, b: string, lang: string): string {
  if (!a) return b;
  if (!b) return a;
  if (lang === 'ja' || CJK.test(a.slice(-1)) || CJK.test(b[0]!)) return a + b;
  return a + ' ' + b;
}

/** 'ja' when kana / kanji make up >= 30 % of the letters, else 'en' (only how pieces are joined depends on it). */
export function pageLang(texts: string[]): 'ja' | 'en' {
  let cjk = 0, letters = 0;
  for (const t of texts) {
    for (const ch of t) {
      if (/[぀-ヿ㐀-鿿]/.test(ch)) { cjk++; letters++; } else if (/\p{L}/u.test(ch)) letters++;
    }
  }
  return letters && cjk / letters >= 0.3 ? 'ja' : 'en';
}

// 1. units -> lines (left to right on one baseline, small gaps only).
export function toLines(units: Unit[], o: GeomOptions, lang: string): Line[] {
  const us = units.filter((u) => u.text && u.text.trim()).map((u) => ({ ...u, text: u.text.trim() }));
  us.sort((a, b) => cy(a) - cy(b) || a.x0 - b.x0);
  const rows: { ref: Unit; units: Unit[] }[] = [];
  for (const u of us) {
    const r = rows.find((row) => Math.abs(cy(row.ref) - cy(u)) < o.rowTol * Math.min(H(row.ref), H(u)));
    if (r) r.units.push(u); else rows.push({ ref: u, units: [u] });
  }
  const lines: Line[] = [];
  for (const r of rows) {
    r.units.sort((a, b) => a.x0 - b.x0);
    let cur: Line | null = null;
    for (const u of r.units) {
      const h = Math.max(1, Math.min(H(u), cur ? H(cur) : H(u)));
      if (cur && u.x0 - cur.x1 < o.joinGap * h) {
        cur.text = joinText(cur.text, u.text, lang);
        cur.x1 = Math.max(cur.x1, u.x1); cur.y0 = Math.min(cur.y0, u.y0); cur.y1 = Math.max(cur.y1, u.y1);
        cur.n++;
      } else {
        cur = { x0: u.x0, y0: u.y0, x1: u.x1, y1: u.y1, text: u.text, n: 1 };
        lines.push(cur);
      }
    }
  }
  return lines;
}

function groupRows(lines: Line[], o: GeomOptions): Row[] {
  // a line joins the row whose y-span it overlaps by >= 30 % of the smaller height (a cell wrapped onto two lines
  // in a narrow column still lies inside its row), or whose first line is centred near it
  const s = [...lines].sort((a, b) => cy(a) - cy(b) || a.x0 - b.x0);
  const rows: Row[] = [];
  for (const l of s) {
    const r = rows[rows.length - 1];
    const ov = r ? Math.min(r.y1, l.y1) - Math.max(r.y0, l.y0) : -1;
    if (r && (ov >= 0.3 * Math.min(r.y1 - r.y0, H(l)) || Math.abs(cy(r.ref) - cy(l)) < o.rowTol * Math.min(H(r.ref), H(l)))) {
      r.lines.push(l); r.y0 = Math.min(r.y0, l.y0); r.y1 = Math.max(r.y1, l.y1);
    } else rows.push({ ref: l, lines: [l], y0: l.y0, y1: l.y1 });
  }
  for (const r of rows) {
    r.lines.sort((a, b) => a.x0 - b.x0);
    r.y0 = Math.min(...r.lines.map((l) => l.y0));
    r.y1 = Math.max(...r.lines.map((l) => l.y1));
  }
  return rows;
}

// Column intervals shared by the rows of a candidate table (x-interval overlap clustering).
function columnsOf(rows: Row[], shrink = 0): Col[] {
  const cols: Col[] = [];
  for (const r of rows) {
    for (const l of r.lines) {
      const s = Math.min(shrink * H(l), 0.45 * (l.x1 - l.x0));
      const lx0 = l.x0 + s;
      const lx1 = l.x1 - s;
      const c = cols.find((k) => lx0 < k.x1 && lx1 > k.x0);
      if (c) { c.x0 = Math.min(c.x0, lx0); c.x1 = Math.max(c.x1, lx1); c.rows.add(r); }
      else cols.push({ x0: lx0, x1: lx1, rows: new Set([r]) });
    }
  }
  // merge columns that came to overlap
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < cols.length && !merged; i++) {
      for (let j = i + 1; j < cols.length; j++) {
        if (cols[i]!.x0 < cols[j]!.x1 && cols[i]!.x1 > cols[j]!.x0) {
          cols[i]!.x0 = Math.min(cols[i]!.x0, cols[j]!.x0); cols[i]!.x1 = Math.max(cols[i]!.x1, cols[j]!.x1);
          for (const r of cols[j]!.rows) cols[i]!.rows.add(r);
          cols.splice(j, 1); merged = true; break;
        }
      }
    }
  }
  return cols.sort((a, b) => a.x0 - b.x0);
}

// 2. tables by alignment (+ optional ruled boxes).
export function findTables(lines: Line[], page: PageSize, o: GeomOptions, ruled: RuledBox[] = []): { tables: Table[]; rest: Line[] } {
  const rows = groupRows(lines, o);
  const hMed = median(lines.map(H)) || 10;
  const isCellRow = (r: Row) => r.lines.length >= 2 && r.lines.every((l) => l.x1 - l.x0 <= o.cellMaxW * page.width);
  const inRuled = (r: Row) => ruled.find((b) => cy(r) >= b.y0 - 2 && cy(r) <= b.y1 + 2);
  const tables: Table[] = [];
  const used = new Set<Line>();
  let i = 0;
  while (i < rows.length) {
    const box = inRuled(rows[i]!);
    if (!isCellRow(rows[i]!) && !box) { i++; continue; }
    let j = i + 1;
    while (j < rows.length && (isCellRow(rows[j]!) || (box && inRuled(rows[j]!) === box)) && rows[j]!.y0 - rows[j - 1]!.y1 < o.rowGapMax * hMed
      && (!box || inRuled(rows[j]!) === box)) j++;
    const run = rows.slice(i, j);
    const cols = columnsOf(run, o.cellShrink);
    const shared = cols.filter((c) => c.rows.size >= o.colMinShare * run.length);
    if ((run.length >= o.minRows || (box && run.length >= 2)) && shared.length >= 2) {
      const t: Table = {
        rows: run,
        cols,
        box: { x0: Math.min(...run.flatMap((r) => r.lines.map((l) => l.x0))), y0: run[0]!.y0, x1: Math.max(...run.flatMap((r) => r.lines.map((l) => l.x1))), y1: run[run.length - 1]!.y1 },
      };
      tables.push(t);
      for (const r of run) for (const l of r.lines) used.add(l);
      i = j;
    } else i++;
  }
  return { tables, rest: lines.filter((l) => !used.has(l)) };
}

export function tableGrid(t: Table, lang: string): string[][] {
  // each line goes to the one column it overlaps most (the column intervals may be the shrunk ones)
  return t.rows.map((r) => {
    const cells: string[][] = t.cols.map(() => []);
    for (const l of r.lines) {
      let best = -1;
      let bestOv = -Infinity;
      t.cols.forEach((c, i) => {
        const ov = Math.min(l.x1, c.x1) - Math.max(l.x0, c.x0);
        if (ov > bestOv) { bestOv = ov; best = i; }
      });
      if (best >= 0) cells[best]!.push(l.text);
    }
    return cells.map((xs) => xs.reduce((a, b) => joinText(a, b, lang), ''));
  });
}

type CutItem = HasBox & { kind: string };

// 3. XY-cut. Returns the items in reading order.
export function xyCut<T extends CutItem>(items: T[], page: PageSize, o: GeomOptions): T[] {
  if (items.length <= 1) return items;
  const hMed = median(items.filter((i) => i.kind === 'line').map(H)) || 10;
  // horizontal cut: the widest y-gap between the vertical extents
  const ys = [...items].sort((a, b) => a.y0 - b.y0);
  let bestGap = 0, cutY: number | null = null, maxY = ys[0]!.y1;
  for (let k = 1; k < ys.length; k++) {
    const gap = ys[k]!.y0 - maxY;
    if (gap > bestGap) { bestGap = gap; cutY = (ys[k]!.y0 + maxY) / 2; }
    maxY = Math.max(maxY, ys[k]!.y1);
  }
  // vertical cut: the widest x-gap (gutter) between the horizontal extents
  const xs = [...items].sort((a, b) => a.x0 - b.x0);
  let bestX = 0, cutX: number | null = null, maxX = xs[0]!.x1;
  for (let k = 1; k < xs.length; k++) {
    const gap = xs[k]!.x0 - maxX;
    if (gap > bestX) { bestX = gap; cutX = (xs[k]!.x0 + maxX) / 2; }
    maxX = Math.max(maxX, xs[k]!.x1);
  }
  const canV = cutX != null && bestX >= o.gutter * page.width;
  const canH = cutY != null && bestGap > 0.5 * hMed;
  // Prefer a vertical gutter only when it separates two tall stacks (page columns), else cut horizontally.
  if (canV) {
    const L = items.filter((i) => i.x1 <= cutX!);
    const R = items.filter((i) => i.x0 >= cutX!);
    const tall = (s: T[]) => s.length >= 2 && (Math.max(...s.map((i) => i.y1)) - Math.min(...s.map((i) => i.y0))) > 4 * hMed;
    if (tall(L) && tall(R) && (!canH || bestX > bestGap)) return [...xyCut(L, page, o), ...xyCut(R, page, o)];
  }
  if (canH) {
    const T = items.filter((i) => cy(i) < cutY!);
    const B = items.filter((i) => cy(i) >= cutY!);
    if (T.length && B.length) return [...xyCut(T, page, o), ...xyCut(B, page, o)];
  }
  if (canV) {
    const L = items.filter((i) => i.x1 <= cutX!);
    const R = items.filter((i) => i.x0 >= cutX!);
    if (L.length && R.length) return [...xyCut(L, page, o), ...xyCut(R, page, o)];
  }
  return [...items].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
}

const boxOf = (ls: HasBox[]): Box => [Math.min(...ls.map((l) => l.x0)), Math.min(...ls.map((l) => l.y0)), Math.max(...ls.map((l) => l.x1)), Math.max(...ls.map((l) => l.y1))];
const tableText = (rows: string[][], lang: string) => rows.flat().filter(Boolean).reduce((a, b) => joinText(a, b, lang), '');

/**
 * Blocks guided by layout regions ({cls, score, x0, y0, x1, y1} in page px; heron's 17 labels): units go to the
 * region holding most of their area (>= 40 %); regions are read in XY-cut order; page_header, page_footer and
 * picture are left out; a table region's units become a grid by the alignment finder forced over the whole region;
 * units in no region stay single lines.
 */
export function layoutRegions(units: Unit[], page: PageSize, regions: Region[], opts: Partial<GeomOptions> = {}): Block[] {
  const o: GeomOptions = { ...DEFAULTS, ...opts };
  const lang = opts.lang ?? 'en';
  const regs = regions.map((r) => ({ ...r, name: typeof r.cls === 'number' ? HERON_LABELS[r.cls]! : r.cls, units: [] as Unit[] }));
  const orphans: Unit[] = [];
  for (const u of units.filter((x) => x.text && x.text.trim())) {
    let best: (typeof regs)[number] | null = null;
    let bestA = 0;
    for (const r of regs) {
      const a = Math.max(0, Math.min(u.x1, r.x1) - Math.max(u.x0, r.x0)) * Math.max(0, Math.min(u.y1, r.y1) - Math.max(u.y0, r.y0));
      if (a > bestA) { bestA = a; best = r; }
    }
    if (best && bestA >= 0.4 * (u.x1 - u.x0) * (u.y1 - u.y0)) best.units.push(u); else orphans.push(u);
  }
  const keep = regs.filter((r) => r.units.length && !['page_header', 'page_footer', 'picture'].includes(r.name));
  const orphanLines = toLines(orphans, o, lang);
  type Item = CutItem & { r?: (typeof regs)[number]; line?: Line };
  const items: Item[] = [
    ...keep.map((r) => ({ x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1, kind: 'region', r })),
    ...orphanLines.map((l) => ({ x0: l.x0, y0: l.y0, x1: l.x1, y1: l.y1, kind: 'line', line: l })),
  ];
  const ordered = xyCut(items, page, o);
  const out: Block[] = [];
  for (const it of ordered) {
    if (it.kind === 'line') {
      const l = it.line!;
      out.push({ type: 'paragraph', text: l.text, bbox: boxOf([l]) });
      continue;
    }
    const r = it.r!;
    const lines = toLines(r.units, o, lang).sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
    if (r.name === 'table') {
      const t = findTables(lines, page, { ...o, cellMaxW: 1, minRows: 1, colMinShare: 0 }, [{ x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1 }]);
      if (t.tables.length) {
        const g = tableGrid(t.tables[0]!, lang);
        const tb = t.tables[0]!.box;
        out.push({ type: 'table', text: tableText(g, lang), bbox: [tb.x0, tb.y0, tb.x1, tb.y1], rows: g, role: 'table' });
        const restText = t.rest.map((l) => l.text).reduce((a, b) => joinText(a, b, lang), '');
        if (restText) out.push({ type: 'paragraph', text: restText, bbox: boxOf(t.rest), role: 'table' });
        continue;
      }
    }
    const text = lines.map((l) => l.text).reduce((a, b) => joinText(a, b, lang), '');
    const bbox = boxOf(lines);
    if (r.name === 'title') out.push({ type: 'heading', level: 1, text, bbox, role: r.name });
    else if (r.name === 'section_header') out.push({ type: 'heading', level: 2, text, bbox, role: r.name });
    else if (r.name === 'list_item') out.push({ type: 'list_item', text: text.replace(BULLET, ''), bbox, role: r.name });
    else out.push({ type: 'paragraph', text, bbox, role: r.name });
  }
  return out;
}

// Column-first: a page gutter = an x in the middle 30-70 % of the page that the fewest lines cross while >= 4 lines
// lie on each side and each side spans >= 25 % of the page height; accepted when the crossing lines are <= 20 % of
// all lines. Crossing lines (titles, full-width blocks) keep their own bands; between two of them the left column is
// read before the right one. Tables are then looked for inside each chunk.
export function findGutter(lines: Line[], page: PageSize): { x: number; cross: number } | null {
  const W = page.width;
  const H0 = page.height;
  let best: { x: number; cross: number } | null = null;
  for (let x = 0.3 * W; x <= 0.7 * W; x += 4) {
    const left = lines.filter((l) => l.x1 <= x);
    const right = lines.filter((l) => l.x0 >= x);
    if (left.length < 4 || right.length < 4) continue;
    const ext = (s: Line[]) => Math.max(...s.map((l) => l.y1)) - Math.min(...s.map((l) => l.y0));
    if (ext(left) < 0.25 * H0 || ext(right) < 0.25 * H0) continue;
    // page columns hold text lines; two sides of short table cells are not columns
    const textLines = (s: Line[]) => s.filter((l) => l.x1 - l.x0 >= 0.25 * W).length;
    if (textLines(left) < 3 || textLines(right) < 3) continue;
    const cross = lines.filter((l) => l.x0 < x && l.x1 > x).length;
    if (!best || cross < best.cross) best = { x, cross };
  }
  return best && best.cross <= 0.2 * lines.length ? best : null;
}

function chunksOf(lines: Line[], page: PageSize): Line[][] {
  const g = findGutter(lines, page);
  if (!g) return [lines];
  const span = lines.filter((l) => l.x0 < g.x && l.x1 > g.x).sort((a, b) => a.y0 - b.y0);
  const body = lines.filter((l) => !(l.x0 < g.x && l.x1 > g.x));
  const chunks: Line[][] = [];
  let top = -Infinity;
  for (const s of [...span, null]) {
    const bottom = s ? s.y0 : Infinity;
    const band = body.filter((l) => (l.y0 + l.y1) / 2 >= top && (l.y0 + l.y1) / 2 < bottom);
    const left = band.filter((l) => l.x1 <= g.x);
    const right = band.filter((l) => l.x0 >= g.x);
    if (left.length) chunks.push(left);
    if (right.length) chunks.push(right);
    if (s) { chunks.push([s]); top = (s.y0 + s.y1) / 2; }
  }
  return chunks;
}

interface RawBlock {
  type: 'head' | 'para' | 'item' | 'table';
  text: string;
  h: number;
  left: number;
  last: Line | null;
  lines: HasBox[];
  grid?: string[][];
}

function blocksOf(lines: Line[], page: PageSize, o: GeomOptions, lang: string, ruled: RuledBox[], body: number): RawBlock[] {
  const { tables, rest } = findTables(lines, page, o, ruled);
  type Item = CutItem & { line?: Line; t?: Table };
  const items: Item[] = [
    ...rest.map((l) => ({ x0: l.x0, y0: l.y0, x1: l.x1, y1: l.y1, kind: 'line', line: l })),
    ...tables.map((t) => ({ ...t.box, kind: 'table', t })),
  ];
  const ordered = xyCut(items, page, o);
  const blocks: RawBlock[] = [];
  let cur: RawBlock | null = null;
  const close = () => { if (cur) blocks.push(cur); cur = null; };
  for (let k = 0; k < ordered.length; k++) {
    const it = ordered[k]!;
    if (it.kind === 'table') {
      close();
      blocks.push({ type: 'table', text: '', grid: tableGrid(it.t!, lang), h: 0, left: it.x0, last: null, lines: [it.t!.box] });
      continue;
    }
    const line = it.line!;
    const h = H(line);
    const bullet = BULLET.exec(line.text);
    if (bullet && (/^[•·●○◦▪■□・]/.test(bullet[1]!) || /^\d/.test(bullet[1]!) || bullet[1] === '-')) {
      close();
      cur = { type: 'item', text: line.text.slice(bullet[0].length), h, left: line.x0, last: line, lines: [line] };
      continue;
    }
    if (cur) {
      const c: RawBlock = cur;
      const gap = line.y0 - c.last!.y1;
      const sameSize = Math.abs(h - c.h) < o.sizeTol * Math.max(h, c.h);
      // a list item's wrapped line sits right of its bullet; a paragraph's new first line is indented
      const indented = c.type === 'item' ? line.x0 < c.left - 0.3 * h : line.x0 - c.left > o.indent * h;
      const continues = gap >= -0.3 * h && gap < o.paraGap * h && sameSize && !indented;
      if (continues && (c.type === 'para' || c.type === 'item' || c.type === 'head')) {
        const a = c.text;
        c.text = /-$/.test(a) && /^[a-z]/.test(line.text) && lang !== 'ja' ? a + line.text : joinText(a, line.text, lang);
        c.last = line;
        c.lines.push(line);
        continue;
      }
    }
    close();
    cur = { type: h >= o.headRatio * body ? 'head' : 'para', text: line.text, h, left: line.x0, last: line, lines: [line] };
  }
  close();
  return blocks;
}

/** Geometry-only blocks: lines -> chunks (page columns) -> tables and paragraphs -> blocks in reading order. */
export function layoutGeometry(units: Unit[], page: PageSize, opts: Partial<GeomOptions> = {}): Block[] {
  const o: GeomOptions = { ...DEFAULTS, ...opts };
  const lang = opts.lang ?? 'en';
  const lines = toLines(units, o, lang);
  const body = median(lines.map(H)) || 10; // the page's body line height (headings are measured against it)
  const raw = (o.columns === false ? [lines] : chunksOf(lines, page)).flatMap((c) => blocksOf(c, page, o, lang, opts.ruled ?? [], body));
  const headSizes = [...new Set(raw.filter((b) => b.type === 'head').map((b) => Math.round(b.h / 2)))].sort((a, b) => b - a);
  return raw.map((b): Block => {
    const bbox = boxOf(b.lines);
    if (b.type === 'table') return { type: 'table', text: tableText(b.grid!, lang), bbox, rows: b.grid! };
    if (b.type === 'head') return { type: 'heading', level: Math.min(3, 1 + headSizes.indexOf(Math.round(b.h / 2))), text: b.text, bbox };
    if (b.type === 'item') return { type: 'list_item', text: b.text, bbox };
    return { type: 'paragraph', text: b.text, bbox };
  });
}

const mdRow = (r: string[]) => `| ${r.map((x) => x.replace(/\|/g, '\\|')).join(' | ')} |`;

/** One block as Markdown (a GFM table, '#' headings, '- ' list items). */
export function blockMarkdown(b: Block): string {
  if (b.type === 'table') {
    const g = b.rows!;
    return [mdRow(g[0]!), mdRow(g[0]!.map(() => '---')), ...g.slice(1).map(mdRow)].join('\n');
  }
  if (b.type === 'heading') return '#'.repeat(b.level ?? 1) + ' ' + b.text;
  if (b.type === 'list_item') return '- ' + b.text;
  return b.text;
}

export function blocksMarkdown(blocks: Block[]): string {
  return blocks.map(blockMarkdown).join('\n\n') + '\n';
}

/** Plain text: blocks separated by a blank line; table rows one per line with tab-separated cells. */
export function blocksText(blocks: Block[]): string {
  return blocks.map((b) => (b.type === 'table' ? b.rows!.map((r) => r.join('\t')).join('\n') : b.text)).join('\n\n') + (blocks.length ? '\n' : '');
}

/** Markdown of a page by geometry only (the measured G0 / G1 output). */
export function toMarkdown(units: Unit[], page: PageSize, opts: Partial<GeomOptions> = {}): string {
  return blocksMarkdown(layoutGeometry(units, page, opts));
}

/** Markdown of a page guided by layout regions (the measured G2 output). */
export function toMarkdownRegions(units: Unit[], page: PageSize, regions: Region[], opts: Partial<GeomOptions> = {}): string {
  return blocksMarkdown(layoutRegions(units, page, regions, opts));
}
