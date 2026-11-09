// Token economy: stale tool output is pruned, and the prompt tells the model
// to work in fewer rounds.
//
// Every step resends the whole history, so an old 30k-char tool result is
// paid for again on every later step. Once the context passes a soft budget,
// results older than the last few steps are cut to head + tail, in one sweep
// (not one result per step, which would break provider prompt caching).
//
// Run: node tests/tool-pruning.test.mjs

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

process.env.OMNI_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "omni-prune-home-"));

const { pruneStaleToolResults, maybePruneToolResults, PRUNED_MARKER, DEFAULT_PRUNE_AT_TOKENS, estimateTokens, runTurn, systemPrompt } = await import(u("src/core/agent.mjs"));
const { resolveModel } = await import(u("src/core/config.mjs"));
const { startMockProvider, mockSettings, MockSession } = await import(u("tests/_mock-provider.mjs"));

const big = (i, n = 6000) => `HEAD-${i} ` + "x".repeat(n) + ` TAIL-${i}`;

// `turns` tool steps, each an assistant call + its result, then a final answer.
function history(turns, size = 6000) {
  const msgs = [{ role: "system", content: "SYSTEM" }, { role: "user", content: "audit the repo" }];
  for (let i = 0; i < turns; i++) {
    msgs.push({ role: "assistant", content: "", tool_calls: [{ id: `c${i}`, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: `f${i}.js` }) } }] });
    msgs.push({ role: "tool", tool_call_id: `c${i}`, name: "read_file", content: big(i, size) });
  }
  return msgs;
}
const toolMsgs = (msgs) => msgs.filter((m) => m.role === "tool");

await ok("old tool results are cut to head + tail; the last 4 steps are untouched", () => {
  const msgs = history(8);
  const r = pruneStaleToolResults(msgs);
  const tools = toolMsgs(msgs);
  assert.equal(r.pruned, 4);
  for (const t of tools.slice(0, 4)) {
    assert.ok(t.content.includes(PRUNED_MARKER), "old result pruned");
    assert.ok(t.content.length < 2000, "and much shorter");
    assert.match(t.content, /^HEAD-\d/, "keeps the head");
    assert.match(t.content, /TAIL-\d$/, "keeps the tail");
    assert.match(t.content, /run the tool again/, "tells the model how to get it back");
  }
  for (const t of tools.slice(4)) assert.ok(!t.content.includes(PRUNED_MARKER), "recent result kept whole");
  assert.ok(r.savedChars > 4 * 4000, `saved ${r.savedChars}`);
});

await ok("short results are kept, and pruning twice changes nothing", () => {
  const msgs = history(8);
  msgs[3].content = "short output";
  pruneStaleToolResults(msgs);
  assert.equal(msgs[3].content, "short output");
  const snapshot = JSON.stringify(msgs);
  assert.equal(pruneStaleToolResults(msgs).pruned, 0);
  assert.equal(JSON.stringify(msgs), snapshot, "idempotent, so the cached prefix stays stable");
});

await ok("image (multipart) tool results are left alone", () => {
  const msgs = history(8);
  msgs[3].content = [{ type: "text", text: "x".repeat(5000) }];
  pruneStaleToolResults(msgs);
  assert.ok(Array.isArray(msgs[3].content));
});

const model = { contextWindow: 200000, maxTokens: 8000 };

await ok("nothing is pruned below the budget", () => {
  const msgs = history(8);
  const session = new MockSession();
  session.contextTokens = DEFAULT_PRUNE_AT_TOKENS - 1;
  assert.equal(maybePruneToolResults({ model, settings: {}, messages: msgs, session }), null);
  assert.equal(toolMsgs(msgs).filter((t) => t.content.includes(PRUNED_MARKER)).length, 0);
});

await ok("over the budget it prunes in one sweep, then waits for the context to regrow", () => {
  const msgs = history(8);
  const session = new MockSession();
  session.contextTokens = DEFAULT_PRUNE_AT_TOKENS + 5000;
  const r = maybePruneToolResults({ model, settings: {}, messages: msgs, session });
  assert.equal(r.pruned, 4);
  assert.ok(r.after < r.before);
  assert.equal(session.contextTokens, r.after, "context count updated");
  // One more step ages another result, but the history barely grew: no rewrite.
  msgs.push({ role: "assistant", content: "", tool_calls: [{ id: "c8", type: "function", function: { name: "read_file", arguments: "{}" } }] });
  msgs.push({ role: "tool", tool_call_id: "c8", name: "read_file", content: big(8) });
  session.contextTokens = DEFAULT_PRUNE_AT_TOKENS + 6000;
  assert.equal(maybePruneToolResults({ model, settings: {}, messages: msgs, session }), null);
  assert.ok(!toolMsgs(msgs)[4].content.includes(PRUNED_MARKER), "the newly aged result waits for the next sweep");
  // Once it regrows by a quarter of the budget, the next sweep runs.
  for (let i = 9; i < 20; i++) {
    msgs.push({ role: "assistant", content: "", tool_calls: [{ id: `c${i}`, type: "function", function: { name: "read_file", arguments: "{}" } }] });
    msgs.push({ role: "tool", tool_call_id: `c${i}`, name: "read_file", content: big(i) });
  }
  session.contextTokens = DEFAULT_PRUNE_AT_TOKENS + 20000;
  const r2 = maybePruneToolResults({ model, settings: {}, messages: msgs, session });
  assert.ok(r2 && r2.pruned > 0);
  assert.ok(toolMsgs(msgs)[4].content.includes(PRUNED_MARKER));
});

await ok("settings: pruneToolResults false turns it off, pruneAtTokens moves the budget", () => {
  const session = new MockSession();
  session.contextTokens = 500000;
  assert.equal(maybePruneToolResults({ model, settings: { compaction: { pruneToolResults: false } }, messages: history(8), session }), null);
  const s2 = new MockSession();
  s2.contextTokens = 3000;
  assert.ok(maybePruneToolResults({ model, settings: { compaction: { pruneAtTokens: 2000 } }, messages: history(8), session: s2 }));
});

await ok("a small window prunes at half its usable size", () => {
  const session = new MockSession();
  session.contextTokens = 9000; // under 48k, over half of a 16k window
  assert.ok(maybePruneToolResults({ model: { contextWindow: 16384, maxTokens: 512 }, settings: {}, messages: history(8), session }));
});

await ok("after a compaction shrinks the history, pruning re-arms", () => {
  const session = new MockSession();
  session.toolPruneMark = 999999;
  session.contextTokens = DEFAULT_PRUNE_AT_TOKENS + 1;
  assert.ok(maybePruneToolResults({ model, settings: {}, messages: history(8), session }));
});

await ok("runTurn sends the pruned history to the provider", async () => {
  const mock = await startMockProvider(["done"]);
  try {
    const settings = mockSettings(mock.baseUrl, { compaction: { pruneAtTokens: 1000, mode: "mechanical" } });
    const m = resolveModel(settings, "mock/main");
    const msgs = history(8, 3000);
    const session = new MockSession();
    const out = await runTurn({ model: m, settings, messages: msgs, session, maxIterations: 2, diffPreview: false });
    assert.ok(out.stop !== "error", out.error);
    const sent = mock.requests[0].messages.filter((x) => x.role === "tool");
    assert.equal(sent.length, 8);
    assert.equal(sent.filter((x) => x.content.includes(PRUNED_MARKER)).length, 4);
    assert.ok(estimateTokens(mock.requests[0].messages) < estimateTokens(history(8, 3000)));
  } finally {
    await mock.close();
  }
});

await ok("the prompt tells the model to batch calls and scale the workflow", () => {
  for (const [name, text] of [["built-in", systemPrompt()], ["prompts/default.md", fs.readFileSync(path.join(root, "prompts", "default.md"), "utf8")]].map(([n, t]) => [n, t.replace(/\s+/g, " ")])) {
    assert.match(text, /# Tool economy/, `${name}: has the section`);
    assert.match(text, /in ONE response/, `${name}: batch independent calls`);
    assert.match(text, /scaled to the size of the task/, `${name}: small tasks get a small workflow`);
    assert.match(text, /never repeat the same search, read, or command/, `${name}: no repeats`);
    assert.ok(!/Read-only tools are always fine to use freely/.test(text), `${name}: no open invitation to explore`);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
