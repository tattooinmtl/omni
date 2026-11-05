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
import crypto from "node:crypto";
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
// Supplementary-plane ideographs (CJK Extensions B–H, U+20000–U+3FFFF) are
// 4-byte sequences F0 A0..BF … . F0 alone also leads emoji (F0 9F …), so only
// the pair is banned: a token carrying F0 followed by A0–BF.
const hasSupplementaryCJK = (bytes) => {
  for (let i = 0; i + 1 < bytes.length; i++) {
    if (bytes[i] === 0xf0 && bytes[i + 1] >= 0xa0 && bytes[i + 1] <= 0xbf) return true;
  }
  return false;
};
// U+3000–U+FFFF and U+20000–U+3FFFF written as text (special/added tokens,
// SentencePiece vocab).
const CJK_TEXT = /[　-￿\u{20000}-\u{3ffff}]/u;

// Byte-fallback tokens in SentencePiece vocabularies: "<0xE4>".
const BYTE_TOKEN = /^<0x([0-9A-Fa-f]{2})>$/;

export function tokenCanStartCJK(token, tokenizerModel = "gpt2") {
  const t = String(token);
  const bt = t.match(BYTE_TOKEN);
  if (bt) return isLeadCJK(parseInt(bt[1], 16));
  if (tokenizerModel === "gpt2") {
    const bytes = [];
    for (const ch of t) {
      const b = U2B.get(ch);
      if (b === undefined) {
        // Not a byte stand-in: a literal character (added/special token).
        if (CJK_TEXT.test(ch)) return true;
        continue;
      }
      if (isLeadCJK(b)) return true;
      bytes.push(b);
    }
    return hasSupplementaryCJK(bytes);
  }
  return CJK_TEXT.test(t);
}

export function cjkTokenIds(tokens, tokenizerModel = "gpt2") {
  const ids = [];
  tokens.forEach((tok, id) => { if (tokenCanStartCJK(tok, tokenizerModel)) ids.push(id); });
  return ids;
}

// The cache key: a hash of the file's first 8 MB (the GGUF header, where the
// vocabulary lives) plus its size, so two different models never share a ban
// list, whatever their names or dates.
function vocabKey(modelPath, size) {
  const fd = fs.openSync(modelPath, "r");
  try {
    const buf = Buffer.alloc(Math.min(size, 8 * 1024 * 1024));
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return crypto.createHash("sha256").update(buf.subarray(0, n)).update(String(size)).digest("hex").slice(0, 32);
  } finally {
    fs.closeSync(fd);
  }
}

// Banned token ids for a GGUF model, cached in `cacheDir` by vocabKey.
// Throws when the vocabulary cannot be read, so the caller can say the guard
// is off instead of silently running without it.
export function cjkBanList(modelPath, { cacheDir } = {}) {
  const stat = fs.statSync(modelPath);
  const cacheFile = cacheDir ? path.join(cacheDir, `cjk-ban-${vocabKey(modelPath, stat.size)}.json`) : null;
  if (cacheFile) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
      if (Array.isArray(cached.ids)) return cached.ids;
    } catch { /* build it */ }
  }
  const meta = readGgufMetadata(modelPath, { keepArrays: ["tokenizer.ggml.tokens"], maxScan: 512 * 1024 * 1024 });
  const tokens = meta.arrays["tokenizer.ggml.tokens"];
  if (!Array.isArray(tokens) || !tokens.length) throw new Error("the GGUF has no tokenizer.ggml.tokens vocabulary");
  const ids = cjkTokenIds(tokens, meta.tokenizerModel || "gpt2");
  if (cacheFile) {
    try {
      fs.mkdirSync(cacheDir, { recursive: true });
      atomicWriteFileSync(cacheFile, JSON.stringify({ model: path.basename(modelPath), ids }));
    } catch { /* cache is optional */ }
  }
  return ids;
}

// llama-server's per-request `logit_bias` accepts [[id, false], …] where
// false means "never sample this token". Checked against b12125 with Spark:
// told to answer in Chinese, it wrote Chinese without this field and none
// with it.
export function logitBiasBody(ids) {
  return ids.map((id) => [id, false]);
}
