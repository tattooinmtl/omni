// Regression test for llamaConfig() precedence + Phase C settings knobs.
// Verifies: modelsDir precedence (settings → env → C:\models → legacy),
// gpuMinVramGB / allowLowVram / threads defaults, and that llamaConfig is
// tolerant of a missing/empty settings block.
// Run directly: node tests/llama-config.test.mjs

import assert from "node:assert/strict";
import path from "node:path";
import { llamaConfig } from "../src/local/llama.mjs";

let pass = 0;
let fail = 0;
function ok(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); pass++; }
  catch (err) { console.log(`  ✗ ${label}\n      ${err.message}`); fail++; }
}

// Snapshot the env so we can mutate it in tests and restore after.
const _originalEnv = process.env.OMNI_MODELS_DIR;
function withEnv(value, fn) {
  if (value === undefined) delete process.env.OMNI_MODELS_DIR;
  else process.env.OMNI_MODELS_DIR = value;
  try { fn(); }
  finally {
    if (_originalEnv === undefined) delete process.env.OMNI_MODELS_DIR;
    else process.env.OMNI_MODELS_DIR = _originalEnv;
  }
}

ok("llamaConfig({}) returns a defaulted object without throwing", () => {
  const cfg = llamaConfig({});
  assert.ok(cfg);
  assert.equal(typeof cfg.modelsDir, "string");
  assert.equal(typeof cfg.binDir, "string");
  assert.equal(typeof cfg.exe, "string");
  assert.equal(cfg.host, "127.0.0.1");
  assert.equal(cfg.port, 8080);
});

ok("llamaConfig(null) or undefined settings is tolerated", () => {
  const cfg = llamaConfig(null);
  assert.ok(cfg && typeof cfg === "object");
  const cfg2 = llamaConfig(undefined);
  assert.ok(cfg2 && typeof cfg2 === "object");
});

ok("modelsDir precedence: settings.llama.modelsDir beats env and default", () => {
  withEnv("D:\\some-env-dir", () => {
    const cfg = llamaConfig({ llama: { modelsDir: "E:\\explicit" } });
    assert.equal(cfg.modelsDir, "E:\\explicit");
  });
});

ok("modelsDir precedence: OMNI_MODELS_DIR env beats the platform default", () => {
  withEnv("D:\\from-env", () => {
    const cfg = llamaConfig({});
    assert.equal(cfg.modelsDir, "D:\\from-env");
  });
});

ok("modelsDir precedence: no settings, no env → platform default (C:\\models on Windows)", () => {
  withEnv(undefined, () => {
    const cfg = llamaConfig({});
    if (process.platform === "win32") {
      // Falls back to legacy <INSTALL_ROOT>/models only if that exists AND
      // C:\models doesn't. On dev machines C:\models often exists so this
      // is the expected answer; on CI without C:\models we accept either.
      const legacy = path.resolve(new URL(".", import.meta.url).pathname, "..", "models");
      const ok = cfg.modelsDir === "C:\\models" || cfg.modelsDir.endsWith(path.join("", "models"));
      assert.ok(ok, `unexpected modelsDir=${cfg.modelsDir}`);
    } else {
      // Non-Windows: still returns the C:\models literal (Phase A is
      // Windows-first per the plan); Phases B/C/D are cross-platform.
      assert.equal(cfg.modelsDir, "C:\\models");
    }
  });
});

ok("Phase C: gpuMinVramGB defaults to 6", () => {
  const cfg = llamaConfig({});
  assert.equal(cfg.gpuMinVramGB, 6);
});

ok("Phase C: gpuMinVramGB honors an explicit override in settings", () => {
  const cfg = llamaConfig({ llama: { gpuMinVramGB: 4 } });
  assert.equal(cfg.gpuMinVramGB, 4);
});

ok("Phase C: gpuMinVramGB rejects a non-positive override (falls back to 6)", () => {
  assert.equal(llamaConfig({ llama: { gpuMinVramGB: 0 } }).gpuMinVramGB, 6);
  assert.equal(llamaConfig({ llama: { gpuMinVramGB: -1 } }).gpuMinVramGB, 6);
  assert.equal(llamaConfig({ llama: { gpuMinVramGB: "nope" } }).gpuMinVramGB, 6);
});

ok("Phase C: allowLowVram defaults to false, honors truthy override", () => {
  assert.equal(llamaConfig({}).allowLowVram, false);
  assert.equal(llamaConfig({ llama: { allowLowVram: true } }).allowLowVram, true);
});

ok("Phase C: threads default is null (means 'use physical-core count from profile')", () => {
  assert.equal(llamaConfig({}).threads, null);
});

ok("Phase C: threads honors an explicit positive override", () => {
  assert.equal(llamaConfig({ llama: { threads: 12 } }).threads, 12);
});

ok("Phase C: threads rejects non-positive overrides (falls back to null)", () => {
  assert.equal(llamaConfig({ llama: { threads: 0 } }).threads, null);
  assert.equal(llamaConfig({ llama: { threads: -4 } }).threads, null);
});

ok("Phase C: extraArgs stays [] when unset, passes through when set", () => {
  assert.deepEqual(llamaConfig({}).extraArgs, []);
  assert.deepEqual(
    llamaConfig({ llama: { extraArgs: ["--flash-attn"] } }).extraArgs,
    ["--flash-attn"]
  );
});

ok("Phase C: extraArgs ignores non-array values (defensive)", () => {
  assert.deepEqual(llamaConfig({ llama: { extraArgs: "--flash-attn" } }).extraArgs, []);
  assert.deepEqual(llamaConfig({ llama: { extraArgs: null } }).extraArgs, []);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
