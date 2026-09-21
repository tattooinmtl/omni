// MCP (Model Context Protocol) client — proxy-tool architecture.
//
// Instead of registering every MCP tool into the model's context (10k+ tokens
// per server), we register ONE `mcp` proxy tool (~200 tokens). The model uses it
// to search/describe/call tools on demand. Servers connect LAZILY on first call,
// tool metadata is cached to <HOME>/mcp-cache.json so search/describe work with
// no live connection, and idle servers disconnect after a timeout.
//
// Optional `directTools` promotes selected tools to first-class Omni Agent tools
// (named mcp__<server>__<tool>) registered from the cache.
//
// Transports: stdio (command/args/env) and StreamableHTTP (url/headers).

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { HOME } from "../core/config.mjs";
import { tools, impl } from "../tools/index.mjs";
import { INSTALL_ROOT } from "../paths.mjs";
import { atomicWriteFileSync } from "../core/atomic-write.mjs";

const CACHE_PATH = path.join(HOME, "mcp-cache.json");
const TRUST_PATH = path.join(HOME, "mcp-trust.json");
const RPC_TIMEOUT = 30000;

let servers = {}; // { name: def }
let settings = { idleTimeout: 10, directTools: false };
let untrustedNames = new Set(); // names sourced from a project-local .mcp.json
let confirmServer = null; // (name, target) => Promise<boolean> — set by the REPL
const connections = new Map(); // name -> conn

// Lets the REPL supply a human-confirm callback once it has one (see
// repl.mjs). One-shot/non-interactive runs never call this, so untrusted
// servers there hit the "no one to ask" branch in ensureConnected and refuse
// to connect rather than silently proceeding.
export function setMcpConfirm(fn) {
  confirmServer = fn;
}

// ---- per-project trust cache ------------------------------------------------
// A server from .mcp.json is trusted once its exact definition (command/args/
// env or url/headers) has been confirmed for this cwd. Any change to the
// definition changes the fingerprint and re-triggers confirmation — a repo
// can't get one host approved and later swap in a different command.

function readTrust() {
  try {
    return JSON.parse(fs.readFileSync(TRUST_PATH, "utf8"));
  } catch {
    return {};
  }
}

function trustKey(name) {
  return `${process.cwd()}::${name}`;
}

function defFingerprint(def) {
  return createHash("sha256").update(JSON.stringify(def)).digest("hex").slice(0, 16);
}

function isTrusted(name, def) {
  return readTrust()[trustKey(name)] === defFingerprint(def);
}

function markTrusted(name, def) {
  const trust = readTrust();
  trust[trustKey(name)] = defFingerprint(def);
  try {
    fs.mkdirSync(path.dirname(TRUST_PATH), { recursive: true });
    // Atomic: a truncated trust file parses as "nothing trusted", which
    // would re-prompt for every project MCP server the user approved.
    atomicWriteFileSync(TRUST_PATH, JSON.stringify(trust, null, 2));
  } catch {
    /* best effort */
  }
}

// Minimal environment for stdio MCP servers. Full `process.env` inheritance
// would hand every configured provider's API key and any other shell secret
// to whatever command the server config names — set `inheritEnv: true` on a
// server definition to opt back into full inheritance when a server genuinely
// needs it (e.g. reading a cloud CLI's own env-based config).
const SAFE_ENV_KEYS = [
  "PATH", "Path", "PATHEXT", "SystemRoot", "windir", "TEMP", "TMP", "TMPDIR",
  "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "HOMEDRIVE", "HOMEPATH",
  "COMSPEC", "LANG", "LC_ALL", "NODE_ENV", "SHELL",
];

function baseEnv() {
  const out = {};
  for (const k of SAFE_ENV_KEYS) if (process.env[k] !== undefined) out[k] = process.env[k];
  return out;
}

// ---- metadata cache --------------------------------------------------------

function readCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
  } catch {
    return {};
  }
}

function cacheTools(name, toolList) {
  const cache = readCache();
  cache[name] = { tools: toolList, cachedAt: new Date().toISOString() };
  try {
    fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
    atomicWriteFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
  } catch {
    /* cache is best-effort */
  }
}

function cachedTools(name) {
  return readCache()[name]?.tools || null;
}

// ---- transports ------------------------------------------------------------

// A package/config-supplied command or arg can't know where Omni itself is
// installed on this machine — {{INSTALL_ROOT}} lets a manifest reference it
// portably instead of baking in a machine-specific absolute path.
function substituteInstallRoot(s) {
  return typeof s === "string" ? s.split("{{INSTALL_ROOT}}").join(INSTALL_ROOT) : s;
}

// cmd.exe argument quoting. The shell parses its argument even inside double
// quotes for several metacharacters — `& | < >` are still command
// separators, `%` is still expanded from environment, and `^` is the
// escape character itself. Naively wrapping an arg in `"..."` (the old
// behaviour) lets a malicious MCP config inject `foo & calc.exe` and have
// the shell run a second command. We escape those metacharacters with `^`
// (cmd.exe's standard escape), then wrap in double quotes with internal
// quotes doubled per cmd.exe convention.
function quoteForCmdExe(arg) {
  let s = String(arg);
  // Escape characters that keep their meaning inside double quotes. Order
  // matters: `^` first so the metacharacter we use as escape is itself
  // escaped, then the metacharacters themselves (cmd.exe command
  // separators/redirection; `;` is included for defense in depth — it isn't
  // strictly a separator in cmd.exe but the TODO lists it as a concern),
  // then `%` (env expansion).
  s = s.replace(/\^/g, "^^");
  s = s.replace(/[&|<>;]/g, "^$&");
  s = s.replace(/%/g, "^%");
  // Internal double quotes are doubled so cmd.exe sees a literal quote.
  s = s.replace(/"/g, '""');
  return `"${s}"`;
}

// Exported for testing — call `quoteForCmdExe("foo & calc.exe")` directly.
export { quoteForCmdExe };

// True when `command` is a path with a space that must be quoted before it is
// concatenated into the cmd.exe command string. A space-free command never
// needs it, and a string that doesn't name an existing file is left alone so
// configs that put a whole command line in `command` aren't broken by quoting.
export function needsCommandQuoting(command) {
  const s = String(command ?? "");
  if (!s.includes(" ")) return false;
  try {
    return fs.statSync(s).isFile();
  } catch {
    return false;
  }
}

function connectStdio(name, def) {
  const env = { ...(def.inheritEnv ? process.env : baseEnv()), ...(def.env || {}) };
  const opts = { env, cwd: def.cwd || process.cwd(), stdio: ["pipe", "pipe", "pipe"] };

  // On Windows, npx/uvx/etc. are .cmd shims that bare spawn() can't resolve
  // (ENOENT). We run through the shell so PATHEXT finds them — but as a single
  // quoted command STRING (no args array) to avoid the DEP0190 warning that
  // fires when args are passed under shell:true. The string itself must be
  // properly escaped for cmd.exe, otherwise an arg like `foo & calc.exe` is
  // parsed as a second command (TODO #6 — the old code only quoted args with
  // whitespace, leaving `& | < > ;` as command separators).
  let command = substituteInstallRoot(def.command);
  let args = (def.args || []).map(substituteInstallRoot);
  if (process.platform === "win32") {
    const escapedArgs = args.map(quoteForCmdExe);
    // The command itself needs quoting too when it's a real path containing a
    // space (`C:\Program Files\...\server.exe`, or an {{INSTALL_ROOT}} that
    // expanded into one) — otherwise cmd.exe splits it at the space and the
    // server never starts. We only quote when the string actually resolves to
    // a file on disk, so a bare shim name (`npx`, still resolved via PATHEXT)
    // and the "whole command line in `command`" style both keep working.
    command = needsCommandQuoting(command) ? quoteForCmdExe(command) : command;
    command = escapedArgs.length ? `${command} ${escapedArgs.join(" ")}` : command;
    args = [];
    opts.shell = true;
  }

  const proc = spawn(command, args, opts);
  const conn = { name, transport: "stdio", proc, pending: new Map(), nextId: 1, tools: [] };

  const failAll = (msg) => {
    conn.dead = true;
    for (const { reject } of conn.pending.values()) reject(new Error(msg));
    conn.pending.clear();
  };

  // A failed spawn emits 'error' asynchronously — handle it so it never crashes
  // the agent; the server is simply marked dead and pending calls reject.
  proc.on("error", (err) => failAll(`MCP server "${name}" failed to start: ${err.message}`));
  proc.stdin.on("error", () => {}); // ignore EPIPE if the child died mid-write
  proc.on("exit", () => failAll(`MCP server "${name}" exited`));

  const rl = createInterface({ input: proc.stdout });
  rl.on("line", (line) => handleStdioMessage(conn, line));
  proc.stderr.on("data", (d) => {
    if (def.debug) process.stderr.write(`[mcp:${name}] ${d}`);
  });
  conn.rl = rl;
  return conn;
}

function handleStdioMessage(conn, line) {
  line = line.trim();
  if (!line) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return; // ignore non-JSON (some servers log to stdout)
  }
  if (msg.id != null && conn.pending.has(msg.id)) {
    const { resolve, reject } = conn.pending.get(msg.id);
    conn.pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
    else resolve(msg.result);
  }
  // server->client requests/notifications are ignored in v1
}

function connectHttp(name, def) {
  return {
    name,
    transport: "http",
    url: def.url,
    headers: def.headers || {},
    nextId: 1,
    tools: [],
  };
}

// Parse a StreamableHTTP SSE body, returning the JSON-RPC payload for `id`.
function parseSse(text, id) {
  let last = null;
  for (const block of text.split(/\n\n/)) {
    const dataLines = block
      .split(/\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim());
    if (!dataLines.length) continue;
    try {
      const obj = JSON.parse(dataLines.join("\n"));
      if (obj.id === id) return obj;
      last = obj;
    } catch {
      /* skip */
    }
  }
  return last;
}

// ---- JSON-RPC --------------------------------------------------------------

function rpc(conn, method, params) {
  if (conn.transport === "http") return rpcHttp(conn, method, params);
  const id = conn.nextId++;
  return new Promise((resolve, reject) => {
    if (conn.dead) return reject(new Error("MCP server not running"));
    // The timer is cleared by whichever of the two settles first, so a busy
    // session doesn't accumulate a 30s timer per RPC.
    let timer;
    const settle = (fn) => (v) => {
      clearTimeout(timer);
      fn(v);
    };
    conn.pending.set(id, { resolve: settle(resolve), reject: settle(reject) });
    conn.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    timer = setTimeout(() => {
      if (conn.pending.has(id)) {
        conn.pending.delete(id);
        reject(new Error(`MCP "${method}" timed out`));
      }
    }, RPC_TIMEOUT);
    timer.unref?.();
  });
}

async function rpcHttp(conn, method, params) {
  const id = conn.nextId++;
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...conn.headers,
  };
  if (conn.sessionId) headers["Mcp-Session-Id"] = conn.sessionId;
  const res = await fetch(conn.url, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const sid = res.headers.get("mcp-session-id");
  if (sid) conn.sessionId = sid;
  if (!res.ok) throw new Error(`MCP HTTP ${res.status}`);
  const ct = res.headers.get("content-type") || "";
  const data = ct.includes("text/event-stream") ? parseSse(await res.text(), id) : await res.json();
  if (!data) return undefined;
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  return data.result;
}

async function notify(conn, method, params) {
  const body = JSON.stringify({ jsonrpc: "2.0", method, params });
  if (conn.transport === "http") {
    const headers = { "Content-Type": "application/json", ...conn.headers };
    if (conn.sessionId) headers["Mcp-Session-Id"] = conn.sessionId;
    await fetch(conn.url, { method: "POST", headers, body }).catch(() => {});
  } else if (!conn.dead) {
    conn.proc.stdin.write(body + "\n");
  }
}

// ---- lifecycle -------------------------------------------------------------

function touch(conn) {
  conn.lastUsed = Date.now();
  if (conn.idleTimer) clearTimeout(conn.idleTimer);
  const mins = settings.idleTimeout;
  if (mins && mins > 0) {
    conn.idleTimer = setTimeout(() => disconnect(conn.name), mins * 60 * 1000);
    conn.idleTimer.unref?.();
  }
}

// In-flight connects, keyed by server name. The agent runs a batch of tool
// calls through Promise.all, so two calls to the same server land here
// concurrently: without this, the second caller saw the connection the first
// had already put in `connections` but whose initialize/tools-list were still
// in flight, and came back with an empty `conn.tools` — surfacing as a bogus
// `tool "x" not found`. Everyone now awaits the same fully-initialized conn.
const connecting = new Map(); // name -> Promise<conn>

function ensureConnected(name) {
  const conn = connections.get(name);
  if (conn && !conn.dead && conn.ready) {
    touch(conn);
    return Promise.resolve(conn);
  }
  const inflight = connecting.get(name);
  if (inflight) return inflight;

  const p = openConnection(name).finally(() => {
    if (connecting.get(name) === p) connecting.delete(name);
  });
  connecting.set(name, p);
  return p;
}

async function openConnection(name) {
  const def = servers[name];
  if (!def) throw new Error(`unknown MCP server: ${name}`);

  if (untrustedNames.has(name) && !isTrusted(name, def)) {
    if (!confirmServer) {
      throw new Error(
        `MCP server "${name}" comes from this project's .mcp.json and hasn't been trusted yet. ` +
        `This session is non-interactive, so there is no one to confirm it with — refusing to connect.`
      );
    }
    const target = def.url || `${def.command} ${(def.args || []).join(" ")}`.trim();
    const approved = await confirmServer(name, target);
    if (!approved) throw new Error(`MCP server "${name}" was not trusted — connection refused.`);
    markTrusted(name, def);
  }

  const conn = def.url ? connectHttp(name, def) : connectStdio(name, def);
  connections.set(name, conn);
  try {
    await rpc(conn, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "Omni Agent", version: "0.1.0" },
    });
    await notify(conn, "notifications/initialized", {});
    const list = await rpc(conn, "tools/list", {});
    conn.tools = list?.tools || [];
  } catch (e) {
    // A handshake that fails partway leaves a live child process behind and a
    // connection object that would be reused by the next caller. Tear both
    // down so the next attempt starts clean.
    disconnect(name);
    throw e;
  }
  conn.ready = true;
  cacheTools(name, conn.tools);
  touch(conn);
  return conn;
}

// `proc.kill()` on Windows only kills the cmd.exe we spawn through (shell:true
// is required for .cmd shims like npx) — the actual server process is its
// child and survives, so every idle timeout, /mcp reconnect and exit leaked a
// running server. taskkill /T walks the tree.
function killProc(proc) {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
  if (process.platform === "win32" && proc.pid) {
    try {
      const killer = spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
      killer.on("error", () => { try { proc.kill(); } catch { /* already gone */ } });
      killer.unref?.();
      return;
    } catch {
      /* fall through to the plain kill below */
    }
  }
  try {
    proc.kill();
  } catch {
    /* already gone */
  }
}

// StreamableHTTP servers keep per-session state keyed by Mcp-Session-Id and
// only release it when the client says it's done. We never said, so every
// idle timeout and every exit left a session allocated on the far side.
function endHttpSession(conn) {
  if (conn.transport !== "http" || !conn.sessionId) return;
  fetch(conn.url, {
    method: "DELETE",
    headers: { ...conn.headers, "Mcp-Session-Id": conn.sessionId },
  }).catch(() => { /* best effort — we're tearing down either way */ });
}

function disconnect(name) {
  const conn = connections.get(name);
  if (!conn) return;
  if (conn.idleTimer) clearTimeout(conn.idleTimer);
  conn.dead = true;
  conn.ready = false;
  endHttpSession(conn);
  try {
    conn.rl?.close();
  } catch {
    /* already closed */
  }
  killProc(conn.proc);
  connections.delete(name);
}

export function disconnectAll() {
  for (const name of [...connections.keys()]) disconnect(name);
}

export async function reconnectServer(name) {
  disconnect(name);
  return ensureConnected(name);
}

// ---- tool discovery helpers ------------------------------------------------

// Set whenever ensureConnected refuses a server (untrusted, non-interactive,
// declined, etc.) — toolsForServer swallows the error so one bad server
// doesn't break discovery of the others, but the reason is kept here so
// mcpProxy can surface WHY a tool wasn't found instead of a bare "not found"
// that reads the same whether it's a typo or a security refusal.
const lastConnectError = new Map(); // name -> message

// A connection that has completed its handshake. A conn that exists but isn't
// `ready` is mid-handshake (its `tools` is still empty), so callers must await
// ensureConnected instead of reading it.
function liveConn(name) {
  const conn = connections.get(name);
  return conn && !conn.dead && conn.ready ? conn : null;
}

// Tools for a server, preferring a live connection, then the disk cache, then a
// one-time connect to populate the cache.
async function toolsForServer(name) {
  if (!servers[name]) return null;
  const conn = liveConn(name);
  if (conn) return conn.tools;
  const cached = cachedTools(name);
  if (cached) return cached;
  try {
    const tools = (await ensureConnected(name)).tools;
    lastConnectError.delete(name);
    return tools;
  } catch (e) {
    lastConnectError.set(name, e.message);
    return [];
  }
}

const norm = (s) => String(s).toLowerCase().replace(/[-_:]/g, "");

// Find which server owns a tool name (bare or server::tool, hyphen/underscore
// insensitive). Loads each server's tools (cache or connect) as needed.
async function findToolOwner(toolName) {
  for (const name of Object.keys(servers)) {
    const list = await toolsForServer(name);
    for (const t of list || []) {
      if (
        t.name === toolName ||
        `${name}::${t.name}` === toolName ||
        norm(t.name) === norm(toolName) ||
        norm(`${name}${t.name}`) === norm(toolName)
      ) {
        return { server: name, tool: t };
      }
    }
  }
  return null;
}

function oneline(s) {
  return String(s || "").split(/\r?\n/)[0].trim();
}

function extractText(result) {
  const parts = [];
  for (const c of result.content || []) {
    if (c.type === "text") parts.push(c.text);
    else if (c.type === "resource" && c.resource?.text) parts.push(c.resource.text);
    else parts.push(`[${c.type}]`);
  }
  return parts.join("\n");
}

// Same output-clip convention as tools/index.mjs (MAX_OUTPUT = 30000) — a
// huge MCP response must not land in context unbounded. Local copy because
// clip() there isn't exported.
const MAX_OUTPUT = 30000;
function clip(s) {
  s = String(s);
  return s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + "\n…[truncated]" : s;
}

function formatToolResult(result) {
  if (!result) return "(no result)";
  const text = extractText(result);
  if (result.isError) return clip("ERROR: " + (text || JSON.stringify(result)));
  return clip(text || JSON.stringify(result));
}

// ---- the proxy tool --------------------------------------------------------

const proxyToolDef = {
  type: "function",
  function: {
    name: "mcp",
    description:
      "Proxy to MCP server tools — discover and call them without bloating context. " +
      "Usage: mcp({}) for status; mcp({server:'name'}) lists a server's tools; " +
      "mcp({search:'words'}) finds tools; mcp({describe:'tool'}) shows a tool's schema; " +
      "mcp({connect:'name'}) force-connects; mcp({tool:'name', args:'{...}'}) calls a tool " +
      "(args is a JSON STRING, not an object). Servers connect lazily on first call.",
    parameters: {
      type: "object",
      properties: {
        search: { type: "string", description: "Search tool names/descriptions across all servers (space = OR)" },
        server: { type: "string", description: "List the tools exposed by this server" },
        describe: { type: "string", description: "Show the full input schema for this tool name" },
        connect: { type: "string", description: "Force-connect this server now" },
        tool: { type: "string", description: "Name of the tool to call" },
        args: { type: "string", description: "Arguments for the tool, as a JSON string e.g. '{\"q\":\"x\"}'" },
      },
    },
  },
};

async function mcpProxy(a = {}) {
  const names = Object.keys(servers);
  if (names.length === 0) {
    return "No MCP servers configured. Add one to omni.config.json `mcpServers`, a project .mcp.json, or `omni install` an mcp package.";
  }

  // call a tool
  if (a.tool) {
    const owner = await findToolOwner(a.tool);
    if (!owner) {
      const refusals = names
        .filter((n) => lastConnectError.has(n))
        .map((n) => `${n}: ${lastConnectError.get(n)}`);
      return refusals.length
        ? `tool "${a.tool}" not found. Some servers refused to connect:\n  ${refusals.join("\n  ")}`
        : `tool "${a.tool}" not found. Try mcp({ search: "..." }).`;
    }
    let parsed = {};
    if (a.args) {
      try {
        parsed = typeof a.args === "string" ? JSON.parse(a.args) : a.args;
      } catch (e) {
        return `args must be a JSON string: ${e.message}`;
      }
    }
    const conn = await ensureConnected(owner.server);
    const result = await rpc(conn, "tools/call", { name: owner.tool.name, arguments: parsed });
    return formatToolResult(result);
  }

  if (a.connect) {
    const conn = await ensureConnected(a.connect);
    return `connected ${a.connect} — ${conn.tools.length} tool(s).`;
  }

  if (a.describe) {
    const owner = await findToolOwner(a.describe);
    if (!owner) return `tool "${a.describe}" not found.`;
    return `${owner.server}::${owner.tool.name}\n` + JSON.stringify(owner.tool, null, 2);
  }

  if (a.server) {
    if (!servers[a.server]) return `unknown server "${a.server}". Configured: ${names.join(", ")}`;
    const list = (await toolsForServer(a.server)) || [];
    const state = liveConn(a.server) ? "connected" : "cached/idle";
    return (
      `${a.server} (${state}):\n` +
      (list.length ? list.map((t) => `  ${t.name} — ${oneline(t.description)}`).join("\n") : "  (no tools)")
    );
  }

  if (a.search != null) {
    const terms = a.search.toLowerCase().replace(/[-_]/g, " ").split(/\s+/).filter(Boolean);
    const hits = [];
    for (const name of names) {
      for (const t of (await toolsForServer(name)) || []) {
        const hay = `${t.name} ${t.description || ""}`.toLowerCase().replace(/[-_]/g, " ");
        if (terms.length === 0 || terms.some((term) => hay.includes(term))) {
          hits.push(`  ${name}::${t.name} — ${oneline(t.description)}`);
        }
      }
    }
    return hits.length ? hits.join("\n") : "(no matching tools)";
  }

  // default: status
  const lines = names.map((n) => {
    const conn = liveConn(n);
    const cached = cachedTools(n);
    const state = conn ? "connected" : cached ? "idle (cached)" : "not connected";
    const count = conn ? conn.tools.length : cached ? cached.length : "?";
    return `  ${n}: ${state}, ${count} tool(s)`;
  });
  return (
    `MCP servers:\n${lines.join("\n")}\n\n` +
    `Discover with mcp({ search: "..." }), then call with mcp({ tool: "name", args: "{...}" }).`
  );
}

// Expose the proxy for the REPL /mcp command.
export function mcpStatus() {
  return mcpProxy({});
}

// ---- direct tools ----------------------------------------------------------

function registerDirectTool(server, t) {
  const fullName = `mcp__${server}__${t.name}`;
  if (tools.find((x) => x.function?.name === fullName)) return;
  tools.push({
    type: "function",
    function: {
      name: fullName,
      description: t.description || `${t.name} (via ${server} MCP server)`,
      parameters: t.inputSchema || { type: "object", properties: {} },
    },
  });
  impl[fullName] = async (args) => {
    const conn = await ensureConnected(server);
    const result = await rpc(conn, "tools/call", { name: t.name, arguments: args || {} });
    return formatToolResult(result);
  };
}

// ---- entry point -----------------------------------------------------------

// Register the proxy tool (and any cached direct tools). Does NOT connect any
// server — connections are lazy. Returns counts for the startup banner.
export function registerMcpProxy(mcpCfg) {
  servers = mcpCfg.servers || {};
  settings = mcpCfg.settings || { idleTimeout: 10, directTools: false };
  untrustedNames = mcpCfg.untrusted || new Set();

  const names = Object.keys(servers);
  if (names.length === 0) return { servers: 0, directTools: 0, names: [], untrusted: [] };

  if (!tools.find((t) => t.function?.name === "mcp")) {
    tools.push(proxyToolDef);
    impl.mcp = mcpProxy;
  }

  let direct = 0;
  for (const [name, def] of Object.entries(servers)) {
    const want = def.directTools !== undefined ? def.directTools : settings.directTools;
    if (!want) continue;
    const cached = cachedTools(name);
    if (!cached) continue; // populated on first proxy use; appears next run
    for (const t of cached) {
      if (Array.isArray(want) && !want.includes(t.name)) continue;
      if (Array.isArray(def.excludeTools) && def.excludeTools.includes(t.name)) continue;
      registerDirectTool(name, t);
      direct++;
    }
  }

  return { servers: names.length, directTools: direct, names, untrusted: names.filter((n) => untrustedNames.has(n)) };
}
