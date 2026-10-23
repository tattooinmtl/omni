// Router training data from your sessions (core/router-data.mjs, /route learn).
//
// Run: node tests/router-data.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

let pass = 0, fail = 0;
async function ok(label, fn) {
  try { await fn(); console.log(`  PASS ${label}`); pass++; }
  catch (e) { console.log(`  FAIL ${label}\n    ${e.stack || e.message}`); fail++; }
}

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1"));
const root = path.join(here, "..");
const u = (p) => pathToFileURL(path.join(root, p)).href;

process.env.OMNI_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "omni-rdata-home-"));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "omni-rdata-work-"));
process.chdir(work);

const { labelTurns, exportRouterData } = await import(u("src/core/router-data.mjs"));
const { Session } = await import(u("src/core/config.mjs"));

const call = (name) => ({ type: "assistant", message: { role: "assistant", content: "", tool_calls: [{ id: "c", type: "function", function: { name, arguments: "{}" } }] } });
const say = (content) => ({ type: "assistant", message: { role: "assistant", content } });

await ok("a prompt followed by edits or commands is coding; a plain answer is assistant", () => {
  const rows = labelTurns([
    { type: "user", content: "fix the failing test in parser.js" }, call("read_file"), call("edit_file"), say("fixed"),
    { type: "user", content: "what's a good name for a cat" }, say("Miso."),
    { type: "user", content: "search the web for llama.cpp releases" }, call("web_search"), say("here"),
  ]);
  assert.deepEqual(rows, [
    { text: "fix the failing test in parser.js", label: "coding" },
    { text: "what's a good name for a cat", label: "assistant" },
    { text: "search the web for llama.cpp releases", label: "assistant" },
  ]);
});

await ok("notes, unanswered prompts and rewound turns are left out", () => {
  const rows = labelTurns([
    { type: "user", content: "(btw — use tabs)" },
    { type: "user", content: "[hook ci] Not done yet" },
    { type: "user", content: "deploy it" }, call("run_shell"),
    { type: "rewind", keep: 0 },
    { type: "user", content: "never answered" },
  ]);
  assert.deepEqual(rows, []);
});

await ok("/route learn writes deduplicated JSONL from this folder's sessions", async () => {
  const s = new Session();
  for (const r of [{ type: "user", content: "refactor the router module" }, call("apply_patch"), { type: "user", content: "Refactor the router module" }, call("edit_file"), { type: "user", content: "explain what a closure is" }, say("A closure is…")]) await s.append(r);
  const sub = new Session({ kind: "subagent" });
  await sub.append({ type: "user", content: "sub-agent prompt should not count" });
  await sub.append(say("x"));
  await new Promise((r) => setTimeout(r, 80));
  const out = path.join(work, "sessions.jsonl");
  const r = exportRouterData({ out });
  assert.equal(r.count, 2, "the two refactor prompts differ only by case");
  assert.equal(r.coding, 1);
  assert.equal(r.assistant, 1);
  const rows = fs.readFileSync(out, "utf8").trim().split("\n").map(JSON.parse);
  assert.ok(rows.every((x) => x.label === "coding" || x.label === "assistant"));
  assert.ok(!rows.some((x) => /sub-agent/.test(x.text)));
});

await ok("the trainers read sessions.jsonl and it is gitignored", () => {
  for (const f of ["router/train.py", "router/train_intent_model.py"]) {
    assert.match(fs.readFileSync(path.join(root, f), "utf8"), /sessions\.jsonl/);
  }
  assert.match(fs.readFileSync(path.join(root, ".gitignore"), "utf8"), /^router\/data\/sessions\.jsonl$/m);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
