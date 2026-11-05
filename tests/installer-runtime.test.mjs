// install/install.ps1's runtime-pack step.
//
// The installer is always fetched fresh from GitHub, but the Omni it runs
// against may not have updated (local changes block the update). On an Omni
// older than 3.5.17, `node bin/omni.mjs runtime install` is not a command —
// it became a one-shot prompt sent to the model. Install-RuntimePack must
// skip such an install. Runs the real function, extracted from the script's
// AST, against a fake old install. Skips where PowerShell isn't available.
//
// Also guards against control characters in shipped text files: a "\v" in a
// generated edit turned "$Root\vendor" into "$Root<VT>endor".
//
// Run: node tests/installer-runtime.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

let pass = 0, fail = 0;
async function ok(label, fn) {
  try { await fn(); console.log(`  ✓ ${label}`); pass++; }
  catch (e) { console.log(`  ✗ ${label}\n    ${e.message}`); fail++; }
}

const root = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1")), "..");
const script = path.join(root, "install", "install.ps1");

await ok("shipped text files contain no stray control characters", () => {
  const files = ["install/install.ps1", "install/web-install.ps1", "README.md", "CHANGELOG.md", "docs/EXTENDING.md",
    "src/local/runtime-pack.mjs", "src/cli/runtime-cmd.mjs", "src/local/hardware-profile.mjs", "extensions/browser-use.js"];
  const bad = [];
  for (const f of files) {
    const p = path.join(root, f);
    if (!fs.existsSync(p)) continue;
    fs.readFileSync(p, "utf8").split("\n").forEach((line, i) => {
      if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(line)) bad.push(`${f}:${i + 1}`);
    });
  }
  assert.deepEqual(bad, []);
});

const ps = ["pwsh", "powershell"].find((exe) => !spawnSync(exe, ["-NoProfile", "-Command", "1"], { encoding: "utf8" }).error);
if (!ps) {
  console.log("  SKIP Install-RuntimePack (no PowerShell)");
} else {
  // Define Info, Get-LocalVersion and Install-RuntimePack from the real
  // script without running its main block, then call the function.
  const run = (fakeRoot) => {
    const cmd = [
      // The installer runs under StrictMode Latest (install.ps1), so the tests do too.
      "Set-StrictMode -Version Latest",
      `$ast = [System.Management.Automation.Language.Parser]::ParseFile('${script.replace(/'/g, "''")}', [ref]$null, [ref]$null)`,
      `$fns = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -in @('Info','Get-LocalVersion','Install-RuntimePack') }, $true)`,
      `foreach ($f in $fns) { . ([ScriptBlock]::Create($f.Extent.Text)) }`,
      `function node { Write-Output "NODE-RAN $args"; $global:LASTEXITCODE = 0 }`,
      `Install-RuntimePack '${fakeRoot.replace(/'/g, "''")}' 3>&1`,
    ].join("; ");
    return spawnSync(ps, ["-NoProfile", "-NonInteractive", "-Command", cmd], { encoding: "utf8" });
  };

  await ok("an Omni without the runtime command is skipped, never handed `runtime install`", () => {
    const fake = fs.mkdtempSync(path.join(os.tmpdir(), "omni-old-"));
    fs.writeFileSync(path.join(fake, "package.json"), JSON.stringify({ version: "3.5.15" }));
    const r = run(fake);
    const out = (r.stdout || "") + (r.stderr || "");
    assert.doesNotMatch(out, /NODE-RAN/, out);
    assert.match(out, /Skipping the runtime pack: this Omni \(3\.5\.15\) predates it/, out);
    fs.rmSync(fake, { recursive: true, force: true });
  });

  await ok("an Omni with the runtime command runs `omni runtime install`", () => {
    const fake = fs.mkdtempSync(path.join(os.tmpdir(), "omni-new-"));
    fs.mkdirSync(path.join(fake, "src", "cli"), { recursive: true });
    fs.writeFileSync(path.join(fake, "src", "cli", "runtime-cmd.mjs"), "");
    const r = run(fake);
    const out = (r.stdout || "") + (r.stderr || "");
    assert.match(out, /NODE-RAN \.\/bin\/omni\.mjs runtime install/, out);
    assert.match(out, /into .*\\vendor/, out);
    fs.rmSync(fake, { recursive: true, force: true });
  });

  // ── local AI option (-Llama / OMNI_LLAMA) ──────────────────────────────
  // Runs the real Resolve-LlamaBuilds / Install-LlamaBuilds with `node` and
  // `nvidia-smi` stubbed, so "a PC with / without an NVIDIA GPU" is testable.
  // `nvidia`: true/false stubs Test-NvidiaGpu; undefined keeps the real one
  // (the timeout tests drive it with fake nvidia-smi scripts on PATH).
  const runLlama = (body, { nvidia, pathPrefix } = {}) => {
    const fns = ["Info", "Get-LocalVersion", "Resolve-LlamaBuilds", "Install-LlamaBuilds", "Test-NvidiaGpu"];
    const cmd = [
      // Like install.ps1 itself: without it, $null.Count is 0 and the bug hides.
      "Set-StrictMode -Version Latest",
      `$ast = [System.Management.Automation.Language.Parser]::ParseFile('${script.replace(/'/g, "''")}', [ref]$null, [ref]$null)`,
      `$fns = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -in @('${fns.join("','")}') }, $true)`,
      `foreach ($f in $fns) { . ([ScriptBlock]::Create($f.Extent.Text)) }`,
      `function node { Write-Output "NODE-RAN $args"; $global:LASTEXITCODE = 0 }`,
      nvidia === undefined ? "" : `function Test-NvidiaGpu { return ${nvidia ? "$true" : "$false"} }`,
      body,
    ].filter(Boolean).join("; ");
    const env = { ...process.env };
    if (pathPrefix) {
      const key = Object.keys(env).find((k) => k.toLowerCase() === "path") || "PATH";
      env[key] = `${pathPrefix};${env[key]}`;
    }
    const r = spawnSync(ps, ["-NoProfile", "-NonInteractive", "-Command", cmd], { encoding: "utf8", env });
    return (r.stdout || "") + (r.stderr || "");
  };

  // A directory holding a fake nvidia-smi.cmd with the given body.
  const fakeSmi = (body) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omni-smi-"));
    fs.writeFileSync(path.join(dir, "nvidia-smi.cmd"), `@echo off\r\n${body}\r\n`);
    return dir;
  };

  await ok("local AI choices: none installs nothing, cpu the CPU build, cuda both", () => {
    assert.match(runLlama("'[' + ((Resolve-LlamaBuilds 'none') -join ',') + ']'"), /\[\]/);
    assert.match(runLlama("'[' + ((Resolve-LlamaBuilds 'cpu') -join ',') + ']'"), /\[cpu\]/);
    assert.match(runLlama("'[' + ((Resolve-LlamaBuilds 'cuda') -join ',') + ']'"), /\[cpu,cuda\]/);
  });

  // Reported on /update-omni 3.5.38 -> 3.5.40: "ERROR: install failed - The
  // property 'Count' cannot be found on this object". With no local AI
  // chosen the function returned @(), which PowerShell hands back as $null,
  // and the installer read $llamaBuilds.Count under StrictMode. The -join
  // checks above can't see that: $null joins to "" just like @() does.
  // The installer's own line that sets $llamaBuilds, taken from install.ps1,
  // run for each choice, then both of the installer's .Count reads.
  await ok("the installer's $llamaBuilds line gives a list whose .Count works under StrictMode", () => {
    const line = fs.readFileSync(script, "utf8").split(/\r?\n/).map((l) => l.trim())
      .find((l) => /^\$llamaBuilds\s*=.*Resolve-LlamaBuilds\s+\$llamaChoice/.test(l));
    assert.ok(line, "install.ps1 sets $llamaBuilds from Resolve-LlamaBuilds $llamaChoice");
    const probe = (choice, opts) => runLlama(
      `$llamaChoice = '${choice}'; ${line}; ` +
      `'COUNT=' + $llamaBuilds.Count + ' BUILDS=[' + ($llamaBuilds -join ',') + '] ' + $(if ($llamaBuilds.Count) { 'INSTALL' } else { 'SKIP' }) + ' ' + $(if (-not $llamaBuilds.Count) { 'HINT' } else { 'NOHINT' })`,
      opts,
    );
    const expect = { none: "COUNT=0 BUILDS=[] SKIP HINT", cpu: "COUNT=1 BUILDS=[cpu] INSTALL NOHINT", cuda: "COUNT=2 BUILDS=[cpu,cuda] INSTALL NOHINT" };
    for (const [choice, want] of Object.entries(expect)) {
      const out = probe(choice);
      assert.ok(out.includes(want), `${choice}: ${out}`);
    }
    const auto = probe("auto", { nvidia: false });
    assert.ok(auto.includes("COUNT=1 BUILDS=[cpu] INSTALL"), auto);
  });

  await ok("auto adds CUDA only when nvidia-smi finds an NVIDIA GPU", () => {
    assert.match(runLlama("'[' + ((Resolve-LlamaBuilds 'auto') -join ',') + ']'", { nvidia: true }), /\[cpu,cuda\]/);
    assert.match(runLlama("'[' + ((Resolve-LlamaBuilds 'auto') -join ',') + ']'", { nvidia: false }), /\[cpu\]/);
  });

  await ok("Test-NvidiaGpu: yes when nvidia-smi names a GPU, no when it names none", () => {
    const yes = fakeSmi("echo NVIDIA GeForce RTX 5060 Ti");
    assert.match(runLlama("'GPU=' + (Test-NvidiaGpu)", { pathPrefix: yes }), /GPU=True/);
    const none = fakeSmi("exit /b 9");
    assert.match(runLlama("'GPU=' + (Test-NvidiaGpu)", { pathPrefix: none }), /GPU=False/);
  });

  await ok("Test-NvidiaGpu gives up on a hung nvidia-smi instead of stalling the install", () => {
    const hang = fakeSmi("ping -n 30 127.0.0.1 >nul");
    const t0 = Date.now();
    const out = runLlama("'GPU=' + (Test-NvidiaGpu -TimeoutSec 2) 3>&1", { pathPrefix: hang });
    assert.match(out, /GPU=False/, out);
    assert.match(out, /did not answer within 2 s/, out);
    assert.ok(Date.now() - t0 < 20000, `took ${Date.now() - t0} ms`);
  });

  await ok("a 3.5.36 install (CUDA pins, no `omni llama` command) is skipped", () => {
    const fake = fs.mkdtempSync(path.join(os.tmpdir(), "omni-3536-"));
    fs.writeFileSync(path.join(fake, "package.json"), JSON.stringify({ version: "3.5.36" }));
    fs.mkdirSync(path.join(fake, "src", "local"), { recursive: true });
    fs.mkdirSync(path.join(fake, "src", "cli"), { recursive: true });
    fs.writeFileSync(path.join(fake, "src", "local", "llama-build.mjs"), "export const LLAMA_BUILD = { cudaBuilds: {} };");
    fs.writeFileSync(path.join(fake, "src", "cli", "main.mjs"), 'if (args[0] === "runtime") {}');
    const out = runLlama(`Install-LlamaBuilds '${fake.replace(/'/g, "''")}' @('cpu') 3>&1`);
    assert.doesNotMatch(out, /NODE-RAN/, out);
    assert.match(out, /Skipping local AI: this Omni \(3\.5\.36\) predates it/, out);
    fs.rmSync(fake, { recursive: true, force: true });
  });

  await ok("Install-LlamaBuilds runs `omni llama update` then `… update cuda` on a new Omni", () => {
    const fake = fs.mkdtempSync(path.join(os.tmpdir(), "omni-llama-"));
    fs.mkdirSync(path.join(fake, "src", "cli"), { recursive: true });
    fs.writeFileSync(path.join(fake, "src", "cli", "main.mjs"), 'if (args[0] === "llama") {}');
    const out = runLlama(`Install-LlamaBuilds '${fake.replace(/'/g, "''")}' @('cpu','cuda') 3>&1`);
    assert.match(out, /NODE-RAN \.\/bin\/omni\.mjs llama update\r?\n/, out);
    assert.match(out, /NODE-RAN \.\/bin\/omni\.mjs llama update cuda/, out);
    fs.rmSync(fake, { recursive: true, force: true });
  });

  await ok("an Omni without `omni llama` is skipped, never handed `llama update` as a prompt", () => {
    const fake = fs.mkdtempSync(path.join(os.tmpdir(), "omni-oldllama-"));
    fs.writeFileSync(path.join(fake, "package.json"), JSON.stringify({ version: "3.5.34" }));
    const out = runLlama(`Install-LlamaBuilds '${fake.replace(/'/g, "''")}' @('cpu') 3>&1`);
    assert.doesNotMatch(out, /NODE-RAN/, out);
    assert.match(out, /Skipping local AI: this Omni \(3\.5\.34\) predates it/, out);
    fs.rmSync(fake, { recursive: true, force: true });
  });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
