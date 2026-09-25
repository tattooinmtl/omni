// Regression test: OMNI_HOME in <install>/.env must not split Omni's state.
// Run directly: node tests/omni-home-dotenv.test.mjs
//
// The bug: config HOME is resolved at import, before loadDotEnv runs, so an
// OMNI_HOME in .env never moved settings.json — but last-provider.mjs reads
// process.env.OMNI_HOME per call, after .env was loaded, and followed it.
// Settings lived in <install>/agent while last-provider.json went elsewhere.
//
// INSTALL_ROOT comes from the module's own location, so the test copies src/
// into a temp "install" and runs there in a child process with no OMNI_HOME.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const install = fs.mkdtempSync(path.join(os.tmpdir(), "omni-install-"));
const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "omni-elsewhere-"));

let pass = 0;
let fail = 0;
function ok(label, fn) {
  try {
    fn();
    console.log(`  ✓ ${label}`);
    pass++;
  } catch (e) {
    console.log(`  ✗ ${label}`);
    console.log(`    ${e.message}`);
    fail++;
  }
}

try {
  fs.cpSync(path.join(repo, "src"), path.join(install, "src"), { recursive: true });
  fs.copyFileSync(path.join(repo, "package.json"), path.join(install, "package.json"));
  fs.writeFileSync(path.join(install, ".env"), `OMNI_HOME=${elsewhere}\n`);

  const probe = `
    const cfg = await import(${JSON.stringify(pathToFileURL(path.join(install, "src/core/config.mjs")).href)});
    const lp = await import(${JSON.stringify(pathToFileURL(path.join(install, "src/core/last-provider.mjs")).href)});
    await cfg.loadSettings();
    lp.setLastProvider("nvidia");
    console.log(JSON.stringify({ envHome: process.env.OMNI_HOME ?? null, settingsPath: cfg.SETTINGS_PATH }));
  `;
  const env = { ...process.env };
  delete env.OMNI_HOME;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", probe], { cwd: install, env, encoding: "utf8" });
  const out = JSON.parse(r.stdout.trim().split(/\r?\n/).pop() || "{}");

  console.log("OMNI_HOME in <install>/.env");
  ok("child process ran", () => assert.equal(r.status, 0, r.stderr));
  ok("is not loaded into process.env", () => assert.equal(out.envHome, null));
  ok("settings stay in <install>/agent", () =>
    assert.equal(path.dirname(out.settingsPath), path.join(install, "agent")));
  ok("last-provider.json lands next to settings, not in the .env folder", () => {
    assert.ok(fs.existsSync(path.join(install, "agent", "last-provider.json")), "missing in <install>/agent");
    assert.ok(!fs.existsSync(path.join(elsewhere, "last-provider.json")), "written to the .env OMNI_HOME");
  });
} finally {
  fs.rmSync(install, { recursive: true, force: true });
  fs.rmSync(elsewhere, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
