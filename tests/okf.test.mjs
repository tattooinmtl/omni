// OKF v2 server tests — spawns the real MCP server over stdio (JSON-RPC),
// pointed at a throwaway OKF_DIR, and exercises the hierarchical index,
// navigation, and the anti-hallucination guardrails end-to-end.
// Also unit-tests the local-model gating in src/core/okfnav.mjs.
// Run:  node tests/okf.test.mjs   (or node tests/run-all.mjs)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { isLocalModel, syncOkfNavGuidance, okfNavGuidance } from "../src/core/okfnav.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(here, "..", "packages", "okf", "server.mjs");

let pass = 0, fail = 0;

function assert(label, result, check) {
  try {
    const ok = check(result);
    if (ok) { console.log(`  ✓ ${label}`); pass++; }
    else { console.log(`  ✗ ${label}\n    got: ${String(result).slice(0, 200)}`); fail++; }
  } catch (e) {
    console.log(`  ✗ ${label}\n    error: ${e.message}`); fail++;
  }
}

// ---- minimal MCP stdio client ------------------------------------------------

function startServer(okfDir) {
  const proc = spawn(process.execPath, [SERVER], {
    env: { ...process.env, OKF_DIR: okfDir },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map();
  let nextId = 1;
  createInterface({ input: proc.stdout }).on("line", (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id != null && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  const rpc = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, resolve);
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); reject(new Error(`${method} timed out`)); }
      }, 10000).unref();
    });
  // Returns the text of a tools/call result (prefixed "ERROR: ..." on tool errors).
  const call = async (name, args = {}) => {
    const res = await rpc("tools/call", { name, arguments: args });
    return res.result?.content?.[0]?.text ?? JSON.stringify(res.error || res);
  };
  return { proc, rpc, call, stop: () => proc.kill() };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "okf-test-"));
const srv = startServer(tmp);

const init = await srv.rpc("initialize", { protocolVersion: "2025-03-26" });
assert("initialize reports okf v2", init, (r) => r.result?.serverInfo?.version?.startsWith("2."));

const list = await srv.rpc("tools/list");
const toolNames = (list.result?.tools || []).map((t) => t.name);
assert("exposes 9 tools incl. browse/move/reindex", toolNames,
  (n) => n.length === 9 && ["okf_browse", "okf_move", "okf_reindex"].every((x) => n.includes(x)));

// ── Scaffold + browse ─────────────────────────────────────────────
console.log("\nScaffold + browse");

const root = await srv.call("okf_browse");
assert("root index lists the 5 canonical categories", root,
  (r) => ["languages/", "frameworks/", "databases/", "tools/", "patterns/"].every((c) => r.includes(c)));

assert("canonical second level seeded on disk", fs.existsSync(path.join(tmp, "languages", "go")), Boolean);

const langs = await srv.call("okf_browse", { path: "languages" });
assert("descend into languages shows go + python", langs, (r) => r.includes("go/") && r.includes("python/"));

const badBrowse = await srv.call("okf_browse", { path: "languages/golang" });
assert("browse of invented path errors with valid siblings", badBrowse,
  (r) => r.startsWith("ERROR") && r.includes("languages/go/") && r.includes("previous okf_browse"));

// ── Add + generated indexes ───────────────────────────────────────
console.log("\nAdd + generated indexes");

const add1 = await srv.call("okf_add", {
  title: "time.Ticker goroutines leak unless stopped",
  body: "Always call ticker.Stop() when done. A forgotten ticker keeps its goroutine alive forever.\n\n```go\nt := time.NewTicker(d)\ndefer t.Stop()\n```",
  type: "gotcha", tags: ["Go", "concurrency", "go"], folder: "languages/go",
});
assert("add card into languages/go", add1, (r) => r.startsWith("Saved card") && r.includes("languages/go"));
const id1 = /Saved card (\S+)/.exec(add1)?.[1];

const add2 = await srv.call("okf_add", {
  title: "Prefer table-driven tests in Go",
  body: "Structure Go tests as a slice of cases and loop. Keeps coverage additions one-line cheap.",
  type: "pattern", tags: ["go", "testing"], folder: "languages/go",
});
const id2 = /Saved card (\S+)/.exec(add2)?.[1];
assert("second card saved", add2, (r) => r.startsWith("Saved card"));

const goIndex = fs.readFileSync(path.join(tmp, "languages", "go", "index.okf"), "utf8");
assert("index.okf generated in languages/go with both cards", goIndex,
  (r) => r.includes(id1) && r.includes(id2) && r.includes("Auto-generated"));

const rootIndex = fs.readFileSync(path.join(tmp, "index.okf"), "utf8");
assert("root index.okf counts 2 cards under languages/", rootIndex,
  (r) => /languages\/ — 2 cards/.test(r) && r.includes("Total cards: 2"));

const browseGo = await srv.call("okf_browse", { path: "languages/go" });
assert("browse languages/go lists cards with first sentence", browseGo,
  (r) => r.includes(id1) && r.includes("Always call ticker.Stop()"));

// ── Guardrails ────────────────────────────────────────────────────
console.log("\nGuardrails");

const badFolder = await srv.call("okf_add", {
  title: "Some knowledge", body: "text", folder: "langages/go",
});
assert("invented top-level category rejected with valid list", badFolder,
  (r) => r.startsWith("ERROR") && r.includes("languages, frameworks, databases, tools, patterns"));

const forced = await srv.call("okf_add", {
  title: "Omni memory design decision", body: "Chose hierarchical OKF index over embeddings for local retrieval.",
  type: "decision", folder: "projects/omni", force: true,
});
assert("force:true allows a new category deliberately", forced, (r) => r.startsWith("Saved card"));
const id3 = /Saved card (\S+)/.exec(forced)?.[1];

const deep = await srv.call("okf_add", { title: "too deep", body: "x", folder: "languages/go/examples/basics" });
assert("depth > 3 rejected", deep, (r) => r.startsWith("ERROR") && r.includes("maximum is 3"));

const dupe = await srv.call("okf_add", {
  title: "time.Ticker goroutines leak unless you stop them",
  body: "different text", type: "gotcha", folder: "languages/go",
});
assert("near-duplicate title rejected, points at existing id", dupe,
  (r) => r.startsWith("ERROR") && r.includes(id1) && r.includes("okf_update"));

const badLink = await srv.call("okf_add", {
  title: "Card with fabricated link", body: "x", folder: "patterns/testing",
  links: ["totally-invented-card-9999"],
});
assert("hallucinated link id rejected", badLink,
  (r) => r.startsWith("ERROR") && r.includes("must reference existing cards"));

const badGet = await srv.call("okf_get", { id: id1.replace(/-[0-9a-f]+$/, "-ffff") });
assert("unknown id gets did-you-mean suggestion", badGet,
  (r) => r.startsWith("ERROR") && r.includes(id1));

const goodLink = await srv.call("okf_add", {
  title: "Detect goroutine leaks with goleak", body: "Use go.uber.org/goleak in TestMain to fail tests that leak goroutines.",
  type: "howto", tags: ["go", "testing"], folder: "languages/go", links: [id1],
});
assert("valid link accepted", goodLink, (r) => r.startsWith("Saved card"));
const id4 = /Saved card (\S+)/.exec(goodLink)?.[1];

// ── Get / search / list ───────────────────────────────────────────
console.log("\nGet / search / list");

const got = await srv.call("okf_get", { id: id1 });
assert("get returns card with location + normalized tags", got,
  (r) => r.includes("Location: languages/go") && r.includes("tags: go, concurrency"));

const found = await srv.call("okf_search", { query: "goroutine leak" });
assert("search finds both goroutine cards with folder shown", found,
  (r) => r.includes(id1) && r.includes(id4) && r.includes("(in languages/go)"));

const scoped = await srv.call("okf_search", { query: "design decision", folder: "projects" });
assert("search scoped to folder subtree", scoped, (r) => r.includes(id3) && !r.includes(id1));

const listed = await srv.call("okf_list", { folder: "languages/go" });
assert("list filters by folder", listed, (r) => r.includes(id1) && r.includes(id2) && !r.includes(id3));

// ── Update / move / delete / reindex ──────────────────────────────
console.log("\nUpdate / move / delete / reindex");

const upd = await srv.call("okf_update", { id: id2, append: "Also name each case for t.Run subtests." });
assert("update append works", upd, (r) => r.startsWith("Updated card"));

const moved = await srv.call("okf_move", { id: id2, folder: "patterns/testing" });
assert("move re-files the card", moved, (r) => r.includes("languages/go") && r.includes("patterns/testing"));
assert("moved file exists at new location", fs.existsSync(path.join(tmp, "patterns", "testing", `${id2}.md`)), Boolean);
assert("old file removed", !fs.existsSync(path.join(tmp, "languages", "go", `${id2}.md`)), Boolean);

const del = await srv.call("okf_delete", { id: id1 });
assert("delete reports dangling backlinks", del, (r) => r.startsWith("Deleted") && r.includes(id4));

const del3 = await srv.call("okf_delete", { id: id3 });
assert("delete prunes empty non-canonical folder", del3,
  (r) => r.startsWith("Deleted") && !fs.existsSync(path.join(tmp, "projects", "omni")));
assert("canonical folders never pruned", fs.existsSync(path.join(tmp, "languages", "go")), Boolean);

// Manual edit outside the tools, then reindex heals the index.
fs.writeFileSync(path.join(tmp, "databases", "sqlite", "wal-mode-aaaa.md"), [
  "---", "okf: 1", "id: wal-mode-aaaa", "title: Enable WAL mode for concurrent readers",
  "type: howto", "tags: sqlite", "language: sql", "source: ", "created: 2026-07-15T00:00:00.000Z",
  "updated: 2026-07-15T00:00:00.000Z", "links: ", "---", "", "PRAGMA journal_mode=WAL;",
].join("\n"), "utf8");
const reidx = await srv.call("okf_reindex");
assert("reindex picks up manually added card", reidx, (r) => /Reindexed: 3 card/.test(r));
assert("sqlite index.okf now lists the manual card",
  fs.readFileSync(path.join(tmp, "databases", "sqlite", "index.okf"), "utf8"),
  (r) => r.includes("wal-mode-aaaa"));

srv.stop();

// ── Local-model gating (okfnav.mjs) ───────────────────────────────
console.log("\nLocal-model gating");

const localModel = { providerName: "local", provider: { baseUrl: "http://localhost:8080/v1" } };
const ollamaModel = { providerName: "ollama", provider: { baseUrl: "http://localhost:11434/v1" } };
const nvidiaModel = { providerName: "nvidia", provider: { baseUrl: "https://integrate.api.nvidia.com/v1" } };
const openaiModel = { providerName: "openai", provider: { baseUrl: "https://api.openai.com/v1" } };

assert("local llama provider detected as local", isLocalModel(localModel), Boolean);
assert("ollama detected as local", isLocalModel(ollamaModel), Boolean);
assert("nvidia NOT local", !isLocalModel(nvidiaModel), Boolean);
assert("openai NOT local", !isLocalModel(openaiModel), Boolean);

const okfTools = [{ function: { name: "mcp" } }];
const noOkfTools = [{ function: { name: "read_file" } }];

let msgs = [{ role: "system", content: "BASE PROMPT" }];
syncOkfNavGuidance(msgs, localModel, okfTools);
assert("local model gets navigation rules injected", msgs[0].content,
  (r) => r.includes("okf-local-nav:start") && r.includes("NEVER invent folder paths"));

syncOkfNavGuidance(msgs, localModel, okfTools);
assert("injection is idempotent (one block after two syncs)", msgs[0].content,
  (r) => r.split("okf-local-nav:start").length === 2);

syncOkfNavGuidance(msgs, nvidiaModel, okfTools);
assert("switching to frontier model removes the block", msgs[0].content,
  (r) => r === "BASE PROMPT");

msgs = [{ role: "system", content: "BASE PROMPT" }];
syncOkfNavGuidance(msgs, localModel, noOkfTools);
assert("no okf tools -> no injection even on local", msgs[0].content, (r) => r === "BASE PROMPT");

assert("guidance text mentions browse-first and search fallback", okfNavGuidance(),
  (r) => r.includes("okf_browse") && r.includes("okf_search"));

// ── done ──────────────────────────────────────────────────────────
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
