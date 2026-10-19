// Download the five pinned model files into .models/ (for the browser tests and examples), checking sizes
// and sha256. Skips files that are already there and correct.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { modelInfo } from '../dist/node.js';

const dir = fileURLToPath(new URL('../.models/', import.meta.url));
mkdirSync(dir, { recursive: true });
const hex = (b) => createHash('sha256').update(b).digest('hex');
for (const f of modelInfo.files) {
  const p = join(dir, f.file);
  if (existsSync(p) && hex(readFileSync(p)) === f.sha256) { console.log('ok (cached)', f.file); continue; }
  const r = await fetch(modelInfo.base + f.file);
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${f.file}`);
  const b = Buffer.from(await r.arrayBuffer());
  if (b.length !== f.bytes || hex(b) !== f.sha256) throw new Error(`${f.file}: size ${b.length} / sha256 ${hex(b)} do not match the pinned file`);
  writeFileSync(p + '.tmp', b);
  renameSync(p + '.tmp', p);
  console.log('ok (downloaded)', f.file, b.length);
}
