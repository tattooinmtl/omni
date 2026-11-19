// The installer's git update and the user's uncommitted edits: an edit to a
// file the update doesn't touch (an MCP server added to omni.config.json) is
// carried along, while an edit to a file the update changes still stops it.
// Runs the real Update-FromGit from install/install.ps1 against throwaway
// git repos.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "install", "install.ps1");

let pass = 0;
let fail = 0;
function ok(label, fn) {
  try {
    fn();
    console.log(`  PASS ${label}`);
    pass++;
  } catch (e) {
    console.log(`  FAIL ${label}\n    ${e.message.split("\n").join("\n    ")}`);
    fail++;
  }
}

console.log("\n[installer-local-edits] git update vs uncommitted edits");

const ps = ["pwsh", "powershell"].find((exe) => !spawnSync(exe, ["-NoProfile", "-Command", "1"], { encoding: "utf8" }).error);
const hasGit = !spawnSync("git", ["--version"], { encoding: "utf8" }).error;

const git = (cwd, ...args) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

// A remote with two commits on main, and an install cloned at the first one.
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omni-edits-"));
  const remote = path.join(dir, "remote.git");
  const seed = path.join(dir, "seed");
  const install = path.join(dir, "install");
  git(dir, "init", "-q", "--bare", "-b", "main", remote);
  git(dir, "clone", "-q", "-c", "core.autocrlf=false", remote, seed);
  for (const [k, v] of [["user.email", "t@t"], ["user.name", "t"]]) git(seed, "config", k, v);
  fs.writeFileSync(path.join(seed, "omni.config.json"), "{}\n");
  fs.writeFileSync(path.join(seed, "ui.mjs"), "v1\n");
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "v1");
  git(seed, "push", "-q", "origin", "main");
  // Line-ending conversion would make every file look edited.
  git(dir, "clone", "-q", "-c", "core.autocrlf=false", remote, install);
  fs.writeFileSync(path.join(seed, "ui.mjs"), "v2\n");
  git(seed, "commit", "-q", "-am", "v2");
  git(seed, "push", "-q", "origin", "main");
  return { dir, seed, install };
}

// Define the installer's git helpers from the real script without running
// its main block, then update `install`.
function update(install) {
  const q = (s) => s.replace(/'/g, "''");
  const cmd = [
    "Set-StrictMode -Version Latest",
    `$ast = [System.Management.Automation.Language.Parser]::ParseFile('${q(script)}', [ref]$null, [ref]$null)`,
    `$fns = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -in @('Info','Ensure-Command','Invoke-External','Invoke-Git','Update-FromGit') }, $true)`,
    `foreach ($f in $fns) { . ([ScriptBlock]::Create($f.Extent.Text)) }`,
    `$Branch = 'main'; $Force = $false; $NoUpdate = $false`,
    `Update-FromGit '${q(install)}' 3>&1`,
  ].join("; ");
  const r = spawnSync(ps, ["-NoProfile", "-NonInteractive", "-Command", cmd], { encoding: "utf8" });
  return (r.stdout || "") + (r.stderr || "");
}

if (!ps || !hasGit) {
  console.log(`  SKIP (${!ps ? "no PowerShell" : "no git"})`);
} else {
  ok("an edit to a file the update doesn't touch is kept, and the update applies", () => {
    const { dir, seed, install } = setup();
    const mine = '{ "mcpServers": { "appinventor": {} } }\n';
    fs.writeFileSync(path.join(install, "omni.config.json"), mine);
    const out = update(install);
    assert.equal(git(install, "rev-parse", "HEAD"), git(seed, "rev-parse", "HEAD"), out);
    assert.equal(fs.readFileSync(path.join(install, "ui.mjs"), "utf8"), "v2\n", "update applied");
    assert.equal(fs.readFileSync(path.join(install, "omni.config.json"), "utf8"), mine, "local edit kept");
    assert.match(out, /Keeping your uncommitted change\(s\).*omni\.config\.json/, out);
    assert.doesNotMatch(out, /NOT updating/, out);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  ok("an edit to a file the update changes still stops it, naming the file", () => {
    const { dir, install } = setup();
    const before = git(install, "rev-parse", "HEAD");
    fs.writeFileSync(path.join(install, "ui.mjs"), "my local hack\n");
    const out = update(install);
    assert.match(out, /NOT updating/, out);
    assert.match(out, /ui\.mjs/, "names the clashing file");
    assert.doesNotMatch(out, /omni\.config\.json/, "lists only the clash");
    assert.equal(git(install, "rev-parse", "HEAD"), before, "tree not moved");
    assert.equal(fs.readFileSync(path.join(install, "ui.mjs"), "utf8"), "my local hack\n", "edit untouched");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  ok("a staged edit counts the same as an unstaged one", () => {
    const { dir, install } = setup();
    fs.writeFileSync(path.join(install, "ui.mjs"), "staged hack\n");
    git(install, "add", "ui.mjs");
    const out = update(install);
    assert.match(out, /NOT updating/, out);
    assert.match(out, /ui\.mjs/, out);
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
