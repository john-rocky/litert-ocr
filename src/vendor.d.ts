// Minimal types for pngjs (it ships none); only what src/node/decode.ts calls.
declare module 'pngjs' {
  const pngjs: {
    PNG: { sync: { read(buffer: Buffer): { width: number; height: number; data: Buffer } } };
  };
  export default pngjs;
}
