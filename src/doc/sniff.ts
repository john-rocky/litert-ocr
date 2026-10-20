// What kind of file convert() got, from its first bytes.

/** "%PDF-" within the first 1024 bytes (the PDF spec allows bytes before the header). */
export function isPdf(b: Uint8Array): boolean {
  const n = Math.min(b.length - 4, 1024);
  for (let i = 0; i < n; i++) if (b[i] === 0x25 && b[i + 1] === 0x50 && b[i + 2] === 0x44 && b[i + 3] === 0x46 && b[i + 4] === 0x2d) return true;
  return false;
}

/** Formats that are neither a PDF nor an image, named so the error says what the file is; null = maybe an image. */
export function sniffOther(b: Uint8Array): string | null {
  if (b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) return 'a ZIP archive (DOCX, XLSX, PPTX and EPUB files are ZIP archives)';
  if (b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) return 'an old Microsoft Office file (DOC, XLS or PPT)';
  if (b.length >= 5 && String.fromCharCode(...b.subarray(0, 5)) === '{\\rtf') return 'an RTF document';
  if (b.length) {
    // text: no NUL byte and every byte printable or whitespace (UTF-8 bytes count as printable)
    for (const c of b) if (c === 0 || (c < 32 && c !== 9 && c !== 10 && c !== 13)) return null;
    const s = String.fromCharCode(...b.subarray(0, 32));
    if (/^\s*<(svg|\?xml)/i.test(s)) return null; // an SVG image: the browser may decode it
    return /^\s*</.test(s) ? 'HTML or XML text' : 'plain text';
  }
  return null;
}
