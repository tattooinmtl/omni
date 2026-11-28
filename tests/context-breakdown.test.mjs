// /context: what fills the context window, by kind (src/core/context-breakdown.mjs).
//
// Run: node tests/context-breakdown.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1")), "..");
process.env.OMNI_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "omni-ctx-"));
const imp = (p) => import(pathToFileURL(path.join(root, p)).href);
const { contextBreakdown, formatBreakdown, bar } = await imp("src/core/context-breakdown.mjs");
const { COMMANDS } = await imp("src/cli/commands.mjs");

let pass = 0, fail = 0;
async function ok(label, fn) {
  try { await fn(); console.log(`  ✓ ${label}`); pass++; }
  catch (e) { console.log(`  ✗ ${label}\n    ${e.stack || e.message}`); fail++; }
}

const big = "x".repeat(40_000);
const messages = [
  { role: "system", content: "s".repeat(4000) },
  { role: "user", content: "fix the build" },
  { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "a.js" }) } }, { id: "c2", type: "function", function: { name: "run_shell", arguments: JSON.stringify({ command: "npm test" }) } }] },
  { role: "tool", tool_call_id: "c1", content: big },
  { role: "tool", tool_call_id: "c2", content: "y".repeat(8000) },
  { role: "system", content: "skill: be careful" },
  { role: "user", content: [{ type: "text", text: "look" }, { type: "image_url", image_url: { url: "data:x" } }] },
  { role: "assistant", content: "Done." },
];

await ok("each kind is counted apart, tool results by tool, images separately", () => {
  const b = contextBreakdown(messages, { toolDefs: [{ type: "function", function: { name: "read_file", description: "d".repeat(400) } }] });
  const row = (k) => b.rows.find((r) => r.key === k).tokens;
  assert.equal(row("system"), Math.ceil(4020 / 4));
  assert.equal(row("results"), Math.ceil((40_020 + 8020) / 4));
  assert.ok(row("tools") > 100);
  assert.ok(row("notes") > 0 && row("user") > 0 && row("assistant") > 0 && row("calls") > 0);
  assert.deepEqual(b.topTools.map((t) => t.name), ["read_file", "run_shell"]);
  assert.equal(b.images, 1);
  assert.equal(b.total, b.rows.reduce((n, r) => n + r.tokens, 0));
});

await ok("the lines show a gauge against the window, each kind's share, and the biggest results", () => {
  const b = contextBreakdown(messages);
  const lines = formatBreakdown(b, { window: 100_000 });
  assert.match(lines[0], /^[█░]{30} 1\d% of 100k \(~1\d\.\dk estimated\)$/);
  assert.ok(lines.some((l) => /tool results\s+[█░]{12}\s+~12\.0k\s+\d+%/.test(l)), lines.join("\n"));
  assert.ok(lines.some((l) => /largest tool results: read_file ~10\.0k, run_shell ~2,005/.test(l)), lines.join("\n"));
  assert.ok(lines.some((l) => /plus 1 image/.test(l)));
  const reported = formatBreakdown(b, { window: 100_000, reported: 40_000 });
  assert.match(reported[0], /40% of 100k \(40\.0k counted by the provider on the last request\)/);
  assert.ok(reported.some((l) => /differs from the provider's count/.test(l)));
  assert.equal(bar(0.5, 4), "██░░");
  assert.equal(bar(2, 3), "███");
});

await ok("/context prints the window, the output cap and the breakdown", async () => {
  const cmd = COMMANDS.find((c) => c.name === "context");
  const ctx = {
    settings: { models: {} },
    model: { key: "mock/m", contextWindow: 200_000, contextWindowSource: "settings", maxTokens: 8192 },
    session: { contextTokens: 0 },
    messages,
  };
  const out = [];
  const orig = console.log;
  console.log = (...a) => out.push(a.join(" "));
  try { await cmd.handler(ctx, ""); } finally { console.log = orig; }
  const text = out.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(text, /context window: 200,000 tokens/);
  assert.match(text, /system prompt\s+[█░]+/);
  assert.match(text, /tool definitions\s+[█░]+/);
  assert.match(text, /largest tool results: read_file/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
