// Deferred tool definitions (core/tool-deferral.mjs).
//
// Every step used to send all ~93 tool definitions (~14k tokens). Now only
// the core set and tools loaded this session are sent; the rest are listed
// by name in load_tools, and a direct call to one still works.
//
// Run: node tests/tool-deferral.test.mjs

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

process.env.OMNI_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "omni-defer-home-"));

const { offeredTools, loadTools, CORE_TOOLS, LOAD_TOOLS } = await import(u("src/core/tool-deferral.mjs"));
const { tools } = await import(u("src/tools/index.mjs"));
const { runTurn, systemPrompt } = await import(u("src/core/agent.mjs"));
const { READ_ONLY_TOOLS } = await import(u("src/core/permission-mode.mjs"));
const { resolveModel } = await import(u("src/core/config.mjs"));
const { startMockProvider, mockSettings, MockSession } = await import(u("tests/_mock-provider.mjs"));

const def = (name, description = `${name} does a thing.`) => ({ type: "function", function: { name, description, parameters: { type: "object", properties: {} } } });
const names = (list) => list.map((t) => t.function.name);
const registry = [def("read_file"), def("edit_file"), def("git_log", "Show commit history."), def("browser_click", "Click an element on the page."), def("mcp__okf__nav")];

await ok("only core tools are sent; the rest are named in load_tools", () => {
  const { offered, deferred } = offeredTools(registry, { loaded: new Set() });
  assert.deepEqual(names(offered), ["read_file", "edit_file", "mcp__okf__nav", LOAD_TOOLS]);
  assert.deepEqual(names(deferred), ["git_log", "browser_click"]);
  const desc = offered.at(-1).function.description;
  assert.match(desc, /browser_click, git_log/, "lists every deferred tool by name");
});

await ok("loaded tools, alwaysLoadTools and deferTools:false are honoured", () => {
  assert.ok(names(offeredTools(registry, { loaded: new Set(["git_log"]) }).offered).includes("git_log"));
  assert.ok(names(offeredTools(registry, { settings: { alwaysLoadTools: ["browser_click"] } }).offered).includes("browser_click"));
  const all = offeredTools(registry, { settings: { deferTools: false } });
  assert.deepEqual(names(all.offered), names(registry));
  assert.equal(all.deferred.length, 0);
  const none = offeredTools([def("read_file")], {});
  assert.deepEqual(names(none.offered), ["read_file"], "no load_tools when nothing is deferred");
});

await ok("load_tools loads by name and by query, and reports unknown names", () => {
  const { deferred } = offeredTools(registry, {});
  const loaded = new Set();
  const out = loadTools({ names: ["git_log", "nope"] }, deferred, loaded);
  assert.ok(loaded.has("git_log"));
  assert.match(out, /git_log: Show commit history\./);
  assert.match(out, /Not found: nope/);
  const q = loadTools({ query: "click page" }, deferred, loaded);
  assert.ok(loaded.has("browser_click"));
  assert.match(q, /Loaded 1 tool/);
  assert.match(loadTools({}, deferred, new Set()), /Nothing to load/);
});

await ok("the real registry: the everyday tools stay, the rest are deferred", () => {
  const { offered, deferred } = offeredTools(tools, {});
  const sent = names(offered);
  for (const n of ["read_file", "edit_file", "apply_patch", "run_shell", "search", "git_diff", "self_review"]) assert.ok(sent.includes(n), n);
  for (const n of ["settings_set_apikey", "memory_forget", "rename_symbol", "system_info"]) assert.ok(names(deferred).includes(n), n);
  assert.ok(JSON.stringify(offered).length < JSON.stringify(tools).length * 0.75, "a real saving");
  for (const n of CORE_TOOLS) assert.ok(!names(deferred).includes(n));
});

await ok("load_tools is allowed in plan mode", () => {
  assert.ok(READ_ONLY_TOOLS.has(LOAD_TOOLS));
});

await ok("runTurn: load_tools sends the tool's definition from the next step", async () => {
  const mock = await startMockProvider([{ tool: LOAD_TOOLS, args: { names: ["system_info"] } }, "done"]);
  try {
    const settings = mockSettings(mock.baseUrl);
    const msgs = [{ role: "system", content: "S" }, { role: "user", content: "what OS is this?" }];
    const out = await runTurn({ model: resolveModel(settings, "mock/main"), settings, messages: msgs, session: new MockSession(), maxIterations: 3, diffPreview: false });
    assert.ok(out.stop !== "error", out.error);
    const first = names(mock.requests[0].tools);
    assert.ok(!first.includes("system_info"), "deferred at first");
    assert.match(mock.requests[0].tools.find((t) => t.function.name === LOAD_TOOLS).function.description, /system_info/);
    assert.ok(names(mock.requests[1].tools).includes("system_info"), "sent after loading");
    assert.match(msgs.find((m) => m.role === "tool").content, /Loaded 1 tool/);
  } finally {
    await mock.close();
  }
});

await ok("runTurn: a deferred tool called directly still runs, and is loaded", async () => {
  const mock = await startMockProvider([{ tool: "system_info" }, "done"]);
  try {
    const settings = mockSettings(mock.baseUrl);
    const msgs = [{ role: "system", content: "S" }, { role: "user", content: "what OS is this?" }];
    const session = new MockSession();
    await runTurn({ model: resolveModel(settings, "mock/main"), settings, messages: msgs, session, maxIterations: 3, diffPreview: false });
    const result = msgs.find((m) => m.role === "tool").content;
    assert.ok(!/Unknown tool|ERROR/.test(result), result);
    assert.ok(names(mock.requests[1].tools).includes("system_info"));
    assert.ok(session.loadedTools.has("system_info"), "stays loaded for the session");
  } finally {
    await mock.close();
  }
});

await ok("runTurn: deferTools:false sends every tool", async () => {
  const mock = await startMockProvider(["done"]);
  try {
    const settings = mockSettings(mock.baseUrl, { deferTools: false });
    await runTurn({ model: resolveModel(settings, "mock/main"), settings, messages: [{ role: "system", content: "S" }, { role: "user", content: "hi" }], session: new MockSession(), maxIterations: 1, diffPreview: false });
    const sent = names(mock.requests[0].tools);
    assert.ok(sent.includes("system_info"));
    assert.ok(!sent.includes(LOAD_TOOLS));
  } finally {
    await mock.close();
  }
});

await ok("both prompts tell the model about load_tools", () => {
  for (const text of [systemPrompt(), fs.readFileSync(path.join(root, "prompts", "default.md"), "utf8")]) {
    assert.match(text.replace(/\s+/g, " "), /listed by name in `?load_tools`?\. Load the ones a task needs, several in one call/);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
