// Forge digest compaction (core/compaction.mjs).
//
// Compaction used to keep only the first request and a list of tool calls,
// so every decision and finding in the dropped turns was lost. It now asks a
// model (optionally a cheaper one, settings.compaction.model) for a structured
// summary, and falls back to the old digest when it can't get one.
//
// Run: node tests/compaction.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

let pass = 0, fail = 0;
async function ok(label, fn) {
  try { await fn(); console.log(`  PASS ${label}`); pass++; }
  catch (e) { console.log(`  FAIL ${label}\n    ${e.stack || e.message}`); fail++; }
}

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1"));
const root = path.join(here, "..");
const u = (p) => pathToFileURL(path.join(root, p)).href;

process.env.OMNI_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "omni-compact-home-"));

const {
  forgeCompact, planCompaction, mechanicalDigest, renderTranscript, pickSummarizer, COMPACTED_MARKER, SUMMARY_HEADINGS,
} = await import(u("src/core/compaction.mjs"));
const { compactMessages, runTurn } = await import(u("src/core/agent.mjs"));
const { resolveModel } = await import(u("src/core/config.mjs"));
const { registerHook, clearHooks } = await import(u("src/core/hooks.mjs"));
const { startMockProvider, mockSettings, MockSession } = await import(u("tests/_mock-provider.mjs"));

// A realistic history: request, tool call + result, a decision, more work.
function history(turns = 6) {
  const msgs = [{ role: "system", content: "SYSTEM" }, { role: "user", content: "migrate the fetch() calls to apiClient" }];
  for (let i = 0; i < turns; i++) {
    msgs.push({ role: "assistant", content: `step ${i}: decided to keep retries at 3`, tool_calls: [{ id: `c${i}`, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: `src/file${i}.js` }) } }] });
    msgs.push({ role: "tool", tool_call_id: `c${i}`, name: "read_file", content: `1: contents of file${i}\n2: more` });
  }
  msgs.push({ role: "assistant", content: "latest answer" });
  return msgs;
}

const SUMMARY = SUMMARY_HEADINGS.map((h) => `## ${h}\n- detail for ${h}`).join("\n") + "\nRetries stay at 3 because the user asked.";

await ok("planCompaction keeps the system prompt and never orphans a tool result", () => {
  const msgs = history();
  const plan = planCompaction(msgs, 2);
  assert.equal(plan.first, 1);
  assert.notEqual(msgs[plan.cut].role, "tool");
  assert.equal(planCompaction(history(1), 8), null, "too short to compact");
});

await ok("compactMessages (mechanical) still works and skips an older digest as the 'original request'", () => {
  const msgs = history();
  msgs.splice(1, 0, { role: "user", content: `${COMPACTED_MARKER} old digest` });
  assert.equal(compactMessages(msgs, { keepTail: 2 }), true);
  assert.match(msgs[1].content, /Original request: migrate the fetch\(\) calls/);
  assert.match(msgs[1].content, /read_file \(src\/file0\.js\) -> 1: contents of file0/);
});

await ok("forge digest replaces the span with the model's summary plus the tool list", async () => {
  const msgs = history();
  const model = { key: "x/main", provider: { baseUrl: "https://example.invalid/v1" }, maxTokens: 1000 };
  let seen = null;
  const r = await forgeCompact(msgs, {
    model, keepTail: 2, sessionGoal: "migrate fetch", focus: "the retry policy",
    complete: async ({ model: m, messages }) => { seen = { m, messages }; return SUMMARY; },
  });
  assert.equal(r.done, true);
  assert.equal(r.mode, "forge");
  assert.equal(r.summarizer, "x/main");
  assert.equal(msgs[0].content, "SYSTEM");
  assert.match(msgs[1].content, /forge digest/);
  assert.match(msgs[1].content, /## Decisions and constraints/);
  assert.match(msgs[1].content, /Tool calls in the summarized part/);
  assert.equal(msgs.length, 3, "system + digest + the last answer (the tool result before it cannot open the tail)");
  assert.equal(msgs[2].content, "latest answer");
  // The summarizer saw the transcript, the goal and the focus.
  const prompt = seen.messages[1].content;
  assert.match(prompt, /Session goal: migrate fetch/);
  assert.match(prompt, /Keep extra detail about: the retry policy/);
  assert.match(prompt, /decided to keep retries at 3/);
  assert.match(seen.messages[0].content, /## Goal/);
});

await ok("a failed or empty summary falls back to the mechanical digest and says why", async () => {
  const model = { key: "x/main", provider: { baseUrl: "https://example.invalid/v1" } };
  let msgs = history();
  let r = await forgeCompact(msgs, { model, keepTail: 2, complete: async () => { throw new Error("503 overloaded"); } });
  assert.equal(r.mode, "mechanical");
  assert.match(r.error, /503 overloaded/);
  assert.match(msgs[1].content, /Original request/);
  msgs = history();
  r = await forgeCompact(msgs, { model, keepTail: 2, complete: async () => "" });
  assert.equal(r.mode, "mechanical");
  assert.match(r.error, /empty/);
});

await ok("local models default to the mechanical digest unless compaction.model is set", () => {
  const local = { key: "local/qwen", providerName: "local", provider: { baseUrl: "http://127.0.0.1:8080/v1" } };
  assert.equal(pickSummarizer(local, {}), null);
  const cloud = { key: "x/main", providerName: "x", provider: { baseUrl: "https://api.example.com/v1" } };
  assert.equal(pickSummarizer(cloud, {}), cloud);
  assert.equal(pickSummarizer(cloud, { compaction: { mode: "mechanical" } }), null);
  const settings = mockSettings("https://api.example.com/v1", { compaction: { model: "mock/cheap" } });
  assert.equal(pickSummarizer(local, settings).key, "mock/cheap");
  assert.equal(pickSummarizer(local, { ...settings, compaction: { model: "no/such" } }), null);
});

await ok("a PreCompact hook can cancel, or add focus for the summary", async () => {
  const model = { key: "x/main", provider: { baseUrl: "https://example.invalid/v1" } };
  clearHooks();
  registerHook({ event: "PreCompact", fn: (p) => (p.trigger === "auto" ? { decision: "deny", reason: "not during a deploy" } : "keep the migration checklist") , name: "guard" });
  let msgs = history();
  let r = await forgeCompact(msgs, { model, keepTail: 2, trigger: "auto", complete: async () => SUMMARY });
  assert.equal(r.done, false);
  assert.match(r.reason, /cancelled by hook guard: not during a deploy/);
  assert.equal(msgs.length, history().length, "nothing was dropped");
  let prompt = "";
  msgs = history();
  r = await forgeCompact(msgs, { model, keepTail: 2, trigger: "manual", complete: async ({ messages }) => { prompt = messages[1].content; return SUMMARY; } });
  assert.equal(r.done, true);
  assert.match(prompt, /keep the migration checklist/);
  clearHooks();
});

await ok("the transcript keeps the start and the end when the history is huge", () => {
  const msgs = [{ role: "user", content: "FIRST-REQUEST" }];
  for (let i = 0; i < 200; i++) msgs.push({ role: "assistant", content: "x".repeat(1000) });
  msgs.push({ role: "assistant", content: "LATEST-STEP" });
  const t = renderTranscript(msgs);
  assert.ok(t.length <= 48100);
  assert.match(t, /FIRST-REQUEST/);
  assert.match(t, /LATEST-STEP/);
  assert.match(t, /middle of the history omitted/);
});

await ok("runTurn auto-compacts near the window using the configured cheap model over the wire", async () => {
  const mock = await startMockProvider();
  try {
    const settings = mockSettings(mock.baseUrl, { compaction: { model: "mock/cheap" } });
    const model = { ...resolveModel(settings, "mock/main"), contextWindow: 4000, maxTokens: 500 };
    // First request is the summarizer (cheap model), then the main answer.
    mock.push((body) => (body.model === "cheap-model" ? SUMMARY : "wrong model"), "continuing the work");
    const msgs = history(12);
    for (const m of msgs) if (m.role === "tool") m.content += "y".repeat(1200);
    const session = new MockSession();
    await runTurn({ model, settings, messages: msgs, session, maxIterations: 2, diffPreview: false });
    assert.equal(mock.requests[0].model, "cheap-model");
    assert.ok(!mock.requests[0].tools, "the summarizer gets no tools");
    assert.equal(mock.requests[1].model, "main-model");
    assert.ok(msgs.some((m) => m.role === "user" && /forge digest/.test(m.content) && /## Still open/.test(m.content)));
    assert.equal(msgs[msgs.length - 1].content, "continuing the work");
  } finally {
    await mock.close();
  }
});

await ok("/compact takes 'now' and a focus", async () => {
  const { findCommand } = await import(u("src/cli/commands.mjs"));
  const cmd = findCommand("compact");
  const msgs = history();
  const ctx = {
    messages: msgs, settings: { compaction: { mode: "mechanical" } },
    model: { key: "x/main", provider: { baseUrl: "https://example.invalid/v1" } },
    session: { file: null, setContextTokens() {} },
  };
  await cmd.handler(ctx, "now keep the API shapes");
  assert.equal(msgs.length, 3, "system + digest + the last answer (the tool result before it cannot open the tail)");
  assert.equal(msgs[2].content, "latest answer");
  assert.match(msgs[1].content, new RegExp(COMPACTED_MARKER.replace(/[[\]]/g, "\\$&")));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
