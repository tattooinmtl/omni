// src/bridge.mjs — Omni bridge (hermes capability backend).
//
// Registers ONE "omni-bridge" proxy tool into the agent's tool registry (~200
// tokens of context), exactly like the MCP proxy in src/mcp.mjs.  The model
// uses it to list, describe, and call the full hermes tool set without
// blowing up the context window.
//
// The bridge_server.py process is kept warm (lazy-spawned on first call,
// kept alive across turns, killed on Omni Agent exit).  If hermes-agent is
// not installed or the bridge server crashes, the omni-bridge tool is simply
// absent from the registry — everything else still works.
//
// Usage in the agent:
//   omni_bridge({})                              → list all bridge tools
//   omni_bridge({ search: "screenshot" })        → search by keyword
//   omni_bridge({ describe: "web_search" })      → full schema for one tool
//   omni_bridge({ tool: "web_search",
//                 args: '{"query":"…"}' })       → call a bridge tool

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tools, impl } from "../tools/index.mjs";
import { INSTALL_ROOT } from "../paths.mjs";
import { loadProjectConfig } from "./extras.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_SCRIPT = path.join(__dirname, "..", "..", "router", "bridge_server.py");
const CALL_TIMEOUT  = 30000; // 30s — some hermes tools (browser, media gen) are slow

// ---------------------------------------------------------------------------
// Bridge process management (same pattern as mcp.mjs)
// ---------------------------------------------------------------------------
let _proc    = null;
let _rl      = null;
let _pending = new Map();  // id → { resolve, reject }
let _nextId  = 1;
let _dead    = false;

function _spawnBridge(pythonExe) {
  if (_dead) return;
  const env = { ...process.env };
  try {
    _proc = spawn(pythonExe, [BRIDGE_SCRIPT], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
      windowsHide: true,
    });

    _proc.on("error", (err) => _failAll(`NimTools bridge failed to start: ${err.message}`));
    _proc.on("exit",  ()    => _failAll("NimTools bridge exited"));
    _proc.stderr.on("data", () => {}); // bridge errors come back as JSON

    _rl = createInterface({ input: _proc.stdout });
    _rl.on("line", (line) => {
      // Responses carry back the request id so we can multiplex.
      try {
        const msg = JSON.parse(line);
        const id  = msg._id;
        const cb  = _pending.get(id);
        if (cb) {
          _pending.delete(id);
          cb.resolve(msg);
        }
      } catch { /* malformed line — drop */ }
    });
  } catch {
    _proc = null;
    _rl   = null;
  }
}

function _failAll(reason) {
  _proc = null;
  _rl   = null;
  for (const { reject } of _pending.values()) reject(new Error(reason));
  _pending.clear();
}

function _rpc(req, pythonExe) {
  if (!_proc && !_dead) _spawnBridge(pythonExe);
  if (!_proc) return Promise.reject(new Error("NimTools bridge unavailable"));

  const id = _nextId++;
  return new Promise((resolve, reject) => {
    // Store the timeout alongside the callbacks so whichever side fires
    // first (response or timeout) can clean up both the entry and the
    // timer. Without this, every timeout silently leaks an entry in
    // _pending — long-running sessions with a flaky bridge eventually OOM
    // (TODO #7).
    const timer = setTimeout(() => {
      _pending.delete(id);
      reject(new Error("NimTools bridge timeout"));
    }, CALL_TIMEOUT);
    timer.unref?.();
    _pending.set(id, {
      resolve: (msg) => { clearTimeout(timer); _pending.delete(id); resolve(msg); },
      reject:  (err) => { clearTimeout(timer); _pending.delete(id); reject(err); },
    });
    const line = JSON.stringify({ ...req, _id: id }) + "\n";
    try {
      _proc.stdin.write(line);
    } catch (e) {
      _pending.delete(id);
      clearTimeout(timer);
      reject(e);
    }
  });
}

async function rpc(req, pythonExe) {
  // Timeout + cleanup now live inside _rpc (see above), so rpc just awaits
  // the inner promise. Keeping the public surface here in case a caller
  // wants to swap the timeout policy in the future.
  return _rpc(req, pythonExe);
}

// Test-only: lets regression tests confirm the timeout path actually clears
// _pending instead of leaking it. Not part of the public surface; if a
// future test wants to swap in a shorter CALL_TIMEOUT, expose a setter here.
export function _pendingSizeForTest() {
  return _pending.size;
}

// ---------------------------------------------------------------------------
// Tool cache (avoids repeated list calls)
// ---------------------------------------------------------------------------
let _toolCache = null; // [{ name, description, toolset }]

async function getToolList(pythonExe) {
  if (_toolCache) return _toolCache;
  const resp = await rpc({ type: "list" }, pythonExe);
  _toolCache = resp.tools || [];
  return _toolCache;
}

// ---------------------------------------------------------------------------
// The single "nimtools" proxy tool implementation
// ---------------------------------------------------------------------------
async function nimtoolsImpl({ search, describe, tool, args: argsRaw } = {}, pythonExe) {
  // --- list / search ---
  if (!describe && !tool) {
    const list = await getToolList(pythonExe);
    if (search) {
      const q = search.toLowerCase();
      const matches = list.filter(
        (t) => t.name.includes(q) || (t.description || "").toLowerCase().includes(q)
      );
      if (!matches.length) return `No NimTools matched "${search}".`;
      return matches.map((t) => `${t.name} (${t.toolset || "general"}): ${t.description}`).join("\n");
    }
    // bare call → full list grouped by toolset
    const byToolset = {};
    for (const t of list) {
      const ts = t.toolset || "general";
      (byToolset[ts] = byToolset[ts] || []).push(t.name);
    }
    const lines = Object.entries(byToolset)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([ts, names]) => `[${ts}] ${names.join(", ")}`);
    return `NimTools (${list.length} total):\n${lines.join("\n")}`;
  }

  // --- describe ---
  if (describe) {
    const resp = await rpc({ type: "schema", tool: describe }, pythonExe);
    if (resp.error) return `Error: ${resp.error}`;
    return JSON.stringify(resp.schema, null, 2);
  }

  // --- call ---
  let parsedArgs = {};
  if (argsRaw) {
    try { parsedArgs = typeof argsRaw === "string" ? JSON.parse(argsRaw) : argsRaw; }
    catch { return `Error: args must be a JSON string. Got: ${argsRaw}`; }
  }
  const resp = await rpc({ type: "call", tool, args: parsedArgs }, pythonExe);
  if (resp.error) return `Error: ${resp.error}`;
  return resp.result ?? "(no output)";
}

// ---------------------------------------------------------------------------
// Register: adds "nimtools" to the shared tools array + impl map.
// Called from bin/omni.mjs when bridge.enabled = true.
// ---------------------------------------------------------------------------
export function registerNimToolsProxy(bridgeCfg = {}) {
  const pythonExe = bridgeCfg.python?.interpreter || "python";

  // Pre-warm the bridge process so the first real call is instant.
  if (!_proc && !_dead) _spawnBridge(pythonExe);

  const toolDef = {
    type: "function",
    function: {
      name: "nimtools",
      description: [
        "Access the full NimTools capability set (browser automation, computer use,",
        "image/video/audio generation and analysis, code execution, memory, todo,",
        "kanban, integrations, and more — powered by the hermes engine).",
        "",
        "Usage:",
        '  nimtools({})                          — list all available NimTools',
        '  nimtools({ search: "browser" })       — search by keyword',
        '  nimtools({ describe: "web_extract" }) — get a tool\'s full schema',
        '  nimtools({ tool: "web_search", args: \'{"query":"…"}\' }) — call a tool',
        "",
        "args must be a JSON string.",
      ].join("\n"),
      parameters: {
        type: "object",
        properties: {
          search:   { type: "string", description: "Keyword to search tool names/descriptions" },
          describe: { type: "string", description: "Tool name to get the full schema for" },
          tool:     { type: "string", description: "Tool name to call" },
          args:     { type: "string", description: "JSON string of arguments for the tool call" },
        },
      },
    },
  };

  // Only register once.
  if (!tools.find((t) => t.function?.name === "nimtools")) {
    tools.push(toolDef);
  }

  impl.nimtools = (params) => nimtoolsImpl(params, pythonExe);

  return { registered: true, pythonExe };
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------
export function disconnectBridge() {
  if (_proc) {
    try { _proc.kill(); } catch { /* already gone */ }
    _proc = null;
    _rl   = null;
    _pending.clear();
  }
}

export function bridgeStatus() {
  if (!_proc) return "NimTools bridge: not connected";
  return `NimTools bridge: connected (pid ${_proc.pid}, ${_toolCache ? _toolCache.length + " tools cached" : "tools not yet listed"})`;
}
