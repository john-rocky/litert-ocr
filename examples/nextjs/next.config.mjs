import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// The two headers let WebAssembly use threads (cross-origin isolation); without them OCR runs on 1 thread.
export default {
  // this folder is the project root (the repository above it has its own lockfile)
  turbopack: { root: dirname(fileURLToPath(import.meta.url)) },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
          { key: 'Cross-Origin-Embedder-Policy', value: 'require-corp' },
        ],
      },
    ];
  },
};
