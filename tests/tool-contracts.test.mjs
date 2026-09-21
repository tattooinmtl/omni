// The contract between a tool's declared schema and what it actually does.
//
// The model only ever sees the schema. Anything the schema promises that the
// implementation doesn't honour — or any argument the model can omit and get
// an inscrutable failure for — costs a wasted turn at best and a silent wrong
// answer at worst. Audit found:
//   read_file({})              -> "EISDIR: illegal operation on a directory"
//   create_markdown_report({}) -> 'The "paths[1]" argument must be of type string'
//   search({}) / jq_query({}) / rag_search({}) -> no error at all
// and 13 parameters with no description, so the model saw a bare name.
//
// Run: node tests/tool-contracts.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

let pass = 0, fail = 0;
async function ok(label, fn) {
  try { await fn(); console.log(`  PASS ${label}`); pass++; }
  catch (e) { console.log(`  FAIL ${label}\n    ${e.message}`); fail++; }
}

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1"));
const root = path.join(here, "..");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omni-contract-"));
const origCwd = process.cwd();
process.chdir(dir);
const { tools, impl } = await import(pathToFileURL(path.join(root, "src", "tools", "index.mjs")).href);

console.log("\nSchema / implementation parity:");

await ok("every declared tool is implemented", () => {
  const missing = tools.map((t) => t.function.name).filter((n) => typeof impl[n] !== "function");
  assert.deepEqual(missing, []);
});

await ok("every implemented tool is declared", () => {
  const declared = new Set(tools.map((t) => t.function.name));
  assert.deepEqual(Object.keys(impl).filter((n) => !declared.has(n)), []);
});

await ok("no tool name is declared twice", () => {
  const names = tools.map((t) => t.function.name);
  assert.deepEqual(names.filter((n, i) => names.indexOf(n) !== i), []);
});

await ok("every tool and every parameter is documented", () => {
  // An undocumented parameter is a bare name in the model's tool list.
  const gaps = [];
  for (const t of tools) {
    const f = t.function;
    if (!f.description) gaps.push(`${f.name}: no tool description`);
    for (const [k, v] of Object.entries(f.parameters?.properties || {})) {
      if (!v.description) gaps.push(`${f.name}.${k}: no description`);
      if (!v.type) gaps.push(`${f.name}.${k}: no type`);
    }
  }
  assert.deepEqual(gaps, []);
});

await ok("every required parameter is actually defined in properties", () => {
  const gaps = [];
  for (const t of tools) {
    const f = t.function;
    for (const r of f.parameters?.required || []) {
      if (!f.parameters?.properties?.[r]) gaps.push(`${f.name}: required "${r}" is not a declared property`);
    }
  }
  assert.deepEqual(gaps, []);
});

console.log("\nMissing required arguments produce a usable error:");

// Tools that mutate the machine, spawn a model, or need a live session.
const SKIP = new Set([
  "run_shell", "run_test", "start_process", "stop_process", "process_input",
  "spawn_agent", "self_review", "stop_agent", "ask_user", "create_tool", "rag_index",
  "git_commit", "settings_add_model", "settings_set_apikey", "invoke_skill", "rename_symbol", "lsp",
]);
// Shapes a model cannot act on.
const INTERNAL = /argument must be of type|Cannot read properties|is not a function|paths\[\d+\]|ERR_INVALID_ARG|EISDIR|ENOENT:/i;

for (const t of tools) {
  const f = t.function;
  const required = f.parameters?.required || [];
  if (!required.length || SKIP.has(f.name)) continue;
  await ok(`${f.name} names the missing argument`, async () => {
    let err = null;
    try { await impl[f.name]({}); } catch (e) { err = e; }
    assert.ok(err, `accepted empty args — a model omitting ${required.join("/")} gets a silent wrong answer`);
    const msg = err.message.split("\n")[0];
    assert.ok(!INTERNAL.test(msg), `internal error the model cannot act on: ${msg}`);
    assert.ok(
      required.some((r) => msg.toLowerCase().includes(r.toLowerCase())),
      `error does not name any of ${required.join("/")}: ${msg}`,
    );
  });
}

console.log("\nThe critic's read-only allowlist:");

await ok("every allowlisted tool exists", () => {
  const src = fs.readFileSync(path.join(root, "src", "tools", "index.mjs"), "utf8");
  const start = src.indexOf("const CRITIC_PERMISSIONS");
  const block = src.slice(start, src.indexOf("};", start));
  const listed = [...block.matchAll(/^\s+([a-z_][a-z0-9_]*)\s*:/gim)].map((m) => m[1]);
  const declared = new Set(tools.map((t) => t.function.name));
  // A name that isn't a real tool is dead config that reads as coverage.
  assert.deepEqual(listed.filter((n) => !declared.has(n)), []);
});

await ok("the critic denies by default and allows nothing that writes", () => {
  const src = fs.readFileSync(path.join(root, "src", "tools", "index.mjs"), "utf8");
  const start = src.indexOf("const CRITIC_PERMISSIONS");
  const block = src.slice(start, src.indexOf("};", start));
  assert.match(block, /"\*":\s*"deny"/, "the critic must deny-by-default");
  for (const writer of ["write_file", "edit_file", "edit_lines", "apply_patch", "run_shell", "git_commit", "find_replace"]) {
    assert.ok(!new RegExp(`\\b${writer}\\s*:\\s*"allow"`).test(block), `${writer} must not be allowed — a critic that edits is not an independent check`);
  }
});

process.chdir(origCwd);
fs.rmSync(dir, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
