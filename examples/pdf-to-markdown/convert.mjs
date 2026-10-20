// Node.js: every PDF or image named on the command line -> <name>.md next to it.
//   node convert.mjs report.pdf scan.jpg
// The OCR model downloads once into ~/.cache/litert-ocr. Pages with a text layer need no model at all.
import { writeFileSync } from 'node:fs';
import { createConverter } from 'litert-ocr';

const converter = createConverter();
try {
  for (const file of process.argv.slice(2)) {
    const { content, document } = await converter.convert(file, { to: 'md' });
    const out = file.replace(/\.[^.]+$/, '') + '.md';
    writeFileSync(out, content);
    for (const p of document.pages) console.log(`${file} page ${p.page}: ${p.status} (${p.engine ?? '-'}) ${Math.round(p.ms)} ms`);
    console.log(`-> ${out}`);
  }
} finally {
  await converter.terminate();
}
