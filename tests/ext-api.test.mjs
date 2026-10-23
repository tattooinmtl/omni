// Extension API: slash commands and status-bar items (core/ext-registry.mjs).
//
// Run: node tests/ext-api.test.mjs

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

process.env.OMNI_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "omni-ext-home-"));

const { registerExtensions } = await import(u("src/tools/index.mjs"));
const { findCommand, commandNames, commandMenu, dispatchCommand, printHelp } = await import(u("src/cli/commands.mjs"));
const { statusBarText } = await import(u("src/ui.mjs"));

const extRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omni-ext-src-"));
const write = (name, code) => fs.writeFileSync(path.join(extRoot, name), code);

write("deployer.js", `
let builds = 0;
export default {
  name: "deployer", tools: [], impl: {},
  commands: [
    { name: "deploy", usage: "/deploy <env>", summary: "deploy to an environment", handler: (ctx, arg) => "Deploy to " + arg + " and verify it." },
    { name: "builds", summary: "count builds", handler: () => { builds++; } },
    { name: "help", summary: "tries to shadow /help", handler: () => "hijacked" },
    { name: "bad name!", handler: () => {} },
  ],
  statusItems: [() => "build #" + builds, () => { throw new Error("broken item"); }, () => ""],
};`);

let loaded;
await ok("an extension's commands and status items load; a bad entry is skipped", async () => {
  const origErr = console.error;
  const errs = [];
  console.error = (...a) => errs.push(a.join(" "));
  try { loaded = await registerExtensions(extRoot, ["deployer.js"]); } finally { console.error = origErr; }
  assert.deepEqual(loaded, ["deployer"]);
  assert.ok(findCommand("deploy"));
  assert.equal(findCommand("deploy").category, "Extensions");
  assert.ok(commandNames().includes("/deploy"));
  assert.ok(commandMenu("dep").some((r) => r.usage === "/deploy <env>"));
  assert.ok(errs.some((e) => /bad name!/.test(e)), "the bad command name is reported");
});

await ok("a built-in always wins over an extension command of the same name", () => {
  assert.notEqual(findCommand("help").category, "Extensions");
  assert.equal(commandNames().filter((n) => n === "/help").length, 1);
});

await ok("a handler's string becomes a prompt for the agent; others run as-is", async () => {
  const r = await dispatchCommand({}, "deploy", "staging", ["/deploy", "staging"]);
  assert.deepEqual(r, { startTurn: true, prompt: "Deploy to staging and verify it." });
  assert.equal(await dispatchCommand({}, "builds", "", ["/builds"]), undefined);
});

await ok("status items show in the status bar; a throwing or empty one is skipped", () => {
  const bar = statusBarText({ contextWindow: 1000, id: "m", providerLabel: "P" }, { contextTokens: 10 }, 120).replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(bar, /ctx .* build #1/);
  assert.doesNotMatch(bar, /broken/);
});

await ok("/help lists extension commands under Extensions", () => {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  try { printHelp({ skills: [] }); } finally { console.log = orig; }
  const out = lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(out, /Extensions\n\s+\/deploy <env>\s+deploy to an environment/);
});

await ok("a hot reload replaces what the extension added instead of duplicating it", async () => {
  write("deployer.js", `export default { name: "deployer", tools: [], impl: {}, commands: [{ name: "ship", handler: () => "ship it" }], statusItems: [] };`);
  await registerExtensions(extRoot, ["deployer.js"]);
  assert.equal(findCommand("deploy"), null, "the old command is gone");
  assert.ok(findCommand("ship"));
  const bar = statusBarText({ contextWindow: 1000, id: "m" }, { contextTokens: 0 }, 120).replace(/\x1b\[[0-9;]*m/g, "");
  assert.doesNotMatch(bar, /build #/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
