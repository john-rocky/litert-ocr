// Download the pinned model files into .models/ (for the browser tests and examples): the five of modelInfo.files
// and, once published, the WebGPU form of the 320-wide recognizer. Checks sizes and sha256; skips files that are
// already there and correct.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { modelInfo } from '../dist/node.js';

const dir = fileURLToPath(new URL('../.models/', import.meta.url));
mkdirSync(dir, { recursive: true });
const hex = (b) => createHash('sha256').update(b).digest('hex');
const files = modelInfo.files.map((f) => ({ ...f, url: modelInfo.base + f.file }));
if (modelInfo.rec320WebGpu.status === 'published') files.push({ ...modelInfo.rec320WebGpu, url: modelInfo.rec320WebGpu.base + modelInfo.rec320WebGpu.file });
for (const f of files) {
  const p = join(dir, f.file);
  if (existsSync(p) && hex(readFileSync(p)) === f.sha256) { console.log('ok (cached)', f.file); continue; }
  const r = await fetch(f.url);
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${f.file}`);
  const b = Buffer.from(await r.arrayBuffer());
  if (b.length !== f.bytes || hex(b) !== f.sha256) throw new Error(`${f.file}: size ${b.length} / sha256 ${hex(b)} do not match the pinned file`);
  writeFileSync(p + '.tmp', b);
  renameSync(p + '.tmp', p);
  console.log('ok (downloaded)', f.file, b.length);
}
