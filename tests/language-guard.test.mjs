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
