// Regression tests for provider API-key persistence.
// Run directly: node tests/provider-keys.test.mjs
//
// The bug these pin down: `omni --set-key nvidia <key>` (the command the
// installer prints to every new user) set providers.nvidia.apiKey, but
// saveSettings mirrored the still-empty active account back over it. The key
// was silently dropped, and the next run sent no Authorization header at all —
// surfacing as a bare "401 unauthorized: Header of type 'authorization' was
// missing" from NVIDIA on a fresh install.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "omni-keys-"));
process.env.OMNI_HOME = home;

// These tests are about disk state, so the ambient environment has to stay out
// of them. Deleting the vars is not enough: loadSettings re-runs loadDotEnv on
// every call, and the developer's own <install>/.env would repopulate them.
// loadDotEnv skips any name already present in process.env, so defining them
// as "" pins them out — an empty key is falsy everywhere downstream.
const KEY_VARS = [
  "OMNI_NVIDIA_KEY", "OMNI_NVIDIA1_KEY", "OMNI_NVIDIA2_KEY",
  "OMNI_AGNES_KEY", "OMNI_AGNES1_KEY", "OMNI_AGNES2_KEY", "OMNI_AGNES_KEY2",
];
function clearEnvKeys() {
  for (const k of KEY_VARS) process.env[k] = "";
}
clearEnvKeys();

const { loadSettings, saveSettings, setProviderKey, SETTINGS_PATH } =
  await import("../src/core/config.mjs");

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

function readDisk() {
  const raw = fs.readFileSync(SETTINGS_PATH, "utf8");
  return { raw, json: JSON.parse(raw.replace(/^\s*\/\/.*$/gm, "")) };
}

function reset() {
  try { fs.rmSync(SETTINGS_PATH); } catch { /* first run */ }
}

async function main() {
  // 1. setProviderKey mirrors into the active account.
  reset();
  {
    const settings = await loadSettings();
    setProviderKey(settings.providers.nvidia, "nvapi-set-key");
    await saveSettings(settings);
    const { json } = readDisk();
    ok("--set-key persists the key on a fresh install (apiKey + active account)", () => {
      assert.equal(json.providers.nvidia.apiKey, "nvapi-set-key");
      assert.equal(json.providers.nvidia.accounts.nvidia1, "nvapi-set-key");
      assert.equal(json.providers.nvidia.accounts.nvidia2, "");
    });
    const reloaded = await loadSettings();
    ok("the next run reads that key back — no keyless request goes out", () => {
      assert.equal(reloaded.providers.nvidia.apiKey, "nvapi-set-key");
    });
  }

  // 2. A provider-level key with an empty active account is adopted, not
  //    blanked — covers a hand-edited settings.json too.
  reset();
  {
    const settings = await loadSettings();
    settings.providers.agnes.apiKey = "agnes-hand-edited";
    await saveSettings(settings);
    const { json } = readDisk();
    ok("a bare apiKey is never blanked by an empty active account", () => {
      assert.equal(json.providers.agnes.apiKey, "agnes-hand-edited");
      assert.equal(json.providers.agnes.accounts.agnes1, "agnes-hand-edited");
    });
  }

  // 3. A populated active account still drives apiKey.
  reset();
  {
    const settings = await loadSettings();
    settings.providers.nvidia.accounts.nvidia1 = "key-one";
    settings.providers.nvidia.accounts.nvidia2 = "key-two";
    settings.providers.nvidia.activeAccount = "nvidia2";
    settings.providers.nvidia.apiKey = "stale-mirror";
    await saveSettings(settings);
    const { json } = readDisk();
    ok("apiKey mirrors the active account when that account holds a key", () => {
      assert.equal(json.providers.nvidia.apiKey, "key-two");
      assert.equal(json.providers.nvidia.accounts.nvidia1, "key-one");
    });
  }

  // 4. Environment keys stay runtime-only — they must never reach disk, and
  //    the adopt-the-bare-key rule above must not become a leak.
  reset();
  {
    process.env.OMNI_NVIDIA1_KEY = "ENV-SECRET-account";
    process.env.OMNI_AGNES_KEY = "ENV-SECRET-provider";
    const settings = await loadSettings();
    const runtime = {
      nvidia: settings.providers.nvidia.apiKey,
      agnes: settings.providers.agnes.apiKey,
    };
    await saveSettings(settings);
    const { raw, json } = readDisk();
    clearEnvKeys();
    ok("env keys are live at runtime", () => {
      assert.equal(runtime.nvidia, "ENV-SECRET-account");
      assert.equal(runtime.agnes, "ENV-SECRET-provider");
    });
    ok("env keys never land in settings.json", () => {
      assert.ok(!raw.includes("ENV-SECRET"), "settings.json contains an env-sourced secret");
      assert.equal(json.providers.nvidia.apiKey, "");
      assert.equal(json.providers.nvidia.accounts.nvidia1, "");
      assert.equal(json.providers.agnes.apiKey, "");
    });
  }

  // 5. A key set this session beats the env value it replaced.
  reset();
  {
    process.env.OMNI_NVIDIA_KEY = "ENV-SECRET-provider";
    const settings = await loadSettings();
    setProviderKey(settings.providers.nvidia, "user-typed-key");
    await saveSettings(settings);
    const { raw, json } = readDisk();
    clearEnvKeys();
    ok("/apikey overrides an env key and persists", () => {
      assert.equal(json.providers.nvidia.apiKey, "user-typed-key");
      assert.equal(json.providers.nvidia.accounts.nvidia1, "user-typed-key");
      assert.ok(!raw.includes("ENV-SECRET"));
    });
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
  process.exit(fail ? 1 : 0);
}

main();
