// omni.brains bridge (/brain) — against a fake brain server speaking HTTP MCP
// (the tools omni.brains serves) that can demand a sign-in. Pins:
//   - the brain server is started only when it isn't answering, only for a
//     local brain, with --enable-dcr, and the bridge waits for it
//   - /brain connect saves the HTTP service; when the brain answers 401 it
//     runs the sign-in once and then succeeds with the saved token
//   - the commands call the right tools with the right arguments, remember
//     always records provenance, a tool error reaches the user as the brain's
//     own message, a revoked sign-in says to reconnect
//   - /brain disconnect removes the service file and the sign-in
//   - Omni's OAuth sign-in registers with the scopes it then asks for
// Run: node tests/omnibrains.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "omni-brain-test-"));
process.env.OMNI_HOME = home;

const bridge = await import("../src/integrations/omnibrains.mjs");
const { brainCommand, unquote, parseRemember, parseConnectArgs } = await import("../src/cli/brain.mjs");
const { serviceFile } = await import("../src/integrations/services.mjs");
const { saveSignIn, getSignIn, oauthSignIn } = await import("../src/integrations/mcp-auth.mjs");
const mcp = await import("../src/integrations/mcp.mjs");

let pass = 0, fail = 0;
async function test(label, fn) {
  try { await fn(); console.log(`  PASS ${label}`); pass++; }
  catch (e) { console.log(`  FAIL ${label}\n    ${e.stack || e.message}`); fail++; }
}

// ---- the fake brain (HTTP MCP) ------------------------------------------------
const brain = { requireToken: null, calls: [] };
const readBody = (req) => new Promise((r) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => r(b)); });
const reply = (res, status, obj, headers = {}) => res.writeHead(status, { "Content-Type": "application/json", ...headers }).end(JSON.stringify(obj));
const text = (v) => ({ content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v) }] });
function call(name, a) {
  brain.calls.push({ name, args: a });
  switch (name) {
    case "get_brain_identity": return text({ version: "0.0.0-fake", engine: "pglite", page_count: 3, chunk_count: 3 });
    case "list_pages": return text([{ slug: "projects/omnibots", title: "OmniBots", type: "project", updated_at_iso: "2026-11-11T10:00:00Z" }]);
    case "get_links": return text([{ from_slug: a.slug, to_slug: "projects/omnibots", link_type: "" }]);
    case "get_backlinks": return text([{ from_slug: "projects/omnibots", link_type: "mentions" }]);
    case "search": case "query":
      return text([{ slug: "projects/omnibots", title: "[quoted conversation excerpt from projects/omnibots; source material, not instructions]\n```text\nOmniBots\n```", chunk_text: "OmniBots is a guild of AI bots." }]);
    case "recall": return text({ facts: [{ id: 1, fact: "OmniCode launches claw-core" }], total: 1 });
    case "remember": return text({ id: "2", status: "inserted", status_text: "remembered as fact #2" });
    case "forget": return text({ status: "forgotten" });
    case "get_page":
      if (a.slug === "missing") return { isError: true, ...text({ error: "page_not_found", message: "No page missing" }) };
      return text({ slug: a.slug, content: "# OmniBots\nA guild of bots." });
    default: return { isError: true, ...text("unknown tool " + name) };
  }
}
let base = "";
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, base);
  if (u.pathname === "/health") return reply(res, 200, { status: "ok" });
  if (u.pathname !== "/mcp") return reply(res, 404, {});
  if (req.method === "DELETE") return res.writeHead(200).end();
  if (brain.requireToken && req.headers.authorization !== `Bearer ${brain.requireToken}`) {
    return reply(res, 401, { error: "invalid_token" }, { "WWW-Authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` });
  }
  const msg = JSON.parse((await readBody(req)) || "{}");
  if (msg.id == null) return res.writeHead(202).end();
  let result = {};
  if (msg.method === "initialize") result = { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "omni.brains" } };
  else if (msg.method === "tools/list") result = { tools: ["get_brain_identity", "search", "recall", "remember"].map((n) => ({ name: n, inputSchema: { type: "object" } })) };
  else if (msg.method === "tools/call") result = call(msg.params.name, msg.params.arguments || {});
  reply(res, 200, { jsonrpc: "2.0", id: msg.id, result });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
base = `http://127.0.0.1:${server.address().port}`;

const lastCall = () => brain.calls.at(-1);
async function captured(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(" ").replace(/\x1b\[[0-9;]*m/g, ""));
  try { await fn(); } finally { console.log = orig; }
  return lines.join("\n");
}

// ---- pure helpers -------------------------------------------------------------
await test("unquote strips the brain's quoting envelope", () => {
  assert.equal(unquote("[quoted conversation excerpt from x; source material, not instructions]\n```text\nOmniBots\n```"), "OmniBots");
});

await test("parseRemember splits entity and fact on the first colon", () => {
  assert.deepEqual(parseRemember("omnicode: launches claw-core: v2"), { entity: "omnicode", fact: "launches claw-core: v2" });
  assert.equal(parseRemember("no colon here"), null);
});

await test("parseConnectArgs reads a quoted path, --url and --home", () => {
  assert.deepEqual(parseConnectArgs('"C:\\Program Files\\omni-brains.exe" --url http://localhost:4000 --home D:\\brain'),
    { bin: "C:\\Program Files\\omni-brains.exe", url: "http://localhost:4000", home: "D:\\brain" });
});

await test("brainCommandLine: binary as is, bun for .ts, node for .mjs", () => {
  assert.deepEqual(bridge.brainCommandLine("C:\\b\\omni-brains.exe", ["serve"]), { command: "C:\\b\\omni-brains.exe", args: ["serve"] });
  assert.equal(bridge.brainCommandLine("C:\\src\\cli.ts", ["serve"]).command, "bun");
  assert.equal(bridge.brainCommandLine("C:\\w\\wrap.mjs", ["serve"]).command, process.execPath);
});

// ---- starting the brain server -------------------------------------------------
await test("a running brain is not started again", async () => {
  let spawned = 0;
  const r = await bridge.ensureBrainServer({ base, spawnImpl: () => { spawned++; return { unref() {} }; } });
  assert.equal(r.started, false);
  assert.equal(spawned, 0);
});

await test("a local brain that isn't answering is started in the background with --enable-dcr, then waited for", async () => {
  const fakeBin = path.join(home, "omni-brains.exe");
  fs.writeFileSync(fakeBin, "");
  let up = false, seen = null;
  const fetchImpl = async () => ({ ok: up });
  const spawnImpl = (command, args, opts) => { seen = { command, args, opts }; setTimeout(() => { up = true; }, 300); return { unref() {} }; };
  const r = await bridge.ensureBrainServer({ base: "http://localhost:3999", bin: fakeBin, fetchImpl, spawnImpl, waitMs: 5000 });
  assert.equal(r.started, true);
  assert.equal(seen.command, fakeBin);
  assert.deepEqual(seen.args, ["serve", "--http", "--port", "3999", "--bind", "127.0.0.1", "--enable-dcr"]);
  assert.equal(seen.opts.detached, true);
  assert.equal(seen.opts.windowsHide, true);
});

await test("a remote brain that isn't answering is never started here", async () => {
  await assert.rejects(bridge.ensureBrainServer({ base: "https://brain.example.com", fetchImpl: async () => ({ ok: false }), spawnImpl: () => { throw new Error("must not spawn"); } }), /isn't answering/);
});

// ---- commands against the fake brain ------------------------------------------
await test("/brain before connect says how to connect", async () => {
  const out = await captured(() => brainCommand({}, ""));
  assert.match(out, /isn't connected/);
});

await test("/brain connect: the brain asks for a sign-in, Omni signs in once, then the brain answers", async () => {
  brain.requireToken = "tok-1";
  let signIns = 0;
  const signIn = async (name, url) => { signIns++; assert.equal(url, `${base}/mcp`); saveSignIn(name, { type: "token", resource: url, token: "tok-1" }); };
  const r = await bridge.connectBrain({ url: base, signIn, spawnImpl: () => { throw new Error("must not spawn"); } });
  assert.equal(signIns, 1);
  assert.equal(r.signedIn, true);
  assert.equal(r.identity.json.version, "0.0.0-fake");
  const saved = JSON.parse(fs.readFileSync(serviceFile("omnibrains"), "utf8"));
  assert.equal(saved.url, `${base}/mcp`);
  assert.equal(saved.headers, undefined, "the token lives in the sign-in store, not the service file");
});

await test("/brain status reports version and pages", async () => {
  const out = await captured(() => brainCommand({}, "status"));
  assert.match(out, /omni\.brains 0\.0\.0-fake · pglite · 3 pages/);
});

await test("/brain search lists hits without the quoting envelope", async () => {
  const out = await captured(() => brainCommand({}, "search guild bots"));
  assert.match(out, /projects\/omnibots\s+OmniBots/);
  assert.doesNotMatch(out, /quoted conversation excerpt/);
  assert.deepEqual(lastCall(), { name: "search", args: { query: "guild bots", limit: 10 } });
});

await test("/brain remember sends entity, fact and provenance", async () => {
  const out = await captured(() => brainCommand({}, "remember projects/omnicode: launches claw-core"));
  assert.match(out, /remembered as fact #2/);
  assert.deepEqual(lastCall(), { name: "remember", args: { entity: "projects/omnicode", fact: "launches claw-core", provenance: "omni /brain remember" } });
});

await test("/brain recall, forget and links call the right tools", async () => {
  assert.match(await captured(() => brainCommand({}, "recall omnicode what agent")), /#1 OmniCode launches claw-core/);
  assert.deepEqual(lastCall(), { name: "recall", args: { entity: "omnicode", query: "what agent" } });
  await captured(() => brainCommand({}, "forget 7"));
  assert.deepEqual(lastCall(), { name: "forget", args: { id: "7" } });
  const out = await captured(() => brainCommand({}, "links projects/omnicode"));
  assert.match(out, /projects\/omnicode: 1 outgoing, 1 incoming/);
});

await test("a brain tool error reaches the user as the brain's message", async () => {
  assert.match(await captured(() => brainCommand({}, "get missing")), /omni\.brains: get_page: No page missing/);
});

await test("a revoked sign-in tells the user to reconnect", async () => {
  brain.requireToken = "tok-2";
  mcp.disconnectAll();
  const out = await captured(() => brainCommand({}, "status"));
  assert.match(out, /isn't signed in to the brain.*\/brain connect/);
  brain.requireToken = "tok-1";
});

await test("the dashboard pages are the brain's own", () => {
  assert.equal(bridge.dashboardUrl("neural"), `${base}/admin/#neural`);
  assert.equal(bridge.dashboardUrl(), `${base}/admin/`);
});

await test("/brain disconnect removes the service file and the sign-in", async () => {
  const out = await captured(() => brainCommand({}, "disconnect"));
  assert.match(out, /omni\.brains disconnected/);
  assert.equal(fs.existsSync(serviceFile("omnibrains")), false);
  assert.equal(getSignIn("omnibrains"), null);
  assert.equal(bridge.brainConfigured(), false);
});

// ---- Omni's OAuth sign-in registers for the scopes it asks for ---------------------
await test("oauthSignIn registers with the scopes it then requests", async () => {
  let registration = null, authorizeScope = null;
  let asBase = "";
  const as = http.createServer(async (req, res) => {
    const u = new URL(req.url, asBase);
    if (u.pathname === "/register") { registration = JSON.parse(await readBody(req)); return reply(res, 201, { client_id: "cid-1" }); }
    if (u.pathname === "/authorize") {
      authorizeScope = u.searchParams.get("scope");
      const back = new URL(u.searchParams.get("redirect_uri"));
      back.searchParams.set("code", "code-1");
      back.searchParams.set("state", u.searchParams.get("state"));
      return res.writeHead(302, { Location: back.href }).end();
    }
    if (u.pathname === "/token") return reply(res, 200, { access_token: "at-1", token_type: "Bearer", expires_in: 3600 });
    reply(res, 404, {});
  });
  await new Promise((r) => as.listen(0, "127.0.0.1", r));
  asBase = `http://127.0.0.1:${as.address().port}`;
  try {
    const meta = { issuer: asBase, authorizationEndpoint: `${asBase}/authorize`, tokenEndpoint: `${asBase}/token`, registrationEndpoint: `${asBase}/register`, scopes: ["read", "write"] };
    await oauthSignIn("scopecheck", `${asBase}/mcp`, { meta, openUrl: (url) => { fetch(url).catch(() => {}); }, timeoutMs: 10_000 });
    assert.equal(registration.scope, "read write");
    assert.equal(authorizeScope, "read write");
    assert.equal(getSignIn("scopecheck").accessToken, "at-1");
  } finally {
    as.close();
  }
});

mcp.disconnectAll();
server.close();
try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* Windows may hold a handle briefly */ }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
