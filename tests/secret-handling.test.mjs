// Two ways a credential escapes, both found by audit.
//
// 1. saveSettings strips env-supplied keys before writing, so a key that came
//    from the environment never lands in settings.json. It rebuilt the env var
//    name inline as `OMNI_${name.toUpperCase()}_KEY`, which yields
//    OMNI_MINIMAX.IO_KEY for the minimax.io provider — not the
//    OMNI_MINIMAX_IO_KEY the key actually came from. The lookup missed, the
//    equality check failed, and the key was written to disk. Any provider name
//    that isn't pure [A-Z0-9] was affected.
//
// 2. security_scan knew only `sk-`-style keys, so a file holding an NVIDIA,
//    Groq, xAI or Google key scanned "clean" — even though config.mjs's log
//    redactor already knew all four formats.
//
// Run: node tests/secret-handling.test.mjs

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
const u = (p) => pathToFileURL(path.join(root, "src", p)).href;

const home = fs.mkdtempSync(path.join(os.tmpdir(), "omni-secret-"));
process.env.OMNI_HOME = home;

const { providerKeyEnvVar } = await import(u("core/env-keys.mjs"));
const { loadSettings, saveSettings, SETTINGS_PATH } = await import(u("core/config.mjs"));

console.log("\nEnv var naming:");

await ok("non-alphanumerics collapse to underscore", () => {
  assert.equal(providerKeyEnvVar("minimax.io"), "OMNI_MINIMAX_IO_KEY");
  assert.equal(providerKeyEnvVar("openai"), "OMNI_OPENAI_KEY");
  assert.equal(providerKeyEnvVar("nvidia1"), "OMNI_NVIDIA1_KEY");
  assert.equal(providerKeyEnvVar("my-proxy"), "OMNI_MY_PROXY_KEY");
});

await ok("the name is always a legal shell identifier", () => {
  for (const n of ["minimax.io", "my-proxy", "a.b.c", "x y"]) {
    assert.match(providerKeyEnvVar(n), /^[A-Z0-9_]+$/, `${n} produced an unusable env var name`);
  }
});

await ok("config.mjs re-exports the same function, not a second copy", async () => {
  const fromConfig = (await import(u("core/config.mjs"))).providerKeyEnvVar;
  assert.equal(fromConfig, providerKeyEnvVar, "two derivations is what caused the leak");
});

console.log("\nAn env-supplied key never reaches settings.json:");

// Covers a dotted provider name (the bug) alongside a plain one (the control).
for (const provider of ["minimax.io", "openai"]) {
  await ok(`${provider}: key from the environment is stripped before writing`, async () => {
    const envVar = providerKeyEnvVar(provider);
    const secret = `ENV-ONLY-SECRET-${provider}`;
    process.env[envVar] = secret;
    try {
      fs.rmSync(SETTINGS_PATH, { force: true });
      const settings = await loadSettings();
      assert.equal(settings.providers[provider].apiKey, secret, "the key should be live in memory");
      await saveSettings(settings);
      const disk = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
      assert.equal(disk.providers[provider].apiKey, "", "the env key must not be persisted");
      assert.ok(!fs.readFileSync(SETTINGS_PATH, "utf8").includes(secret),
        "the secret appears somewhere in settings.json");
    } finally {
      delete process.env[envVar];
    }
  });
}

await ok("a key the user set this session IS persisted", async () => {
  const envVar = providerKeyEnvVar("minimax.io");
  process.env[envVar] = "ENV-ONLY-SECRET";
  try {
    fs.rmSync(SETTINGS_PATH, { force: true });
    const settings = await loadSettings();
    // Simulates /apikey minimax.io <key> — a deliberate change, not the env value.
    settings.providers["minimax.io"].apiKey = "TYPED-BY-THE-USER";
    await saveSettings(settings);
    const disk = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
    assert.equal(disk.providers["minimax.io"].apiKey, "TYPED-BY-THE-USER");
  } finally {
    delete process.env[envVar];
  }
});

console.log("\nsecurity_scan covers every provider key format:");

const scanDir = fs.mkdtempSync(path.join(os.tmpdir(), "omni-scan-"));
const samples = {
  "nvapi-": "nvapi-" + "a".repeat(40),
  "gsk_": "gsk_" + "b".repeat(45),
  "xai-": "xai-" + "c".repeat(30),
  "AIza": "AIza" + "D".repeat(35),
  "sk-": "sk-" + "e".repeat(40),
};
fs.writeFileSync(
  path.join(scanDir, "keys.js"),
  Object.values(samples).map((v, i) => `const k${i} = "${v}";`).join("\n") + "\n",
);

const { impl } = await import(u("tools/index.mjs"));
const origCwd = process.cwd();
let report = "";
try {
  process.chdir(scanDir);
  report = impl.security_scan({ scope: "secrets", path: "." });
} finally {
  process.chdir(origCwd);
}

for (const prefix of Object.keys(samples)) {
  await ok(`a ${prefix} key is reported`, () => {
    assert.match(report, /keys\.js/, `scan found nothing at all:\n${report}`);
    const found = (report.match(/\[/g) || []).length;
    assert.ok(found >= Object.keys(samples).length,
      `expected ${Object.keys(samples).length} findings, report had ${found}:\n${report}`);
  });
}

await ok("the scanner never prints the matched secret itself", () => {
  for (const v of Object.values(samples)) {
    assert.ok(!report.includes(v), "a raw key value leaked into the scan report");
  }
});

await ok("the scanner and the log redactor know the same formats", async () => {
  // Drift between these two lists is what left nvapi-/gsk_ scannable-but-unscanned.
  const toolsSrc = fs.readFileSync(path.join(root, "src", "tools", "index.mjs"), "utf8");
  const configSrc = fs.readFileSync(path.join(root, "src", "core", "config.mjs"), "utf8");
  const rules = toolsSrc.slice(toolsSrc.indexOf("const SECRET_RULES"), toolsSrc.indexOf("];", toolsSrc.indexOf("const SECRET_RULES")));
  const patterns = configSrc.slice(configSrc.indexOf("const SECRET_PATTERNS"), configSrc.indexOf("];", configSrc.indexOf("const SECRET_PATTERNS")));
  for (const token of ["nvapi-", "gsk_", "xai-", "AIza", "sk-", "AKIA"]) {
    assert.ok(rules.includes(token), `security_scan is missing ${token}`);
    assert.ok(patterns.includes(token), `the log redactor is missing ${token}`);
  }
});

fs.rmSync(scanDir, { recursive: true, force: true });
fs.rmSync(home, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
