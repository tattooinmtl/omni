// Language guardrail for local models: stop a model from writing Chinese,
// Japanese or Korean, whatever is in its context.
//
// A prompt rule is not enough. Spark X2.6 drifts into Chinese as the context
// grows past ~12k tokens, when the system prompt's instructions have faded.
// So the guard works at the sampler instead: every vocabulary token whose
// bytes can start a CJK character gets a logit bias of -inf, and the model
// cannot pick it. English, French accents (2-byte UTF-8), punctuation such as
// — … « » (E2 / C2 lead bytes) and emoji (4-byte) are untouched.
//
// Why lead bytes: in UTF-8 every character from U+3000 to U+FFFF is written
// as a 3-byte sequence starting with 0xE3–0xEF. That range holds CJK
// punctuation, kana, all CJK ideographs, Hangul and full-width forms. A
// byte-level BPE model can only produce such a character if some sampled
// token carries its lead byte, so banning every token that contains one closes
// the door completely — including the byte-fallback path where a character is
// assembled from fragments.
//
// The ban list is computed from the GGUF's own vocabulary and cached on disk
// next to the model's mtime/size, so it is built once per model file.

import fs from "node:fs";
import path from "node:path";
import { readGgufMetadata } from "./gguf.mjs";
import { atomicWriteFileSync } from "../core/atomic-write.mjs";

// GPT-2's byte→unicode table, inverted: token strings in a GPT-2 style
// vocabulary spell raw bytes with these printable stand-ins.
function gpt2UnicodeToByte() {
  const bs = [];
  for (let b = 0x21; b <= 0x7e; b++) bs.push(b);
  for (let b = 0xa1; b <= 0xac; b++) bs.push(b);
  for (let b = 0xae; b <= 0xff; b++) bs.push(b);
  const cs = bs.slice();
  let n = 0;
  for (let b = 0; b < 256; b++) {
    if (!bs.includes(b)) { bs.push(b); cs.push(256 + n); n++; }
  }
  const map = new Map();
  bs.forEach((b, i) => map.set(String.fromCodePoint(cs[i]), b));
  return map;
}
const U2B = gpt2UnicodeToByte();

const isLeadCJK = (b) => b >= 0xe3 && b <= 0xef;
// U+3000–U+FFFF written as text (special/added tokens, SentencePiece vocab).
const CJK_TEXT = /[　-￿]/u;

// Byte-fallback tokens in SentencePiece vocabularies: "<0xE4>".
const BYTE_TOKEN = /^<0x([0-9A-Fa-f]{2})>$/;

export function tokenCanStartCJK(token, tokenizerModel = "gpt2") {
  const t = String(token);
  const bt = t.match(BYTE_TOKEN);
  if (bt) return isLeadCJK(parseInt(bt[1], 16));
  if (tokenizerModel === "gpt2") {
    for (const ch of t) {
      const b = U2B.get(ch);
      if (b === undefined) {
        // Not a byte stand-in: a literal character (added/special token).
        if (CJK_TEXT.test(ch)) return true;
        continue;
      }
      if (isLeadCJK(b)) return true;
    }
    return false;
  }
  return CJK_TEXT.test(t);
}

export function cjkTokenIds(tokens, tokenizerModel = "gpt2") {
  const ids = [];
  tokens.forEach((tok, id) => { if (tokenCanStartCJK(tok, tokenizerModel)) ids.push(id); });
  return ids;
}

// Banned token ids for a GGUF model, cached in `cacheDir` keyed by the model's
// name, size and mtime. Returns [] when the vocabulary cannot be read.
export function cjkBanList(modelPath, { cacheDir } = {}) {
  let stat;
  try { stat = fs.statSync(modelPath); } catch { return []; }
  const key = `${path.basename(modelPath)}-${stat.size}-${Math.floor(stat.mtimeMs)}`.replace(/[^\w.-]/g, "_");
  const cacheFile = cacheDir ? path.join(cacheDir, `cjk-ban-${key}.json`) : null;
  if (cacheFile) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
      if (Array.isArray(cached.ids)) return cached.ids;
    } catch { /* build it */ }
  }
  let ids = [];
  try {
    const meta = readGgufMetadata(modelPath, { keepArrays: ["tokenizer.ggml.tokens"], maxScan: 512 * 1024 * 1024 });
    const tokens = meta.arrays["tokenizer.ggml.tokens"] || [];
    ids = cjkTokenIds(tokens, meta.tokenizerModel || "gpt2");
  } catch {
    return [];
  }
  if (cacheFile) {
    try {
      fs.mkdirSync(cacheDir, { recursive: true });
      atomicWriteFileSync(cacheFile, JSON.stringify({ model: path.basename(modelPath), ids }));
    } catch { /* cache is optional */ }
  }
  return ids;
}

// llama-server's per-request `logit_bias` accepts [[id, false], …] where
// false means "never sample this token".
export function logitBiasBody(ids) {
  return ids.map((id) => [id, false]);
}
