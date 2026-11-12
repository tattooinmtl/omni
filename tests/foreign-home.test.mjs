// Omni's home must be its own folder, not another program's install.
//
// The bug this pins (2026-11-12): OMNI_HOME pointed at OmniCode's install
// folder (C:\Users\…\AppData\Local\Programs\OMNI-CODE), so Omni's settings,
// memories and session logs lived among OmniCode's files and Omni kept
// working on OmniCode. Omni now warns at startup when OMNI_HOME is a folder
// with an uninstaller or a program (.exe at the top or in bin/) in it.
//
// Run: node tests/foreign-home.test.mjs

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omni-foreign-home-"));
process.env.OMNI_HOME = path.join(tmp, "own");
const { foreignHomeReason, foreignHomeWarning } = await import(pathToFileURL(path.join(root, "src/core/config.mjs")).href);

const dir = (name, files = {}) => {
  const d = path.join(tmp, name);
  fs.mkdirSync(d, { recursive: true });
  for (const [f, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true });
    fs.writeFileSync(path.join(d, f), body);
  }
  return d;
};

const own = dir("own", { "settings.json": "{}", "memory.jsonl": "", "sessions/x.jsonl": "" });
const app = dir("OMNI-CODE", { "Uninstall.exe": "MZ", "bin/omni-core.exe": "MZ", "settings.json": "{}" });

await ok("Omni's own home is not foreign", () => {
  assert.equal(foreignHomeReason(own), null);
  assert.equal(foreignHomeWarning({ OMNI_HOME: own }, own), null);
});

await ok("an install folder with an uninstaller is foreign", () => {
  assert.equal(foreignHomeReason(app), "it has Uninstall.exe");
  assert.equal(foreignHomeReason(dir("inno", { "unins000.exe": "MZ" })), "it has unins000.exe");
});

await ok("so is one with a program at the top or in bin/", () => {
  assert.equal(foreignHomeReason(dir("top", { "app.exe": "MZ" })), "it has app.exe");
  assert.match(foreignHomeReason(dir("binonly", { "bin/tool.exe": "MZ", "settings.json": "{}" })), /^it has bin[\\/]tool\.exe$/);
});

await ok("the warning says what to do, and only when OMNI_HOME is set", () => {
  const w = foreignHomeWarning({ OMNI_HOME: app }, app);
  assert.ok(w.includes(app));
  assert.match(w, /another program's install folder \(it has Uninstall\.exe\)/);
  assert.match(w, /Remove OMNI_HOME, or point it at a folder of Omni's own/);
  assert.equal(foreignHomeWarning({}, app), null, "the default home is Omni's own agent/ folder");
  assert.equal(foreignHomeReason(path.join(tmp, "missing")), null, "a home that doesn't exist yet is fine");
});

// Start the REPL in a home, exit at once, and return everything it printed.
function startOmni(home) {
  fs.writeFileSync(path.join(home, "settings.json"), JSON.stringify({
    defaultModel: "fake/one",
    providers: { fake: { baseUrl: "http://127.0.0.1:9/v1", apiKey: "not-needed" } },
    models: { "fake/one": { provider: "fake", id: "one" } },
    hardware: { enabled: false },
  }));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, "bin", "omni.mjs")], {
      cwd: home, env: { ...process.env, OMNI_HOME: home }, stdio: ["pipe", "pipe", "pipe"],
    });
    let buf = "";
    child.stdout.on("data", (d) => { buf += d; });
    child.stderr.on("data", (d) => { buf += d; });
    const timer = setTimeout(() => child.kill(), 90000);
    child.on("close", () => { clearTimeout(timer); resolve(buf); });
    child.stdin.end("/exit\n");
  });
}

const flat = (t) => t.replace(/\x1b\[[0-9;]*m/g, "").replace(/\s+/g, " ");

await ok("omni warns at startup in another program's folder, and not in its own", async () => {
  assert.match(flat(await startOmni(app)), /another program's install folder \(it has Uninstall\.exe\)/);
  assert.doesNotMatch(flat(await startOmni(own)), /another program's install folder/);
});

try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* temp dir */ }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
