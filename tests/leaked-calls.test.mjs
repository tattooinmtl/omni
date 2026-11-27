// A tool call that comes back as text on a native-tools provider runs, and a
// 1M-token window no longer means "never compact".
//
// The bugs this pins (2026-11-27, a three-day tower-defense session on
// minimax.io/m3.1-flash):
//   - MiniMax's tool parser misfired and the reply's content was the raw
//     call, "]<]minimax[>[<invoke name="run_shell">]<]minimax[>[<command>…".
//     Omni only parses text calls on text-tool providers, so the turn ended
//     on that text as if it were the answer, and the build never ran.
//   - Auto-compaction waited for 85% of the window. With a 1M window that is
//     ~850k tokens, so the session never compacted: every step re-sent ~300k
//     tokens (149M prompt tokens over 696 steps) and the model lost the thread.
//
// Run: node tests/leaked-calls.test.mjs

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omni-leak-"));
process.env.OMNI_HOME = path.join(tmp, "home");
fs.mkdirSync(process.env.OMNI_HOME, { recursive: true });
fs.writeFileSync(path.join(process.env.OMNI_HOME, "settings.json"), JSON.stringify({ memory: { provider: "legacy-jsonl" } }));

const { parseTextToolCalls, buildParamRegistry, hasToolIntent, leakedToolCallText, stripToolCallText, recoveryMessage } = await import(u("src/core/toolcalls.mjs"));
const { tools } = await import(u("src/tools/index.mjs"));
const { runTurn, autoCompactThreshold, DEFAULT_COMPACT_AT_TOKENS } = await import(u("src/core/agent.mjs"));
const { resolveModel } = await import(u("src/core/config.mjs"));
const { startMockProvider, mockSettings, MockSession } = await import(u("tests/_mock-provider.mjs"));

const reg = buildParamRegistry(tools);
const args = (call) => JSON.parse(call.function.arguments);

// The reply from the session log, verbatim apart from the path.
const SEP = "]<]minimax[>[";
const LEAKED = `${SEP}<invoke name="run_shell">${SEP}<command>cmd /c "cd /d C:\\game && npm run build 2>&1"${SEP}</command>${SEP}<timeout_ms>180000${SEP}</timeout_ms>${SEP}<allow_unsafe>false${SEP}</allow_unsafe>${SEP}<dry_run>false${SEP}</dry_nap>false${SEP}</dry_nap>${SEP}</invoke>`;

console.log("\n[leaked-calls] parsing");

await ok("the leaked MiniMax reply parses into the run_shell call it was", () => {
  assert.ok(hasToolIntent(LEAKED));
  const calls = parseTextToolCalls(LEAKED, reg);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].function.name, "run_shell");
  const a = args(calls[0]);
  assert.equal(a.command, 'cmd /c "cd /d C:\\game && npm run build 2>&1"');
  assert.equal(a.timeout_ms, 180000);
  assert.equal(a.allow_unsafe, false);
  assert.equal(a.dry_run, false, "a garbled boolean keeps its leading word, never a truthy string");
  assert.equal(stripToolCallText(LEAKED).trim(), "");
});

await ok("MiniMax's own <minimax:tool_call> / <invoke> format parses", () => {
  const s = 'Reading it.\n<minimax:tool_call>\n<invoke name="read_file">\n<parameter name="path">a.txt</parameter>\n</invoke>\n<invoke name="list_dir">\n<parameter name="path">.</parameter>\n</invoke>\n</minimax:tool_call>';
  const calls = parseTextToolCalls(s, reg);
  assert.deepEqual(calls.map((c) => [c.function.name, args(c).path]), [["read_file", "a.txt"], ["list_dir", "."]]);
  assert.equal(stripToolCallText(s).trim(), "Reading it.");
});

await ok("a bare <invoke> with no wrapper parses too", () => {
  const calls = parseTextToolCalls('Let me test.\n<invoke name="run_shell">\n<parameter name="command">npm test</parameter>\n</invoke>', reg);
  assert.equal(calls.length, 1);
  assert.equal(args(calls[0]).command, "npm test");
});

await ok("on native providers, only a real leaked call counts — not an explanation", () => {
  assert.ok(leakedToolCallText(LEAKED));
  assert.ok(leakedToolCallText('Now:\n<invoke name="run_shell">\n<parameter name="command">ls</parameter>\n</invoke>'));
  assert.equal(leakedToolCallText("The format is:\n```\n<invoke name=\"run_shell\">\n```\nas shown."), "", "a code block is an answer");
  assert.equal(leakedToolCallText("Use `<invoke name=\"x\">` inline."), "");
  assert.equal(leakedToolCallText("All done, the build passes."), "");
});

await ok("the native recovery nudge asks for a real call, not tags", () => {
  assert.match(recoveryMessage({ native: true }), /tool-calling interface/);
  assert.match(recoveryMessage(), /<tool_call>/, "the text-tool path keeps its format");
});

console.log("\n[leaked-calls] the agent loop");

await ok("a leaked call on a native-tools provider runs instead of ending the turn", async () => {
  const startCwd = process.cwd();
  const project = path.join(tmp, "project");
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, "a.txt"), "hello from a.txt\n");
  process.chdir(project);
  const leak = `${SEP}<invoke name="read_file">${SEP}<path>a.txt${SEP}</path>${SEP}</invoke>`;
  const mock = await startMockProvider([leak, "done"]);
  try {
    const settings = mockSettings(mock.baseUrl);
    const msgs = [{ role: "system", content: "S" }, { role: "user", content: "read a.txt" }];
    const out = await runTurn({ model: resolveModel(settings, "mock/main"), settings, messages: msgs, session: new MockSession(), maxIterations: 5, diffPreview: false });
    assert.equal(out.stop, "done");
    assert.equal(mock.requests.length, 2, "the loop went on to a second step");
    const second = mock.requests[1].messages;
    const asst = second.find((m) => m.role === "assistant" && m.tool_calls?.length);
    assert.equal(asst.tool_calls[0].function.name, "read_file");
    const result = second.find((m) => m.role === "tool");
    assert.match(String(result.content), /hello from a\.txt/, "the file was really read");
  } finally {
    await mock.close();
    process.chdir(startCwd);
  }
});

console.log("\n[leaked-calls] when to compact");

await ok("a 1M window compacts at the cap, not near 850k", () => {
  const big = { contextWindow: 1000000, maxTokens: 8192 };
  assert.equal(autoCompactThreshold(big, {}), DEFAULT_COMPACT_AT_TOKENS);
  assert.ok(DEFAULT_COMPACT_AT_TOKENS <= 200000);
});

await ok("a small window keeps its 85% mark", () => {
  const small = { contextWindow: 32768, maxTokens: 512 };
  assert.equal(autoCompactThreshold(small, {}), Math.floor((32768 - 512) * 0.85));
});

await ok("settings.compaction.compactAtTokens moves the cap, never past 85%", () => {
  const big = { contextWindow: 1000000, maxTokens: 0 };
  assert.equal(autoCompactThreshold(big, { compaction: { compactAtTokens: 400000 } }), 400000);
  assert.equal(autoCompactThreshold(big, { compaction: { compactAtTokens: 5000000 } }), 850000);
  assert.equal(autoCompactThreshold({ contextWindow: 0 }, {}), 0, "no window, no auto-compaction");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
