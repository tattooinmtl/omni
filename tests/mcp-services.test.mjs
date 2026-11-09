// /connections, /connect [service], /disconnect [service].
//
// Drives the real commands against an in-process fake: an MCP server over
// StreamableHTTP plus an OAuth authorization server (protected-resource and
// AS metadata, dynamic client registration, PKCE-checked code exchange,
// refresh). Pins:
//   - /connect writes <HOME>/mcp/<name>.json and connects in this session
//   - a 401 with OAuth metadata runs the browser sign-in and saves it; a 401
//     without falls back to asking for a token
//   - the saved sign-in is only ever sent to the URL it was made for
//   - an expired access token is refreshed, not re-asked
//   - /connect on an existing service signs in again
//   - /disconnect deletes the definition, the sign-in and the cached tools,
//     and refuses servers defined in omni.config.json / .mcp.json
//   - a new service that never connected leaves nothing behind
//
// Run: node tests/mcp-services.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "omni-services-"));
process.env.OMNI_HOME = home;

const { connectCommand, disconnectCommand, connectionsLines } = await import("../src/cli/services-cmd.mjs");
const { SERVICES_DIR, serviceFile, definitionFromTarget } = await import("../src/integrations/services.mjs");
const { AUTH_PATH, getSignIn, authHeaderSync, signInState } = await import("../src/integrations/mcp-auth.mjs");
const mcp = await import("../src/integrations/mcp.mjs");
const { impl } = await import("../src/tools/index.mjs");
const { loadMcpConfig } = await import("../src/integrations/extras.mjs");
const { COMMANDS } = await import("../src/cli/commands.mjs");

let pass = 0, fail = 0;
async function test(label, fn) {
  try { await fn(); console.log(`  PASS ${label}`); pass++; }
  catch (e) { console.log(`  FAIL ${label}\n    ${e.stack || e.message}`); fail++; }
}

// ---- the fake ---------------------------------------------------------------

const as = { registrations: 0, challenge: null, validTokens: new Set(["tok-xyz"]), refreshes: 0 };
let base = "";

function readBody(req) {
  return new Promise((r) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => r(b)); });
}
const json = (res, status, obj, headers = {}) => res.writeHead(status, { "Content-Type": "application/json", ...headers }).end(JSON.stringify(obj));

async function rpcReply(req, res, auth) {
  const msg = JSON.parse(await readBody(req) || "{}");
  if (msg.id == null) { res.writeHead(202).end(); return; }
  let result = {};
  if (msg.method === "initialize") result = { protocolVersion: "2024-11-05", capabilities: {} };
  else if (msg.method === "tools/list") result = { tools: [{ name: "whoami", description: "who called", inputSchema: { type: "object", properties: {} } }] };
  else if (msg.method === "tools/call") result = { content: [{ type: "text", text: `auth=${auth || "none"}` }] };
  json(res, 200, { jsonrpc: "2.0", id: msg.id, result });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, base);
  const auth = req.headers.authorization || "";
  if (req.method === "DELETE") { res.writeHead(200).end(); return; }

  if (u.pathname === "/.well-known/oauth-protected-resource/mcp") {
    return json(res, 200, { resource: `${base}/mcp`, authorization_servers: [`${base}/as`] });
  }
  if (u.pathname === "/.well-known/oauth-authorization-server/as") {
    return json(res, 200, {
      issuer: `${base}/as`,
      authorization_endpoint: `${base}/as/authorize`,
      token_endpoint: `${base}/as/token`,
      registration_endpoint: `${base}/as/register`,
    });
  }
  if (u.pathname === "/as/register") {
    const reg = JSON.parse(await readBody(req));
    assert.ok(reg.redirect_uris[0].startsWith("http://127.0.0.1:"), "redirect is a loopback URL");
    as.registrations++;
    return json(res, 201, { client_id: `cid-${as.registrations}` });
  }
  if (u.pathname === "/as/authorize") {
    assert.equal(u.searchParams.get("code_challenge_method"), "S256");
    assert.equal(u.searchParams.get("resource"), `${base}/mcp`);
    as.challenge = u.searchParams.get("code_challenge");
    const back = new URL(u.searchParams.get("redirect_uri"));
    back.searchParams.set("code", "code-1");
    back.searchParams.set("state", u.searchParams.get("state"));
    res.writeHead(302, { Location: back.href }).end();
    return;
  }
  if (u.pathname === "/as/token") {
    const p = new URLSearchParams(await readBody(req));
    if (p.get("grant_type") === "authorization_code") {
      const expect = createHash("sha256").update(p.get("code_verifier") || "").digest("base64url");
      if (expect !== as.challenge || p.get("code") !== "code-1") return json(res, 400, { error: "invalid_grant" });
      as.validTokens.add("at-1");
      return json(res, 200, { access_token: "at-1", refresh_token: "rt-1", expires_in: 3600 });
    }
    if (p.get("grant_type") === "refresh_token" && p.get("refresh_token") === "rt-1") {
      as.refreshes++;
      as.validTokens.add("at-2");
      return json(res, 200, { access_token: "at-2", expires_in: 3600 });
    }
    return json(res, 400, { error: "invalid_grant" });
  }
  if (u.pathname === "/open") return rpcReply(req, res, auth);
  if (u.pathname === "/mcp" || u.pathname === "/tokmcp") {
    const tok = auth.replace(/^Bearer /, "");
    if (!as.validTokens.has(tok)) {
      const www = u.pathname === "/mcp" ? `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` : "Bearer";
      return json(res, 401, { error: "unauthorized" }, { "WWW-Authenticate": www });
    }
    return rpcReply(req, res, auth);
  }
  res.writeHead(404).end();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
base = `http://127.0.0.1:${server.address().port}`;

// The "browser": follow the authorize redirect to Omni's loopback callback.
const browser = {
  opened: 0,
  openUrl(url) {
    browser.opened++;
    (async () => {
      const r = await fetch(url, { redirect: "manual" });
      await fetch(r.headers.get("location"));
    })().catch((e) => console.log("    browser error:", e.message));
  },
};
const io = { openUrl: browser.openUrl, timeoutMs: 10000 };

const logs = [];
const origLog = console.log, origErr = console.error;
function captured(fn) {
  return async () => {
    logs.length = 0;
    console.log = (...a) => logs.push(a.join(" "));
    console.error = (...a) => logs.push(a.join(" "));
    try { await fn(); } finally { console.log = origLog; console.error = origErr; }
  };
}
const said = (re) => logs.some((l) => re.test(l.replace(/\x1b\[[0-9;]*m/g, "")));
const plain = (lines) => lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, "")).join("\n");

const ctx = { canRaw: false };
mcp.registerMcpProxy({ servers: {}, settings: { idleTimeout: 0 } });

// ---- tests ------------------------------------------------------------------

console.log("\nservices: /connect, /connections, /disconnect");

await test("the commands are registered with the documented usage", () => {
  const byName = Object.fromEntries(COMMANDS.map((c) => [c.name, c]));
  assert.equal(byName.connections.usage, "/connections");
  assert.equal(byName.connect.usage, "/connect [service]");
  assert.equal(byName.disconnect.usage, "/disconnect [service]");
  assert.ok(byName.login && byName.logout, "provider setup moved to /login and /logout");
});

await test("/connect <name> <url> writes the definition file and connects", captured(async () => {
  await connectCommand(ctx, `open ${base}/open`, io);
  const file = path.join(SERVICES_DIR, "open.json");
  assert.ok(fs.existsSync(file), "definition file written");
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { url: `${base}/open` });
  assert.ok(said(/connected open — 1 tool/), logs.join("\n"));
  const out = plain(connectionsLines());
  assert.match(out, /open\s+connected · 1 tool/);
}));

await test("a 401 with OAuth metadata signs in through the browser and saves it", captured(async () => {
  await connectCommand(ctx, `secure ${base}/mcp`, io);
  assert.ok(said(/connected secure — 1 tool/), logs.join("\n"));
  assert.equal(browser.opened, 1);
  const rec = getSignIn("secure");
  assert.equal(rec.type, "oauth");
  assert.equal(rec.accessToken, "at-1");
  assert.equal(rec.resource, `${base}/mcp`);
  const r = await impl.mcp({ tool: "secure::whoami" });
  assert.match(r, /auth=Bearer at-1/);
  assert.match(plain(connectionsLines()), /secure\s+connected · 1 tool · signed in · token good for/);
}));

await test("the sign-in is only attached to the URL it was made for", () => {
  assert.equal(authHeaderSync("secure", `${base}/mcp`), "Bearer at-1");
  assert.equal(authHeaderSync("secure", "https://evil.example/mcp"), null);
  assert.equal(signInState("secure", "https://evil.example/mcp").state, "mismatch");
});

await test("a project's .mcp.json can't take over a service's name", () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "omni-services-proj-"));
  fs.writeFileSync(path.join(proj, ".mcp.json"), JSON.stringify({ mcpServers: { secure: { url: "https://evil.example/mcp" }, other: { command: "x" } } }));
  const cwd = process.cwd();
  process.chdir(proj);
  try {
    const cfg = loadMcpConfig({ mcpServers: { cfgsrv: { command: "y" } } });
    assert.equal(cfg.servers.secure.url, `${base}/mcp`, "the service definition wins");
    assert.ok(cfg.services.has("secure") && !cfg.untrusted.has("secure"));
    assert.ok(cfg.untrusted.has("other"), "other .mcp.json servers still need trust");
    assert.equal(cfg.sources.other, "project");
    assert.equal(cfg.sources.cfgsrv, "config");
  } finally {
    process.chdir(cwd);
  }
});

await test("an expired access token is refreshed, not re-asked", async () => {
  const all = JSON.parse(fs.readFileSync(AUTH_PATH, "utf8"));
  all.secure.expiresAt = new Date(Date.now() - 1000).toISOString();
  fs.writeFileSync(AUTH_PATH, JSON.stringify(all));
  as.validTokens.delete("at-1");
  const r = await impl.mcp({ tool: "secure::whoami" });
  assert.match(r, /auth=Bearer at-2/);
  assert.equal(as.refreshes, 1);
  assert.equal(browser.opened, 1, "no second browser sign-in");
  assert.equal(getSignIn("secure").refreshToken, "rt-1", "refresh token kept when not rotated");
});

await test("/connect on an existing service signs in again", captured(async () => {
  const regs = as.registrations;
  await connectCommand(ctx, "secure", io);
  assert.equal(as.registrations, regs + 1);
  assert.equal(browser.opened, 2);
  assert.equal(getSignIn("secure").accessToken, "at-1");
  assert.ok(said(/connected secure/), logs.join("\n"));
}));

await test("a 401 without OAuth metadata asks for a token", captured(async () => {
  const asked = [];
  const tctx = { canRaw: false, askLine: async (q) => { asked.push(q); return "tok-xyz"; } };
  await connectCommand(tctx, `tok ${base}/tokmcp`, io);
  assert.equal(asked.length, 1, "asked once for a token");
  assert.equal(getSignIn("tok").type, "token");
  assert.match(await impl.mcp({ tool: "tok::whoami" }), /auth=Bearer tok-xyz/);
  assert.match(plain(connectionsLines()), /tok\s+connected · 1 tool · token saved/);
}));

await test("a new service that never connects leaves nothing behind", captured(async () => {
  const dead = http.createServer();
  await new Promise((r) => dead.listen(0, "127.0.0.1", r));
  const port = dead.address().port;
  await new Promise((r) => dead.close(r));
  await connectCommand(ctx, `ghost http://127.0.0.1:${port}/mcp`, io);
  assert.ok(said(/couldn't connect ghost/), logs.join("\n"));
  assert.ok(!fs.existsSync(path.join(SERVICES_DIR, "ghost.json")));
  assert.ok(!mcp.serverStatuses().some((s) => s.name === "ghost"));
}));

await test("a bad service name is refused before touching disk", captured(async () => {
  await connectCommand(ctx, `../evil ${base}/open`, io);
  assert.ok(said(/isn't a usable service name/), logs.join("\n"));
  assert.ok(!fs.existsSync(path.join(home, "evil.json")));
  assert.throws(() => serviceFile("../evil"));
}));

await test("/disconnect deletes the definition, the sign-in and the cached tools", captured(async () => {
  await disconnectCommand(ctx, "secure");
  assert.ok(!fs.existsSync(path.join(SERVICES_DIR, "secure.json")));
  assert.equal(getSignIn("secure"), null);
  assert.ok(!mcp.serverStatuses().some((s) => s.name === "secure"));
  const cache = JSON.parse(fs.readFileSync(path.join(home, "mcp-cache.json"), "utf8"));
  assert.ok(!("secure" in cache), "cached tool list dropped");
  assert.ok(said(/disconnected secure — deleted .*secure\.json and its saved sign-in/), logs.join("\n"));
}));

await test("/disconnect refuses a server defined in omni.config.json", captured(async () => {
  mcp.addServer("cfgsrv", { command: "nothing" }, { service: false });
  await disconnectCommand(ctx, "cfgsrv");
  assert.ok(said(/defined in omni\.config\.json/), logs.join("\n"));
  assert.ok(mcp.serverStatuses().some((s) => s.name === "cfgsrv"), "left alone");
  mcp.removeServer("cfgsrv");
}));

await test("/disconnect with no name and no terminal lists the services", captured(async () => {
  await disconnectCommand(ctx, "");
  assert.ok(said(/usage: \/disconnect <service> — yours: open, tok/), logs.join("\n"));
}));

await test("definitionFromTarget reads URLs and command lines", () => {
  assert.deepEqual(definitionFromTarget("https://x.example/mcp"), { url: "https://x.example/mcp" });
  assert.deepEqual(definitionFromTarget('npx -y "@scope/server name" .'), { command: "npx", args: ["-y", "@scope/server name", "."] });
  assert.equal(definitionFromTarget("  "), null);
});

mcp.disconnectAll();
server.close();
fs.rmSync(home, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
