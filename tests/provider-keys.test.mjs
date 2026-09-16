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
  "OMNI_MINIMAX_IO_KEY", "OMNI_MINIMAX_KEY",
  "OMNI_ATRIA_KEY", "ATRIA_API_KEY",
];
function clearEnvKeys() {
  for (const k of KEY_VARS) process.env[k] = "";
}
clearEnvKeys();

const { loadSettings, saveSettings, setProviderKey, resolveModel, providerKeyEnvVars, SETTINGS_PATH } =
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

  // 6. Legacy-seed path: provider-level env var + empty accounts on a fresh
  //    install. The seed at config.mjs:374 copies prov.apiKey into the first
  //    account, and the if-block above it MUST record that as "imposed" in
  //    savedAccounts so saveSettings can strip it back to "" on save. If the
  //    recording is ever lost, this is the regression that surfaces (TODO #1).
  reset();
  {
    process.env.OMNI_NVIDIA_KEY = "ENV-SECRET-legacy-seed";
    const settings = await loadSettings();
    // Confirm the env value actually reached the runtime + the first account
    // (the seed fired) — otherwise the test below proves nothing.
    ok("legacy-seed populates the first account at runtime", () => {
      assert.equal(settings.providers.nvidia.apiKey, "ENV-SECRET-legacy-seed");
      assert.equal(settings.providers.nvidia.accounts.nvidia1, "ENV-SECRET-legacy-seed");
    });
    await saveSettings(settings);
    const { raw, json } = readDisk();
    clearEnvKeys();
    ok("legacy-seed env value never lands in settings.json", () => {
      assert.ok(!raw.includes("ENV-SECRET-legacy-seed"), "settings.json contains the legacy-seed env value");
      assert.equal(json.providers.nvidia.apiKey, "");
      assert.equal(json.providers.nvidia.accounts.nvidia1, "");
    });
  }

  // 7. settings.json wins when env ALSO has a key for the same provider.
  //    Previously, env always overrode settings.json — /apikey looked broken
  //    when the new key differed from .env's value (a stale .env entry kept
  //    reasserting itself on every launch). Precedence now: settings.json
  //    is canonical; env only fills empty slots.
  reset();
  {
    process.env.OMNI_MINIMAX_IO_KEY = "ENV-OVERRIDE-KEY";
    // Seed settings.json with a real key first (simulates user ran /apikey).
    const initial = JSON.parse(JSON.stringify({
      ...(await loadSettings()),
    }));
    initial.providers["minimax.io"].apiKey = "SETTINGS-JSON-KEY";
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(initial, null, 2));
    const settings = await loadSettings();
    ok("settings.json key wins over env when both are set", () => {
      assert.equal(settings.providers["minimax.io"].apiKey, "SETTINGS-JSON-KEY");
    });
    await saveSettings(settings);
    const { raw, json } = readDisk();
    clearEnvKeys();
    ok("env key does not leak into settings.json, settings.json key persists", () => {
      assert.equal(json.providers["minimax.io"].apiKey, "SETTINGS-JSON-KEY");
      assert.ok(!raw.includes("ENV-OVERRIDE-KEY"), "env key leaked into settings.json");
    });
  }

  // 8. Atria ships as a first-class provider, and its key can come from the
  //    vendor's own ATRIA_API_KEY as well as OMNI_ATRIA_KEY. The alias has to
  //    be honoured on BOTH sides: filled in on load, stripped back out on save.
  //    (Only the canonical name used to be stripped, so a key supplied under a
  //    vendor-native name would have been written into settings.json.)
  reset();
  {
    const settings = await loadSettings();
    ok("/provider atria has an endpoint and a model to switch to", () => {
      assert.equal(settings.providers.atria.baseUrl, "https://api.atria-asi.ai/v1");
      const m = resolveModel(settings, "atria/dawn-preview");
      assert.equal(m.id, "Atria-Dawn-Preview");
      assert.equal(m.providerName, "atria");
    });
    ok("ATRIA_API_KEY is an accepted alias, after the canonical name", () => {
      assert.deepEqual(providerKeyEnvVars("atria"), ["OMNI_ATRIA_KEY", "ATRIA_API_KEY"]);
    });
  }

  reset();
  {
    process.env.ATRIA_API_KEY = "ENV-SECRET-atr_alias";
    const settings = await loadSettings();
    const runtime = settings.providers.atria.apiKey;
    await saveSettings(settings);
    const { raw, json } = readDisk();
    clearEnvKeys();
    ok("ATRIA_API_KEY is live at runtime but never lands in settings.json", () => {
      assert.equal(runtime, "ENV-SECRET-atr_alias");
      assert.ok(!raw.includes("ENV-SECRET"), "settings.json contains the alias-sourced secret");
      assert.equal(json.providers.atria.apiKey, "");
    });
  }

  // 9. /apikey atria <key> still wins over the alias and persists.
  reset();
  {
    process.env.ATRIA_API_KEY = "ENV-SECRET-atr_alias";
    const settings = await loadSettings();
    setProviderKey(settings.providers.atria, "atr_user-typed");
    await saveSettings(settings);
    const { raw, json } = readDisk();
    clearEnvKeys();
    ok("/apikey atria overrides the ATRIA_API_KEY alias and persists", () => {
      assert.equal(json.providers.atria.apiKey, "atr_user-typed");
      assert.ok(!raw.includes("ENV-SECRET"));
    });
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
  process.exit(fail ? 1 : 0);
}

main();
