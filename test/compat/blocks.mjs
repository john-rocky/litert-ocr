// Reading words and boxes the tesseract.js 6+ way: ask for `blocks` in the output argument.
import { createWorker } from 'litert-ocr';

const image = process.argv[2] ?? new URL('../fixtures/settings-dark.png', import.meta.url).pathname;
const worker = await createWorker('eng');
const { data } = await worker.recognize(image, {}, { blocks: true });
for (const block of data.blocks) {
  for (const paragraph of block.paragraphs) {
    for (const line of paragraph.lines) {
      for (const word of line.words) {
        console.log(word.text, Math.round(word.confidence), JSON.stringify(word.bbox));
      }
    }
  }
}
await worker.terminate();
