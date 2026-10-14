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
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
