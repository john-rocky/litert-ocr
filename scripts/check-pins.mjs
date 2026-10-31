// prepublishOnly: refuse to publish while a pinned Hugging Face revision is still the placeholder <commit>
// (it is filled with the commit of the Hub upload: sed -i '' "s/<commit>/<40-hex commit>/" src/core/models.ts NOTICE).
import { readFileSync } from 'node:fs';

const files = ['src/core/models.ts', 'NOTICE'];
const left = files.filter((f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').includes('<commit>'));
if (left.length) {
  console.error(`The Hugging Face revision is still the placeholder <commit> in ${left.join(', ')}: fill it with the commit of the Hub upload first.`);
  process.exit(1);
}
