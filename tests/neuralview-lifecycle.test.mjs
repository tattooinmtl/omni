// Neuralview server lifecycle + local-only enforcement.
//
// What this pins:
//  1. Two concurrent startNeuralView() calls share ONE server. `activeServer`
//     is only assigned in the listen callback, so main.mjs's fire-and-forget
//     start and a /neuralview call in the same tick both got past the guard
//     and bound two ports — and stopNeuralView() could only ever close the
//     second, leaving the first bound for the life of the process.
//  2. Requests with a non-loopback Host are refused. The server binds to
//     127.0.0.1, which stops remote machines but NOT DNS rebinding: a page
//     the user is browsing could otherwise read /api/graph — the whole
//     knowledge base and every memory atom.
//  3. The live-graph registry is bounded, so a long session can't grow the
//     /api/graph payload without limit.
//
// Run: node tests/neuralview-lifecycle.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
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
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "omni-nv-lifecycle-"));
process.env.OMNI_HOME = tmpHome;

const nv = await import(pathToFileURL(path.join(root, "src/local/neuralview-server.mjs")).href);
const bus = await import(pathToFileURL(path.join(root, "src/local/activity-bus.mjs")).href);

const portOpen = (port) => new Promise((resolve) => {
  const s = net.connect(port, "127.0.0.1", () => { s.destroy(); resolve(true); });
  s.on("error", () => resolve(false));
});

// Raw request so we control the Host header (fetch always sets it correctly).
const rawGet = (port, pathname, host) => new Promise((resolve) => {
  const s = net.connect(port, "127.0.0.1", () => {
    s.write(`GET ${pathname} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
  });
  let buf = "";
  s.on("data", (d) => { buf += d; });
  s.on("error", () => resolve(buf));
  s.on("close", () => resolve(buf));
});

const BASE = 5931;

await ok("two concurrent starts share one server on one port", async () => {
  const [a, b] = await Promise.all([
    nv.startNeuralView({ port: BASE }),
    nv.startNeuralView({ port: BASE }),
  ]);
  assert.equal(a.port, b.port, `two servers bound: ${a.port} and ${b.port}`);
  assert.equal(await portOpen(BASE + 1), false, `a second server is listening on ${BASE + 1}`);
});

await ok("stopNeuralView closes the server that was actually started", async () => {
  const port = nv.neuralViewStatus().port;
  assert.equal(nv.stopNeuralView(), true);
  // Give the listener a moment to release the port.
  for (let i = 0; i < 20 && (await portOpen(port)); i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(await portOpen(port), false, `port ${port} still bound after stop`);
});

await ok("a request with a non-loopback Host is refused", async () => {
  const st = await nv.startNeuralView({ port: BASE + 4 });
  const res = await rawGet(st.port, "/api/graph", "attacker.example.com");
  assert.match(res.split("\r\n")[0], /403/, res.split("\r\n")[0]);
  assert.ok(!/"nodes"/.test(res), "the graph leaked to a rebound host");
});

await ok("localhost, 127.0.0.1 and [::1] Hosts are all still served", async () => {
  const port = nv.neuralViewStatus().port;
  for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, "localhost", `[::1]:${port}`]) {
    const res = await rawGet(port, "/api/graph", host);
    assert.match(res.split("\r\n")[0], /200/, `Host "${host}" was refused: ${res.split("\r\n")[0]}`);
  }
});

await ok("the page itself is still served to a loopback Host", async () => {
  const port = nv.neuralViewStatus().port;
  const res = await rawGet(port, "/", `localhost:${port}`);
  assert.match(res.split("\r\n")[0], /200/);
  assert.ok(/<html|<!doctype/i.test(res), "page body missing");
});

nv.stopNeuralView();

// ---- live-graph registry bounds --------------------------------------------

await ok("the live-node registry stops growing instead of running away", () => {
  for (let i = 0; i < 6000; i++) {
    bus.publishActivity({ kind: "live_node", op: "add", nodeId: `probe-node-${i}`, label: `n${i}`, nodeKind: "tool_call" });
    bus.publishActivity({ kind: "live_edge", source: `probe-node-${i}`, target: "hub", edgeKind: "live" });
  }
  const g = bus.liveGraph();
  assert.ok(g.nodes.length <= 4000, `live nodes unbounded: ${g.nodes.length}`);
  assert.ok(g.edges.length <= 8000, `live edges unbounded: ${g.edges.length}`);
  // The most recent work is what's kept.
  assert.ok(g.nodes.some((n) => n.id === "probe-node-5999"), "newest node was evicted");
});

await ok("evicted live nodes don't leave dangling edges in the rendered graph", async () => {
  const { buildGraph } = await import(pathToFileURL(path.join(root, "src/local/galaxy-graph.mjs")).href);
  const g = buildGraph();
  const ids = new Set(g.nodes.map((n) => n.id));
  const dangling = g.edges.filter((e) => !ids.has(e.source) || !ids.has(e.target));
  assert.equal(dangling.length, 0, `dangling edges: ${JSON.stringify(dangling.slice(0, 3))}`);
});

// ---- tied to Omi's lifetime -------------------------------------------------
// The view used to keep running until the process was force-killed, open
// pages never learned Omi had gone, and a half-closed Omi kept the port so
// the next one silently moved to another.

// An SSE client like the browser page; collects the events it receives.
const sseClient = (port) => new Promise((resolve) => {
  const events = [];
  let ended = false;
  const s = net.connect(port, "127.0.0.1", () => {
    s.write(`GET /api/events HTTP/1.1\r\nHost: localhost\r\n\r\n`);
  });
  s.on("data", (d) => {
    for (const m of String(d).matchAll(/data: (\{.*\})/g)) { try { events.push(JSON.parse(m[1])); } catch { /* partial */ } }
  });
  s.on("close", () => { ended = true; });
  setTimeout(() => resolve({ events, get ended() { return ended; }, socket: s }), 200);
});

await ok("stopping tells open pages Omi closed, ends their stream, frees the port", async () => {
  nv.stopNeuralView();
  const st = await nv.startNeuralView({ port: BASE + 8 });
  const client = await sseClient(st.port);
  assert.equal(nv.neuralViewClients(), 1, "the page should count as connected");
  assert.equal(nv.stopNeuralView({ reason: "closed" }), true);
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(client.events.some((e) => e.kind === "_shutdown" && e.reason === "closed"), JSON.stringify(client.events.map((e) => e.kind)));
  assert.equal(client.ended, true, "the page's stream should be closed");
  assert.equal(await portOpen(st.port), false, "port still bound after stop");
  assert.equal(nv.neuralViewClients(), 0);
});

await ok("restart keeps the same port, so open pages reconnect by themselves", async () => {
  const st = await nv.startNeuralView({ port: BASE + 9 });
  const client = await sseClient(st.port);
  const again = await nv.restartNeuralView();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(again.port, st.port);
  assert.ok(client.events.some((e) => e.kind === "_shutdown" && e.reason === "restart"));
  assert.equal(await portOpen(st.port), true);
  nv.stopNeuralView();
});

await ok("/api/whoami identifies the owning Omi so a port clash can be explained", async () => {
  const st = await nv.startNeuralView({ port: BASE + 10 });
  const who = await nv.probeNeuralView(st.port);
  assert.equal(who.app, "omni-neuralview");
  assert.equal(who.pid, process.pid);
  assert.equal(await nv.probeNeuralView(BASE + 11), null, "nothing listening → null");
  nv.stopNeuralView();
});

await ok("the view never keeps Omi alive, and dies with it (even on a hard exit)", async () => {
  const { spawnSync } = await import("node:child_process");
  const script = `
    const nv = await import(${JSON.stringify(pathToFileURL(path.join(root, "src/local/neuralview-server.mjs")).href)});
    await nv.startNeuralView({ port: ${BASE + 12} });
    console.log("up");
  `;
  // No explicit stop and nothing else pending: the process must exit on its own.
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8", timeout: 8000, env: { ...process.env, OMNI_HOME: tmpHome },
  });
  assert.equal(r.error?.code, undefined, `process didn't exit by itself (${r.error?.code})`);
  assert.match(r.stdout, /up/);
  assert.equal(await portOpen(BASE + 12), false);
});

await ok("/neuralview status|stop|restart work and bad subcommands show usage", async () => {
  const { neuralViewCommand } = await import(pathToFileURL(path.join(root, "src/cli/neuralview.mjs")).href);
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  try {
    await neuralViewCommand("stop");
    await neuralViewCommand("status");
    await neuralViewCommand("bogus");
  } finally { console.log = orig; }
  const text = lines.join("\n");
  assert.match(text, /isn't running/);
  assert.match(text, /usage: \/neuralview \[open\|restart\|stop\|status\]/);
});

fs.rmSync(tmpHome, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
