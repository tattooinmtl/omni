// The installer works in every PowerShell: Windows PowerShell 5.1, and
// PowerShell 6/7, and 5.1 started from 7.
//
// 3.5.42's /update-omni died with "Get-FileHash is not recognized" when Omni
// had been started from a pwsh 7 terminal: powershell.exe inherited pwsh's
// PSModulePath, found PowerShell 7's own Microsoft.PowerShell.Utility first
// and couldn't load it. The installer now repairs the module path under 5.1,
// hashes with .NET instead of Get-FileHash, and /update-omni starts it with
// no inherited PSModulePath at all.
//
// Run: node tests/installer-powershells.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { installerEnv } from "../src/cli/update-cmd.mjs";

let pass = 0, fail = 0, skip = 0;
async function ok(label, fn) {
  try { await fn(); console.log(`  PASS ${label}`); pass++; }
  catch (e) { console.log(`  FAIL ${label}\n    ${e.message}`); fail++; }
}

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "install", "install.ps1");
const src = fs.readFileSync(script, "utf8");

console.log("\n[installer-powershells]");

await ok("the installer never calls Get-FileHash (missing when 5.1 inherits pwsh's modules)", () => {
  const code = src.split(/\r?\n/).filter((l) => !l.trim().startsWith("#")).join("\n");
  assert.doesNotMatch(code, /Get-FileHash/);
});

await ok("/update-omni starts the installer without an inherited PSModulePath", () => {
  const env = installerEnv({ PATH: "x", PSModulePath: String.raw`C:\Program Files\PowerShell\7\Modules`, OTHER: "1" });
  assert.equal(env.PSModulePath, undefined);
  assert.equal(env.PATH, "x");
  assert.equal(env.OTHER, "1");
  assert.equal(installerEnv({ psmodulepath: "y" }).psmodulepath, undefined, "any casing");
});

const available = (exe) => !spawnSync(exe, ["-NoProfile", "-Command", "1"], { encoding: "utf8" }).error;
const shells = ["powershell", "pwsh"].filter(available);
if (process.platform !== "win32" || !shells.length) {
  console.log("  SKIP running the installer's helpers (no PowerShell here)");
  skip++;
} else {
  // A PSModulePath like the one pwsh hands its children: its own folders
  // first. The real one when pwsh is installed, so the 5.1 case is the bug.
  let pwshPath = String.raw`C:\Users\Someone\Documents\PowerShell\Modules;C:\Program Files\PowerShell\Modules;C:\Program Files\PowerShell\7\Modules`;
  if (shells.includes("pwsh")) {
    const r = spawnSync("pwsh", ["-NoProfile", "-Command", "$env:PSModulePath"], { encoding: "utf8" });
    if (r.stdout?.trim()) pwshPath = r.stdout.trim();
  }
  const q = (s) => s.replace(/'/g, "''");
  const run = (exe, body, env) => {
    const cmd = [
      "Set-StrictMode -Version Latest",
      "$ErrorActionPreference = 'Stop'",
      `$ast = [System.Management.Automation.Language.Parser]::ParseFile('${q(script)}', [ref]$null, [ref]$null)`,
      "$fns = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -in @('Repair-ModulePath','Get-Sha256') }, $true)",
      "foreach ($f in $fns) { . ([ScriptBlock]::Create($f.Extent.Text)) }",
      body,
    ].join("; ");
    const r = spawnSync(exe, ["-NoProfile", "-NonInteractive", "-Command", cmd], { encoding: "utf8", env });
    return (r.stdout || "") + (r.stderr || "");
  };
  const sample = path.join(root, "package.json");
  const crypto = await import("node:crypto");
  const want = crypto.createHash("sha256").update(fs.readFileSync(sample)).digest("hex").toUpperCase();

  for (const exe of shells) {
    for (const [label, env] of [
      ["its own environment", { ...process.env }],
      ["PowerShell 7's PSModulePath inherited", { ...process.env, PSModulePath: pwshPath }],
    ]) {
      await ok(`${exe}, ${label}: Get-Sha256 matches and Utility cmdlets load`, () => {
        const out = run(exe, `Repair-ModulePath; 'HASH=' + (Get-Sha256 '${q(sample)}'); 'JSON=' + ('{"a":7}' | ConvertFrom-Json).a; 'WEB=' + [bool](Get-Command Invoke-RestMethod -ErrorAction SilentlyContinue)`, env);
        assert.ok(out.includes(`HASH=${want}`), out);
        assert.match(out, /JSON=7/, out);
        assert.match(out, /WEB=True/, out);
      });
    }
  }
}

console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
process.exit(fail ? 1 : 0);
