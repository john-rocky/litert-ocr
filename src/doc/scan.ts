// Page image steps of the measured document path (r2d / r3x, the OCR pages): the skew estimate and the ruled
// lines that mark table regions. Both read an RGBA copy of the page that the platform scales (canvas in the
// browser, plain JS in Node); the loops here are the same as in the measured pipeline.

/** Width of the grayscale copy the skew is estimated on. */
export const SKEW_WIDTH = 1000;
/** Width of the copy the ruled lines are looked for on. */
export const RULE_WIDTH = 2000;

/**
 * Skew estimate: the angle in [-maxDeg, maxDeg] (step 0.1 deg) that maximizes the variance of the row ink sums of
 * the copy (dark = r + g + b < 3 x 140, every second column). Positive = lines that go down to the right; the page
 * is turned back by this angle. Rounded to 0.1 deg.
 */
export function estimateSkew(rgba: Uint8ClampedArray, W: number, H: number, maxDeg = 2, step = 0.1): number {
  const pts: number[] = [];
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 2) {
      const i = (y * W + x) * 4;
      if (rgba[i]! + rgba[i + 1]! + rgba[i + 2]! < 3 * 140) pts.push(x - W / 2, y - H / 2);
    }
  }
  let best = 0;
  let bestVar = -1;
  const rows = new Float64Array(H * 2 + 8);
  for (let a = -maxDeg; a <= maxDeg + 1e-9; a += step) {
    const t = Math.tan((a * Math.PI) / 180);
    rows.fill(0);
    for (let k = 0; k < pts.length; k += 2) {
      const yy = Math.round(pts[k + 1]! - pts[k]! * t + H);
      if (yy >= 0 && yy < rows.length) rows[yy]!++;
    }
    let m = 0, v = 0;
    for (let i = 0; i < rows.length; i++) m += rows[i]!;
    m /= rows.length;
    for (let i = 0; i < rows.length; i++) v += (rows[i]! - m) ** 2;
    if (v > bestVar) { bestVar = v; best = a; }
  }
  return Math.round(best * 10) / 10;
}

export interface RuledRegion {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  rules: number;
}

/**
 * Long dark horizontal runs (>= 8 % of the copy's width, r + g + b < 3 x 110) -> rules (rows of one thick rule
 * merged) -> groups of >= 3 rules that overlap in x and lie close together -> table regions, in page pixels
 * (`scale` = copy width / page width).
 */
export function ruledBoxes(rgba: Uint8ClampedArray, W: number, H: number, scale: number): RuledRegion[] {
  const minLen = 0.08 * W;
  const segs: { y: number; x0: number; x1: number }[] = [];
  for (let y = 0; y < H; y++) {
    let run = -1;
    for (let x = 0; x <= W; x++) {
      const i = (y * W + x) * 4;
      const dark = x < W && rgba[i]! + rgba[i + 1]! + rgba[i + 2]! < 3 * 110;
      if (dark && run < 0) run = x;
      if (!dark && run >= 0) {
        if (x - run >= minLen) segs.push({ y, x0: run, x1: x });
        run = -1;
      }
    }
  }
  // merge rows of one thick rule
  const rules: { y0: number; y1: number; x0: number; x1: number }[] = [];
  for (const s of segs) {
    const r = rules.find((q) => s.y - q.y1 <= 2 && s.x0 < q.x1 && s.x1 > q.x0);
    if (r) { r.y1 = s.y; r.x0 = Math.min(r.x0, s.x0); r.x1 = Math.max(r.x1, s.x1); } else rules.push({ y0: s.y, y1: s.y, x0: s.x0, x1: s.x1 });
  }
  rules.sort((a, b) => a.y0 - b.y0);
  const groups: { y0: number; y1: number; x0: number; x1: number; n: number }[] = [];
  for (const r of rules) {
    const g = groups.find((q) => r.y0 - q.y1 < 0.12 * H && Math.min(r.x1, q.x1) - Math.max(r.x0, q.x0) > 0.8 * Math.min(r.x1 - r.x0, q.x1 - q.x0));
    if (g) { g.n++; g.y1 = r.y1; g.x0 = Math.min(g.x0, r.x0); g.x1 = Math.max(g.x1, r.x1); } else groups.push({ ...r, n: 1 });
  }
  return groups.filter((g) => g.n >= 3).map((g) => ({ x0: g.x0 / scale, y0: g.y0 / scale, x1: g.x1 / scale, y1: g.y1 / scale, rules: g.n }));
}
