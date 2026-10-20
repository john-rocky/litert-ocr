// Image operations on OffscreenCanvas, in the same calls and settings as the measured pipeline (r1a):
// the detector input is drawn with default smoothing, crops and the 48-px strip with high-quality
// smoothing, every 2D context with willReadFrequently.

import type { Quad } from '../core/db.js';
import type { RasterOps } from '../core/pipeline.js';

const canvas = (w: number, h: number) => new OffscreenCanvas(w, h);
const ctx2d = (c: OffscreenCanvas) => c.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D;

type Src = ImageBitmap;
type Crop = OffscreenCanvas;
type Strip = { canvas: OffscreenCanvas; rgba: Uint8ClampedArray };

export const canvasOps: RasterOps<Src, Crop, Strip> = {
  size: (b) => ({ width: b.width, height: b.height }),

  detRGBA(b, S) {
    const c = ctx2d(canvas(S, S));
    c.drawImage(b, 0, 0, b.width, b.height, 0, 0, S, S);
    return c.getImageData(0, 0, S, S).data;
  },

  cropQuad(source, quad: Quad) {
    const [p0, p1, p2, p3] = quad;
    const dist = (a: number[], b: number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!);
    const w = Math.max(1, Math.floor(Math.max(dist(p0, p1), dist(p2, p3))));
    const h = Math.max(1, Math.floor(Math.max(dist(p0, p3), dist(p1, p2))));
    const c = canvas(w, h);
    const ctx = ctx2d(c);
    // M maps p1 - p0 -> (w, 0) and p3 - p0 -> (0, h)
    const ax = p1[0] - p0[0], ay = p1[1] - p0[1], bx = p3[0] - p0[0], by = p3[1] - p0[1];
    const det = ax * by - bx * ay;
    if (Math.abs(det) < 1e-6) return null;
    const i00 = by / det, i01 = -bx / det, i10 = -ay / det, i11 = ax / det; // A^-1
    const m00 = w * i00, m01 = w * i01, m10 = h * i10, m11 = h * i11;
    const e = -(m00 * p0[0] + m01 * p0[1]), f = -(m10 * p0[0] + m11 * p0[1]);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.setTransform(m00, m10, m01, m11, e, f);
    ctx.drawImage(source, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    let sr = 0, sg = 0, sb = 0, n = 0, holes = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 255) { sr += d[i]!; sg += d[i + 1]!; sb += d[i + 2]!; n++; } else holes++;
    }
    if (holes && n) {
      // pixels outside the image: blend toward the crop's mean colour
      const mr = sr / n, mg = sg / n, mb = sb / n;
      for (let i = 0; i < d.length; i += 4) {
        const a = d[i + 3]! / 255;
        d[i] = d[i]! * a + mr * (1 - a); d[i + 1] = d[i + 1]! * a + mg * (1 - a); d[i + 2] = d[i + 2]! * a + mb * (1 - a); d[i + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
    }
    if (h / w >= 1.5) {
      const r = canvas(h, w);
      const rctx = ctx2d(r);
      // counter-clockwise quarter turn: new(x, y) = old(w - 1 - y, x)
      rctx.setTransform(0, -1, 1, 0, 0, w);
      rctx.drawImage(c, 0, 0);
      rctx.setTransform(1, 0, 0, 1, 0, 0);
      return { crop: r, width: h, height: w, rotated: true };
    }
    return { crop: c, width: w, height: h, rotated: false };
  },

  strip(crop, nat, h) {
    const s = canvas(nat, h);
    const sctx = ctx2d(s);
    sctx.imageSmoothingEnabled = true;
    sctx.imageSmoothingQuality = 'high';
    sctx.drawImage(crop, 0, 0, nat, h);
    // read back once, as the measured pipeline did (the ink split of long lines uses it)
    return { canvas: s, rgba: sctx.getImageData(0, 0, nat, h).data };
  },

  stripRGBA: (strip) => strip.rgba,

  windowRGBA(strip, from, pw, cw, h) {
    const wctx = ctx2d(canvas(cw, h));
    wctx.drawImage(strip.canvas, from, 0, pw, h, 0, 0, cw, h);
    return wctx.getImageData(0, 0, cw, h).data;
  },
};

/** Page steps of convert(), drawn as the measured document path drew them. */
export const canvasDocOps = {
  /** The whole page scaled to w x h (default smoothing). */
  scaled(b: Src, w: number, h: number): Uint8ClampedArray {
    const c = ctx2d(canvas(w, h));
    c.drawImage(b, 0, 0, w, h);
    return c.getImageData(0, 0, w, h).data;
  },
  /** The page turned by -deg about its centre on a white canvas of the same size. */
  async rotate(b: Src, deg: number): Promise<{ src: Src; release(): void }> {
    const c = canvas(b.width, b.height);
    const ctx = c.getContext('2d') as OffscreenCanvasRenderingContext2D;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.translate(c.width / 2, c.height / 2);
    ctx.rotate((-deg * Math.PI) / 180);
    ctx.drawImage(b, -b.width / 2, -b.height / 2);
    const out = await createImageBitmap(c);
    return { src: out, release: () => out.close() };
  },
};
