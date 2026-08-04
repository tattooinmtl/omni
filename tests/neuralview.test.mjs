// /neuralview tests — the galaxy-graph builder (OKF cards + memory atoms +
// legacy memories -> nodes/edges), the local HTTP server it's served from,
// and the live activity SSE stream (src/local/activity-bus.mjs) that drives
// the real-time pulse animation. Runs against a throwaway OMNI_HOME with a
// couple of real OKF cards copied in, and a real (127.0.0.1-only) server.
// Run: node tests/neuralview.test.mjs  (or node tests/run-all.mjs)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

let pass = 0, fail = 0;
async function assert(label, result, check) {
  try {
    const ok = check(await result);
    if (ok) { console.log(`  ✓ ${label}`); pass++; }
    else { console.log(`  ✗ ${label}\n    got: ${String(await result).slice(0, 200)}`); fail++; }
  } catch (e) {
    console.log(`  ✗ ${label}\n    error: ${e.message}`); fail++;
  }
}

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1"));
const root = path.join(here, "..");
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "omni-neuralview-test-"));
process.env.OMNI_HOME = tmpHome;

// Seed one real OKF card so the graph builder has something to find.
fs.mkdirSync(path.join(tmpHome, "knowledge", "patterns", "testing"), { recursive: true });
fs.writeFileSync(
  path.join(tmpHome, "knowledge", "patterns", "testing", "neuralview-fixture.md"),
  [
    "---", "okf: 1", "id: neuralview-fixture", "title: neuralview test fixture card",
    "type: reference", "tags: test, fixture", "language: ", "source: ",
    "created: 2026-01-01T00:00:00.000Z", "updated: 2026-01-01T00:00:00.000Z", "links: ",
    "---", "", "Body text for the fixture card.",
  ].join("\n"),
  "utf8"
);

const u = (p) => pathToFileURL(path.join(root, "src", p)).href;
const { buildGraph } = await import(u("local/galaxy-graph.mjs"));
const { layeredProvider } = await import(u("core/memory-provider.mjs"));
const { publishActivity } = await import(u("local/activity-bus.mjs"));
const { startNeuralView, stopNeuralView, neuralViewStatus } = await import(u("local/neuralview-server.mjs"));

layeredProvider.propose({ type: "fact", text: "Fixture atom for neuralview graph test.", tags: ["test"], confidence: 0.6 });

// ---- graph builder -----------------------------------------------------------

const graph = buildGraph();
await assert("buildGraph finds the seeded OKF card", graph.counts.cards, (n) => n >= 1);
await assert("buildGraph finds the seeded atom", graph.counts.atoms, (n) => n >= 1);
await assert("node/edge counts in the payload match the arrays returned", graph, (g) => g.nodes.length === g.counts.nodes && g.edges.length === g.counts.edges);
await assert("every node has a stable id and a kind", graph.nodes,
  (ns) => ns.every((n) => n.id && ["system", "system-inactive", "hub", "folder", "card", "atom", "memory"].includes(n.kind)));
await assert("the architecture core (Coordinator/L0/Chat Memory/Skills/Wiki/CodeGraph/Feedback) is always present",
  graph.nodes.map((n) => n.id),
  (ids) => ["sys-coordinator", "sys-l0", "sys-chatmem", "sys-skills", "sys-wiki", "sys-codegraph", "sys-feedback", "okf-root"].every((id) => ids.includes(id)));
await assert("the full OKF taxonomy skeleton renders even for unpopulated folders",
  graph.counts.folders, (n) => n >= 57); // 5 top-level + 52 canonical subcategories
await assert("memory atoms attach directly to Chat Memory, not scattered into the OKF taxonomy",
  graph, (g) => {
    const atom = g.nodes.find((n) => n.kind === "atom");
    return !!atom && g.edges.some((e) => e.source === "sys-chatmem" && e.target === atom.id);
  });
await assert("every edge references node ids present in the graph", graph, (g) => {
  const ids = new Set(g.nodes.map((n) => n.id));
  return g.edges.every((e) => ids.has(e.source) && ids.has(e.target));
});

// ---- HTTP server --------------------------------------------------------------

await assert("neuralViewStatus reports not running before start", neuralViewStatus().running, (v) => v === false);

const started = await startNeuralView({ port: 6010 });
await assert("startNeuralView reports running + a localhost URL", started, (s) => s.running && /^http:\/\/localhost:\d+\/$/.test(s.url));

const homeRes = await fetch(started.url);
const html = await homeRes.text();
await assert("GET / returns 200", homeRes.status, (s) => s === 200);
await assert("page is self-contained: no external hosts referenced", html, (h) =>
  !/https?:\/\/(?!localhost)/i.test(h.replace(/https:\/\/github\.com/g, "")) // tolerate a stray doc comment only, not real refs
);
await assert("page title identifies the network view", html, (h) => h.includes("Omni Neural Network"));
await assert("page subscribes to the live activity stream", html, (h) => h.includes("/api/events"));

const graphRes = await fetch(started.url + "api/graph");
const graphJson = await graphRes.json();
await assert("GET /api/graph returns the same shape buildGraph() produces", graphJson.counts, (c) => c.cards === graph.counts.cards);

const atomId = graph.nodes.find((n) => n.kind === "atom").id;
const explainRes = await fetch(started.url + "api/explain/" + encodeURIComponent(atomId));
await assert("GET /api/explain/:id resolves a real atom", explainRes.status, (s) => s === 200);

const missingRes = await fetch(started.url + "api/explain/not-a-real-id");
await assert("GET /api/explain/:id 404s for an unknown id", missingRes.status, (s) => s === 404);

// ---- live activity: Server-Sent Events -----------------------------------

// Reads /api/events until `matchFn` sees a matching event or `timeoutMs`
// elapses, calling `triggerFn` right after the stream connects. A single
// sequential reader loop (never overlapping read() calls), aborted via
// AbortController on timeout so it can't hang the suite.
async function collectSSE(url, triggerFn, matchFn, timeoutMs = 3000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const res = await fetch(url, { signal: controller.signal });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  await new Promise((r) => setTimeout(r, 50)); // let the server register the listener
  triggerFn();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const m = /^data: (.*)$/m.exec(chunk);
        if (!m) continue;
        try {
          const evt = JSON.parse(m[1]);
          if (matchFn(evt)) { clearTimeout(timer); controller.abort(); return evt; }
        } catch { /* keep-alive ping or malformed — skip */ }
      }
    }
  } catch { /* aborted (timeout) or stream closed */ }
  clearTimeout(timer);
  return null;
}

const atomEvent = await collectSSE(
  started.url + "api/events",
  () => layeredProvider.propose({ type: "fact", text: "SSE trigger atom for neuralview test.", tags: ["sse-test"], confidence: 0.6 }),
  (e) => e.kind === "memory_atom" && e.action === "created" && /SSE trigger atom/.test(e.text || "")
);
await assert("propose() publishes a memory_atom SSE event a browser client can observe",
  atomEvent, (e) => e && e.action === "created");

const toolEvent = await collectSSE(
  started.url + "api/events",
  () => publishActivity({ kind: "tool_call", tool: "read_file", phase: "start" }),
  (e) => e.kind === "tool_call" && e.tool === "read_file"
);
await assert("arbitrary activity-bus events (e.g. agent tool calls) are forwarded over SSE",
  toolEvent, (e) => e && e.phase === "start");

const routedEvent = await collectSSE(
  started.url + "api/events",
  () => publishActivity({ kind: "tool_call", tool: "memory_search", phase: "start", route: "sys-chatmem" }),
  (e) => e.kind === "tool_call" && e.tool === "memory_search"
);
await assert("a memory_* tool call carries a route to the Chat Memory architecture node",
  routedEvent, (e) => e && e.route === "sys-chatmem");

// core/config.mjs's Session.append publishes an l0_event on every capture —
// "session events -> L0 immutable conversation log" (NewPlanConversion.md).
const { Session } = await import(u("core/config.mjs"));
const testSession = new Session(); // constructor itself appends a session_start record
const l0Event = await collectSSE(
  started.url + "api/events",
  () => testSession.append({ type: "user", content: "L0 SSE trigger message." }),
  // The constructor's own (unawaited) session_start append may still be
  // in flight and could publish its l0_event around the same time — match
  // specifically on the event we triggered, not just any l0_event.
  (e) => e.kind === "l0_event" && e.eventType === "user"
);
await assert("session capture publishes a live l0_event pulse",
  l0Event, (e) => e && e.eventType === "user");

// ---- replay: a tab that connects AFTER activity already happened should
// still see it — this is what makes /neuralview useful when opened mid-
// session instead of only showing whatever occurs after the tab connects.
const replayedAtom = await collectSSE(
  started.url + "api/events",
  () => {}, // nothing to trigger — this checks history already published above
  (e) => e.replay === true && e.kind === "memory_atom" && /SSE trigger atom/.test(e.text || "")
);
await assert("a freshly-opened /api/events connection replays recent history",
  replayedAtom, (e) => e && e.replay === true);

const replayEnd = await collectSSE(
  started.url + "api/events",
  () => {},
  (e) => e.kind === "_replay_end"
);
await assert("the replay burst ends with an explicit marker the page uses to sync the graph once",
  replayEnd, (e) => e && e.kind === "_replay_end");

// ---- lifecycle --------------------------------------------------------------

await assert("a second startNeuralView() call while running is idempotent (returns the same server)",
  startNeuralView({ port: 6010 }), (s) => s.port === started.port);

await assert("stopNeuralView stops the server", stopNeuralView(), (v) => v === true);
await assert("neuralViewStatus reports not running after stop", neuralViewStatus().running, (v) => v === false);
await assert("stopping an already-stopped server returns false, doesn't throw", stopNeuralView(), (v) => v === false);

// ---- cleanup ----------------------------------------------------------------

fs.rmSync(tmpHome, { recursive: true, force: true });

console.log(`\n  ${pass} passed, ${fail} failed`);
// exitCode (not process.exit()) lets libuv finish closing the HTTP server's
// handles on its own — calling exit() immediately after server.close() can
// race the handle teardown and crash the process on Windows.
process.exitCode = fail ? 1 : 0;
