// The pipeline's image operations in plain JS (Node.js, Deno, Bun have no canvas). Same geometry as the
// browser path; the resampling differs a little (bilinear, and area averaging when shrinking), so a line
// can come out differently from the browser in rare cases.

import type { Quad } from '../core/db.js';
import type { RasterOps } from '../core/pipeline.js';

export interface Raster {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel. */
  data: Uint8ClampedArray;
}

export function newRaster(width: number, height: number): Raster {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

/** Bilinear sample at continuous coordinates (pixel centers at +0.5), clamped to the edge inside the
 * image; a point outside the image is transparent (as canvas drawImage leaves it). */
function sample(src: Raster, x: number, y: number, out: number[]): void {
  const W = src.width, H = src.height;
  if (x < 0 || y < 0 || x > W || y > H) {
    out[0] = out[1] = out[2] = out[3] = 0;
    return;
  }
  const fx = Math.min(W - 1, Math.max(0, x - 0.5)), fy = Math.min(H - 1, Math.max(0, y - 0.5));
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(H - 1, y0 + 1);
  const ax = fx - x0, ay = fy - y0;
  const d = src.data;
  const k00 = (y0 * W + x0) * 4, k01 = (y0 * W + x1) * 4, k10 = (y1 * W + x0) * 4, k11 = (y1 * W + x1) * 4;
  for (let c = 0; c < 4; c++) {
    out[c] = (d[k00 + c]! * (1 - ax) + d[k01 + c]! * ax) * (1 - ay) + (d[k10 + c]! * (1 - ax) + d[k11 + c]! * ax) * ay;
  }
}

/** Resize a region of src to dw x dh: area averaging when shrinking, bilinear otherwise. */
export function resizeRegion(src: Raster, sx: number, sy: number, sw: number, sh: number, dw: number, dh: number): Raster {
  const out = newRaster(dw, dh);
  const kx = sw / dw, ky = sh / dh;
  const d = out.data;
  const px = [0, 0, 0, 0];
  if (kx > 1 || ky > 1) {
    // box filter over the source footprint of each destination pixel (fractional edges weighted)
    for (let y = 0; y < dh; y++) {
      const y0 = sy + y * ky, y1 = y0 + ky;
      for (let x = 0; x < dw; x++) {
        const x0 = sx + x * kx, x1 = x0 + kx;
        let r = 0, g = 0, b = 0, a = 0, wsum = 0;
        for (let yy = Math.floor(y0); yy < Math.ceil(y1); yy++) {
          if (yy < 0 || yy >= src.height) continue;
          const wy = Math.min(y1, yy + 1) - Math.max(y0, yy);
          for (let xx = Math.floor(x0); xx < Math.ceil(x1); xx++) {
            if (xx < 0 || xx >= src.width) continue;
            const w = wy * (Math.min(x1, xx + 1) - Math.max(x0, xx));
            const k = (yy * src.width + xx) * 4;
            r += src.data[k]! * w; g += src.data[k + 1]! * w; b += src.data[k + 2]! * w; a += src.data[k + 3]! * w;
            wsum += w;
          }
        }
        const o = (y * dw + x) * 4;
        if (wsum > 0) { d[o] = r / wsum; d[o + 1] = g / wsum; d[o + 2] = b / wsum; d[o + 3] = a / wsum; }
      }
    }
    return out;
  }
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      sample(src, sx + (x + 0.5) * kx, sy + (y + 0.5) * ky, px);
      const o = (y * dw + x) * 4;
      d[o] = px[0]!; d[o + 1] = px[1]!; d[o + 2] = px[2]!; d[o + 3] = px[3]!;
    }
  }
  return out;
}

/** Plain bilinear resize (sample at each destination pixel's center), as canvas 'low' smoothing does. */
export function resizeBilinear(src: Raster, dw: number, dh: number): Raster {
  const out = newRaster(dw, dh);
  const kx = src.width / dw, ky = src.height / dh;
  const px = [0, 0, 0, 0];
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      sample(src, (x + 0.5) * kx, (y + 0.5) * ky, px);
      const o = (y * dw + x) * 4;
      out.data[o] = px[0]!; out.data[o + 1] = px[1]!; out.data[o + 2] = px[2]!; out.data[o + 3] = px[3]!;
    }
  }
  return out;
}

export const jsOps: RasterOps<Raster, Raster, Raster> = {
  size: (r) => ({ width: r.width, height: r.height }),

  // canvas drawImage with default smoothing samples bilinearly without averaging; the measured detector input
  detRGBA: (r, S) => resizeBilinear(r, S, S).data,

  cropQuad(source, quad: Quad) {
    const [p0, p1, p2, p3] = quad;
    const dist = (a: number[], b: number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!);
    const w = Math.max(1, Math.floor(Math.max(dist(p0, p1), dist(p2, p3))));
    const h = Math.max(1, Math.floor(Math.max(dist(p0, p3), dist(p1, p2))));
    const ax = p1[0] - p0[0], ay = p1[1] - p0[1], bx = p3[0] - p0[0], by = p3[1] - p0[1];
    if (Math.abs(ax * by - bx * ay) < 1e-6) return null;
    // crop pixel (u, v) -> source point p0 + (u / w) * (p1 - p0) + (v / h) * (p3 - p0)
    const out = newRaster(w, h);
    const d = out.data;
    const px = [0, 0, 0, 0];
    // shrinking crops (a line drawn larger than its crop) are pre-averaged so thin strokes survive
    const scale = Math.max(Math.hypot(ax, ay) / w, Math.hypot(bx, by) / h);
    const src = scale > 1.5 ? resizeRegion(source, 0, 0, source.width, source.height, Math.max(1, Math.round(source.width / scale)), Math.max(1, Math.round(source.height / scale))) : source;
    const f = src === source ? 1 : src.width / source.width;
    let sr = 0, sg = 0, sb = 0, n = 0, holes = 0;
    for (let v = 0; v < h; v++) {
      for (let u = 0; u < w; u++) {
        const fu = (u + 0.5) / w, fv = (v + 0.5) / h;
        const x = (p0[0] + fu * ax + fv * bx) * f, y = (p0[1] + fu * ay + fv * by) * f;
        sample(src, x, y, px);
        const o = (v * w + u) * 4;
        d[o] = px[0]!; d[o + 1] = px[1]!; d[o + 2] = px[2]!; d[o + 3] = px[3]!;
        if (px[3]! >= 254.5) { sr += px[0]!; sg += px[1]!; sb += px[2]!; n++; } else holes++;
      }
    }
    if (holes && n) {
      const mr = sr / n, mg = sg / n, mb = sb / n;
      for (let i = 0; i < d.length; i += 4) {
        const a = d[i + 3]! / 255;
        d[i] = d[i]! * a + mr * (1 - a); d[i + 1] = d[i + 1]! * a + mg * (1 - a); d[i + 2] = d[i + 2]! * a + mb * (1 - a); d[i + 3] = 255;
      }
    }
    if (h / w >= 1.5) {
      // counter-clockwise quarter turn: new(x, y) = old(w - 1 - y, x)
      const rr = newRaster(h, w);
      for (let y = 0; y < w; y++) {
        for (let x = 0; x < h; x++) {
          const s = (x * w + (w - 1 - y)) * 4, t = (y * h + x) * 4;
          rr.data[t] = d[s]!; rr.data[t + 1] = d[s + 1]!; rr.data[t + 2] = d[s + 2]!; rr.data[t + 3] = d[s + 3]!;
        }
      }
      return { crop: rr, width: h, height: w, rotated: true };
    }
    return { crop: out, width: w, height: h, rotated: false };
  },

  strip: (crop, nat, h) => resizeRegion(crop, 0, 0, crop.width, crop.height, nat, h),

  stripRGBA: (s) => s.data,

  windowRGBA: (s, from, pw, cw, h) => (pw === cw ? copyColumns(s, from, cw) : resizeRegion(s, from, 0, pw, s.height, cw, h)).data,
};

function copyColumns(s: Raster, from: number, cw: number): Raster {
  const out = newRaster(cw, s.height);
  for (let y = 0; y < s.height; y++) {
    out.data.set(s.data.subarray((y * s.width + from) * 4, (y * s.width + from + cw) * 4), y * cw * 4);
  }
  return out;
}

/** Crop and/or scale for a rectangle and the size limit. */
export function cropScale(src: Raster, sx: number, sy: number, sw: number, sh: number, scale: number): Raster {
  if (scale === 1) {
    const out = newRaster(sw, sh);
    for (let y = 0; y < sh; y++) out.data.set(src.data.subarray(((sy + y) * src.width + sx) * 4, ((sy + y) * src.width + sx + sw) * 4), y * sw * 4);
    return out;
  }
  return resizeRegion(src, sx, sy, sw, sh, Math.max(1, Math.round(sw * scale)), Math.max(1, Math.round(sh * scale)));
}
