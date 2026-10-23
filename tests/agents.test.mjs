// Named sub-agents (core/agents.mjs) and worktree isolation
// (core/worktree-agent.mjs, merge_agent).
//
// Sub-agents used to share the parent's files and tools with no way to give
// them a role or limits. Now a .md definition sets role, tools, model and
// read-only, and isolation "worktree" runs the agent as its own headless Omni
// on a separate git branch that merge_agent reviews before merging.
//
// Run: node tests/agents.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

let pass = 0, fail = 0;
async function ok(label, fn) {
  try { await fn(); console.log(`  PASS ${label}`); pass++; }
  catch (e) { console.log(`  FAIL ${label}\n    ${e.stack || e.message}`); fail++; }
}

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1"));
const root = path.join(here, "..");
const u = (p) => pathToFileURL(path.join(root, p)).href;

const home = fs.mkdtempSync(path.join(os.tmpdir(), "omni-agents-home-"));
process.env.OMNI_HOME = home;
process.env.OMNI_NO_HOOKS = "1";

const { startMockProvider } = await import(u("tests/_mock-provider.mjs"));
const mock = await startMockProvider();
fs.writeFileSync(path.join(home, "settings.json"), JSON.stringify({
  defaultModel: "mock/main",
  providers: { mock: { baseUrl: mock.baseUrl, apiKey: "k-test" } },
  models: {
    "mock/main": { provider: "mock", id: "main-model", maxTokens: 256, contextWindow: 32768 },
    "mock/cheap": { provider: "mock", id: "cheap-model", maxTokens: 256, contextWindow: 32768 },
  },
  router: { enabled: false },
  checkpoints: false,
}));

const ag = await import(u("src/core/agents.mjs"));
const { runTool, tools, refreshAgentCatalog } = await import(u("src/tools/index.mjs"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitDone(id, ms = 120000) {
  const end = Date.now() + ms;
  let s = "";
  while (Date.now() < end) {
    s = await runTool("agent_status", { id });
    if (!/\[(running|stopping)\]/.test(s)) return s;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${id}: ${s}`);
}

// ── definitions ───────────────────────────────────────────────────────────

const proj = fs.mkdtempSync(path.join(os.tmpdir(), "omni-agents-proj-"));
fs.mkdirSync(path.join(proj, ".omni", "agents"), { recursive: true });
fs.writeFileSync(path.join(proj, ".omni", "agents", "reviewer.md"), "---\ndescription: Project reviewer\nreadonly: true\nmodel: mock/cheap\n---\nReview like this project wants.");
fs.writeFileSync(path.join(proj, ".omni", "agents", "docs-writer.md"), "---\ndescription: Writes docs\ntools: read_file, write_file\n---\nWrite clear docs.");
fs.writeFileSync(path.join(proj, ".omni", "agents", "Bad Name!.md"), "---\nname: Bad Name!\n---\nx");
fs.mkdirSync(path.join(home, "agents"), { recursive: true });
fs.writeFileSync(path.join(home, "agents", "mine.md"), "---\ndescription: Personal helper\n---\nHelp me.");

await ok("loads built-in, personal and project agents; project overrides built-in", () => {
  const agents = ag.loadAgents({ cwd: proj, home });
  assert.deepEqual([...agents.keys()].sort(), ["docs-writer", "explorer", "mine", "reviewer", "tester"]);
  assert.equal(agents.get("reviewer").scope, "project");
  assert.equal(agents.get("reviewer").model, "mock/cheap");
  assert.equal(agents.get("explorer").scope, "built-in");
  assert.equal(agents.get("tester").isolation, "worktree");
  assert.deepEqual(agents.get("docs-writer").tools, ["read_file", "write_file"]);
});

await ok("read-only agents get read tools only, never spawn_agent or edits", () => {
  const allowed = ag.agentAllowedTools(ag.loadAgents().get("explorer"));
  assert.ok(allowed.has("read_file") && allowed.has("search"));
  for (const t of ["write_file", "edit_file", "run_shell", "spawn_agent", "exit_plan_mode"]) assert.ok(!allowed.has(t), t);
  assert.equal(ag.agentAllowedTools({ tools: null, readonly: false }), null, "no limits means all tools");
});

await ok("an agent is never wider than its parent: deny stays deny, ask stays ask", () => {
  const writer = ag.loadAgents({ cwd: proj, home }).get("docs-writer");
  const perms = ag.agentPermissions(writer, { write_file: "deny", "*": "ask" });
  assert.equal(perms["*"], "deny");
  assert.equal(perms.write_file, "deny");
  assert.equal(perms.read_file, "ask");
  assert.equal(ag.agentPermissions(writer, null).read_file, "allow");
});

await ok("the role is added to the system prompt with its limits", () => {
  const writer = ag.loadAgents({ cwd: proj, home }).get("docs-writer");
  const sys = ag.agentSystemPrompt("BASE", writer);
  assert.match(sys, /^BASE/);
  assert.match(sys, /# Your role: docs-writer\nWrite clear docs\./);
  assert.match(sys, /only these tools: read_file, write_file/);
});

await ok("spawn_agent's description names the available agents", () => {
  refreshAgentCatalog();
  refreshAgentCatalog(); // idempotent
  const d = tools.find((t) => t.function.name === "spawn_agent").function.description;
  assert.match(d, /explorer \(read-only\)/);
  assert.match(d, /tester \(own git branch\)/);
  assert.equal(d.split("Named agents you can pass").length, 2);
});

// ── a named agent in-process ──────────────────────────────────────────────

await ok("a read-only agent is only offered read tools, and its writes are refused", async () => {
  process.chdir(proj);
  mock.clear();
  mock.push({ tool: "write_file", args: { path: "x.txt", content: "nope" } }, "Review done: found nothing.");
  const before = mock.requests.length;
  const out = await runTool("spawn_agent", { prompt: "Review the project", agent: "reviewer" });
  const id = /spawned (A\d+) as reviewer/.exec(out)[1];
  const status = await waitDone(id);
  assert.match(status, /agent: reviewer/);
  assert.match(status, /model: mock\/cheap/, "the agent's own model");
  const req = mock.requests[before];
  const offered = (req.tools || []).map((t) => t.function.name);
  assert.ok(offered.includes("read_file"));
  assert.ok(!offered.includes("write_file"), "write_file must not even be offered");
  assert.match(req.messages[0].content, /# Your role: reviewer/);
  assert.ok(!fs.existsSync(path.join(proj, "x.txt")));
  assert.match(status, /found nothing/);
});

await ok("an unknown agent name is a clear error", async () => {
  await assert.rejects(runTool("spawn_agent", { prompt: "x", agent: "nobody" }), /no agent named "nobody" \(known: /);
});

// ── worktree isolation ────────────────────────────────────────────────────

const hasGit = spawnSync("git", ["--version"]).status === 0;
const repo = fs.mkdtempSync(path.join(os.tmpdir(), "omni-agents-repo-"));
const git = (...a) => spawnSync("git", a, { cwd: repo, encoding: "utf8" });
if (hasGit) {
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
}

await ok("worktree isolation needs a git repo", async () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "omni-agents-plain-"));
  process.chdir(plain);
  await assert.rejects(runTool("spawn_agent", { prompt: "x", isolation: "worktree" }), /needs a git repository/);
});

let firstId;
await ok("a worktree agent works on its own branch; your checkout is untouched until merge", async () => {
  if (!hasGit) return console.log("    (skipped: git not installed)");
  process.chdir(repo);
  mock.clear();
  // The child Omni process: one write, then its report.
  mock.push({ tool: "write_file", args: { path: "feature.txt", content: "made by the agent\n" } }, "Added feature.txt.");
  const out = await runTool("spawn_agent", { prompt: "Add feature.txt", isolation: "worktree" });
  firstId = /spawned (A\d+)/.exec(out)[1];
  assert.match(out, /own worktree on branch omni\/agent-/);
  const status = await waitDone(firstId);
  assert.match(status, /\[done\]/, status);
  assert.match(status, /changed 1 file\(s\): A feature\.txt/);
  assert.match(status, /Added feature\.txt\./);
  assert.ok(!fs.existsSync(path.join(repo, "feature.txt")), "nothing reaches your checkout before merge_agent");
  const branch = /branch: (\S+)/.exec(status)[1];
  assert.match(git("show", `${branch}:feature.txt`).stdout, /made by the agent/);
  // Its own log is a sub-agent's, so /resume never offers it.
  const childLogs = fs.readdirSync(path.join(home, "sessions")).flatMap((d) => fs.readdirSync(path.join(home, "sessions", d)).filter((f) => f.endsWith(".jsonl")).map((f) => fs.readFileSync(path.join(home, "sessions", d, f), "utf8")));
  assert.ok(childLogs.some((l) => /"kind":"subagent"/.test(l) && /Add feature\.txt/.test(l)));
});

await ok("merge_agent reviews the diff, merges on CLEAN, and removes the worktree", async () => {
  if (!hasGit) return console.log("    (skipped: git not installed)");
  mock.clear();
  mock.push("Checked the new file against the task.\nVERDICT: CLEAN");
  const status = await runTool("agent_status", { id: firstId });
  const branch = /branch: (\S+)/.exec(status)[1];
  const wtPath = spawnSync("git", ["worktree", "list", "--porcelain"], { cwd: repo, encoding: "utf8" }).stdout.split("\n").find((l) => l.startsWith("worktree ") && l.includes(firstId.toLowerCase()));
  const out = await runTool("merge_agent", { id: firstId });
  assert.match(out, /^Merged A\d+'s branch into your checkout as [0-9a-f]{7}/);
  assert.match(out, /VERDICT: CLEAN/);
  // (CRLF on a Windows checkout with core.autocrlf on)
  assert.equal(fs.readFileSync(path.join(repo, "feature.txt"), "utf8").replace(/\r\n/g, "\n"), "made by the agent\n");
  assert.match(git("log", "-1", "--format=%s").stdout, /Merge omni sub-agent/);
  assert.equal(git("branch", "--list", branch).stdout.trim(), "", "the branch is deleted");
  assert.ok(wtPath && !fs.existsSync(wtPath.slice("worktree ".length).trim()), "the worktree folder is gone");
  assert.match(await runTool("merge_agent", { id: firstId }), /already merged as/);
});

await ok("a BLOCKERS review stops the merge; discard then cleans up", async () => {
  if (!hasGit) return console.log("    (skipped: git not installed)");
  mock.clear();
  mock.push({ tool: "write_file", args: { path: "README.md", content: "broken\n" } }, "Rewrote the README.");
  const out = await runTool("spawn_agent", { prompt: "Improve the README", isolation: "worktree" });
  const id = /spawned (A\d+)/.exec(out)[1];
  await waitDone(id);
  mock.clear();
  mock.push("[BLOCKER] README.md:1 — deleted all the content\nVERDICT: BLOCKERS");
  const refused = await runTool("merge_agent", { id });
  assert.match(refused, /^NOT merged: .*VERDICT: BLOCKERS/);
  assert.equal(fs.readFileSync(path.join(repo, "README.md"), "utf8").replace(/\r\n/g, "\n"), "hello\n", "your checkout is unchanged");
  const branch = /branch (omni\/agent-\S+)/.exec(refused)[1];
  assert.match(await runTool("merge_agent", { id, action: "discard" }), /discarded/);
  assert.equal(git("branch", "--list", branch).stdout.trim(), "");
});

await ok("merge_agent refuses a shared (non-worktree) agent", async () => {
  process.chdir(proj);
  mock.clear();
  mock.push("ok");
  const out = await runTool("spawn_agent", { prompt: "say ok" });
  const id = /spawned (A\d+)/.exec(out)[1];
  await waitDone(id);
  await assert.rejects(runTool("merge_agent", { id }), /no branch to merge/);
});

process.chdir(os.tmpdir());
await mock.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
