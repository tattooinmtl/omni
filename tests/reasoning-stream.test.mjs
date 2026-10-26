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
const { chatStream, buildChatBody } = await import(u("core/provider.mjs"));
const { extractThink } = await import(u("core/toolcalls.mjs"));

// Serve `deltas` as an SSE body from a stubbed fetch.
async function stream(deltas, { usage = true, provider = { baseUrl: "https://example.test/v1", apiKey: "k" } } = {}) {
  const lines = deltas.map((d) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: d.delta || {}, finish_reason: d.finish || null }] })}\n\n`);
  if (usage) lines.push(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 5 } })}\n\n`);
  lines.push("data: [DONE]\n\n");
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(lines.join(""), { status: 200 });
  const tokens = [];
  try {
    const out = await chatStream({
      model: { key: "minimax.io/m3.1-flash", id: "MiniMax-M3.1-Flash", maxTokens: 64, provider },
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

console.log("\nreasoning echoed back to the provider:");

// Reflection's Beam rejects a request whose earlier assistant messages lost
// their reasoning: "Missing required parameter: 'messages[2].reasoning_content'.
// This model needs the reasoning of every earlier assistant message." The
// harness folds the reasoning into <think> tags for display and strips them
// from the stored content, so the raw text has to be kept somewhere.

await test("the raw reasoning is kept on the message, without the <think> tags", async () => {
  const out = await stream([
    { delta: { role: "assistant", reasoning_content: "17*23 " } },
    { delta: { reasoning_content: "= 391" } },
    { delta: { content: "391" } },
    { delta: {}, finish: "stop" },
  ]);
  assert.equal(out.message.reasoning_content, "17*23 = 391");
  // The tags still ride in the content for the display splitter.
  assert.equal(out.message.content, "<think>17*23 = 391</think>391");
});

await test("a reply that ends in a tool call still keeps its reasoning", async () => {
  const out = await stream([
    { delta: { reasoning_content: "need the time" } },
    { delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "get_time", arguments: "{}" } }] } },
    { delta: {}, finish: "tool_calls" },
  ]);
  assert.equal(out.message.reasoning_content, "need the time");
});

await test("a reply with no reasoning carries no reasoning field", async () => {
  const out = await stream([{ delta: { content: "ok" } }, { delta: {}, finish: "stop" }]);
  assert.equal(out.message.reasoning_content, undefined);
});

const history = [
  { role: "user", content: "hi" },
  { role: "assistant", content: "391", reasoning_content: "17*23 = 391" },
];

await test("a provider that echoes reasoning gets it back on the wire", () => {
  const body = buildChatBody({
    model: { id: "Beam-1.0-501B-A23B", maxTokens: 64, provider: { baseUrl: "https://x.test/v1", apiKey: "k", echoReasoning: true } },
    messages: history,
  });
  assert.equal(body.messages[1].reasoning_content, "17*23 = 391");
});

await test("every other provider has it stripped before the request leaves", () => {
  const body = buildChatBody({
    model: { id: "gpt-4.1", maxTokens: 64, provider: { baseUrl: "https://x.test/v1", apiKey: "k" } },
    messages: history,
  });
  assert.equal(body.messages[1].reasoning_content, undefined);
  assert.equal(body.messages[1].content, "391");
  assert.ok(!JSON.stringify(body).includes("reasoning_content"),
    "reasoning_content leaked into another provider's request");
});

await test("the strip never touches a user or tool message", () => {
  const body = buildChatBody({
    model: { id: "gpt-4.1", maxTokens: 64, provider: { baseUrl: "https://x.test/v1", apiKey: "k" } },
    messages: [
      { role: "user", content: "hi" },
      { role: "tool", tool_call_id: "c1", content: "42" },
    ],
  });
  assert.equal(body.messages.length, 2);
  assert.equal(body.messages[1].content, "42");
});

// A reply with no reasoning at all is a dead end for a provider that needs
// it: an empty string does not satisfy the requirement either (measured
// against api.reflection.ai), so the provider would answer with a bare
// "missing required parameter" 400. Say what is wrong instead.
const echoProvider = { baseUrl: "https://x.test/v1", apiKey: "k", echoReasoning: true, label: "Reflection AI" };

await test("a provider that echoes reasoning refuses a reply that has none", () => {
  assert.throws(
    () => buildChatBody({
      model: { id: "Beam-1.0-501B-A23B", maxTokens: 64, provider: echoProvider },
      messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "391" }],
    }),
    /needs the reasoning of every earlier assistant message/,
  );
});

await test("an empty reasoning_content does not satisfy the requirement either", () => {
  assert.throws(
    () => buildChatBody({
      model: { id: "Beam-1.0-501B-A23B", maxTokens: 64, provider: echoProvider },
      messages: [{ role: "assistant", content: "391", reasoning_content: "" }],
    }),
    /needs the reasoning of every earlier assistant message/,
  );
});

await test("the refusal names the way out", () => {
  assert.throws(
    () => buildChatBody({
      model: { id: "Beam-1.0-501B-A23B", maxTokens: 64, provider: echoProvider },
      messages: [{ role: "assistant", content: "391" }],
    }),
    /\/clear/,
  );
});

// With nativeTools off, an assistant tool-call message is rebuilt as plain
// text; the rebuild must not drop the reasoning, or every tool turn would
// trip the refusal above and /clear would not get the user out of it.
await test("a text-tools provider keeps the reasoning of a flattened tool call", () => {
  const body = buildChatBody({
    model: { id: "Beam-1.0-501B-A23B", maxTokens: 64, nativeTools: false, provider: echoProvider },
    messages: [
      { role: "user", content: "time?" },
      { role: "assistant", content: "", reasoning_content: "need the time",
        tool_calls: [{ id: "c1", type: "function", function: { name: "get_time", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: "12:00" },
    ],
  });
  assert.equal(body.messages[1].reasoning_content, "need the time");
  assert.equal(body.messages[1].tool_calls, undefined);
});

await test("a text-tools provider without the echo still has it stripped", () => {
  const body = buildChatBody({
    model: { id: "gpt-4.1", maxTokens: 64, nativeTools: false, provider: { baseUrl: "https://x.test/v1", apiKey: "k" } },
    messages: [
      { role: "assistant", content: "", reasoning_content: "r",
        tool_calls: [{ id: "c1", type: "function", function: { name: "t", arguments: "{}" } }] },
    ],
  });
  assert.ok(!JSON.stringify(body).includes("reasoning_content"));
});

await test("other providers are unaffected by a reply without reasoning", () => {
  const body = buildChatBody({
    model: { id: "gpt-4.1", maxTokens: 64, provider: { baseUrl: "https://x.test/v1", apiKey: "k" } },
    messages: [{ role: "assistant", content: "391" }],
  });
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].content, "391");
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
