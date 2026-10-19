// The same example in CommonJS (tesseract.js docs/examples.md style): require() of this ESM package
// works on Node.js 20.19+ / 22.12+.
const { createWorker } = require('litert-ocr');

(async () => {
  const worker = await createWorker('eng');
  const { data: { text } } = await worker.recognize('https://tesseract.projectnaptha.com/img/eng_bw.png');
  console.log(text);
  await worker.terminate();
})();
