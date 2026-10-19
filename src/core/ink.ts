// Copyright 2026 The Google AI Edge Authors. All Rights Reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ==============================================================================
//
// Modified for litert-ocr: columnInkProfile, splitByInk, windowSeparator and CJK_EDGE are copied from
// google-ai-edge/litert-samples samples/web_demos/chrome_extension/src-ocr/ocr-pipeline.js and ported to
// TypeScript (types added, logic unchanged). See NOTICE.

const REC_H = 48;
const REC_W = 320;

/**
 * Column ink profile of a 48-high RGBA strip: per column, the max absolute deviation from the background
 * color (estimated from the strip's corners), 0..765. Returns {profile, bg}.
 */
export function columnInkProfile(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number): { profile: Float32Array; bg: [number, number, number] } {
  let br = 0, bg_ = 0, bb = 0, n = 0;
  for (const [cx, cy] of [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]] as [number, number][]) {
    for (let d = 0; d < 3; d++) {
      const x = Math.min(w - 1, Math.max(0, cx + (cx === 0 ? d : -d)));
      const i = (cy * w + x) * 4;
      br += rgba[i]!; bg_ += rgba[i + 1]!; bb += rgba[i + 2]!; n++;
    }
  }
  br /= n; bg_ /= n; bb /= n;
  const profile = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    let m = 0;
    for (let y = 0; y < h; y++) {
      const i = (y * w + x) * 4;
      const d = Math.abs(rgba[i]! - br) + Math.abs(rgba[i + 1]! - bg_) + Math.abs(rgba[i + 2]! - bb);
      if (d > m) m = d;
    }
    profile[x] = m;
  }
  return { profile, bg: [Math.round(br), Math.round(bg_), Math.round(bb)] };
}

export interface InkPiece { from: number; to: number; midWord: boolean }

/**
 * Split a 48-high line strip of width lw into recognizer windows using the ink profile. Cuts only at
 * background gaps; a stretch without a gap may grow to squashLimit and is squashed at recognition time.
 * A gap narrower than wordGap is the space between two letters; the window after such a cut gets midWord
 * and windowSeparator joins it without a space. Returns [{from, to, midWord}] in strip px.
 */
export function splitByInk(
  profile: Float32Array,
  lw: number,
  { maxW = REC_W, squashLimit = REC_W * 2.2, gapFrac = 0.06, wordGap = REC_H * 0.15 } = {},
): InkPiece[] {
  if (lw <= maxW) return [{ from: 0, to: lw, midWord: false }];
  let peak = 0;
  for (let x = 0; x < lw; x++) if (profile[x]! > peak) peak = profile[x]!;
  const low = Math.max(12, peak * gapFrac);
  // Whole width of the background run around column x (0 inside ink).
  const runWidth = (x: number) => {
    let a = Math.round(x);
    if (!(profile[a]! <= low)) return 0;
    let b = a;
    while (a > 0 && profile[a - 1]! <= low) a--;
    while (b < lw - 1 && profile[b + 1]! <= low) b++;
    return b - a + 1;
  };
  // Center of the widest background run (>= 2 px) inside [a, b], or null.
  const widestRun = (a: number, b: number) => {
    let bestRunStart = -1;
    let bestRunLen = 0;
    let runStart = -1;
    for (let x = a; x <= b + 1; x++) {
      const isLow = x <= b && x < lw && profile[x]! <= low;
      if (isLow && runStart < 0) runStart = x;
      if (!isLow && runStart >= 0) {
        if (x - runStart > bestRunLen) { bestRunLen = x - runStart; bestRunStart = runStart; }
        runStart = -1;
      }
    }
    return bestRunLen >= 2 ? bestRunStart + (bestRunLen >> 1) : null;
  };

  const pieces: InkPiece[] = [];
  let start = 0;
  let midWord = false;
  for (;;) {
    const remaining = lw - start;
    if (remaining <= squashLimit) {
      pieces.push({ from: start, to: lw, midWord });
      break;
    }
    let cut = widestRun(start + Math.round(maxW * 0.55), start + maxW);
    if (cut == null || runWidth(cut) < wordGap) {
      // Only letter gaps here: a word gap a little past maxW beats cutting the word.
      const past = widestRun(start + maxW + 1, Math.min(lw - 1, start + Math.round(maxW * 1.1)));
      if (past != null && runWidth(past) >= wordGap) cut = past;
    }
    if (cut != null) {
      pieces.push({ from: start, to: cut, midWord });
      midWord = runWidth(cut) < wordGap;
      start = cut;
    } else if (remaining <= squashLimit) {
      pieces.push({ from: start, to: lw, midWord });
      break;
    } else {
      // No gap in the window: take a squashed oversized window and search for the next gap beyond it.
      let end = Math.min(lw, start + Math.floor(squashLimit));
      for (let x = end; x >= start + maxW; x--) {
        if (profile[x]! <= low) { end = x; break; }
      }
      pieces.push({ from: start, to: end, midWord });
      midWord = runWidth(end) < wordGap;
      start = end;
    }
    if (start >= lw - 2) break;
  }
  return pieces;
}

export const CJK_EDGE = /[぀-ヿ㐀-䶿一-鿿。、!?」』)]$|^[぀-ヿ㐀-䶿一-鿿「『(]/;

/** Text between two adjacent recognizer windows of one line: none after a mid-word cut or at a CJK edge, else one space. */
export function windowSeparator(before: { text: string }, after: { text: string; midWord: boolean }): string {
  if (after.midWord) return '';
  return CJK_EDGE.test(before.text.slice(-1)) || CJK_EDGE.test(after.text[0] ?? '') ? '' : ' ';
}
