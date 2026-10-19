// Reasoning sent in a separate stream field.
//
// MiniMax-M3.1-Flash (and DeepSeek/OpenRouter-style providers) stream their
// reasoning in delta.reasoning_content, not as <think> tags in delta.content.
// chatStream only read delta.content, so that reasoning was dropped: nothing
// on screen while the model thought, and /thinking last came back empty.
// It is now folded into the same <think>…</think> stream M3 sends inline, so
// the existing splitter, collapse and history-stripping all apply.
//
// Run: node tests/reasoning-stream.test.mjs

import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

let pass = 0, fail = 0;
async function test(label, fn) {
  try { await fn(); console.log(`  PASS ${label}`); pass++; }
  catch (e) { console.log(`  FAIL ${label}\n    ${e.message}`); fail++; }
}

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1"));
const u = (p) => pathToFileURL(path.join(here, "..", "src", p)).href;
const { chatStream } = await import(u("core/provider.mjs"));
const { extractThink } = await import(u("core/toolcalls.mjs"));

// Serve `deltas` as an SSE body from a stubbed fetch.
async function stream(deltas, { usage = true } = {}) {
  const lines = deltas.map((d) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: d.delta || {}, finish_reason: d.finish || null }] })}\n\n`);
  if (usage) lines.push(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 5 } })}\n\n`);
  lines.push("data: [DONE]\n\n");
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(lines.join(""), { status: 200 });
  const tokens = [];
  try {
    const out = await chatStream({
      model: { key: "minimax.io/m3.1-flash", id: "MiniMax-M3.1-Flash", maxTokens: 64, provider: { baseUrl: "https://example.test/v1", apiKey: "k" } },
      messages: [{ role: "user", content: "hi" }],
      onToken: (t) => tokens.push(t),
    });
    return { ...out, streamed: tokens.join("") };
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log("\nreasoning_content stream field:");

await test("reasoning_content is streamed as a <think> block ahead of the answer", async () => {
  const out = await stream([
    { delta: { role: "assistant", reasoning_content: "17*23 " } },
    { delta: { reasoning_content: "= 391" } },
    { delta: { content: "391" } },
    { delta: {}, finish: "stop" },
  ]);
  assert.equal(out.streamed, "<think>17*23 = 391</think>391");
  assert.equal(out.message.content, "<think>17*23 = 391</think>391");
  const { think, rest } = extractThink(out.message.content);
  assert.equal(think.trim(), "17*23 = 391");
  assert.equal(rest, "391");
  assert.equal(out.finishReason, "stop");
  assert.ok(out.usage, "usage chunk still captured");
});

await test("reasoning that ends in a tool call is closed before the call", async () => {
  const out = await stream([
    { delta: { reasoning_content: "need the time" } },
    { delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "get_time", arguments: "{}" } }] } },
    { delta: {}, finish: "tool_calls" },
  ]);
  assert.equal(out.message.content, "<think>need the time</think>");
  assert.equal(out.message.tool_calls[0].function.name, "get_time");
});

await test("a reasoning-only reply is still closed", async () => {
  const out = await stream([{ delta: { reasoning_content: "hmm" } }, { delta: {}, finish: "length" }]);
  assert.equal(out.message.content, "<think>hmm</think>");
});

await test("plain content (and inline <think> from M3) is untouched", async () => {
  const out = await stream([{ delta: { content: "<think>x</think>\n\nok" } }, { delta: {}, finish: "stop" }]);
  assert.equal(out.message.content, "<think>x</think>\n\nok");
  assert.equal(out.streamed, "<think>x</think>\n\nok");
});

await test("an empty reasoning_content field adds no tags", async () => {
  const out = await stream([{ delta: { reasoning_content: "", content: "ok" } }, { delta: {}, finish: "stop" }]);
  assert.equal(out.message.content, "ok");
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
