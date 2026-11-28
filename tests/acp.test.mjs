// `omni --acp`: Agent Client Protocol for editors (src/cli/acp.mjs).
//
// The editor is this test: it writes JSON-RPC lines to Omni's input and
// reads what Omni emits. The model is a local mock (first reply calls
// read_file, the second answers with a think block in front).
//
// Run: node tests/acp.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";

for (const k of Object.keys(process.env)) if (/^OMNI_.*_KEY\d*$/.test(k)) delete process.env[k];
const root = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1")), "..");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "omni-acp-"));
process.env.OMNI_HOME = home;
const work = path.join(home, "proj");
fs.mkdirSync(work);
fs.writeFileSync(path.join(work, "notes.txt"), "hello from the notes\n");
const imp = (p) => import(pathToFileURL(path.join(root, p)).href);
const acp = await imp("src/cli/acp.mjs");
const { resolveModel } = await imp("src/core/config.mjs");

let pass = 0, fail = 0;
async function ok(label, fn) {
  try { await fn(); console.log(`  ✓ ${label}`); pass++; }
  catch (e) { console.log(`  ✗ ${label}\n    ${e.stack || e.message}`); fail++; }
}

let slow = false;
const model = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => { raw += d; });
  req.on("end", async () => {
    const body = JSON.parse(raw);
    // A tool result as the newest message means the answer step; else call the tool.
    const last = body.messages.at(-1);
    const tool = last?.role === "tool" ? last : null;
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    if (slow) await new Promise((r) => setTimeout(r, 3000));
    if (!tool) {
      send({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "notes.txt" }) } }] }, finish_reason: null }] });
      send({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });
    } else {
      const said = /DENIED/.test(String(tool.content)) ? ["Not ", "allowed."] : ["<think>", "hmm", "</think>", "The notes ", "say hello."];
      for (const t of said) send({ choices: [{ delta: { content: t }, finish_reason: null }] });
      send({ choices: [{ delta: {}, finish_reason: "stop" }] });
    }
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
await new Promise((r) => model.listen(0, "127.0.0.1", r));
const settings = {
  reasoning: "medium",
  providers: { mock: { baseUrl: `http://127.0.0.1:${model.address().port}/v1`, apiKey: "k", label: "Mock" } },
  models: { "mock/m": { provider: "mock", id: "m", maxTokens: 256 } },
  fallback: { enabled: false },
  permissions: {},
};
const startDir = process.cwd();
const ctx = { settings, model: resolveModel(settings, "mock/m"), messages: [{ role: "system", content: `You are Omni.\nWorking directory: ${startDir}` }], contextMode: "classic" };

// ── the editor side ──────────────────────────────────────────────────────────
const input = new PassThrough();
const out = [];
let onEmit = null;
acp.startAcp(ctx, { emit: (m) => { out.push(m); onEmit?.(m); }, input, onExit: () => {} });
const send = (m) => input.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
let rid = 0;
function call(method, params) {
  const id = ++rid;
  return new Promise((resolve) => {
    const check = () => { const r = out.find((m) => m.id === id && (m.result !== undefined || m.error)); if (r) { onEmit = null; resolve(r); return true; } return false; };
    onEmit = (m) => { if (m.method === "session/request_permission") permissionAsked(m); check(); };
    send({ id, method, params });
  });
}
let permissionAnswer = "allow-once";
const asked = [];
function permissionAsked(m) {
  asked.push(m.params);
  send({ id: m.id, result: { outcome: permissionAnswer ? { outcome: "selected", optionId: permissionAnswer } : { outcome: "cancelled" } } });
}
const updates = (sid) => out.filter((m) => m.method === "session/update" && m.params.sessionId === sid).map((m) => m.params.update);

// ── tests ────────────────────────────────────────────────────────────────────
await ok("initialize answers protocol 1 with Omni's capabilities", async () => {
  const r = await call("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } } });
  assert.equal(r.result.protocolVersion, 1);
  assert.equal(r.result.agentInfo.name, "omni");
  assert.deepEqual(r.result.agentCapabilities.promptCapabilities, { image: false, audio: false, embeddedContext: true });
  assert.deepEqual(r.result.authMethods, []);
});

let sid;
await ok("session/new makes a session in the editor's folder", async () => {
  const r = await call("session/new", { cwd: work, mcpServers: [] });
  sid = r.result.sessionId;
  assert.match(sid, /^sess_[0-9a-f]{16}$/);
  assert.equal(path.resolve(process.cwd()), path.resolve(work));
});

await ok("a prompt streams the reply (think left out), reports the tool call and its result, and ends the turn", async () => {
  const r = await call("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: "what do the notes say?" }, { type: "resource", resource: { uri: "file:///x/a.js", mimeType: "text/javascript", text: "let a = 1;" } }] });
  assert.deepEqual(r.result, { stopReason: "end_turn" });
  const u = updates(sid);
  const call0 = u.find((x) => x.sessionUpdate === "tool_call");
  assert.equal(call0.toolCallId, "c1");
  assert.equal(call0.kind, "read");
  assert.equal(call0.status, "in_progress");
  assert.equal(call0.title, "read_file notes.txt");
  assert.deepEqual(call0.locations, [{ path: path.join(work, "notes.txt") }]);
  const done = u.find((x) => x.sessionUpdate === "tool_call_update");
  assert.equal(done.status, "completed");
  assert.match(done.content[0].content.text, /hello from the notes/);
  const text = u.filter((x) => x.sessionUpdate === "agent_message_chunk").map((x) => x.content.text).join("");
  assert.equal(text, "The notes say hello.");
});

await ok("a tool set to ask goes to the editor's permission dialog; reject is a no", async () => {
  settings.permissions = { read_file: "ask" };
  try {
    permissionAnswer = "reject-once";
    const r = await call("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: "again" }] });
    assert.equal(r.result.stopReason, "end_turn");
    assert.equal(asked.length, 1);
    assert.equal(asked[0].sessionId, sid);
    assert.deepEqual(asked[0].options.map((o) => o.kind), ["allow_once", "allow_always", "reject_once"]);
    assert.match(asked[0].toolCall.title, /^read_file/);
    const failed = updates(sid).filter((x) => x.sessionUpdate === "tool_call_update").at(-1);
    assert.equal(failed.status, "failed");
  } finally { settings.permissions = {}; }
});

await ok("session/cancel stops the turn with stopReason cancelled", async () => {
  slow = true;
  const pending = call("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: "slow one" }] });
  await new Promise((r) => setTimeout(r, 400));
  send({ method: "session/cancel", params: { sessionId: sid } });
  const r = await pending;
  slow = false;
  assert.equal(r.result.stopReason, "cancelled");
});

await ok("bad requests get JSON-RPC errors", async () => {
  assert.equal((await call("session/prompt", { sessionId: "sess_nope", prompt: [{ type: "text", text: "x" }] })).error.code, -32602);
  assert.equal((await call("session/prompt", { sessionId: sid, prompt: [] })).error.code, -32602);
  assert.equal((await call("session/fork", {})).error.code, -32601);
});

await ok("helpers: tool kinds, titles, prompt blocks", () => {
  assert.equal(acp.toolKind("run_shell"), "execute");
  assert.equal(acp.toolKind("apply_patch"), "edit");
  assert.equal(acp.toolKind("mystery"), "other");
  assert.equal(acp.describeCall("run_shell", { command: "npm test" }).title, "run_shell: npm test");
  assert.equal(acp.promptText([{ type: "text", text: "hi" }, { type: "resource_link", uri: "file:///a.md", name: "a.md" }]), "hi\n\n(the editor refers to file:///a.md — a.md)");
});

input.end();
model.close();
process.chdir(root);
try { fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* in use */ }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
