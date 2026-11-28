// `omni --serve`: the OpenAI-compatible API (src/cli/serve.mjs).
//
// The model behind it is a local mock (first reply calls read_file, the
// second answers); the API is called over real HTTP on 127.0.0.1.
//
// Run: node tests/api-server.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

for (const k of Object.keys(process.env)) if (/^OMNI_.*_KEY\d*$/.test(k)) delete process.env[k];
const root = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1")), "..");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "omni-serve-"));
process.env.OMNI_HOME = home;
const work = path.join(home, "work");
fs.mkdirSync(work);
fs.writeFileSync(path.join(work, "notes.txt"), "hello from the notes\n");
process.chdir(work);
const imp = (p) => import(pathToFileURL(path.join(root, p)).href);
const serve = await imp("src/cli/serve.mjs");
const { resolveModel } = await imp("src/core/config.mjs");

let pass = 0, fail = 0;
async function ok(label, fn) {
  try { await fn(); console.log(`  ✓ ${label}`); pass++; }
  catch (e) { console.log(`  ✗ ${label}\n    ${e.stack || e.message}`); fail++; }
}

// ── the model behind the API ─────────────────────────────────────────────────
let bodies = [];
const model = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => { raw += d; });
  req.on("end", () => {
    const body = JSON.parse(raw);
    bodies.push(body);
    const tool = body.messages.find((m) => m.role === "tool");
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    if (!tool) {
      send({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "notes.txt" }) } }] }, finish_reason: null }] });
      send({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });
    } else {
      const said = /DENIED/.test(String(tool.content)) ? ["I ", "was ", "not ", "allowed."] : ["<think>", "checking", "</think>", "The ", "notes ", "say ", "hello."];
      for (const t of said) send({ choices: [{ delta: { content: t }, finish_reason: null }] });
      send({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } });
    }
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
await new Promise((r) => model.listen(0, "127.0.0.1", r));

const settings = {
  reasoning: "medium",
  providers: { mock: { baseUrl: `http://127.0.0.1:${model.address().port}/v1`, apiKey: "k", label: "Mock" } },
  models: { "mock/m": { provider: "mock", id: "m", maxTokens: 256 }, "mock/other": { provider: "mock", id: "other", maxTokens: 256 } },
  fallback: { enabled: false },
  permissions: {},
};
const ctx = { settings, model: resolveModel(settings, "mock/m"), messages: [{ role: "system", content: "You are Omni." }], contextMode: "classic" };
const logs = [];
const { server, token } = await serve.startServe(ctx, { port: 0 }, { log: (s) => logs.push(s) });
const base = `http://127.0.0.1:${server.address().port}`;
const auth = { authorization: `Bearer ${token}` };
const post = (body, headers = auth) => fetch(`${base}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

// ── tests ────────────────────────────────────────────────────────────────────
await ok("it says where it listens and prints the token it made", () => {
  assert.match(logs[0], /^Omni API on http:\/\/127\.0\.0\.1:\d+\/v1 \(this PC only\) — model "omni" is mock\/m/);
  assert.match(logs[1], new RegExp(`token .*: ${token}$`));
  assert.ok(token.length >= 32);
  assert.equal(server.address().address, "127.0.0.1");
});

await ok("no token, a wrong token, or a request from a web page is refused; /health needs none", async () => {
  assert.equal((await fetch(`${base}/health`)).status, 200);
  assert.equal((await fetch(`${base}/v1/models`)).status, 401);
  assert.equal((await fetch(`${base}/v1/models`, { headers: { authorization: "Bearer nope" } })).status, 401);
  const fromPage = await fetch(`${base}/v1/models`, { headers: { ...auth, origin: "https://evil.example" } });
  assert.equal(fromPage.status, 403);
  assert.equal((await fromPage.json()).error.type, "permission_error");
});

await ok("/v1/models lists omni and the configured models", async () => {
  const r = await (await fetch(`${base}/v1/models`, { headers: auth })).json();
  assert.equal(r.object, "list");
  assert.deepEqual(r.data.map((m) => m.id), ["omni", "mock/m", "mock/other"]);
});

await ok("a completion runs the agent with its tools and returns its last reply, think block left out", async () => {
  bodies = [];
  const r = await post({ model: "omni", messages: [{ role: "system", content: "Be terse." }, { role: "user", content: "what do the notes say?" }] });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.object, "chat.completion");
  assert.equal(j.model, "mock/m");
  assert.deepEqual(j.choices[0].message, { role: "assistant", content: "The notes say hello." });
  assert.equal(j.choices[0].finish_reason, "stop");
  assert.equal(j.usage.total_tokens > 0, true);
  assert.equal(bodies.length, 2, "two model calls: the tool step and the answer");
  // The provider layer folds every system message into the first one.
  assert.match(bodies[0].messages[0].content, /^You are Omni\.[\s\S]*# Instructions from the API client\nBe terse\./);
  assert.equal(bodies[0].messages[1].content, "what do the notes say?");
  assert.match(String(bodies[1].messages.find((m) => m.role === "tool").content), /hello from the notes/);
  assert.deepEqual(ctx.messages, [{ role: "system", content: "You are Omni." }], "each request is its own conversation");
});

await ok("stream: true sends the words as they come, then the finish, usage and [DONE]", async () => {
  const r = await post({ model: "mock/m", stream: true, messages: [{ role: "user", content: [{ type: "text", text: "notes?" }] }] });
  assert.equal(r.headers.get("content-type"), "text/event-stream");
  const text = await r.text();
  const events = text.split("\n\n").filter(Boolean).map((e) => e.replace(/^data: /, ""));
  assert.equal(events.at(-1), "[DONE]");
  const chunks = events.slice(0, -1).map((e) => JSON.parse(e));
  assert.deepEqual(chunks[0].choices[0].delta, { role: "assistant" });
  const words = chunks.map((c) => c.choices[0]?.delta?.content || "").join("");
  assert.equal(words, "The notes say hello.");
  assert.ok(chunks.some((c) => c.choices[0]?.finish_reason === "stop"));
  assert.ok(chunks.at(-1).usage.total_tokens > 0);
});

await ok("a tool set to ask is refused, since no one is there to OK it", async () => {
  settings.permissions = { read_file: "ask" };
  try {
    const j = await (await post({ messages: [{ role: "user", content: "notes?" }] })).json();
    assert.equal(j.choices[0].message.content, "I was not allowed.");
  } finally { settings.permissions = {}; }
});

await ok("an unknown model or no user message is a 4xx in OpenAI's error shape", async () => {
  const a = await post({ model: "gpt-9", messages: [{ role: "user", content: "hi" }] });
  assert.equal(a.status, 404);
  assert.equal((await a.json()).error.code, "model_not_found");
  const b = await post({ messages: [{ role: "system", content: "x" }] });
  assert.equal(b.status, 400);
  const c = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers: auth, body: "{not json" });
  assert.equal(c.status, 400);
});

await ok("two requests at once both finish (they run one after the other)", async () => {
  const [a, b] = await Promise.all([post({ messages: [{ role: "user", content: "1" }] }), post({ messages: [{ role: "user", content: "2" }] })]);
  assert.equal((await a.json()).choices[0].message.content, "The notes say hello.");
  assert.equal((await b.json()).choices[0].message.content, "The notes say hello.");
});

await ok("flags: --port and --token are read and removed; a short token is refused", () => {
  const args = ["--port", "9001", "--token", "0123456789abcdef0123", "rest"];
  assert.deepEqual(serve.parseServeArgs(args), { port: 9001, token: "0123456789abcdef0123" });
  assert.deepEqual(args, ["rest"]);
  assert.throws(() => serve.parseServeArgs(["--token", "short"]), /at least 16/);
  assert.throws(() => serve.parseServeArgs(["--port", "x"]), /--port/);
});

await ok("the think filter drops think blocks split across tokens", () => {
  const out = [];
  const f = serve.thinkFilter((t) => out.push(t));
  for (const t of ["Hi <thi", "nk>secret</th", "ink> there <", "b>"]) f(t);
  assert.equal(out.join(""), "Hi  there <b>");
  f("!");
  assert.equal(out.join(""), "Hi  there <b>!");
  const out2 = [];
  const g = serve.thinkFilter((t) => out2.push(t));
  g("a <");
  assert.equal(out2.join(""), "a ", "a '<' that may start <think> waits for the next token");
  g("3");
  assert.equal(out2.join(""), "a <3");
  g(" <");
  g.flush();
  assert.equal(out2.join(""), "a <3 <", "flush sends what was held back at the end");
});

server.close();
model.close();
process.chdir(root);
try { fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* in use */ }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
