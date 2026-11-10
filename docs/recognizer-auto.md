# The 0.2.1 default recognizer, measured

The numbers behind the table in the section [Safari and WebGPU](speed-and-files.md#safari-and-webgpu): litert-ocr 0.2.1 with the default `recognizer: 'auto'`, 2026-11-10.

| Browser | Recognizer (320 / 640 / 960) | Lines as with `recognizer: 'wasm'` | Time per image, default / `'wasm'` | Start, 0.2.1 / 0.2.0 |
|---|---|---|---|---|
| Chrome 157 on a Mac Studio (Apple M4 Max), 281 of the 295 images of the README's speed table | WebGPU / WebGPU / WebGPU | 6,876 of 6,876 | 173 / 276 ms | 0.84 / 0.89 s |
| WebKit 26.5 on the same Mac, the 12 images of the README's first table | WebGPU / WebGPU / WebGPU | 333 of 333 | 291 / 1,977 ms | — |
| Chrome 156 on a Galaxy S26, the same 12 images | WebGPU / WebAssembly (its check differed in 1 or 2 of 80 output steps, 7 of 7 times) / WebGPU | 335 of 335 | 766 / 849 ms (the CPU clock was capped on every image, more in the later `'wasm'` run) | 2.46 / 1.62 s |
| Chrome 156 on a Pixel 8a, the same 12 images | WebGPU / WebGPU / WebGPU | 335 of 335 | 2,982 / 3,843 ms | 6.96 / 6.14 s |

The Mac ran other work during these runs, so its times compare within a row only. Start = from `createWorker()` to the first text of the 390 x 800 phone screenshot, with the files in the cache (median of 3). The checks are part of it, as that screenshot needs the 320 and 640-wide recognizers (medians of the same 3 starts): 0.81 and 0.46 s on the Galaxy S26, 2.03 and 1.32 s on the Pixel 8a, 0.20 and 0.24 s on the Mac.

The check reads one line, so it is a coarse guard: given `ppocrv6_small_rec_320_fp32.tflite` instead (which misreads lines on WebGPU), it saw the difference in Chrome 157 on the Mac (2 of 40 output steps) but not in WebKit 26.5, where that line read the same (probabilities within 2.9e-6). On the Galaxy S26, `recognizer: 'webgpu'` (every width on WebGPU, no check) read 13 of the 335 lines differently in Chrome 155 (2026-10-20). The detector reads the same on WebGPU and WebAssembly.
