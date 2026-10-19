import { useEffect, useRef, useState } from 'react';
import { createWorker } from 'litert-ocr';

export default function App() {
  const worker = useRef(null);
  const [status, setStatus] = useState('Loading the model…');
  const [text, setText] = useState('');

  useEffect(() => {
    let cancelled = false;
    const ready = createWorker('eng', 1, {
      logger: (m) => {
        if (m.status === 'loading model') setStatus(`Loading the model… ${Math.round(m.progress * 100)}%`);
      },
    });
    ready.then((w) => {
      if (cancelled) return w.terminate();
      worker.current = w;
      setStatus(`Ready (${w.info.detector} detector, ${w.info.threads} threads).`);
    }, (e) => setStatus(`Could not start: ${e.message}`));
    return () => {
      cancelled = true;
      ready.then((w) => w.terminate(), () => {});
    };
  }, []);

  async function onFile(e) {
    const file = e.target.files?.[0];
    if (!file || !worker.current) return;
    setStatus(`Reading ${file.name}…`);
    const t0 = performance.now();
    const { data } = await worker.current.recognize(file);
    setText(data.text);
    setStatus(`${file.name}: ${Math.round(performance.now() - t0)} ms`);
  }

  return (
    <main style={{ font: '15px/1.5 system-ui, sans-serif', margin: 24, maxWidth: 760 }}>
      <h1>Read text from an image</h1>
      <input type="file" accept="image/*" onChange={onFile} disabled={!worker.current} />
      <p id="status">{status}</p>
      <pre id="out" style={{ whiteSpace: 'pre-wrap', background: '#f4f4f5', padding: 12 }}>{text}</pre>
    </main>
  );
}
