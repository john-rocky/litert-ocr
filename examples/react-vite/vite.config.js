import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The two headers let WebAssembly use threads (cross-origin isolation); without them OCR runs on 1 thread.
const isolation = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' };

export default defineConfig({
  base: './',
  plugins: [react()],
  server: { headers: isolation },
  preview: { headers: isolation },
});
