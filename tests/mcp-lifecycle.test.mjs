// MCP server lifecycle: connect/disconnect, concurrency, process teardown.
//
// Three regressions this pins, all found by driving a real stdio MCP server:
//
//  1. Concurrent first-use. agent.mjs runs a tool batch through Promise.all,
//     so two mcp() calls to the same server land in ensureConnected at once.
//     The second used to get back the connection object the first had already
//     stored but whose initialize/tools-list were still in flight — its
//     `tools` was [], so the call failed with a bogus `tool "x" not found`.
//  2. Orphaned processes. On Windows stdio servers are spawned through
//     cmd.exe (needed for .cmd shims like npx); proc.kill() killed the shell
//     and left the real server running forever — on every idle timeout,
//     /mcp reconnect and exit.
//  3. A failed handshake left the half-built connection in the map, so the
//     next call reused a dead server instead of retrying.
//
// Run: node tests/mcp-lifecycle.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

let pass = 0, fail = 0;
async function ok(label, fn) {
  try { await fn(); console.log(`  PASS ${label}`); pass++; }
  catch (e) { console.log(`  FAIL ${label}\n    ${e.message}`); fail++; }
}

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const mcp = await import(pathToFileURL(path.join(root, "src/integrations/mcp.mjs")).href);
const { impl } = await import(pathToFileURL(path.join(root, "src/tools/index.mjs")).href);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omni-mcp-life-"));
const markerPath = path.join(tmp, "pids.txt");
const serverPath = path.join(tmp, "fake-mcp-server.mjs");

// A minimal but protocol-correct MCP stdio server. It records its pid so the
// test can assert the process is actually gone after disconnect, and stays
// alive on an interval so an orphan is unmistakable.
fs.writeFileSync(serverPath, `
import fs from "node:fs";
import readline from "node:readline";
if (process.env.FAKE_MCP_MARKER) fs.appendFileSync(process.env.FAKE_MCP_MARKER, process.pid + "\\n");
if (process.env.FAKE_MCP_FAIL_HANDSHAKE === "1") { setInterval(() => {}, 1 << 30); }
else {
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    let msg; try { msg = JSON.parse(line); } catch { return; }
    if (msg.id == null) return;
    let result = {};
    if (msg.method === "initialize") result = { protocolVersion: "2024-11-05", capabilities: {} };
    else if (msg.method === "tools/list") result = { tools: [{ name: "ping", description: "ping the fake server", inputSchema: { type: "object", properties: {} } }] };
    else if (msg.method === "tools/call") result = { content: [{ type: "text", text: "pong from " + process.pid }] };
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\\n");
  });
  setInterval(() => {}, 1 << 30);
}
`);

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const recordedPids = () => {
  try { return fs.readFileSync(markerPath, "utf8").trim().split(/\n/).filter(Boolean).map(Number); }
  catch { return []; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function configure(extraEnv = {}) {
  try { fs.unlinkSync(markerPath); } catch { /* first run */ }
  mcp.registerMcpProxy({
    servers: {
      fake: {
        command: process.execPath,
        args: [serverPath],
        env: { FAKE_MCP_MARKER: markerPath, ...extraEnv },
      },
    },
    // A fresh cache dir per run would be nicer, but registerMcpProxy reads the
    // shared one only for direct tools, which stay off here.
    settings: { idleTimeout: 10, directTools: false },
    untrusted: new Set(),
  });
}

// ---- 1. concurrent first-use ------------------------------------------------

await ok("three parallel calls to a cold server all succeed (no phantom 'not found')", async () => {
  configure();
  const results = await Promise.all([
    impl.mcp({ tool: "ping", args: "{}" }),
    impl.mcp({ tool: "ping", args: "{}" }),
    impl.mcp({ tool: "ping", args: "{}" }),
  ]);
  for (const r of results) {
    assert.ok(/^pong from \d+$/.test(r), `expected a pong, got: ${r}`);
  }
});

await ok("parallel first-use starts exactly one server process", async () => {
  await sleep(300);
  const pids = recordedPids();
  assert.equal(pids.length, 1, `expected 1 server process, saw ${pids.length}: ${pids.join(",")}`);
});

// ---- 2. teardown kills the real process, not just the shell -----------------

await ok("disconnectAll leaves no running server process behind", async () => {
  const pids = recordedPids();
  assert.ok(pids.length > 0, "no server was started — earlier test failed");
  mcp.disconnectAll();
  // taskkill is async on Windows; give the tree a moment to go down.
  for (let i = 0; i < 20 && pids.some(alive); i++) await sleep(150);
  const survivors = pids.filter(alive);
  for (const p of survivors) { try { process.kill(p, "SIGKILL"); } catch { /* cleanup */ } }
  assert.equal(survivors.length, 0, `orphaned server process(es): ${survivors.join(",")}`);
});

// ---- 3. a failed handshake doesn't poison the connection map ---------------

await ok("a server that never answers initialize is torn down, not cached", async () => {
  configure({ FAKE_MCP_FAIL_HANDSHAKE: "1" });
  // Force a connect; the handshake times out (RPC_TIMEOUT) unless the process
  // is killed first, so assert via the status line rather than waiting 30s.
  const connectPromise = impl.mcp({ connect: "fake" }).catch((e) => `err: ${e.message}`);
  await sleep(400);
  const pids = recordedPids();
  assert.equal(pids.length, 1, `expected 1 hung server, saw ${pids.length}`);
  // Tearing down mid-handshake must kill it and clear the entry.
  mcp.disconnectAll();
  for (let i = 0; i < 20 && pids.some(alive); i++) await sleep(150);
  const survivors = pids.filter(alive);
  for (const p of survivors) { try { process.kill(p, "SIGKILL"); } catch { /* cleanup */ } }
  assert.equal(survivors.length, 0, `hung server was not killed: ${survivors.join(",")}`);
  const status = await mcp.mcpStatus();
  assert.ok(!/fake: connected/.test(status), `dead server still reported connected:\n${status}`);
  await connectPromise;
});

// ---- 4. command-path quoting on Windows -------------------------------------

await ok("a command path containing a space is quoted", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omni mcp space-"));
  const exe = path.join(dir, "server.cmd");
  fs.writeFileSync(exe, "@echo off\r\n");
  assert.equal(mcp.needsCommandQuoting(exe), true, `${exe} should need quoting`);
  fs.rmSync(dir, { recursive: true, force: true });
});

await ok("a bare shim name is left unquoted so PATHEXT still resolves it", () => {
  assert.equal(mcp.needsCommandQuoting("npx"), false);
  assert.equal(mcp.needsCommandQuoting("uvx"), false);
});

await ok("a whole command line in `command` is left alone (not a real file)", () => {
  assert.equal(mcp.needsCommandQuoting("npx -y @scope/some-mcp-server"), false);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
