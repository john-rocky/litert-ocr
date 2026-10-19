// Image decoding for Node.js, Deno and Bun: PNG (pngjs) and JPEG (jpeg-js, with the EXIF orientation
// applied), both pure JS. Other formats are rejected with a message that says how to pass them.

import jpeg from 'jpeg-js';
import pngjs from 'pngjs';
import { OcrError, errText } from '../core/errors.js';
import { newRaster, type Raster } from './raster.js';

const isPng = (b: Uint8Array) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
const isJpeg = (b: Uint8Array) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

function sniff(b: Uint8Array): string {
  const ascii = (o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n));
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'WebP';
  if (ascii(0, 3) === 'GIF') return 'GIF';
  if (ascii(0, 2) === 'BM') return 'BMP';
  if (ascii(4, 4) === 'ftyp') return /avif|avis/.test(ascii(8, 4)) ? 'AVIF' : 'HEIC / MP4';
  if (ascii(0, 4) === '%PDF') return 'PDF';
  if ((b[0] === 0x49 && b[1] === 0x49) || (b[0] === 0x4d && b[1] === 0x4d)) return 'TIFF';
  if (/^\s*</.test(ascii(0, 16))) return 'SVG / HTML text';
  return 'unknown';
}

export function decodeBytes(bytes: Uint8Array): Raster {
  if (isPng(bytes)) {
    try {
      const png = pngjs.PNG.sync.read(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      return { width: png.width, height: png.height, data: new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.byteLength) };
    } catch (e) {
      throw new OcrError('IMAGE_DECODE_FAILED', `This PNG could not be decoded (${errText(e)}); the file is damaged or truncated (${bytes.length} bytes).`);
    }
  }
  if (isJpeg(bytes)) {
    let img: { width: number; height: number; data: Uint8Array };
    try {
      img = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: 200, maxMemoryUsageInMB: 2048 });
    } catch (e) {
      throw new OcrError('IMAGE_DECODE_FAILED', `This JPEG could not be decoded (${errText(e)}); the file is damaged, truncated or uses an encoding jpeg-js does not read (${bytes.length} bytes).`);
    }
    const r: Raster = { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data.buffer, img.data.byteOffset, img.data.byteLength) };
    return orient(r, exifOrientation(bytes));
  }
  const kind = sniff(bytes);
  throw new OcrError(
    'IMAGE_DECODE_FAILED',
    `In Node.js this library decodes PNG and JPEG only; this file looks like ${kind} (${bytes.length} bytes). Convert it first (for example with sharp: await sharp(file).png().toBuffer()), or pass raw pixels as { data, width, height } (RGBA).`,
  );
}

/** EXIF Orientation (1-8) from a JPEG's APP1 segment; 1 when absent. */
export function exifOrientation(b: Uint8Array): number {
  let o = 2;
  while (o + 4 < b.length) {
    if (b[o] !== 0xff) return 1;
    const marker = b[o + 1]!;
    const len = (b[o + 2]! << 8) | b[o + 3]!;
    if (marker === 0xda || marker === 0xd9) return 1;
    if (marker === 0xe1 && String.fromCharCode(...b.subarray(o + 4, o + 8)) === 'Exif') {
      const t = o + 10; // TIFF header
      const le = b[t] === 0x49;
      const u16 = (p: number) => (le ? b[p]! | (b[p + 1]! << 8) : (b[p]! << 8) | b[p + 1]!);
      const u32 = (p: number) => (le ? (b[p]! | (b[p + 1]! << 8) | (b[p + 2]! << 16)) + b[p + 3]! * 2 ** 24 : b[p]! * 2 ** 24 + ((b[p + 1]! << 16) | (b[p + 2]! << 8) | b[p + 3]!));
      const ifd = t + u32(t + 4);
      const n = u16(ifd);
      for (let i = 0; i < n; i++) {
        const e = ifd + 2 + i * 12;
        if (e + 10 > b.length) break;
        if (u16(e) === 0x0112) {
          const v = u16(e + 8);
          return v >= 1 && v <= 8 ? v : 1;
        }
      }
      return 1;
    }
    o += 2 + len;
  }
  return 1;
}

/** Apply an EXIF orientation so the raster is upright (as browsers draw it). */
export function orient(r: Raster, orientation: number): Raster {
  if (orientation === 1) return r;
  const { width: W, height: H, data } = r;
  const swap = orientation >= 5;
  const out = newRaster(swap ? H : W, swap ? W : H);
  const OW = out.width;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let nx: number, ny: number;
      switch (orientation) {
        case 2: nx = W - 1 - x; ny = y; break;
        case 3: nx = W - 1 - x; ny = H - 1 - y; break;
        case 4: nx = x; ny = H - 1 - y; break;
        case 5: nx = y; ny = x; break;
        case 6: nx = H - 1 - y; ny = x; break;
        case 7: nx = H - 1 - y; ny = W - 1 - x; break;
        default: nx = y; ny = W - 1 - x; break; // 8
      }
      const s = (y * W + x) * 4, t = (ny * OW + nx) * 4;
      out.data[t] = data[s]!; out.data[t + 1] = data[s + 1]!; out.data[t + 2] = data[s + 2]!; out.data[t + 3] = data[s + 3]!;
    }
  }
  return out;
}
