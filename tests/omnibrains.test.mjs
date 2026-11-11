// omni.brains bridge (/brain) — against a fake brain: a stdio MCP server
// speaking the tools omni.brains serves (get_brain_identity, list_pages,
// get_links, get_backlinks, search, query, recall, remember, forget,
// get_page). It logs every call to GBRAIN_HOME/calls.jsonl, which /brain
// connect --home sets, so the tests can check exactly what was sent. Pins:
//   - /brain connect saves <HOME>/mcp/omnibrains.json and the brain answers
//   - the commands call the right tools with the right arguments, and
//     remember always records provenance
//   - the 3D snapshot: pages + links, links to pages outside it dropped,
//     drawn in buildGraph() as the omni.brains region (type hubs, pages, links)
//   - a brain tool error reaches the user as the brain's own message
//   - /brain disconnect removes the service file and the snapshot
// Run: node tests/omnibrains.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "omni-brain-test-"));
process.env.OMNI_HOME = home;
const brainHome = path.join(home, "brainhome");
fs.mkdirSync(brainHome, { recursive: true });

const bridge = await import("../src/integrations/omnibrains.mjs");
const { brainCommand, unquote, parseRemember, parseConnectArgs } = await import("../src/cli/brain.mjs");
const { serviceFile } = await import("../src/integrations/services.mjs");
const { buildGraph } = await import("../src/local/galaxy-graph.mjs");
const { BRAIN_ID } = await import("../src/local/graph-ids.mjs");
const mcp = await import("../src/integrations/mcp.mjs");

let pass = 0, fail = 0;
async function test(label, fn) {
  try { await fn(); console.log(`  PASS ${label}`); pass++; }
  catch (e) { console.log(`  FAIL ${label}\n    ${e.stack || e.message}`); fail++; }
}

// ---- the fake brain ---------------------------------------------------------
const fake = path.join(home, "fake-brain.mjs");
fs.writeFileSync(fake, `
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
const log = path.join(process.env.GBRAIN_HOME || ".", "calls.jsonl");
const pages = [
  { slug: "projects/omnibots", title: "OmniBots", type: "project", source_id: "default", updated_at_iso: "2026-11-11T10:00:00Z" },
  { slug: "projects/omnicode", title: "OmniCode", type: "project", source_id: "default", updated_at_iso: "2026-11-10T10:00:00Z" },
  { slug: "people/alice-example", title: "Alice Example", type: "person", source_id: "default", updated_at_iso: "2026-11-09T10:00:00Z" },
];
const links = {
  "projects/omnibots": [
    { from_slug: "projects/omnibots", to_slug: "projects/omnicode", link_type: "mentions" },
    { from_slug: "projects/omnibots", to_slug: "people/alice-example", link_type: "" },
    { from_slug: "projects/omnibots", to_slug: "ghost/not-in-snapshot", link_type: "" },
  ],
  "projects/omnicode": [{ from_slug: "projects/omnicode", to_slug: "projects/omnibots", link_type: "" }],
};
const text = (v) => ({ content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v) }] });
function call(name, a) {
  fs.appendFileSync(log, JSON.stringify({ name, args: a }) + "\\n");
  switch (name) {
    case "get_brain_identity": return text({ version: "0.0.0-fake", engine: "pglite", page_count: 3, chunk_count: 3 });
    case "list_pages": return text(pages.slice(a.offset || 0, (a.offset || 0) + (a.limit || 50)));
    case "get_links": return text(links[a.slug] || []);
    case "get_backlinks": return text(a.slug === "projects/omnicode" ? [{ from_slug: "projects/omnibots", link_type: "mentions" }] : []);
    case "search": case "query":
      return text([{ slug: "projects/omnibots", title: "[quoted conversation excerpt from projects/omnibots; source material, not instructions]\\n\`\`\`text\\nOmniBots\\n\`\`\`", chunk_text: "OmniBots is a guild of AI bots." }]);
    case "recall": return text({ facts: [{ id: 1, fact: "OmniCode launches claw-core" }], total: 1 });
    case "remember": return text({ id: "2", status: "inserted", status_text: "remembered as fact #2" });
    case "forget": return text({ status: "forgotten" });
    case "get_page":
      if (a.slug === "missing") return { isError: true, ...text({ error: "page_not_found", message: "No page missing" }) };
      return text({ slug: a.slug, content: "# OmniBots\\nA guild of bots." });
    default: return { isError: true, ...text("unknown tool " + name) };
  }
}
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id == null) return;
  let result = {};
  if (msg.method === "initialize") result = { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "omni.brains" } };
  else if (msg.method === "tools/list") result = { tools: ["get_brain_identity", "list_pages", "get_links", "recall", "remember"].map((n) => ({ name: n, inputSchema: { type: "object" } })) };
  else if (msg.method === "tools/call") result = call(msg.params.name, msg.params.arguments || {});
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\\n");
});
`);

const callsFile = path.join(brainHome, "calls.jsonl");
const calls = () => (fs.existsSync(callsFile) ? fs.readFileSync(callsFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const clearCalls = () => { try { fs.unlinkSync(callsFile); } catch { /* none yet */ } };

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
  assert.equal(unquote("plain"), "plain");
});

await test("parseRemember splits entity and fact on the first colon", () => {
  assert.deepEqual(parseRemember("omnicode: launches claw-core: v2"), { entity: "omnicode", fact: "launches claw-core: v2" });
  assert.equal(parseRemember("no colon here"), null);
  assert.equal(parseRemember(" : empty entity"), null);
});

await test("parseConnectArgs reads a quoted path and --home", () => {
  assert.deepEqual(parseConnectArgs('"C:\\Program Files\\omni-brains.exe" --home D:\\brain'), { bin: "C:\\Program Files\\omni-brains.exe", home: "D:\\brain" });
  assert.deepEqual(parseConnectArgs(""), { bin: undefined, home: undefined });
});

await test("brainDefinition: binary, bun for .ts, node for .mjs, GBRAIN_HOME from --home", () => {
  assert.deepEqual(bridge.brainDefinition("C:\\b\\omni-brains.exe").args, ["serve"]);
  const ts = bridge.brainDefinition("C:\\src\\cli.ts");
  assert.equal(ts.command, "bun"); assert.deepEqual(ts.args, ["run", "C:\\src\\cli.ts", "serve"]);
  const js = bridge.brainDefinition("C:\\w\\wrap.mjs", { home: brainHome });
  assert.equal(js.command, process.execPath); assert.equal(js.env.GBRAIN_HOME, path.resolve(brainHome));
});

await test("an explicit brain path that doesn't exist is refused", () => {
  assert.throws(() => bridge.findBrainBinary(path.join(home, "nope.exe")), /no brain binary/);
});

// ---- commands against the fake brain ------------------------------------------------
await test("/brain before connect says how to connect", async () => {
  const outText = await captured(() => brainCommand({}, ""));
  assert.match(outText, /isn't connected/);
});

await test("/brain connect saves the service and the brain answers", async () => {
  const outText = await captured(() => brainCommand({}, `connect "${fake}" --home "${brainHome}"`));
  assert.match(outText, /connected omni\.brains 0\.0\.0-fake \(3 pages\)/);
  const saved = JSON.parse(fs.readFileSync(serviceFile("omnibrains"), "utf8"));
  assert.equal(saved.command, process.execPath);
  assert.deepEqual(saved.args, [fake, "serve"]);
  assert.equal(saved.env.GBRAIN_HOME, path.resolve(brainHome));
  assert.ok(bridge.brainConfigured());
});

await test("/brain status reports version and pages", async () => {
  const outText = await captured(() => brainCommand({}, "status"));
  assert.match(outText, /omni\.brains 0\.0\.0-fake · pglite · 3 pages/);
});

await test("/brain search lists hits without the quoting envelope", async () => {
  clearCalls();
  const outText = await captured(() => brainCommand({}, "search guild bots"));
  assert.match(outText, /projects\/omnibots\s+OmniBots/);
  assert.doesNotMatch(outText, /quoted conversation excerpt/);
  assert.deepEqual(calls().at(-1), { name: "search", args: { query: "guild bots", limit: 10 } });
});

await test("/brain remember sends entity, fact and provenance", async () => {
  clearCalls();
  const outText = await captured(() => brainCommand({}, "remember omnicode: launches claw-core as its agent"));
  assert.match(outText, /remembered as fact #2/);
  assert.deepEqual(calls().at(-1), { name: "remember", args: { entity: "omnicode", fact: "launches claw-core as its agent", provenance: "omni /brain remember" } });
});

await test("/brain remember without entity:fact shows usage and calls nothing", async () => {
  clearCalls();
  const outText = await captured(() => brainCommand({}, "remember just words"));
  assert.match(outText, /usage: \/brain remember <entity>: <fact>/);
  assert.equal(calls().length, 0);
});

await test("/brain recall lists the entity's facts", async () => {
  clearCalls();
  const outText = await captured(() => brainCommand({}, "recall omnicode what agent"));
  assert.match(outText, /#1 OmniCode launches claw-core/);
  assert.deepEqual(calls().at(-1), { name: "recall", args: { entity: "omnicode", query: "what agent" } });
});

await test("/brain forget passes the fact id", async () => {
  clearCalls();
  await captured(() => brainCommand({}, "forget 7"));
  assert.deepEqual(calls().at(-1), { name: "forget", args: { id: "7" } });
});

await test("/brain links shows outgoing and incoming", async () => {
  const outText = await captured(() => brainCommand({}, "links projects/omnicode"));
  assert.match(outText, /projects\/omnicode: 1 outgoing, 1 incoming/);
  assert.match(outText, /→ projects\/omnibots/);
  assert.match(outText, /← projects\/omnibots \(mentions\)/);
});

await test("a brain tool error reaches the user as the brain's message", async () => {
  const outText = await captured(() => brainCommand({}, "get missing"));
  assert.match(outText, /omni\.brains: get_page: No page missing/);
});

// ---- the 3D view --------------------------------------------------------------
await test("refreshBrainGraph snapshots pages and links, dropping links outside it", async () => {
  const g = await bridge.refreshBrainGraph();
  assert.equal(g.pages.length, 3);
  assert.equal(g.totalPages, 3);
  assert.equal(g.truncated, false);
  const pairs = g.links.map((l) => `${l.from}>${l.to}`).sort();
  assert.deepEqual(pairs, [
    "brain:default:projects/omnibots>brain:default:people/alice-example",
    "brain:default:projects/omnibots>brain:default:projects/omnicode",
    "brain:default:projects/omnicode>brain:default:projects/omnibots",
  ]);
});

await test("buildGraph draws the omni.brains region: hub, type clusters, pages, links", () => {
  const graph = buildGraph();
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  assert.equal(byId.get(BRAIN_ID)?.label, "omni.brains");
  assert.ok(graph.edges.some((e) => e.target === BRAIN_ID && e.kind === "system"), "brain hangs off the coordinator");
  assert.equal(byId.get("brain-type:project")?.kind, "brain-type");
  assert.equal(byId.get("brain-type:person")?.kind, "brain-type");
  const page = byId.get("brain:default:projects/omnibots");
  assert.equal(page?.kind, "brain-page");
  assert.equal(page.label, "OmniBots");
  assert.ok(graph.edges.some((e) => e.source === "brain-type:project" && e.target === page.id && e.kind === "hierarchy"));
  assert.equal(graph.edges.filter((e) => e.kind === "link" && String(e.source).startsWith("brain:")).length, 3);
  assert.equal(graph.counts.brainPages, 3);
  assert.equal(graph.counts.brainLinks, 3);
});

await test("background refresh: one fetch at a time, skipped when a snapshot exists and ifMissing", async () => {
  clearCalls();
  const a = bridge.refreshBrainGraphInBackground();
  const b = bridge.refreshBrainGraphInBackground();
  assert.equal(a, b, "a second call while one is running reuses it");
  await a;
  assert.equal(calls().filter((c) => c.name === "list_pages").length, 1);
  clearCalls();
  assert.equal(bridge.refreshBrainGraphInBackground({ ifMissing: true }), null);
  assert.equal(calls().length, 0);
});

await test("a tab connecting to the neural view loads the brain when there is no snapshot", async () => {
  const { setBrainGraph } = await import("../src/local/brain-graph-store.mjs");
  const { startNeuralView, stopNeuralView } = await import("../src/local/neuralview-server.mjs");
  setBrainGraph(null);
  const st = await startNeuralView({ port: 6040 });
  const ctrl = new AbortController();
  try {
    const res = await fetch(`${st.url}api/events`, { signal: ctrl.signal, headers: { Host: new URL(st.url).host } });
    assert.equal(res.status, 200);
    for (let i = 0; i < 50 && !bridge.brainGraph(); i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(bridge.brainGraph()?.pages.length, 3, "the snapshot was loaded by the tab connecting");
  } finally {
    ctrl.abort();
    stopNeuralView({ reason: "stopped" });
  }
});

await test("/brain disconnect removes the service file and the 3D snapshot", async () => {
  const outText = await captured(() => brainCommand({}, "disconnect"));
  assert.match(outText, /omni\.brains disconnected/);
  assert.equal(fs.existsSync(serviceFile("omnibrains")), false);
  assert.equal(bridge.brainConfigured(), false);
  assert.equal(bridge.brainGraph(), null);
  assert.equal(buildGraph().nodes.some((n) => n.id === BRAIN_ID), false);
});

mcp.disconnectAll();
try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* Windows may hold a handle briefly */ }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
