// Regression tests: every /provider key command must go through setProviderKey.
// Run directly: node tests/provider-key-accounts.test.mjs
//
// The bug: /provider apikey|login|edit|logout assigned provider.apiKey
// directly. For a provider with accounts (nvidia, agnes), the next load runs
// activateAccount, which mirrors accounts[activeAccount] back over apiKey — so
// the new key silently reverted to the old one on restart, and logout
// resurrected the old key.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "omni-acctkeys-"));
process.env.OMNI_HOME = home;

// Pin the ambient key vars out (see provider-keys.test.mjs for why "" not delete).
for (const k of [
  "OMNI_NVIDIA_KEY", "OMNI_NVIDIA1_KEY", "OMNI_NVIDIA2_KEY",
  "OMNI_AGNES_KEY", "OMNI_AGNES1_KEY", "OMNI_AGNES2_KEY", "OMNI_AGNES_KEY2",
]) process.env[k] = "";

const { loadSettings, saveSettings, SETTINGS_PATH } = await import("../src/core/config.mjs");
const { dispatchCommand } = await import("../src/cli/commands.mjs");

let pass = 0;
let fail = 0;
async function ok(label, fn) {
  try {
    await fn();
    console.log(`  ✓ ${label}`);
    pass++;
  } catch (e) {
    console.log(`  ✗ ${label}`);
    console.log(`    ${e.message}`);
    fail++;
  }
}

// Fresh settings with nvidia holding OLD on its active account, as on disk.
async function seed() {
  try { fs.rmSync(SETTINGS_PATH); } catch { /* first run */ }
  const s = await loadSettings();
  s.providers.nvidia.accounts = { nvidia1: "OLD", nvidia2: "" };
  s.providers.nvidia.activeAccount = "nvidia1";
  s.providers.nvidia.apiKey = "OLD";
  await saveSettings(s);
  const settings = await loadSettings();
  return { settings, model: { key: settings.defaultModel } };
}

async function run(ctx, sub) {
  const arg = sub;
  await dispatchCommand(ctx, "provider", arg, ["provider", ...arg.split(/\s+/)]);
}

console.log("provider key commands on a provider with accounts");

async function silently(fn) {
  const orig = console.log;
  console.log = () => {};
  try { await fn(); } finally { console.log = orig; }
}

for (const [label, sub] of [
  ["/provider apikey nvidia NEW survives a reload", "apikey nvidia NEW"],
  ["/provider login nvidia NEW survives a reload", "login nvidia NEW"],
  ["/provider edit nvidia apiKey NEW survives a reload", "edit nvidia apiKey NEW"],
]) {
  await ok(label, async () => {
    const ctx = await seed();
    await silently(() => run(ctx, sub));
    const after = (await loadSettings()).providers.nvidia;
    assert.equal(after.apiKey, "NEW");
    assert.equal(after.accounts.nvidia1, "NEW");
  });
}

await ok("/provider logout nvidia stays logged out after a reload", async () => {
  const ctx = await seed();
  await silently(() => run(ctx, "logout nvidia"));
  const after = (await loadSettings()).providers.nvidia;
  assert.equal(after.apiKey, "");
  assert.equal(after.accounts.nvidia1, "");
});

fs.rmSync(home, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
