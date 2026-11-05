// Language guard: tokens that can start a CJK character are banned, and the
// ban reaches request bodies only for the server that registered it.
// Run directly: node tests/language-guard.test.mjs

import assert from "node:assert/strict";

let pass = 0;
let fail = 0;
async function ok(label, fn) {
  try {
    await fn();
    console.log(`  ✓ ${label}`);
    pass++;
  } catch (err) {
    console.log(`  ✗ ${label}\n      ${err.message}`);
    fail++;
  }
}

// Spell a UTF-8 string the way a GPT-2 byte-level vocabulary stores it.
function gpt2Spell(text) {
  const bs = [];
  for (let b = 0x21; b <= 0x7e; b++) bs.push(b);
  for (let b = 0xa1; b <= 0xac; b++) bs.push(b);
  for (let b = 0xae; b <= 0xff; b++) bs.push(b);
  const cs = bs.slice();
  let n = 0;
  for (let b = 0; b < 256; b++) if (!bs.includes(b)) { bs.push(b); cs.push(256 + n); n++; }
  const map = new Map(bs.map((b, i) => [b, String.fromCodePoint(cs[i])]));
  return [...Buffer.from(text, "utf8")].map((b) => map.get(b)).join("");
}

import fsMod from "node:fs";
import osMod from "node:os";
import pathMod from "node:path";
const await_fs = () => fsMod;
const await_os = () => osMod;
const await_path = () => pathMod;

// A minimal GGUF v3 with only tokenizer.ggml.model and tokenizer.ggml.tokens.
function makeGguf(tokens) {
  const parts = [];
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); parts.push(b); };
  const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); parts.push(b); };
  const str = (s) => { const b = Buffer.from(s, "utf8"); u64(b.length); parts.push(b); };
  parts.push(Buffer.from("GGUF")); u32(3); u64(0); u64(2);
  str("tokenizer.ggml.model"); u32(8); str("gpt2");
  str("tokenizer.ggml.tokens"); u32(9); u32(8); u64(tokens.length);
  for (const t of tokens) str(t);
  return Buffer.concat(parts);
}

async function main() {
  const g = await import("../src/local/language-guard.mjs");
  const x = await import("../src/local/request-extras.mjs");
  const p = await import("../src/core/provider.mjs");

  await ok("Chinese, Japanese, Korean and full-width tokens are banned", () => {
    for (const s of ["你好", "的", "。", "カタカナ", "한국어", "，", " 中文"]) {
      assert.equal(g.tokenCanStartCJK(gpt2Spell(s)), true, s);
    }
  });

  await ok("a lone CJK lead byte is banned, so fragments cannot assemble a character", () => {
    const lead = gpt2Spell("你").slice(0, 1); // byte 0xE4
    assert.equal(g.tokenCanStartCJK(lead), true);
    // continuation bytes alone are harmless once every lead byte is gone
    const cont = gpt2Spell("你").slice(1);
    assert.equal(g.tokenCanStartCJK(cont), false);
  });

  await ok("English, French, punctuation and emoji stay allowed", () => {
    for (const s of ["hello", " été", "français", "ç", "«", "»", "—", "…", "€", "🙂", "\n\n", "<think>", "def foo():"]) {
      assert.equal(g.tokenCanStartCJK(gpt2Spell(s)), false, s);
    }
  });

  await ok("literal CJK in added tokens and SentencePiece byte tokens are caught", () => {
    assert.equal(g.tokenCanStartCJK("<|中文|>"), true);
    assert.equal(g.tokenCanStartCJK("<0xE4>", "llama"), true);
    assert.equal(g.tokenCanStartCJK("<0xC3>", "llama"), false);
    assert.equal(g.tokenCanStartCJK("▁你好", "llama"), true);
    assert.equal(g.tokenCanStartCJK("▁bonjour", "llama"), false);
  });

  await ok("supplementary-plane ideographs are banned, emoji are not", () => {
    assert.equal(g.tokenCanStartCJK(gpt2Spell("𠀀")), true); // U+20000, F0 A0 80 80
    assert.equal(g.tokenCanStartCJK(gpt2Spell("𪚥")), true); // U+2A6A5
    assert.equal(g.tokenCanStartCJK("<|𠀀|>"), true);
    assert.equal(g.tokenCanStartCJK(gpt2Spell("🙂")), false); // F0 9F
    assert.equal(g.tokenCanStartCJK(gpt2Spell("🚀 go")), false);
  });

  await ok("cjkBanList throws on an unreadable vocabulary instead of returning an empty ban", () => {
    const fs = await_fs();
    const os = await_os();
    const path = await_path();
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "omni-guard-")), "broken.gguf");
    fs.writeFileSync(f, "not a gguf");
    assert.throws(() => g.cjkBanList(f), /gguf|bad magic/i);
  });

  await ok("the cache is keyed by file contents: two models with the same name never share a ban list", () => {
    const fs = await_fs();
    const os = await_os();
    const path = await_path();
    const cache = fs.mkdtempSync(path.join(os.tmpdir(), "omni-guard-cache-"));
    const a = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "omni-a-")), "m.gguf");
    const b = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "omni-b-")), "m.gguf");
    fs.writeFileSync(a, makeGguf([gpt2Spell("the"), gpt2Spell("你")]));
    fs.writeFileSync(b, makeGguf([gpt2Spell("你"), gpt2Spell("the")]));
    assert.deepEqual(g.cjkBanList(a, { cacheDir: cache }), [1]);
    assert.deepEqual(g.cjkBanList(b, { cacheDir: cache }), [0]);
    assert.deepEqual(g.cjkBanList(a, { cacheDir: cache }), [1]); // from cache
    assert.equal(fs.readdirSync(cache).length, 2);
  });

  await ok("cjkTokenIds returns the ids of the banned tokens", () => {
    const vocab = [gpt2Spell("the"), gpt2Spell("你"), gpt2Spell(" été"), gpt2Spell("。")];
    assert.deepEqual(g.cjkTokenIds(vocab), [1, 3]);
    assert.deepEqual(g.logitBiasBody([1, 3]), [[1, false], [3, false]]);
  });

  await ok("request extras reach chat bodies for the server that set them, localhost or not", () => {
    x.clearRequestExtras();
    x.setRequestExtras("http://127.0.0.1:8080/v1", { logit_bias: [[5, false]] });
    const model = (baseUrl) => ({ id: "m", key: "local/coder", maxTokens: 10, provider: { baseUrl } });
    const body = p.buildChatBody({ model: model("http://localhost:8080/v1/"), messages: [{ role: "user", content: "hi" }] });
    assert.deepEqual(body.logit_bias, [[5, false]]);
    const other = p.buildChatBody({ model: model("https://api.example.com/v1"), messages: [{ role: "user", content: "hi" }] });
    assert.equal(other.logit_bias, undefined);
    x.clearRequestExtras("http://127.0.0.1:8080/v1");
    const after = p.buildChatBody({ model: model("http://127.0.0.1:8080/v1"), messages: [{ role: "user", content: "hi" }] });
    assert.equal(after.logit_bias, undefined);
  });

  await ok("extras never overwrite a field the caller set", () => {
    x.setRequestExtras("http://127.0.0.1:9/v1", { temperature: 9, logit_bias: [] });
    const body = x.applyRequestExtras({ temperature: 0.2 }, "http://127.0.0.1:9/v1");
    assert.equal(body.temperature, 0.2);
    x.clearRequestExtras();
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main();
