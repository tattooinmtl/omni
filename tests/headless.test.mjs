// Headless mode (src/cli/headless.mjs): omni -p "…" --output json|stream-json.
//
// One-shot runs only printed terminal text and always exited 0, so a script
// or CI job couldn't read the answer or tell success from failure. These run
// the real CLI against a local mock provider and pin the JSON on stdout (and
// nothing else there), the stream of events, stdin prompts, --max-turns and
// the exit codes.
//
// Run: node tests/headless.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

let pass = 0, fail = 0;
async function ok(label, fn) {
  try { await fn(); console.log(`  PASS ${label}`); pass++; }
  catch (e) { console.log(`  FAIL ${label}\n    ${e.stack || e.message}`); fail++; }
}

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1"));
const root = path.join(here, "..");
const u = (p) => pathToFileURL(path.join(root, p)).href;

const { parseHeadlessFlags, eventForRecord, buildResult } = await import(u("src/cli/headless.mjs"));
const { startMockProvider } = await import(u("tests/_mock-provider.mjs"));

const mock = await startMockProvider();
const home = fs.mkdtempSync(path.join(os.tmpdir(), "omni-hl-home-"));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "omni-hl-work-"));
fs.writeFileSync(path.join(work, "a.txt"), "hello from a.txt");
const baseSettings = {
  defaultModel: "mock/main",
  providers: { mock: { baseUrl: mock.baseUrl, apiKey: "k-test" }, nokey: { baseUrl: mock.baseUrl, apiKey: "" } },
  models: {
    "mock/main": { provider: "mock", id: "main-model", maxTokens: 256, contextWindow: 32768 },
    "nokey/m": { provider: "nokey", id: "m", maxTokens: 256, contextWindow: 32768 },
  },
  router: { enabled: false },
  checkpoints: false,
};
fs.writeFileSync(path.join(home, "settings.json"), JSON.stringify(baseSettings));

function omni(args, { stdin = null } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, "bin", "omni.mjs"), ...args], {
      cwd: work, env: { ...process.env, OMNI_HOME: home, OMNI_NO_HOOKS: "1" },
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    if (stdin != null) child.stdin.end(stdin); else child.stdin.end();
    const timer = setTimeout(() => child.kill(), 90000);
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

// ── flag parsing ──────────────────────────────────────────────────────────

await ok("flags are pulled out of argv, the prompt words are left", () => {
  const args = ["-p", "fix", "it", "--output", "json", "--max-turns", "5"];
  assert.deepEqual(parseHeadlessFlags(args), { print: true, output: "json", maxTurns: 5, agent: null });
  assert.equal(parseHeadlessFlags(["--agent", "Reviewer"]).agent, "reviewer");
  assert.throws(() => parseHeadlessFlags(["--agent", "--output"]), /name of an agent/);
  assert.deepEqual(args, ["fix", "it"]);
  assert.equal(parseHeadlessFlags(["--output-format", "stream-json"]).output, "stream-json");
  assert.throws(() => parseHeadlessFlags(["--output", "xml"]), /text, json, stream-json/);
  assert.throws(() => parseHeadlessFlags(["--max-turns", "0"]), /whole number/);
});

await ok("buildResult and eventForRecord shapes", () => {
  const r = buildResult({ stop: "done", messages: [{ role: "assistant", content: "", tool_calls: [{}] }, { role: "assistant", content: "answer" }], session: { code: "omni-session-x-0000000", cost: { totalTokens: 9 } }, model: { key: "a/b" } });
  assert.equal(r.ok, true);
  assert.equal(r.result, "answer");
  assert.equal(r.turns, 2);
  assert.equal(r.toolCalls, 1);
  assert.equal(r.usage.totalTokens, 9);
  assert.equal(buildResult({ stop: "max_turns" }).ok, false);
  assert.equal(eventForRecord({ type: "tool", name: "x", tool_call_id: "c", result: "ERROR: nope" }).ok, false);
  assert.equal(eventForRecord({ type: "session_start" }), null);
});

// ── the real CLI ──────────────────────────────────────────────────────────

await ok("--output json: one JSON object on stdout, UI text on stderr, exit 0", async () => {
  mock.push({ tool: "read_file", args: { path: "a.txt" } }, "The file says hello.");
  const r = await omni(["-p", "what is in a.txt?", "--output", "json"]);
  assert.equal(r.code, 0, r.stderr.slice(-800));
  const lines = r.stdout.trim().split("\n");
  assert.equal(lines.length, 1, `stdout must hold only the JSON, got:\n${r.stdout}`);
  const res = JSON.parse(lines[0]);
  assert.equal(res.type, "result");
  assert.equal(res.ok, true);
  assert.equal(res.stop, "done");
  assert.equal(res.result, "The file says hello.");
  assert.equal(res.toolCalls, 1);
  assert.match(res.session, /^omni-session-/);
  assert.equal(res.model, "mock/main");
  assert.ok(res.usage.totalTokens > 0);
  assert.match(r.stderr, /read_file/, "the terminal UI still shows up, on stderr");
});

await ok("--output stream-json: init, events as they happen, then the result", async () => {
  mock.push({ tool: "read_file", args: { path: "a.txt" } }, "done reading");
  const r = await omni(["-p", "read a.txt", "--output", "stream-json"]);
  assert.equal(r.code, 0, r.stderr.slice(-800));
  const events = r.stdout.trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(events.map((e) => e.type), ["init", "user", "assistant", "tool_result", "assistant", "result"]);
  assert.equal(events[2].toolCalls[0].name, "read_file");
  assert.deepEqual(events[2].toolCalls[0].args, { path: "a.txt" });
  assert.match(events[3].result, /hello from a\.txt/);
  assert.equal(events[3].ok, true);
  assert.equal(events.at(-1).result, "done reading");
});

await ok("the prompt can come from stdin", async () => {
  mock.push((body) => `you said: ${body.messages.at(-1).content}`);
  const r = await omni(["-p", "--output", "json"], { stdin: "summarize the repo\n" });
  assert.equal(r.code, 0, r.stderr.slice(-800));
  assert.equal(JSON.parse(r.stdout).result, "you said: summarize the repo");
});

await ok("--max-turns stops the run and exits 3", async () => {
  mock.push({ tool: "read_file", args: { path: "a.txt" } }, { tool: "read_file", args: { path: "a.txt" } }, { tool: "read_file", args: { path: "a.txt" } });
  const r = await omni(["-p", "loop", "--output", "json", "--max-turns", "2"]);
  assert.equal(r.code, 3, r.stderr.slice(-800));
  const res = JSON.parse(r.stdout);
  assert.equal(res.stop, "max_turns");
  assert.equal(res.ok, false);
  mock.push("drain"); // the third scripted reply was never requested
  await omni(["-p", "x", "--output", "json"]);
});

await ok("a missing API key is an error result with exit 1", async () => {
  const r = await omni(["-p", "hi", "--output", "json", "--model", "nokey/m"]);
  assert.equal(r.code, 1);
  const res = JSON.parse(r.stdout);
  assert.equal(res.stop, "error");
  assert.match(res.error, /no API key for provider "nokey"/);
  // Regression: that run's --model used to be saved as the "last good" model,
  // so every later launch started on a provider with no key.
  const last = path.join(home, "last-provider.json");
  const saved = fs.existsSync(last) ? JSON.parse(fs.readFileSync(last, "utf8")) : {};
  assert.notEqual(saved.modelKey || saved.model || saved.key, "nokey/m");
  assert.doesNotMatch(fs.existsSync(last) ? fs.readFileSync(last, "utf8") : "", /nokey/);
});

await ok("no prompt at all is an error, not a hang", async () => {
  const r = await omni(["-p", "--output", "json"], { stdin: "" });
  assert.equal(r.code, 1);
  assert.match(JSON.parse(r.stdout).error, /no prompt/);
});

await ok("a bad --output value fails fast", async () => {
  const r = await omni(["-p", "x", "--output", "yaml"]);
  assert.equal(r.code, 1);
  assert.match(r.stdout + r.stderr, /text, json, stream-json/);
});

await ok("a prompt template works headless too", async () => {
  fs.mkdirSync(path.join(work, ".omni", "commands"), { recursive: true });
  fs.writeFileSync(path.join(work, ".omni", "commands", "explain.md"), "Explain $1 in one line.");
  mock.push((body) => `got: ${body.messages.at(-1).content}`);
  const r = await omni(["-p", "/explain", "a.txt", "--output", "json"]);
  assert.equal(r.code, 0, r.stdout + r.stderr.slice(-800));
  assert.equal(JSON.parse(r.stdout).result, "got: Explain a.txt in one line.");
});

// ── review fixes ──────────────────────────────────────────────────────────

const { runTurn } = await import(u("src/core/agent.mjs"));
const { resolveModel } = await import(u("src/core/config.mjs"));
const { streamSessionEvents, logFailure } = await import(u("src/cli/headless.mjs"));
const { MockSession } = await import(u("tests/_mock-provider.mjs"));

await ok("--max-turns wins over a routed persona's own iteration budget", async () => {
  const model = resolveModel(baseSettings, "mock/main");
  const persona = { id: "coding", maxIterations: 50, systemPrompt: () => "PERSONA" };
  mock.clear();
  for (let i = 0; i < 4; i++) mock.push({ tool: "read_file", args: { path: "a.txt" } });
  const before = mock.requests.length;
  const outcome = await runTurn({ model, settings: baseSettings, messages: [{ role: "system", content: "S" }, { role: "user", content: "go" }], session: new MockSession(), persona, maxIterations: 30, turnLimit: 2, diffPreview: false });
  assert.equal(outcome.stop, "max_turns");
  assert.equal(mock.requests.length - before, 2, "exactly --max-turns model calls");
  // And a persona with a smaller budget can't cut a larger --max-turns short.
  mock.clear();
  mock.push({ tool: "read_file", args: { path: "a.txt" } }, { tool: "read_file", args: { path: "a.txt" } }, "finished on turn 3");
  const done = await runTurn({ model, settings: baseSettings, messages: [{ role: "system", content: "S" }, { role: "user", content: "go" }], session: new MockSession(), persona: { ...persona, maxIterations: 1 }, turnLimit: 3, diffPreview: false });
  assert.equal(done.stop, "done");
});

await ok("/omnibots in json mode still ends with a result object", async () => {
  const r = await omni(["-p", "/omnibots", "status", "--output", "json"]);
  const lines = r.stdout.trim().split("\n").filter(Boolean);
  assert.equal(lines.length, 1, r.stdout);
  const res = JSON.parse(lines[0]);
  assert.equal(res.type, "result");
  assert.equal(res.stop, "done");
  assert.equal(r.code, 0);
});

await ok("stream events are emitted only after their log write lands", async () => {
  const emitted = [];
  const order = [];
  // The first write is slow, the second fast: events still come out in order.
  const session = {
    append: async (rec) => {
      if (rec.content === "slow") await new Promise((r) => setTimeout(r, 40));
      order.push("write:" + rec.content);
      return rec.content !== "lost";
    },
  };
  streamSessionEvents(session, (ev) => { order.push("emit:" + ev.content); emitted.push(ev); });
  session.append({ type: "user", content: "slow" }); // not awaited, like runTurn
  session.append({ type: "user", content: "fast" });
  await session.append({ type: "user", content: "lost" });
  await session.drainStream();
  assert.deepEqual(order, ["write:slow", "emit:slow", "write:fast", "emit:fast", "write:lost"], "in order, write before emit, nothing for a failed write");
  assert.equal(emitted.length, 2);
});

await ok("a run whose log lost records is reported as an error", () => {
  assert.equal(logFailure({ appendFailures: 0 }), null);
  assert.match(logFailure({ appendFailures: 2 }), /2 records lost/);
});

await mock.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
