// The first example of the tesseract.js README (v7.0.0), with one line changed: the import.
import { createWorker } from 'litert-ocr';

(async () => {
  const worker = await createWorker('eng');
  const ret = await worker.recognize('https://tesseract.projectnaptha.com/img/eng_bw.png');
  console.log(ret.data.text);
  await worker.terminate();
})();
