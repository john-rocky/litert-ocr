// Is a PNG or JPEG file cut short (a download that broke off)? Browsers differ on such a file: Chrome rejects it,
// Safari draws the part that arrived. The library says so in a notice either way (never an error of its own).

/** The second half of the notice: what it means for the result. */
export const CUT_HINT = 'Image decoders differ on such a file (some read the part that arrived, others reject it); either way, text in the missing part is not read. Pass the complete file.';

/**
 * For a PNG that ends before its IEND chunk or a JPEG that ends before its EOI marker: a sentence that says so.
 * null for a complete file, and for anything that is not a PNG or a JPEG.
 */
export function cutShort(b: Uint8Array): string | null {
  if (isPng(b)) return pngComplete(b) ? null : `This PNG file ends before its IEND chunk (${b.length} bytes): it was cut short, as by an interrupted download.`;
  if (isJpeg(b)) return jpegComplete(b) ? null : `This JPEG file ends before its end marker (${b.length} bytes): it was cut short, as by an interrupted download.`;
  return null;
}

/** The same for a Blob: the end of the file first (the usual case), the whole file only when that is not enough. */
export async function cutShortBlob(blob: Blob): Promise<string | null> {
  if (blob.size < 12) return null;
  const head = new Uint8Array(await blob.slice(0, 3).arrayBuffer());
  const png = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e;
  const jpeg = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  if (!png && !jpeg) return null;
  const tail = new Uint8Array(await blob.slice(blob.size - 12).arrayBuffer());
  if (png ? endsWithIend(tail) : endsWithEoi(tail)) return null;
  return cutShort(new Uint8Array(await blob.arrayBuffer()));
}

const isPng = (b: Uint8Array) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
const isJpeg = (b: Uint8Array) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

// IEND: length 0, type 'IEND', CRC ae 42 60 82
const IEND = [0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82];
const endsWithIend = (b: Uint8Array) => b.length >= 12 && IEND.every((v, i) => b[b.length - 12 + i] === v);
const endsWithEoi = (b: Uint8Array) => b.length >= 2 && b[b.length - 2] === 0xff && b[b.length - 1] === 0xd9;

/** Walk the chunks: complete when the IEND chunk fits in the file (bytes after it are allowed). */
function pngComplete(b: Uint8Array): boolean {
  if (endsWithIend(b)) return true;
  let o = 8;
  while (o + 8 <= b.length) {
    const len = ((b[o]! << 24) >>> 0) + (b[o + 1]! << 16) + (b[o + 2]! << 8) + b[o + 3]!;
    const end = o + 12 + len;
    if (b[o + 4] === 0x49 && b[o + 5] === 0x45 && b[o + 6] === 0x4e && b[o + 7] === 0x44) return end <= b.length;
    if (end > b.length) return false;
    o = end;
  }
  return false;
}

/**
 * Walk the markers: complete when the EOI marker is reached (data after it, such as a motion photo's video, is
 * allowed). Entropy-coded data after SOS is skipped up to the next marker (0xFF followed by neither 0x00 nor a
 * restart marker). A file whose structure cannot be followed is not called cut short.
 */
function jpegComplete(b: Uint8Array): boolean {
  if (endsWithEoi(b)) return true;
  const n = b.length;
  let o = 2;
  while (o < n) {
    if (b[o] !== 0xff) return true; // not a marker where one must be: damaged, not cut short
    while (o + 1 < n && b[o + 1] === 0xff) o++; // fill bytes
    if (o + 1 >= n) return false;
    const m = b[o + 1]!;
    if (m === 0xd9) return true;
    if ((m >= 0xd0 && m <= 0xd7) || m === 0x01) { o += 2; continue; }
    if (o + 4 > n) return false;
    const end = o + 2 + ((b[o + 2]! << 8) | b[o + 3]!);
    if (end > n) return false;
    o = end;
    if (m === 0xda) {
      // entropy-coded data up to the next marker
      while (o + 1 < n && !(b[o] === 0xff && b[o + 1] !== 0x00 && !(b[o + 1]! >= 0xd0 && b[o + 1]! <= 0xd7))) o++;
      if (o + 1 >= n) return false;
    }
  }
  return false;
}
