// Regression tests for the v3.1.1 audit fixes.
//
//   #1 fileLockKey covers edit_lines (same-path edit_lines calls serialize)
//   #2 find_skill uses rankChunks' r.index (no O(N²) haystack indexOf, works
//      correctly when two skills share an identical haystack string)
//   #4 invoke_skill loads the body ephemerally into the live conversation
//   #6 buildChatBody strips `name` from role:"tool" messages on the native
//      path — the field is a harness affordance for the text-tool renderer
//      and isn't part of the OpenAI chat.completions spec.
//
// Run: node tests/v311-fixes.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

let pass = 0, fail = 0;
async function ok(label, fn) {
  try { await fn(); console.log(`  PASS ${label}`); pass++; }
  catch (e) { console.log(`  FAIL ${label}\n    ${e.message}`); fail++; }
}

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1"));
const root = path.join(here, "..");
const u = (p) => pathToFileURL(path.join(root, "src", p)).href;

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "omni-v311-"));
process.env.OMNI_HOME = tmpHome;

const { fileLockKey } = await import(u("core/agent.mjs"));
const { buildChatBody } = await import(u("core/provider.mjs"));
const tools = await import(u("tools/index.mjs"));
const { isEphemeralSkill } = await import(u("cli/helpers.mjs"));

// -- #1 ---------------------------------------------------------------------

await ok("fileLockKey serializes edit_lines against the same path", () => {
  const k1 = fileLockKey("edit_lines", { path: "src/foo.js", start_line: 1, end_line: 5, new_string: "x" });
  const k2 = fileLockKey("edit_lines", { path: "src/foo.js", start_line: 10, end_line: 12, new_string: "y" });
  const k3 = fileLockKey("edit_lines", { path: "src/bar.js", start_line: 1, end_line: 5, new_string: "x" });
  assert.equal(k1, "src/foo.js");
  assert.equal(k1, k2, "same path must produce same lock key so the two edits serialize");
  assert.notEqual(k1, k3, "different paths must produce different lock keys");
  assert.equal(fileLockKey("edit_lines", null), null, "no args → no lock");
});

// -- #2 + #4 ----------------------------------------------------------------

await ok("find_skill uses rankChunks' r.index and returns the right skill for a query", () => {
  const fakeSkills = [
    { command: "/code-review", description: "review code for bugs and style", body: "b1", category: "Code Review" },
    { command: "/html-game-builder", description: "build tiny html canvas games", body: "b2", category: "Html Game Builder" },
    { command: "/dupe", description: "same description as another", body: "b3", category: "X" },
    { command: "/dupe", description: "same description as another", body: "b4", category: "X" },
  ];
  tools.setSessionCtx({ skills: fakeSkills, messages: [] });
  const out = tools.impl.find_skill({ query: "html canvas game" });
  assert.ok(out.includes("/html-game-builder"), `expected /html-game-builder in results:\n${out}`);
  // Empty session context — degrades gracefully instead of throwing.
  tools.setSessionCtx({ skills: [], messages: [] });
  const empty = tools.impl.find_skill({ query: "anything" });
  assert.ok(empty.startsWith("(no skills"), `expected empty-catalog fallback, got: ${empty}`);
});

await ok("invoke_skill pushes an ephemeral system message into the live conversation", () => {
  const messages = [{ role: "system", content: "base" }];
  const skills = [
    { command: "/foo", name: "foo", description: "d", body: "FOO BODY HERE" },
  ];
  tools.setSessionCtx({ skills, messages });
  const r1 = tools.impl.invoke_skill({ command: "/foo" });
  assert.ok(r1.startsWith("Loaded skill"), `expected success string, got: ${r1}`);
  assert.equal(messages.length, 2);
  assert.equal(messages[1].role, "system");
  assert.ok(messages[1].content.includes("FOO BODY HERE"));
  assert.ok(isEphemeralSkill(messages[1]), "invoke_skill's message must be ephemeral so REPL evicts it after the turn");

  // Missing leading slash still works.
  const r2 = tools.impl.invoke_skill({ command: "foo", args: "some args" });
  assert.ok(r2.includes("some args"));
  assert.equal(messages.length, 3);

  // Unknown command returns a friendly error, not a throw.
  const r3 = tools.impl.invoke_skill({ command: "/does-not-exist" });
  assert.ok(r3.startsWith("unknown skill"), `expected unknown-skill message, got: ${r3}`);
  assert.equal(messages.length, 3, "unknown skill must NOT push a system message");
});

// -- #6 ---------------------------------------------------------------------

await ok("buildChatBody strips `name` from role:'tool' messages on the native path", () => {
  const model = {
    id: "test-model",
    maxTokens: 1024,
    provider: { nativeTools: true },
  };
  const messages = [
    { role: "user", content: "hi" },
    { role: "assistant", tool_calls: [{ id: "c1", function: { name: "grep", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", name: "grep", content: "hits: 3" },
  ];
  const body = buildChatBody({ model, messages, tools: [] });
  const toolMsg = body.messages.find((m) => m.role === "tool");
  assert.ok(toolMsg, "expected tool message to survive");
  assert.equal(toolMsg.name, undefined, `name field must be stripped for OpenAI spec compliance — got: ${toolMsg.name}`);
  assert.equal(toolMsg.tool_call_id, "c1");
  assert.equal(toolMsg.content, "hits: 3");
  // In-memory message is untouched (renderer still reads name upstream).
  assert.equal(messages[2].name, "grep");
});

await ok("buildChatBody's text-tool path renders name into the flattened content", () => {
  const model = {
    id: "test-model",
    maxTokens: 1024,
    provider: {},
    nativeTools: false,
  };
  const messages = [
    { role: "tool", tool_call_id: "c1", name: "grep", content: "hits: 3" },
  ];
  const body = buildChatBody({ model, messages, tools: [] });
  const flat = body.messages[0];
  assert.equal(flat.role, "user");
  assert.ok(flat.content.includes("(grep)"), `expected 'Tool result (grep):' label, got: ${flat.content}`);
});

fs.rmSync(tmpHome, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
