// PP-OCRv6-Small text detector: input preprocessing and the DB postprocess (probability map → quads).
// Written from the litert-community/PP-OCRv6-Small-LiteRT card and INTEGRATION.md:
//   det: [1,3,640,640] float32 NCHW, BGR order, per channel (x - mean*255) / (std*255) with the RGB means
//        [.406,.456,.485] / stds [.225,.224,.229] written B,G,R -> probability map [1,1,640,640]
//   DB: bitmap threshold 0.2, box score 0.45, unclip ratio 1.4, max candidates 3000, min size 3; min-area
//       rectangle per component, mean probability inside it, rectangle grown by d = area * ratio / perimeter
// Browser departure from the card (no OpenCV): connected components instead of contours (same pixels).

export type Point = [number, number];
export type Quad = [Point, Point, Point, Point];

export const DET_SIZE = 640;
const DET_MEAN_RGB = [0.406, 0.456, 0.485];
const DET_STD_RGB = [0.225, 0.224, 0.229];

/** RGBA (S x S) -> detector input (BGR NCHW float32). */
export function detPreprocess(rgba: Uint8ClampedArray | Uint8Array, S: number): Float32Array {
  const plane = S * S;
  const out = new Float32Array(3 * plane);
  const m = DET_MEAN_RGB.map((v) => Math.fround(v * 255));
  const s = DET_STD_RGB.map((v) => Math.fround(v * 255));
  for (let i = 0; i < plane; i++) {
    const r = rgba[i * 4]!, g = rgba[i * 4 + 1]!, b = rgba[i * 4 + 2]!;
    out[i] = (b - m[2]!) / s[2]!;
    out[plane + i] = (g - m[1]!) / s[1]!;
    out[2 * plane + i] = (r - m[0]!) / s[0]!;
  }
  return out;
}

function convexHull(pts: Point[]): Point[] {
  // Andrew's monotone chain on unique points.
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length <= 2) return pts.slice();
  const cross = (o: Point, a: Point, b: Point) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Point[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Point[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

interface Rect { area: number; cx: number; cy: number; w: number; h: number; ux: number; uy: number }

/** Minimum-area rectangle of a convex hull; (ux, uy) is the unit vector along w. */
function minAreaRect(hull: Point[]): Rect | null {
  if (hull.length === 1) return { area: 0, cx: hull[0]![0], cy: hull[0]![1], w: 0, h: 0, ux: 1, uy: 0 };
  let best: Rect | null = null;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i]!, b = hull[(i + 1) % hull.length]!;
    let ux = b[0] - a[0], uy = b[1] - a[1];
    const len = Math.hypot(ux, uy);
    if (len === 0) continue;
    ux /= len; uy /= len;
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const p of hull) {
      const u = p[0] * ux + p[1] * uy;
      const v = -p[0] * uy + p[1] * ux;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    const area = (maxU - minU) * (maxV - minV);
    if (!best || area < best.area) {
      const cu = (minU + maxU) / 2, cv = (minV + maxV) / 2;
      best = { area, w: maxU - minU, h: maxV - minV, ux, uy, cx: cu * ux - cv * uy, cy: cu * uy + cv * ux };
    }
  }
  return best;
}

function rectCorners(r: Rect, grow = 0): Quad {
  const hw = r.w / 2 + grow, hh = r.h / 2 + grow;
  const vx = -r.uy, vy = r.ux;
  const pts = ([[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]] as Point[]).map(([a, b]) => [r.cx + a * r.ux + b * vx, r.cy + a * r.uy + b * vy] as Point);
  // TL, TR, BR, BL as get_mini_boxes orders them: by x, then by y within the left / right pairs
  const byX = pts.slice().sort((p, q) => p[0] - q[0]);
  const [l0, l1] = byX[0]![1] <= byX[1]![1] ? [byX[0]!, byX[1]!] : [byX[1]!, byX[0]!];
  const [r0, r1] = byX[2]![1] <= byX[3]![1] ? [byX[2]!, byX[3]!] : [byX[3]!, byX[2]!];
  return [l0, r0, r1, l1];
}

function pointInPoly(x: number, y: number, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!, [xj, yj] = poly[j]!;
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export interface DetBox { quad: Quad; score: number }

/** DB postprocess on a W x H probability map -> quads in map pixels, in component scan order. */
export function dbPostprocess(
  prob: Float32Array,
  W: number,
  H: number,
  { thresh = 0.2, boxThresh = 0.45, unclip = 1.4, maxCandidates = 3000, minSize = 3 } = {},
): DetBox[] {
  const labels = new Int32Array(W * H);
  const stack = new Int32Array(W * H);
  const out: DetBox[] = [];
  let nComp = 0;
  for (let start = 0; start < W * H && nComp < maxCandidates; start++) {
    if (labels[start] !== 0 || !(prob[start]! > thresh)) continue;
    nComp++;
    const label = nComp;
    let top = 0;
    stack[top++] = start;
    labels[start] = label;
    const boundary: Point[] = [];
    while (top > 0) {
      const p = stack[--top]!;
      const x = p % W, y = (p / W) | 0;
      let edge = false;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) { if (!dx || !dy) edge = true; continue; }
          const q = ny * W + nx;
          if (prob[q]! > thresh) {
            if (labels[q] === 0) { labels[q] = label; stack[top++] = q; }
          } else if (!dx || !dy) edge = true;
        }
      }
      if (edge) boundary.push([x, y]);
    }
    const hull = convexHull(boundary);
    const r = minAreaRect(hull);
    if (!r || Math.min(r.w, r.h) < minSize) continue;
    const quad = rectCorners(r);
    // box score: mean probability inside the quad (over its bounding box mask)
    const xs = quad.map((q) => q[0]), ys = quad.map((q) => q[1]);
    const x0 = Math.max(0, Math.floor(Math.min(...xs))), x1 = Math.min(W - 1, Math.ceil(Math.max(...xs)));
    const y0 = Math.max(0, Math.floor(Math.min(...ys))), y1 = Math.min(H - 1, Math.ceil(Math.max(...ys)));
    let sum = 0, n = 0;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (pointInPoly(x + 0.5, y + 0.5, quad)) { sum += prob[y * W + x]!; n++; }
      }
    }
    const score = n ? sum / n : 0;
    if (score < boxThresh) continue;
    const area = r.w * r.h;
    const perim = 2 * (r.w + r.h);
    const d = perim > 0 ? (area * unclip) / perim : 0;
    if (Math.min(r.w, r.h) + 2 * d < minSize + 2) continue;
    out.push({ quad: rectCorners(r, d), score });
  }
  return out;
}
