// Permission modes and plan mode (core/permission-mode.mjs).
//
// Omni had per-tool allow/ask/deny and nothing else: no read-only planning
// mode, no way to stop being asked for every edit. These pin the four modes,
// what plan mode lets through, exit_plan_mode's approval flow, and that a
// "deny" setting is never overridden by any mode.
//
// Run: node tests/permission-mode.test.mjs

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

process.env.OMNI_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "omni-mode-home-"));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "omni-mode-work-"));
process.chdir(work);
fs.writeFileSync(path.join(work, "a.txt"), "alpha");

const pm = await import(u("src/core/permission-mode.mjs"));
const { checkPermission, checkCommandRisk, runTurn } = await import(u("src/core/agent.mjs"));
const { runTool, setSessionCtx } = await import(u("src/tools/index.mjs"));
const { resolveModel } = await import(u("src/core/config.mjs"));
const { startMockProvider, mockSettings, MockSession } = await import(u("tests/_mock-provider.mjs"));

const allowAll = null;
const askAll = { "*": "ask" };
const never = async () => { throw new Error("must not ask"); };
const yes = async () => "y";

await ok("modes: names, aliases, Shift+Tab cycle skips auto", () => {
  pm.setPermissionMode("default");
  assert.equal(pm.normalizeMode("acceptEdits"), "accept-edits");
  assert.equal(pm.normalizeMode("yolo"), "auto");
  assert.equal(pm.normalizeMode("nonsense"), null);
  assert.throws(() => pm.setPermissionMode("nonsense"), /unknown mode/);
  assert.equal(pm.cyclePermissionMode(), "accept-edits");
  assert.equal(pm.cyclePermissionMode(), "plan");
  assert.equal(pm.cyclePermissionMode(), "default");
  pm.setPermissionMode("auto");
  assert.equal(pm.cyclePermissionMode(), "default", "from auto, Shift+Tab goes back to default");
});

await ok("plan mode remembers the mode it came from", () => {
  pm.setPermissionMode("accept-edits");
  pm.setPermissionMode("plan");
  assert.equal(pm.modeBeforePlan(), "accept-edits");
  pm.setPermissionMode("default");
});

await ok("read-only shell commands: one plain command, no chaining or redirection", () => {
  for (const c of ["git status", "git log --oneline -5", "ls -la", "Get-ChildItem src", "rg TODO src", "node --version"]) {
    assert.ok(pm.isReadOnlyCommand(c), c);
  }
  for (const c of ["npm install", "git status; rm -rf x", "git log > out.txt", "cat a | tee b", "git push", "rm a.txt", "echo $(whoami)", "git commit -m x", ""]) {
    assert.ok(!pm.isReadOnlyCommand(c), c);
  }
});

await ok("plan mode: reads run, anything that changes state is refused", async () => {
  pm.setPermissionMode("plan");
  try {
    for (const [name, args] of [["read_file", { path: "a.txt" }], ["search", { pattern: "x" }], ["run_shell", { command: "git status" }], ["exit_plan_mode", { plan: "x" }], ["deps", { action: "audit" }]]) {
      assert.equal((await checkPermission(name, "", allowAll, never, args)).allowed, true, name);
    }
    for (const [name, args] of [["write_file", { path: "b.txt" }], ["edit_file", {}], ["run_shell", { command: "npm install" }], ["git_commit", {}], ["delete_path", {}], ["some_extension_tool", {}], ["mcp", {}]]) {
      const r = await checkPermission(name, "", allowAll, never, args);
      assert.equal(r.allowed, false, name);
      assert.match(r.message, /plan mode/);
    }
  } finally { pm.setPermissionMode("default"); }
});

await ok("accept-edits: edits stop asking, shell still asks, deny still denies", async () => {
  pm.setPermissionMode("accept-edits");
  try {
    assert.equal((await checkPermission("edit_file", "", askAll, never, {})).allowed, true);
    let asked = false;
    await checkPermission("run_shell", "", askAll, async () => { asked = true; return "n"; }, { command: "npm test" });
    assert.ok(asked, "run_shell must still ask");
    const r = await checkPermission("write_file", "", { write_file: "deny" }, never, {});
    assert.equal(r.allowed, false);
  } finally { pm.setPermissionMode("default"); }
});

await ok("auto: nothing asks, deny still denies, the high-risk shell gate still asks", async () => {
  pm.setPermissionMode("auto");
  try {
    assert.equal((await checkPermission("run_shell", "", askAll, never, { command: "npm test" })).allowed, true);
    assert.equal((await checkPermission("git_push", "", { git_push: "deny" }, never, {})).allowed, false);
    const gate = await checkCommandRisk("run_shell", { command: "reg delete HKLM\\Software\\X /f" }, null);
    assert.ok(gate && gate.allowed === false, "the risk gate is independent of the mode");
  } finally { pm.setPermissionMode("default"); }
});

await ok("default mode is unchanged: ask asks", async () => {
  let asked = false;
  await checkPermission("edit_file", "", askAll, async () => { asked = true; return "y"; }, {});
  assert.ok(asked);
});

await ok("isMutatingCall: edits, writes and non-read-only shell; not reads or planning tools", () => {
  assert.ok(pm.isMutatingCall("write_file", {}));
  assert.ok(pm.isMutatingCall("run_shell", { command: "npm i" }));
  assert.ok(pm.isMutatingCall("git_commit", {}));
  assert.ok(!pm.isMutatingCall("read_file", {}));
  assert.ok(!pm.isMutatingCall("run_shell", { command: "git diff" }));
  assert.ok(!pm.isMutatingCall("project_todo", { action: "add" }));
});

await ok("the system prompt says which mode is on, and only while it is", () => {
  const msgs = [{ role: "system", content: "BASE" }];
  pm.syncModeGuidance(msgs, "plan");
  assert.match(msgs[0].content, /# Plan mode/);
  assert.match(msgs[0].content, /exit_plan_mode/);
  pm.syncModeGuidance(msgs, "accept-edits");
  assert.doesNotMatch(msgs[0].content, /# Plan mode/);
  assert.match(msgs[0].content, /accept edits/);
  pm.syncModeGuidance(msgs, "default");
  assert.equal(msgs[0].content, "BASE");
});

await ok("planSteps reads numbered and bulleted steps", () => {
  const steps = pm.planSteps("Intro text\n1. Add the **loader** in src/a.js\n2) Wire it up\n- Write tests\n  * Run npm test\nNot a step");
  assert.deepEqual(steps, ["Add the loader in src/a.js", "Wire it up", "Write tests", "Run npm test"]);
});

// ── exit_plan_mode ────────────────────────────────────────────────────────

const PLAN = "1. Add a retry helper in src/net.js\n2. Use it in fetchUser\n3. Run npm test";

await ok("exit_plan_mode outside plan mode does nothing", async () => {
  assert.match(await runTool("exit_plan_mode", { plan: PLAN }), /Not in plan mode/);
});

await ok("exit_plan_mode with no one to ask keeps plan mode", async () => {
  setSessionCtx(null);
  pm.setPermissionMode("plan");
  assert.match(await runTool("exit_plan_mode", { plan: PLAN }), /not interactive/);
  assert.equal(pm.getPermissionMode(), "plan");
  pm.setPermissionMode("default");
});

await ok("approve: back to the previous mode, steps land in project_todo", async () => {
  let asked = null;
  setSessionCtx({ askUser: async (q) => { asked = q; return q.options[0]; } });
  pm.setPermissionMode("plan");
  const out = await runTool("exit_plan_mode", { plan: PLAN });
  assert.match(asked.question, /Add a retry helper/);
  assert.equal(pm.getPermissionMode(), "default");
  assert.match(out, /approved/);
  assert.match(out, /3 step\(s\) were added to project_todo/);
  const todos = JSON.parse(fs.readFileSync(path.join(work, "omni", "todos.json"), "utf8"));
  const titles = (todos.todos || todos).map((t) => t.title);
  assert.ok(titles.includes("Use it in fetchUser"), JSON.stringify(titles));
  setSessionCtx(null);
});

await ok("approve with accept edits switches to accept-edits", async () => {
  setSessionCtx({ askUser: async (q) => q.options[1] });
  pm.setPermissionMode("plan");
  await runTool("exit_plan_mode", { plan: "1. one step" });
  assert.equal(pm.getPermissionMode(), "accept-edits");
  pm.setPermissionMode("default");
  setSessionCtx(null);
});

await ok("a typed reply instead of yes keeps plan mode and hands the feedback back", async () => {
  setSessionCtx({ askUser: async () => "use the existing backoff util instead" });
  pm.setPermissionMode("plan");
  const out = await runTool("exit_plan_mode", { plan: PLAN });
  assert.equal(pm.getPermissionMode(), "plan");
  assert.match(out, /use the existing backoff util instead/);
  pm.setPermissionMode("default");
  setSessionCtx(null);
});

// ── inside runTurn ────────────────────────────────────────────────────────

const mock = await startMockProvider();
const settings = mockSettings(mock.baseUrl);
const model = resolveModel(settings, "mock/main");

await ok("in plan mode a write is refused in the loop and the model is told why", async () => {
  pm.setPermissionMode("plan");
  try {
    mock.push({ tool: "write_file", args: { path: "new.txt", content: "x" } }, "ok, here is the plan instead");
    const messages = [{ role: "system", content: "SYS" }, { role: "user", content: "add new.txt" }];
    await runTurn({ model, settings, messages, session: new MockSession(), maxIterations: 4, diffPreview: false });
    assert.ok(!fs.existsSync(path.join(work, "new.txt")));
    assert.match(messages.find((m) => m.role === "tool").content, /plan mode/);
    assert.match(mock.requests[mock.requests.length - 1].messages[0].content, /# Plan mode/);
  } finally { pm.setPermissionMode("default"); }
});

await ok("beforeMutation runs once, before the first change, and never for reads", async () => {
  let calls = 0;
  let fileExistedAtCheckpoint = null;
  mock.push({ tool: "read_file", args: { path: "a.txt" } }, { tool: "write_file", args: { path: "c.txt", content: "1" } }, { tool: "write_file", args: { path: "d.txt", content: "2" } }, "done");
  const messages = [{ role: "user", content: "go" }];
  await runTurn({
    model, settings, messages, session: new MockSession(), maxIterations: 6, diffPreview: false,
    beforeMutation: () => { calls++; fileExistedAtCheckpoint = fs.existsSync(path.join(work, "c.txt")); },
  });
  assert.equal(calls, 1);
  assert.equal(fileExistedAtCheckpoint, false, "the checkpoint is taken before the write runs");
  assert.ok(fs.existsSync(path.join(work, "d.txt")));
});

await mock.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
