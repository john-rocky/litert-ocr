'use client';

import { useEffect, useRef, useState } from 'react';

// The library runs in the browser only: import it inside the effect, so the server never loads it.
export default function Ocr() {
  const worker = useRef(null);
  const [status, setStatus] = useState('Loading the model…');
  const [text, setText] = useState('');

  useEffect(() => {
    let cancelled = false;
    const ready = import('litert-ocr').then(({ createWorker }) =>
      createWorker('eng', 1, {
        logger: (m) => {
          if (m.status === 'loading model') setStatus(`Loading the model… ${Math.round(m.progress * 100)}%`);
        },
      }),
    );
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
    <>
      <input type="file" accept="image/*" onChange={onFile} disabled={!worker.current} />
      <p id="status">{status}</p>
      <pre id="out" style={{ whiteSpace: 'pre-wrap', background: '#f4f4f5', padding: 12 }}>{text}</pre>
    </>
  );
}
