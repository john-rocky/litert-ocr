// Greedy CTC decoding of the recognizer output (probabilities [T, C], blank = 0, no softmax needed):
// argmax per timestep, collapse repeats, drop blanks. score = mean probability of the emitted tokens.
// Each emitted character keeps its timestep, so word and character boxes can be placed along the line.

export interface CtcChar {
  ch: string;
  prob: number;
  /** Timestep index of the emission. */
  t: number;
}

export interface CtcResult {
  text: string;
  score: number;
  chars: CtcChar[];
  T: number;
}

/**
 * `allowed`: when set, argmax runs over the blank and these class indices only (tessedit_char_whitelist /
 * tessedit_char_blacklist). Without it the result equals plain greedy decoding.
 */
export function ctcDecode(probs: Float32Array, T: number, C: number, chars: string[], allowed: Int32Array | null = null): CtcResult {
  let text = '', prev = -1, sum = 0, n = 0;
  const out: CtcChar[] = [];
  for (let t = 0; t < T; t++) {
    const off = t * C;
    let best = 0, bv = probs[off]!;
    if (allowed) {
      for (let k = 0; k < allowed.length; k++) {
        const c = allowed[k]!;
        const v = probs[off + c]!;
        if (v > bv) { bv = v; best = c; }
      }
    } else {
      for (let c = 1; c < C; c++) {
        const v = probs[off + c]!;
        if (v > bv) { bv = v; best = c; }
      }
    }
    if (best !== 0 && best !== prev) {
      const ch = chars[best]!;
      text += ch;
      sum += bv;
      n++;
      out.push({ ch, prob: bv, t });
    }
    prev = best;
  }
  return { text, score: n ? sum / n : 0, chars: out, T };
}

/** Class indices allowed by a whitelist / blacklist, or null when neither is set. */
export function allowedClasses(chars: string[], whitelist: string | null, blacklist: string | null): Int32Array | null {
  if (!whitelist && !blacklist) return null;
  const white = whitelist ? new Set([...whitelist]) : null;
  const black = blacklist ? new Set([...blacklist]) : null;
  const idx: number[] = [];
  for (let c = 1; c < chars.length; c++) {
    const ch = chars[c]!;
    if (white && !white.has(ch)) continue;
    if (black && black.has(ch)) continue;
    idx.push(c);
  }
  return Int32Array.from(idx);
}
