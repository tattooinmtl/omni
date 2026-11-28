// MCP: the older HTTP+SSE transport, and requests a server sends us
// (sampling/createMessage, elicitation/create, roots/list, ping) over stdio,
// StreamableHTTP and SSE. Plus the front end that answers them
// (src/cli/mcp-client-ui.mjs).
//
// Every server is local: an HTTP mock for SSE and StreamableHTTP, a Node
// child for stdio. No model is called; sampling goes to a stub.
//
// Run: node tests/mcp-sse-sampling.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1")), "..");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "omni-mcp-sse-"));
process.env.OMNI_HOME = home;
const imp = (p) => import(pathToFileURL(path.join(root, p)).href);
const mcp = await imp("src/integrations/mcp.mjs");
const ui = await imp("src/cli/mcp-client-ui.mjs");

let pass = 0, fail = 0;
async function ok(label, fn) {
  try { await fn(); console.log(`  ✓ ${label}`); pass++; }
  catch (e) { console.log(`  ✗ ${label}\n    ${e.stack || e.message}`); fail++; }
}

// What a server does on tools/call: "ask" samples, "form" elicits, "where"
// lists roots, "ping" pings us back. `ask(method, params)` sends a request to
// the client and resolves with its reply.
async function callTool(name, ask) {
  const text = (t) => ({ content: [{ type: "text", text: t }] });
  if (name === "ask") {
    const r = await ask("sampling/createMessage", { messages: [{ role: "user", content: { type: "text", text: "Say hi" } }], maxTokens: 50, systemPrompt: "Be brief." });
    return text(r.error ? `refused: ${r.error.message}` : `model said: ${r.result.content.text} (${r.result.model})`);
  }
  if (name === "form") {
    const r = await ask("elicitation/create", { message: "Pick a plan", requestedSchema: { type: "object", properties: { plan: { type: "string", enum: ["free", "pro"] }, seats: { type: "integer" } }, required: ["plan"] } });
    return text(r.error ? `refused: ${r.error.message}` : JSON.stringify(r.result));
  }
  if (name === "where") { const r = await ask("roots/list", {}); return text(JSON.stringify(r.result.roots)); }
  if (name === "ping") { const r = await ask("ping", {}); return text(JSON.stringify(r)); }
  return text("?");
}
const TOOLS = { tools: ["ask", "form", "where", "ping"].map((n) => ({ name: n, description: n, inputSchema: { type: "object", properties: {} } })) };
let lastCaps = {};

// ── legacy HTTP+SSE server ───────────────────────────────────────────────────
const sseClients = new Map();          // sid → res
const waiting = new Map();             // request id → resolve
let seq = 0;
const sseServer = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (req.method === "GET" && u.pathname === "/sse") {
    const sid = String(++seq);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`event: endpoint\ndata: /messages?sid=${sid}\n\n`);
    sseClients.set(sid, res);
    req.on("close", () => sseClients.delete(sid));
    return;
  }
  if (req.method === "POST" && u.pathname === "/messages") {
    let raw = "";
    req.on("data", (d) => { raw += d; });
    req.on("end", async () => {
      res.writeHead(202); res.end();
      const msg = JSON.parse(raw);
      const out = sseClients.get(u.searchParams.get("sid"));
      const send = (o) => out.write(`event: message\ndata: ${JSON.stringify(o)}\n\n`);
      if (msg.method === undefined && msg.id != null) { waiting.get(msg.id)?.(msg); return; }   // a reply to our request
      if (msg.id == null) return;                                                           // a notification
      let result = {};
      if (msg.method === "initialize") { lastCaps = msg.params.capabilities; result = { protocolVersion: "2024-11-05", capabilities: {} }; }
      else if (msg.method === "tools/list") result = TOOLS;
      else if (msg.method === "tools/call") {
        result = await callTool(msg.params.name, (method, params) => new Promise((resolve) => {
          const id = `srv-${++seq}`;
          waiting.set(id, resolve);
          send({ jsonrpc: "2.0", id, method, params });
        }));
      }
      send({ jsonrpc: "2.0", id: msg.id, result });
    });
    return;
  }
  res.writeHead(404); res.end();
});

// ── StreamableHTTP server (replies as an SSE body, asks mid-reply) ────────────
const shWaiting = new Map();
const shServer = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => { raw += d; });
  req.on("end", async () => {
    const msg = JSON.parse(raw || "{}");
    if (msg.method === undefined && msg.id != null) { res.writeHead(202); res.end(); shWaiting.get(msg.id)?.(msg); return; }
    if (msg.id == null) { res.writeHead(202); res.end(); return; }
    if (msg.method !== "tools/call") {
      if (msg.method === "initialize") lastCaps = msg.params.capabilities;
      res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "s-1" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: msg.method === "tools/list" ? TOOLS : { protocolVersion: "2024-11-05", capabilities: {} } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const result = await callTool(msg.params.name, (method, params) => new Promise((resolve) => {
      const id = `sh-${++seq}`;
      shWaiting.set(id, resolve);
      res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n\n`);
    }));
    res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })}\n\n`);
    res.end();
  });
});

// ── stdio server ─────────────────────────────────────────────────────────────
const stdioPath = path.join(home, "stdio-server.mjs");
fs.writeFileSync(stdioPath, `
import readline from "node:readline";
const waiting = new Map(); let n = 0;
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const ask = (method, params) => new Promise((resolve) => { const id = "io-" + (++n); waiting.set(id, resolve); send({ jsonrpc: "2.0", id, method, params }); });
readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  const msg = JSON.parse(line);
  if (msg.method === undefined && msg.id != null) { waiting.get(msg.id)?.(msg); return; }
  if (msg.id == null) return;
  let result = {};
  if (msg.method === "initialize") result = { protocolVersion: "2024-11-05", capabilities: {}, _caps: msg.params.capabilities };
  else if (msg.method === "tools/list") result = { tools: [{ name: "ask", description: "ask", inputSchema: { type: "object", properties: {} } }] };
  else if (msg.method === "tools/call") {
    const r = await ask("sampling/createMessage", { messages: [{ role: "user", content: { type: "text", text: "Say hi" } }], maxTokens: 50 });
    result = { content: [{ type: "text", text: r.error ? "refused: " + r.error.message : "model said: " + r.result.content.text }] };
  }
  send({ jsonrpc: "2.0", id: msg.id, result });
});
setInterval(() => {}, 1 << 30);
`);

await new Promise((r) => sseServer.listen(0, "127.0.0.1", r));
await new Promise((r) => shServer.listen(0, "127.0.0.1", r));
const sseUrl = `http://127.0.0.1:${sseServer.address().port}/sse`;
const shUrl = `http://127.0.0.1:${shServer.address().port}/mcp`;
mcp.registerMcpProxy({
  servers: {
    legacy: { url: sseUrl },
    streamy: { url: shUrl },
    piped: { command: process.execPath, args: [stdioPath] },
  },
  settings: { idleTimeout: 10, directTools: false },
  untrusted: new Set(),
});
const call = async (server, tool) => mcp.toolResultText(await mcp.callServerTool(server, tool, {}));

// Stub handlers: sampling answers "hi there", the form picks pro.
const sampled = [];
function useHandlers() {
  mcp.setMcpClientHandlers({
    sample: async (server, params) => { sampled.push({ server, params }); return { role: "assistant", content: { type: "text", text: "hi there" }, model: "mock/m", stopReason: "endTurn" }; },
    elicit: async () => ({ action: "accept", content: { plan: "pro", seats: 3 } }),
  });
}

// ── tests ────────────────────────────────────────────────────────────────────
await ok("an /sse url uses the SSE transport; a transport setting wins", () => {
  assert.equal(mcp.usesSseTransport({ url: "http://h/sse" }), true);
  assert.equal(mcp.usesSseTransport({ url: "http://h/mcp" }), false);
  assert.equal(mcp.usesSseTransport({ url: "http://h/events", transport: "sse" }), true);
  assert.equal(mcp.usesSseTransport({ url: "http://h/sse", transport: "http" }), false);
  assert.equal(mcp.usesSseTransport({ command: "x" }), false);
});

await ok("SSE: connects through the endpoint event, lists tools, and the server's sampling request reaches the model", async () => {
  useHandlers();
  sampled.length = 0;
  assert.equal(await call("legacy", "ask"), "model said: hi there (mock/m)");
  assert.deepEqual(Object.keys(lastCaps).sort(), ["elicitation", "roots", "sampling"]);
  assert.equal(sampled[0].server, "legacy");
  assert.equal(sampled[0].params.systemPrompt, "Be brief.");
  assert.equal(await call("legacy", "form"), JSON.stringify({ action: "accept", content: { plan: "pro", seats: 3 } }));
  assert.deepEqual(JSON.parse(await call("legacy", "ping")).result, {}, "our answer to the server's ping");
  const roots = JSON.parse(await call("legacy", "where"));
  assert.equal(roots[0].uri, pathToFileURL(process.cwd()).href);
});

await ok("StreamableHTTP: a request in the middle of a reply is answered, and the reply still arrives", async () => {
  sampled.length = 0;
  assert.equal(await call("streamy", "ask"), "model said: hi there (mock/m)");
  assert.equal(sampled[0].server, "streamy");
  assert.equal(await call("streamy", "form"), JSON.stringify({ action: "accept", content: { plan: "pro", seats: 3 } }));
});

await ok("stdio: the server's sampling request is answered over stdin", async () => {
  sampled.length = 0;
  assert.equal(await call("piped", "ask"), "model said: hi there");
  assert.equal(sampled[0].server, "piped");
});

await ok("without handlers (a headless run) sampling and forms aren't offered, and a request gets an error", async () => {
  mcp.setMcpClientHandlers({});
  assert.deepEqual(mcp.clientCapabilities(), { roots: { listChanged: false } });
  assert.match(await call("streamy", "ask"), /^refused: this Omni session can't sample/);
  assert.match(await call("legacy", "form"), /^refused: this Omni session can't ask the user/);
  const r = await mcp.answerServerRequest("x", { id: 1, method: "resources/subscribe" });
  assert.equal(r.error.code, -32601);
});

// ── the front end ────────────────────────────────────────────────────────────
function fakeCtx(answers) {
  const asked = [];
  return {
    asked,
    model: { key: "mock/m", id: "m", maxTokens: 4096, provider: {} },
    confirmToolUse: async (name, summary) => { asked.push(`${name}: ${summary}`); return answers.shift(); },
    askLine: async (q) => { asked.push(q.replace(/\x1b\[[0-9;]*m/g, "").trim()); return answers.shift(); },
  };
}
const silent = () => {};

await ok("sampling asks first, with what the server sent; no means refused; a = that server for the session", async () => {
  const chats = [];
  const chat = async (o) => { chats.push(o); return { message: { content: "<think>hm</think>Hello!" } }; };
  const ctx = fakeCtx(["n", "a"]);
  const h = ui.makeMcpClientHandlers(ctx, { chat, log: silent });
  const params = { messages: [{ role: "user", content: { type: "text", text: "Say hi" } }, { role: "assistant", content: [{ type: "image", data: "x" }] }], maxTokens: 99999, systemPrompt: "Be brief." };
  await assert.rejects(h.sample("docs", params), /declined this sampling request/);
  assert.equal(chats.length, 0, "nothing reached the model");
  const r = await h.sample("docs", params);
  assert.deepEqual(r, { role: "assistant", content: { type: "text", text: "Hello!" }, model: "mock/m", stopReason: "endTurn" });
  assert.equal(chats[0].model.maxTokens, 4096, "capped at the model's own limit");
  assert.equal(chats[0].tools, null);
  assert.deepEqual(chats[0].messages, [{ role: "system", content: "Be brief." }, { role: "user", content: "Say hi" }, { role: "assistant", content: "[image omitted]" }]);
  await h.sample("docs", params);
  assert.equal(ctx.asked.length, 2, "always for docs: not asked again");
  assert.match(ctx.asked[0], /^mcp sampling for docs: up to 99999 tokens$/);
});

await ok("a form is asked field by field, checked, and can be declined or cancelled", async () => {
  const schema = { type: "object", properties: { plan: { type: "string", enum: ["free", "pro"] }, seats: { type: "integer", minimum: 1 }, notify: { type: "boolean" }, note: { type: "string" } }, required: ["plan", "seats"] };
  let h = ui.makeMcpClientHandlers(fakeCtx(["y", "2", "x", "0", "3", "yes", ""]), { log: silent });
  const quietWarn = console.log; console.log = () => {};
  try {
    assert.deepEqual(await h.elicit("shop", { message: "Pick a plan", requestedSchema: schema }), { action: "accept", content: { plan: "pro", seats: 3, notify: true } });
    h = ui.makeMcpClientHandlers(fakeCtx([""]), { log: silent });
    assert.deepEqual(await h.elicit("shop", { message: "m", requestedSchema: schema }), { action: "decline" });
    h = ui.makeMcpClientHandlers(fakeCtx(["c"]), { log: silent });
    assert.deepEqual(await h.elicit("shop", { message: "m", requestedSchema: schema }), { action: "cancel" });
    h = ui.makeMcpClientHandlers(fakeCtx(["y", "9", "9", "9"]), { log: silent });
    assert.deepEqual(await h.elicit("shop", { message: "m", requestedSchema: schema }), { action: "cancel" }, "three bad answers");
  } finally { console.log = quietWarn; }
});

await ok("a form that asks for a password, key, token or card is declined without asking anything", async () => {
  assert.deepEqual(ui.sensitiveFields({ properties: { user: {}, password: {} } }), ["password"]);
  assert.deepEqual(ui.sensitiveFields({ properties: { k: { title: "Your API key" }, n: { format: "password" }, plan: {} } }), ["k", "n"]);
  const ctx = fakeCtx([]);
  const h = ui.makeMcpClientHandlers(ctx, { log: silent });
  const quietWarn = console.log; console.log = () => {};
  try {
    assert.deepEqual(await h.elicit("evil", { message: "Log in", requestedSchema: { properties: { email: {}, password: {} } } }), { action: "decline" });
  } finally { console.log = quietWarn; }
  assert.equal(ctx.asked.length, 0);
});

await ok("field answers are coerced to their type", () => {
  assert.deepEqual(ui.coerceField("2", { enum: ["a", "b"] }), { value: "b" });
  assert.deepEqual(ui.coerceField("B", { enum: ["a", "b"] }), { value: "b" });
  assert.match(ui.coerceField("c", { enum: ["a", "b"] }).error, /pick one of/);
  assert.deepEqual(ui.coerceField("no", { type: "boolean" }), { value: false });
  assert.deepEqual(ui.coerceField("2.5", { type: "number" }), { value: 2.5 });
  assert.match(ui.coerceField("2.5", { type: "integer" }).error, /whole number/);
  assert.match(ui.coerceField("a@b", { type: "string", format: "email" }).error, /email/);
  assert.deepEqual(ui.coerceField(" hi ", { type: "string" }), { value: "hi" });
});

mcp.disconnectAll();
for (const res of sseClients.values()) res.end();
sseServer.close();
shServer.close();
try { fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* in use */ }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
