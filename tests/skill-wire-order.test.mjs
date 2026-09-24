// Regression: "/rust" → the model calls invoke_skill → "Provider 400 Bad
// Request: invalid params, 400 (2013)" from MiniMax.
//
// invoke_skill ran while the model's tool call was in flight and appended the
// skill body as a system message, so the next request carried
//   assistant(tool_calls) → system(skill) → tool(result)
// — a system message wedged between a tool call and its result, which strict
// OpenAI-compatible providers reject. Separately, skill/goal system messages
// deep in the history trip providers that only accept system at the top.
//
// Run: node tests/skill-wire-order.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.OMNI_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "omni-skill-wire-"));

const { buildChatBody, hoistSystemMessages } = await import("../src/core/provider.mjs");
const tools = await import("../src/tools/index.mjs");
const { applySkill, isEphemeralSkill, evictEphemeralSkillMessages } = await import("../src/cli/helpers.mjs");

let pass = 0;
let fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n    ${e.message}`); fail++; }
}

// What an OpenAI-compatible validator insists on.
function assertValidWire(msgs) {
  msgs.forEach((m, i) => {
    if (m.role === "system") assert.equal(i, 0, `system message at index ${i} (only index 0 allowed)`);
    if (m.role === "tool") {
      const prev = msgs[i - 1];
      assert.ok(
        prev && (prev.role === "tool" || (prev.role === "assistant" && prev.tool_calls?.length)),
        `tool message at ${i} must directly follow the assistant tool_calls (got ${prev?.role})`,
      );
    }
  });
}

const model = { id: "MiniMax-M3", maxTokens: 4096, provider: { apiKey: "k" } };
const skill = { name: "rust-coding", command: "/rust-coding", description: "rust", body: "RUST SKILL BODY" };

console.log("\n[skill-wire-order]");

await test("the /rust → invoke_skill sequence produces a valid request", async () => {
  const messages = [{ role: "system", content: "base prompt" }];
  const session = { append: async () => {} };
  await applySkill(skill, "", messages, session);          // user typed /rust-coding
  tools.setSessionCtx({ skills: [skill], messages });
  // The model answers with a tool call...
  const call = { id: "call_1", type: "function", function: { name: "invoke_skill", arguments: '{"command":"/rust-coding"}' } };
  messages.push({ role: "assistant", content: "", tool_calls: [call] });
  // ...the tool runs while that call is in flight...
  const result = tools.impl.invoke_skill({ command: "/rust-coding" });
  assert.match(result, /Loaded skill "rust-coding"/);
  // ...and the agent loop appends the result.
  messages.push({ role: "tool", tool_call_id: "call_1", name: "invoke_skill", content: result });

  // In memory: the tool result directly follows its call.
  const callIdx = messages.findIndex((m) => m.tool_calls);
  assert.equal(messages[callIdx + 1].role, "tool", "invoke_skill must not land between a tool call and its result");

  const body = buildChatBody({ model, messages, tools: [] });
  assertValidWire(body.messages);
  assert.equal(body.messages.filter((m) => m.role === "system").length, 1);
  assert.match(body.messages[0].content, /base prompt[\s\S]*RUST SKILL BODY/);
});

await test("invoke_skill's message is still ephemeral and still evicted after the turn", () => {
  const messages = [{ role: "system", content: "base" }, { role: "user", content: "hi" }];
  tools.setSessionCtx({ skills: [skill], messages });
  messages.push({ role: "assistant", content: "", tool_calls: [{ id: "c", function: { name: "invoke_skill", arguments: "{}" } }] });
  tools.impl.invoke_skill({ command: "rust-coding" });
  const sys = messages.find((m) => m.role === "system" && /RUST SKILL BODY/.test(m.content));
  assert.ok(sys && isEphemeralSkill(sys));
  assert.equal(evictEphemeralSkillMessages(messages), 1);
  assert.ok(!messages.some((m) => /RUST SKILL BODY/.test(String(m.content))));
});

await test("goal / expand-skill system notes deep in history are hoisted to the top", () => {
  const messages = [
    { role: "system", content: "base" },
    { role: "user", content: "a" },
    { role: "assistant", content: "b" },
    { role: "system", content: "GOAL DIRECTIVE" },
    { role: "user", content: "c" },
  ];
  const wire = hoistSystemMessages(messages);
  assertValidWire(wire);
  assert.deepEqual(wire.map((m) => m.role), ["system", "user", "assistant", "user"]);
  assert.equal(wire[0].content, "base\n\nGOAL DIRECTIVE");
  assert.equal(messages.length, 5, "the in-memory list must not be mutated");
});

await test("a history with one leading system message is passed through as-is", () => {
  const messages = [{ role: "system", content: "base" }, { role: "user", content: "hi" }];
  assert.equal(hoistSystemMessages(messages), messages);
  const none = [{ role: "user", content: "hi" }];
  assert.equal(hoistSystemMessages(none), none);
});

await test("the text-tool path gets the same single leading system message", () => {
  const messages = [
    { role: "system", content: "base" },
    { role: "user", content: "hi" },
    { role: "system", content: "SKILL" },
  ];
  const body = buildChatBody({ model: { ...model, nativeTools: false }, messages, tools: [] });
  assert.deepEqual(body.messages.map((m) => m.role), ["system", "user"]);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
