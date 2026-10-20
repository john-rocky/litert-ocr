// A small PDF writer for the test fixtures: pages of Helvetica text lines and / or one JPEG drawn over the page, and
// optional password protection (the standard security handler, revision 2: RC4 with a 40-bit key, which every PDF
// reader opens). No dependencies.
//   makePdf({ pages: [{ width, height, lines: [{ x, y, size, text }], jpeg: { bytes, width, height } }], password })
import { createHash } from 'node:crypto';

const PAD = Buffer.from('28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a', 'hex');

function rc4(key, data) {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i++) s[i] = i;
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
  }
  const out = Buffer.alloc(data.length);
  for (let k = 0, i = 0, j = 0; k < data.length; k++) {
    i = (i + 1) & 255;
    j = (j + s[i]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
    out[k] = data[k] ^ s[(s[i] + s[j]) & 255];
  }
  return out;
}
const md5 = (...parts) => createHash('md5').update(Buffer.concat(parts.map((p) => Buffer.from(p)))).digest();
const padPw = (pw) => Buffer.concat([Buffer.from(pw, 'latin1'), PAD]).subarray(0, 32);
const esc = (s) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

export function makePdf({ pages, password = null }) {
  const objs = []; // index = object number - 1; each = { dict: string, stream?: Buffer }
  const add = (o) => { objs.push(o); return objs.length; };
  const catalog = add(null);
  const pagesObj = add(null);
  const font = add({ dict: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>' });
  const kids = [];
  for (const p of pages) {
    let content = '';
    const res = [`/Font << /F1 ${font} 0 R >>`];
    if (p.jpeg) {
      const img = add({ dict: `<< /Type /XObject /Subtype /Image /Width ${p.jpeg.width} /Height ${p.jpeg.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length LEN >>`, stream: Buffer.from(p.jpeg.bytes) });
      res.push(`/XObject << /Im1 ${img} 0 R >>`);
      content += `q ${p.width} 0 0 ${p.height} 0 0 cm /Im1 Do Q\n`;
    }
    for (const l of p.lines ?? []) content += `BT /F1 ${l.size} Tf ${l.x} ${p.height - l.y} Td (${esc(l.text)}) Tj ET\n`;
    const contents = add({ dict: '<< /Length LEN >>', stream: Buffer.from(content, 'latin1') });
    kids.push(add({ dict: `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${p.width} ${p.height}] /Resources << ${res.join(' ')} >> /Contents ${contents} 0 R >>` }));
  }
  objs[catalog - 1] = { dict: `<< /Type /Catalog /Pages ${pagesObj} 0 R >>` };
  objs[pagesObj - 1] = { dict: `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>` };
  const id = md5('litert-ocr test fixture', String(pages.length));
  let encrypt = null;
  let key = null;
  if (password !== null) {
    const P = -44; // print + copy allowed
    const okey = md5(padPw('owner-' + password)).subarray(0, 5);
    const O = rc4(okey, padPw(password));
    const pb = Buffer.alloc(4);
    pb.writeInt32LE(P);
    key = md5(padPw(password), O, pb, id).subarray(0, 5);
    const U = rc4(key, PAD);
    encrypt = add({ dict: `<< /Filter /Standard /V 1 /R 2 /O <${O.toString('hex')}> /U <${U.toString('hex')}> /P ${P} >>` });
  }
  const chunks = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  const offsets = [];
  let pos = chunks[0].length;
  objs.forEach((o, i) => {
    const num = i + 1;
    let stream = o.stream ?? null;
    if (stream && key && num !== encrypt) {
      const k = md5(key, Buffer.from([num & 255, (num >> 8) & 255, (num >> 16) & 255, 0, 0])).subarray(0, 10);
      stream = rc4(k, stream);
    }
    const head = `${num} 0 obj\n${o.dict.replace('LEN', String(stream?.length ?? 0))}\n`;
    const body = stream ? Buffer.concat([Buffer.from(head + 'stream\n', 'latin1'), stream, Buffer.from('\nendstream\nendobj\n', 'latin1')]) : Buffer.from(head + 'endobj\n', 'latin1');
    offsets.push(pos);
    chunks.push(body);
    pos += body.length;
  });
  const xref = [`xref\n0 ${objs.length + 1}\n`, '0000000000 65535 f \n', ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)].join('');
  const trailer = `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /ID [<${id.toString('hex')}> <${id.toString('hex')}>]${encrypt ? ` /Encrypt ${encrypt} 0 R` : ''} >>\nstartxref\n${pos}\n%%EOF\n`;
  chunks.push(Buffer.from(xref + trailer, 'latin1'));
  return new Uint8Array(Buffer.concat(chunks));
}

/** Width and height of a baseline JPEG (from its SOF marker). */
export function jpegSize(b) {
  let o = 2;
  while (o < b.length) {
    if (b[o] !== 0xff) return null;
    const m = b[o + 1];
    const len = (b[o + 2] << 8) | b[o + 3];
    if (m >= 0xc0 && m <= 0xc3) return { height: (b[o + 5] << 8) | b[o + 6], width: (b[o + 7] << 8) | b[o + 8] };
    o += 2 + len;
  }
  return null;
}
