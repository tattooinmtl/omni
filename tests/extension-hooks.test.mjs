// In-process extension hooks: TransformToolResult, PreModelCall,
// PostModelCall, StreamToken, SessionEnd (src/core/hooks.mjs, src/core/agent.mjs).
//
// The model is a local mock server: its first reply calls read_file, its
// second answers in text. Every request body is kept, so the test sees what
// the hooks changed on the way to the model.
//
// Run: node tests/extension-hooks.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

for (const k of Object.keys(process.env)) if (/^OMNI_.*_KEY\d*$/.test(k)) delete process.env[k];
delete process.env.OMNI_NO_HOOKS;
const root = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1")), "..");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "omni-ext-hooks-"));
process.env.OMNI_HOME = home;
const work = path.join(home, "work");
fs.mkdirSync(work);
fs.writeFileSync(path.join(work, "notes.txt"), "the secret token is sk-test-1234\nand some more text\n");
process.chdir(work);
const imp = (p) => import(pathToFileURL(path.join(root, p)).href);
const hooks = await imp("src/core/hooks.mjs");
const { runTurn } = await imp("src/core/agent.mjs");
const { resolveModel } = await imp("src/core/config.mjs");
const { registerExtensions } = await imp("src/tools/index.mjs");

let pass = 0, fail = 0;
async function ok(label, fn) {
  try { await fn(); console.log(`  ✓ ${label}`); pass++; }
  catch (e) { console.log(`  ✗ ${label}\n    ${e.stack || e.message}`); fail++; }
}

// ── mock model ───────────────────────────────────────────────────────────────
let bodies = [];
const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => { raw += d; });
  req.on("end", () => {
    const body = JSON.parse(raw);
    bodies.push(body);
    const sawTool = body.messages.some((m) => m.role === "tool");
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    if (!sawTool) {
      send({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "notes.txt" }) } }] }, finish_reason: null }] });
      send({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });
    } else {
      for (const t of ["The ", "file ", "says ", "hello."]) send({ choices: [{ delta: { content: t }, finish_reason: null }] });
      send({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 } });
    }
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));

const settings = {
  reasoning: "medium",
  providers: { mock: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "k-mock", label: "Mock" } },
  models: { "mock/m": { provider: "mock", id: "m", maxTokens: 256 } },
  fallback: { enabled: false },
};
class MockSession { constructor() { this.records = []; } async append(r) { this.records.push(r); } setContextTokens() {} addCost() {} }

async function turn() {
  bodies = [];
  const messages = [{ role: "system", content: "You are a test agent." }, { role: "user", content: "read notes.txt" }];
  const session = new MockSession();
  await runTurn({ model: resolveModel(settings, "mock/m"), settings, messages, session, maxIterations: 4, diffPreview: false });
  return { messages, session };
}
const toolMsg = (body) => body.messages.find((m) => m.role === "tool");

// ── tests ────────────────────────────────────────────────────────────────────
await ok("without hooks the tool result goes to the model as it is", async () => {
  hooks.clearHooks();
  await turn();
  assert.equal(bodies.length, 2);
  assert.match(String(toolMsg(bodies[1]).content), /sk-test-1234/);
});

await ok("TransformToolResult replaces a tool's result, for the model and the history, and only for matching tools", async () => {
  hooks.clearHooks();
  const seen = [];
  hooks.registerHook({ event: "TransformToolResult", matcher: "read_file", name: "redact", source: "test", fn: ({ tool, args, result }) => {
    seen.push({ tool, path: args.path });
    return { result: result.replace(/sk-[\w-]+/g, "[redacted]") };
  } });
  hooks.registerHook({ event: "TransformToolResult", matcher: "run_shell", name: "never", source: "test", fn: () => ({ result: "WRONG" }) });
  const { messages } = await turn();
  assert.deepEqual(seen, [{ tool: "read_file", path: "notes.txt" }]);
  const sent = String(toolMsg(bodies[1]).content);
  assert.match(sent, /\[redacted\]/);
  assert.doesNotMatch(sent, /sk-test-1234|WRONG/);
  assert.match(String(messages.find((m) => m.role === "tool").content), /\[redacted\]/, "the history keeps the replaced text");
});

await ok("transforms chain in order, and PostToolUse sees the transformed result", async () => {
  hooks.clearHooks();
  hooks.registerHook({ event: "TransformToolResult", name: "a", source: "test", fn: ({ result }) => ({ result: result.toUpperCase() }) });
  hooks.registerHook({ event: "TransformToolResult", name: "b", source: "test", fn: ({ result }) => ({ result: `<<${result.slice(0, 20)}>>` }) });
  let post = "";
  hooks.registerHook({ event: "PostToolUse", name: "watch", source: "test", fn: ({ result }) => { post = result; } });
  await turn();
  // read_file numbers its lines: "    1\t…", upper-cased by a, then cut by b.
  assert.match(String(toolMsg(bodies[1]).content), /^<<\s*1\tTHE SECRET TOK>>$/);
  assert.match(post, /^<<\s*1\tTHE SECRET/);
});

await ok("PreModelCall can add to the system message or send other messages, without touching the history", async () => {
  hooks.clearHooks();
  const steps = [];
  hooks.registerHook({ event: "PreModelCall", name: "ctx", source: "test", fn: ({ model, step, messages, tools }) => {
    steps.push({ model, step, n: messages.length, hasRead: tools.includes("read_file") });
    return { additionalContext: "Answer in French." };
  } });
  const { messages } = await turn();
  assert.deepEqual(steps.map((s) => s.step), [0, 1]);
  assert.equal(steps[0].model, "mock/m");
  assert.ok(steps[0].hasRead);
  for (const b of bodies) assert.match(b.messages[0].content, /You are a test agent\.[\s\S]*Answer in French\.$/);
  assert.doesNotMatch(messages[0].content, /Answer in French/, "the history's system message is unchanged");

  hooks.clearHooks();
  hooks.registerHook({ event: "PreModelCall", name: "swap", source: "test", fn: ({ messages: m }) => ({ messages: [...m, { role: "user", content: "(extra note from a hook)" }] }) });
  await turn();
  assert.equal(bodies[0].messages.at(-1).content, "(extra note from a hook)");
});

await ok("PostModelCall sees each reply and can change what is kept; StreamToken sees every token", async () => {
  hooks.clearHooks();
  const replies = [];
  const tokens = [];
  hooks.registerHook({ event: "PostModelCall", name: "post", source: "test", fn: ({ content, toolCalls, usage }) => {
    replies.push({ content, toolCalls });
    if (content) return { content: content + " [checked]" };
  } });
  hooks.registerHook({ event: "StreamToken", name: "tok", source: "test", fn: ({ token }) => { tokens.push(token); } });
  const { messages } = await turn();
  assert.deepEqual(replies[0].toolCalls, ["read_file"]);
  assert.equal(replies[1].content, "The file says hello.");
  assert.equal(messages.at(-1).content, "The file says hello. [checked]");
  assert.equal(tokens.join(""), "The file says hello.");
});

await ok("a StreamToken hook that throws doesn't break the stream, and is dropped after ten failures", async () => {
  hooks.clearHooks();
  let calls = 0;
  hooks.registerHook({ event: "StreamToken", name: "bad", source: "test", fn: () => { calls++; throw new Error("boom"); } });
  for (let i = 0; i < 15; i++) hooks.emitStreamToken("x");
  assert.equal(calls, 10);
  const { messages } = await turn();
  assert.equal(messages.at(-1).content, "The file says hello.");
});

await ok("the extension-only events refuse command hooks; SessionEnd takes either", async () => {
  for (const event of ["TransformToolResult", "PreModelCall", "PostModelCall", "StreamToken"]) {
    assert.throws(() => hooks.registerHook({ event, command: "echo hi" }), /run inside Omni: an extension's hooks/);
  }
  hooks.clearHooks();
  hooks.registerHook({ event: "SessionEnd", command: "node -e \"process.exit(0)\"", source: "test" });
  let ended = null;
  hooks.registerHook({ event: "SessionEnd", source: "test", fn: (p) => { ended = p.reason; } });
  const r = await hooks.runHooks("SessionEnd", { reason: "exit" });
  assert.equal(r.ran, 2);
  assert.equal(ended, "exit");
  assert.deepEqual(r.errors, []);
});

await ok("an extension file's hooks object registers the new events", async () => {
  hooks.clearHooks();
  const extDir = path.join(home, "ext");
  fs.mkdirSync(extDir);
  fs.writeFileSync(path.join(extDir, "redact.js"), `export default {
    name: "redact",
    tools: [],
    impl: {},
    hooks: {
      TransformToolResult: { matcher: "read_file", run: ({ result }) => ({ result: result.replace(/sk-[\\w-]+/g, "[gone]") }) },
    },
  };`);
  const loaded = await registerExtensions(extDir, ["redact.js"]);
  assert.ok(!String(loaded[0]).includes("failed"), String(loaded[0]));
  assert.ok(hooks.listHooks().some((h) => h.event === "TransformToolResult" && h.kind === "extension" && /read_file/.test(h.matcher)));
  await turn();
  assert.match(String(toolMsg(bodies[1]).content), /\[gone\]/);
});

hooks.clearHooks();
server.close();
process.chdir(root);
try { fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* still in use */ }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
