// RPC mode (src/cli/rpc.mjs): `omni --rpc`, JSON lines over stdio.
//
// Drives the real CLI against a local mock provider: ready event, prompt
// with streamed events and a reply, a permission prompt answered by the
// client, a question from ask_user, status, commands, errors and exit.
//
// Run: node tests/rpc.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
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
const { startMockProvider } = await import(u("tests/_mock-provider.mjs"));

const mock = await startMockProvider();
const home = fs.mkdtempSync(path.join(os.tmpdir(), "omni-rpc-home-"));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "omni-rpc-work-"));
fs.writeFileSync(path.join(home, "settings.json"), JSON.stringify({
  defaultModel: "mock/main",
  providers: { mock: { baseUrl: mock.baseUrl, apiKey: "k" } },
  models: {
    "mock/main": { provider: "mock", id: "main-model", maxTokens: 256, contextWindow: 32768 },
    "mock/cheap": { provider: "mock", id: "cheap-model", maxTokens: 256, contextWindow: 32768 },
  },
  router: { enabled: false },
  checkpoints: false,
  permissions: { write_file: "ask" },
}));

const child = spawn(process.execPath, [path.join(root, "bin", "omni.mjs"), "--rpc"], {
  cwd: work, env: { ...process.env, OMNI_HOME: home, OMNI_NO_HOOKS: "1" },
});
let stderr = "";
child.stderr.on("data", (d) => { stderr += d; });
const lines = [];
const waiters = [];
readline.createInterface({ input: child.stdout }).on("line", (l) => {
  let msg;
  try { msg = JSON.parse(l); } catch { msg = { type: "NOT_JSON", raw: l }; }
  lines.push(msg);
  for (const w of [...waiters]) if (w.match(msg)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(msg); }
});
const waitFor = (match, ms = 60000) => {
  const found = lines.find(match);
  if (found) return Promise.resolve(found);
  return new Promise((resolve, reject) => {
    const w = { match, resolve };
    waiters.push(w);
    setTimeout(() => reject(new Error(`timed out; stderr tail: ${stderr.slice(-500)}`)), ms);
  });
};
let nextId = 1;
const send = (method, params = {}) => {
  const id = nextId++;
  child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  return waitFor((m) => m.id === id);
};

await ok("starts with a ready event; stdout carries only JSON", async () => {
  const ready = await waitFor((m) => m.type === "ready");
  assert.match(ready.session, /^omni-session-/);
  assert.equal(ready.model, "mock/main");
  assert.equal(ready.mode, "default");
});

await ok("prompt streams events and replies with the result", async () => {
  mock.push("Hello from the agent.");
  const reply = await send("prompt", { text: "say hello" });
  assert.equal(reply.result.stop, "done");
  assert.equal(reply.result.result, "Hello from the agent.");
  assert.ok(lines.some((m) => m.type === "user" && m.content === "say hello"));
  assert.ok(lines.some((m) => m.type === "assistant" && m.text === "Hello from the agent."));
});

await ok("a tool set to ask sends a confirm event; the client's yes lets it run", async () => {
  mock.push({ tool: "write_file", args: { path: "note.txt", content: "approved" } }, "Wrote it.");
  const replyP = send("prompt", { text: "write note.txt" });
  const confirm = await waitFor((m) => m.type === "confirm");
  assert.equal(confirm.tool, "write_file");
  await send("confirm", { requestId: confirm.requestId, answer: "y" });
  const reply = await replyP;
  assert.equal(reply.result.result, "Wrote it.");
  assert.equal(fs.readFileSync(path.join(work, "note.txt"), "utf8"), "approved");
});

await ok("a no from the client denies the call", async () => {
  mock.push({ tool: "write_file", args: { path: "denied.txt", content: "x" } }, "Okay, I won't.");
  const replyP = send("prompt", { text: "write denied.txt" });
  const confirm = await waitFor((m) => m.type === "confirm" && m.requestId !== lines.find((x) => x.type === "confirm").requestId);
  await send("confirm", { requestId: confirm.requestId, answer: "n" });
  await replyP;
  assert.ok(!fs.existsSync(path.join(work, "denied.txt")));
  assert.ok(lines.some((m) => m.type === "tool_result" && /declined/.test(m.result)));
});

await ok("ask_user becomes a question event the client answers", async () => {
  mock.push({ tool: "ask_user", args: { question: "Which database?", options: ["sqlite", "postgres"] } }, (body) => `Using ${body.messages.at(-1).content}`);
  const replyP = send("prompt", { text: "set up storage" });
  const q = await waitFor((m) => m.type === "question");
  assert.equal(q.question, "Which database?");
  assert.deepEqual(q.options, ["sqlite", "postgres"]);
  await send("answer", { requestId: q.requestId, text: "postgres" });
  const reply = await replyP;
  assert.match(reply.result.result, /postgres/);
});

await ok("status, set_mode, set_model and slash commands", async () => {
  assert.equal((await send("set_mode", { mode: "plan" })).result.mode, "plan");
  const st = await send("status");
  assert.equal(st.result.mode, "plan");
  assert.equal(st.result.running, false);
  assert.equal((await send("command", { line: "/mode default" })).result.mode, "default");
  assert.equal((await send("set_model", { model: "mock/cheap" })).result.model, "mock/cheap");
  const before = st.result.session;
  const cleared = await send("command", { line: "/clear" });
  assert.notEqual(cleared.result.session, before, "/clear starts a new session");
});

await ok("errors: bad JSON, unknown method, unknown command, steering with nothing running", async () => {
  child.stdin.write("this is not json\n");
  await waitFor((m) => m.type === "error" && /not JSON/.test(m.message));
  assert.match((await send("fly")).error.message, /unknown method "fly"/);
  assert.match((await send("command", { line: "/nope" })).error.message, /unknown command/);
  assert.match((await send("steer", { text: "x" })).error.message, /no turn is running/);
});

await ok("every stdout line was JSON", () => {
  assert.ok(!lines.some((m) => m.type === "NOT_JSON"), JSON.stringify(lines.find((m) => m.type === "NOT_JSON")));
});

await ok("exit ends the process", async () => {
  const code = new Promise((resolve) => child.on("close", resolve));
  await send("exit");
  assert.equal(await code, 0);
});

await mock.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
