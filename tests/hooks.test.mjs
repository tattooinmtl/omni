// Lifecycle hooks (core/hooks.mjs).
//
// omni.config.json shipped a SessionStart hook (hooks/scan-now.json) that
// nothing ever ran: the schema said hooks were "run by the host harness".
// Omni now runs them itself, at seven points in the loop, and these tests pin
// both the runner and the places runTurn() calls it.
//
// Run: node tests/hooks.test.mjs

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

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "omni-hooks-home-"));
process.env.OMNI_HOME = tmpHome;
const work = fs.mkdtempSync(path.join(os.tmpdir(), "omni-hooks-work-"));
process.chdir(work);
fs.writeFileSync(path.join(work, "hello.txt"), "hi");

const hooks = await import(u("src/core/hooks.mjs"));
const { registerHook, clearHooks, runHooks, loadHooks, listHooks, interpretCommandResult, submitPromptHooks } = hooks;
const { runTurn } = await import(u("src/core/agent.mjs"));
const { resolveModel } = await import(u("src/core/config.mjs"));
const { registerExtensions } = await import(u("src/tools/index.mjs"));
const { startMockProvider, mockSettings, MockSession } = await import(u("tests/_mock-provider.mjs"));

const node = JSON.stringify(process.execPath);
// A command hook written as a small node script, so it runs the same on
// Windows and elsewhere.
function scriptHook(code) {
  const file = path.join(work, `hook-${Math.random().toString(36).slice(2)}.mjs`);
  fs.writeFileSync(file, code);
  return `${node} ${JSON.stringify(file)}`;
}

// ── the runner ────────────────────────────────────────────────────────────

await ok("registerHook rejects unknown events and hooks with nothing to run", () => {
  clearHooks();
  assert.throws(() => registerHook({ event: "Nope", command: "x" }), /unknown hook event/);
  assert.throws(() => registerHook({ event: "Stop" }), /needs a "command"/);
  // `trigger` (the shipped scan-now.json key) and any casing are accepted.
  assert.equal(registerHook({ trigger: "sessionstart", command: "x" }).event, "SessionStart");
});

await ok("command replies: exit 2 denies, JSON decides, text becomes context, other exits are errors", () => {
  assert.deepEqual(interpretCommandResult({ code: 2, stderr: "no rm -rf\n" }), { decision: "deny", reason: "no rm -rf" });
  assert.equal(interpretCommandResult({ code: 0, stdout: '{"decision":"block","reason":"r"}' }).decision, "deny");
  assert.deepEqual(interpretCommandResult({ code: 0, stdout: '{"updatedInput":{"a":1}}' }).args, { a: 1 });
  assert.deepEqual(interpretCommandResult({ code: 0, stdout: "lint is clean\n" }), { additionalContext: "lint is clean" });
  assert.deepEqual(interpretCommandResult({ code: 0, stdout: "" }), {});
  assert.match(interpretCommandResult({ code: 1, stderr: "boom" }).error, /exited 1: boom/);
});

await ok("hooks run in order, a deny stops the chain, args rewrites are passed along", async () => {
  clearHooks();
  const seen = [];
  registerHook({ event: "PreToolUse", fn: (p) => { seen.push(["a", p.args.path]); return { args: { path: "b.txt" } }; } });
  registerHook({ event: "PreToolUse", fn: (p) => { seen.push(["b", p.args.path]); return { decision: "deny", reason: "nope" }; } });
  registerHook({ event: "PreToolUse", fn: () => { seen.push(["c"]); } });
  const r = await runHooks("PreToolUse", { tool: "read_file", args: { path: "a.txt" } });
  assert.deepEqual(seen, [["a", "a.txt"], ["b", "b.txt"]]);
  assert.equal(r.denied, true);
  assert.equal(r.reason, "nope");
  assert.deepEqual(r.args, { path: "b.txt" });
});

await ok("matcher limits a hook to matching tool names", async () => {
  clearHooks();
  let calls = 0;
  registerHook({ event: "PreToolUse", matcher: "run_shell|run_test", fn: () => { calls++; } });
  await runHooks("PreToolUse", { tool: "read_file" });
  await runHooks("PreToolUse", { tool: "run_shell" });
  await runHooks("PreToolUse", { tool: "run_shell_extra" });
  assert.equal(calls, 1, "the matcher is anchored to the whole name");
});

await ok("a slow or throwing hook is reported, not fatal", async () => {
  clearHooks();
  registerHook({ event: "Stop", fn: () => new Promise(() => {}), timeout_ms: 1000, name: "slow" });
  registerHook({ event: "Stop", fn: () => { throw new Error("broke"); }, name: "bad" });
  const r = await runHooks("Stop", {});
  assert.equal(r.denied, false);
  assert.equal(r.errors.length, 2);
  assert.match(r.errors[0], /slow: timed out/);
  assert.match(r.errors[1], /bad: broke/);
});

await ok("OMNI_NO_HOOKS turns every hook off", async () => {
  clearHooks();
  registerHook({ event: "Stop", fn: () => ({ decision: "deny" }) });
  process.env.OMNI_NO_HOOKS = "1";
  try {
    assert.equal((await runHooks("Stop", {})).denied, false);
    assert.equal(hooks.hasHooks("Stop"), false);
  } finally { delete process.env.OMNI_NO_HOOKS; }
});

await ok("a command hook reads the event as JSON on stdin and can block with exit 2", async () => {
  clearHooks();
  registerHook({
    event: "PreToolUse",
    command: scriptHook(`
      let s = ""; process.stdin.on("data", d => s += d); process.stdin.on("end", () => {
        const e = JSON.parse(s);
        if (e.event !== "PreToolUse" || process.env.OMNI_HOOK_EVENT !== "PreToolUse") process.exit(1);
        if (/rm /.test(e.args.command)) { process.stderr.write("rm is not allowed here"); process.exit(2); }
        process.stdout.write(JSON.stringify({ additionalContext: "checked " + e.tool }));
      });`),
  });
  const bad = await runHooks("PreToolUse", { tool: "run_shell", args: { command: "rm x" } });
  assert.equal(bad.denied, true);
  assert.equal(bad.reason, "rm is not allowed here");
  const good = await runHooks("PreToolUse", { tool: "run_shell", args: { command: "ls" } });
  assert.equal(good.denied, false);
  assert.match(good.context, /checked run_shell/);
});

await ok("a background command returns at once and its answer is ignored", async () => {
  clearHooks();
  registerHook({ event: "SessionStart", background: true, command: scriptHook(`setTimeout(() => { process.stdout.write('{"decision":"deny"}'); process.exit(2); }, 3000);`) });
  const t = Date.now();
  const r = await runHooks("SessionStart", {});
  assert.ok(Date.now() - t < 1500, "must not wait for the background hook");
  assert.equal(r.denied, false);
});

await ok("UserPromptSubmit context is appended to the prompt", async () => {
  clearHooks();
  registerHook({ event: "UserPromptSubmit", fn: (p) => (p.prompt.includes("deploy") ? "deploys need a ticket number" : undefined) });
  const r = await submitPromptHooks("deploy it");
  assert.equal(r.content, "deploy it\n\n[hook extension] deploys need a ticket number");
  assert.equal((await submitPromptHooks("hello")).content, "hello");
});

await ok("loadHooks reads the shipped hook-file format and settings hooks", () => {
  const install = fs.mkdtempSync(path.join(os.tmpdir(), "omni-hooks-install-"));
  fs.mkdirSync(path.join(install, "hooks"));
  fs.copyFileSync(path.join(root, "hooks", "scan-now.json"), path.join(install, "hooks", "scan-now.json"));
  const r = loadHooks({ installRoot: install, files: ["scan-now.json", "missing.json"], settingsHooks: [{ event: "Stop", command: "echo hi" }], cwd: work });
  assert.equal(r.loaded, 2);
  assert.equal(r.errors.length, 1, "a missing hook file is reported");
  const list = listHooks();
  assert.equal(list[0].event, "SessionStart");
  assert.equal(list[0].background, true);
  assert.equal(list[0].timeoutMs, 15000);
  assert.equal(list[1].source, "settings");
});

await ok("a project's .omni/hooks.json loads only in a trusted folder", () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "omni-hooks-proj-"));
  fs.mkdirSync(path.join(proj, ".omni"));
  fs.writeFileSync(path.join(proj, ".omni", "hooks.json"), JSON.stringify([{ event: "Stop", command: "echo x" }]));
  let r = loadHooks({ cwd: proj, projectTrusted: false });
  assert.equal(r.loaded, 0);
  assert.match(r.errors[0], /not trusted/);
  r = loadHooks({ cwd: proj, projectTrusted: true });
  assert.equal(r.loaded, 1);
  assert.equal(listHooks()[0].source, "project");
});

await ok("extensions register in-process hooks, which survive loadHooks and reload", async () => {
  clearHooks();
  const extRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omni-hooks-ext-"));
  fs.writeFileSync(path.join(extRoot, "guard.js"), `export default {
    name: "guard", tools: [], impl: {},
    hooks: { PreToolUse: { matcher: "write_file", run: () => ({ decision: "deny", reason: "read-only today" }) }, Bogus: () => {} },
  };`);
  await registerExtensions(extRoot, ["guard.js"]);
  loadHooks({ cwd: work });
  assert.equal(listHooks().filter((h) => h.source === "extension:guard.js").length, 1);
  await registerExtensions(extRoot, ["guard.js"]); // hot reload must not duplicate
  assert.equal(listHooks().filter((h) => h.source === "extension:guard.js").length, 1);
  assert.equal((await runHooks("PreToolUse", { tool: "write_file" })).reason, "read-only today");
  clearHooks();
});

// ── inside runTurn ────────────────────────────────────────────────────────

const mock = await startMockProvider();
const settings = mockSettings(mock.baseUrl);
const model = resolveModel(settings, "mock/main");
const turn = (messages, session) => runTurn({ model, settings, messages, session, maxIterations: 8, diffPreview: false });

await ok("PreToolUse deny reaches the model as a DENIED tool result; the tool never runs", async () => {
  clearHooks();
  registerHook({ event: "PreToolUse", matcher: "write_file", fn: () => ({ decision: "deny", reason: "no writes in review mode" }), name: "ro" });
  mock.push({ tool: "write_file", args: { path: "out.txt", content: "x" } }, "ok, I won't");
  const messages = [{ role: "user", content: "write out.txt" }];
  await turn(messages, new MockSession());
  const toolMsg = messages.find((m) => m.role === "tool");
  assert.match(toolMsg.content, /DENIED by hook "ro": no writes in review mode/);
  assert.ok(!fs.existsSync(path.join(work, "out.txt")));
});

await ok("PreToolUse can rewrite args; PostToolUse notes are appended to the result", async () => {
  clearHooks();
  registerHook({ event: "PreToolUse", matcher: "read_file", fn: () => ({ args: { path: "hello.txt" } }) });
  registerHook({ event: "PostToolUse", matcher: "read_file", fn: (p) => `read ${p.args.path}, ok=${p.ok}` , name: "audit" });
  mock.push({ tool: "read_file", args: { path: "does-not-exist.txt" } }, "done");
  const messages = [{ role: "user", content: "read it" }];
  await turn(messages, new MockSession());
  const toolMsg = messages.find((m) => m.role === "tool");
  assert.match(toolMsg.content, /hi/, "the rewritten path was read");
  assert.match(toolMsg.content, /\[hook audit\] read hello\.txt, ok=true/);
});

await ok("a Stop hook sends the agent back to work, at most 3 times", async () => {
  clearHooks();
  let n = 0;
  registerHook({ event: "Stop", fn: () => (++n <= 5 ? { decision: "block", reason: "tests still fail" } : undefined), name: "ci" });
  mock.push("done 1", "done 2", "done 3", "done 4");
  const messages = [{ role: "user", content: "fix it" }];
  await turn(messages, new MockSession());
  const nudges = messages.filter((m) => m.role === "user" && /\[hook ci\] Not done yet: tests still fail/.test(m.content));
  assert.equal(nudges.length, 3);
  assert.equal(messages.filter((m) => m.role === "assistant").length, 4);
});

await ok("a Stop hook that lets the turn end changes nothing", async () => {
  clearHooks();
  registerHook({ event: "Stop", fn: () => ({ decision: "allow" }) });
  mock.push("all good");
  const messages = [{ role: "user", content: "hi" }];
  await turn(messages, new MockSession());
  assert.equal(messages.length, 2);
});

clearHooks();
await mock.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
