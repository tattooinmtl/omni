// Guards the version path that the website banner and the public installer
// both depend on.
//
// The banner reads package.json from main at page load, so it self-updates on
// push. The hardcoded value in the HTML is only the fallback for when that
// fetch can't run — offline, blocked, CSP — which is exactly why it rotted
// unnoticed: it still said v2.2.4 while the project shipped 3.1.x, telling
// anyone who hit the fallback the release was four minor versions old. The
// happy path overwrites the wrong value with the right one and hides it, so
// nothing but a check like this can catch the drift.
//
// website/ is gitignored (it's deployed separately), so those checks only run
// on a machine that has the deploy folder. The tracked installer files are
// always checked.
//
// Run: node tests/website-version.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

let pass = 0, fail = 0, skip = 0;
function ok(label, fn) {
  try { fn(); console.log(`  PASS ${label}`); pass++; }
  catch (e) { console.log(`  FAIL ${label}\n    ${e.message}`); fail++; }
}
function optional(file, label, fn) {
  if (!fs.existsSync(file)) {
    console.log(`  SKIP ${label} (${path.basename(path.dirname(file))}/ not present — it is gitignored)`);
    skip++;
    return;
  }
  ok(label, fn);
}

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1"));
const root = path.join(here, "..");

const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

// -- tracked: the real installer + the shim it is served through -----------

const installer = fs.readFileSync(path.join(root, "install", "install.ps1"), "utf8");

ok("the installer derives its version from package.json, never a hardcoded one", () => {
  assert.match(installer, /\$Branch\/package\.json/,
    "installer must read the version from package.json on the branch");
  assert.ok(
    !/\$Version\s*=\s*["']\d+\.\d+\.\d+["']/.test(installer),
    "a hardcoded version in the installer would drift from package.json",
  );
});

ok("the installer's default branch is the one the website reads", () => {
  const branch = /\$Branch\s*=\s*"([^"]+)"/.exec(installer);
  assert.ok(branch, "installer must declare a default branch");
  assert.equal(branch[1], "main",
    "the banner reads main/package.json — an installer on another branch would serve a different version than the site advertises");
});

const shimPath = path.join(root, "install", "web-install.ps1");
ok("the deployed shim hands off to the real installer on the same repo/branch", () => {
  const shim = fs.readFileSync(shimPath, "utf8");
  assert.match(shim, /install\/install\.ps1/, "the shim must hand off to the real installer");
  const branch = /\$Branch\s*=\s*"([^"]+)"/.exec(shim);
  assert.ok(branch, "shim must declare a branch");
  assert.equal(branch[1], "main", "shim branch must match the installer's");
});

// -- the installer has to actually run, and actually update ----------------
//
// Two bugs kept every existing install pinned to its original version:
//
//  1. The .ps1 files contained em dashes. Windows PowerShell 5.1 (what
//     `powershell.exe` is) reads a BOM-less script as the ANSI codepage, and
//     one of those bytes decodes to a double quote — which terminates a string
//     early and turns the whole file into a parse error. So
//     `powershell -File .\install\install.ps1` (README, and both npm
//     install:* scripts) could not run AT ALL. Only the web one-liner worked,
//     because Invoke-RestMethod decodes UTF-8 before the parser sees it.
//  2. In git mode the update was gated behind -AutoUpdate, which the public
//     one-liner physically cannot pass (`irm | iex` takes no arguments). It
//     printed "update available", declined, and then reported
//     "Install complete — Omni v<old> is ready".

for (const rel of ["install/install.ps1", "install/web-install.ps1"]) {
  ok(`${rel} is pure ASCII so Windows PowerShell 5.1 can parse it from a file`, () => {
    const text = fs.readFileSync(path.join(root, rel), "utf8");
    const offenders = [];
    text.split(/\r?\n/).forEach((line, i) => {
      for (const ch of line) {
        if (ch.codePointAt(0) > 127) {
          offenders.push(`line ${i + 1}: U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")} in ${line.trim().slice(0, 60)}`);
          break;
        }
      }
    });
    assert.deepEqual(offenders, [],
      `non-ASCII in a BOM-less .ps1 breaks 'powershell -File' on 5.1:\n    ${offenders.join("\n    ")}`);
  });
}

ok("git-mode updating is the default, not gated behind a flag the one-liner can't pass", () => {
  assert.ok(!/Re-run with -AutoUpdate/.test(installer),
    "the installer must not tell the user to re-run with a flag `irm | iex` cannot pass");
  assert.match(installer, /\[switch\]\$NoUpdate/,
    "opting OUT of the update is the flag that should exist, not opting in");
});

ok("the update fast-forwards and checks whether git actually succeeded", () => {
  assert.match(installer, /merge --ff-only/,
    "a plain `git pull` can create a merge commit in a user's install dir");
  assert.match(installer, /git fetch[\s\S]{0,200}LASTEXITCODE/,
    "a failed fetch must not be treated as a successful update");
});

ok("a declined or failed update is never reported as a finished install", () => {
  // The success line must be reachable only when the installed version is the
  // latest one; an unconditional "Install complete" is what made a no-op
  // install look like a successful upgrade.
  const successLine = /Info "Install complete/.exec(installer);
  assert.ok(successLine, "installer should still report success somewhere");
  const before = installer.slice(0, successLine.index);
  assert.match(before.slice(-600), /\$installed -ne \$latest/,
    "the success message must be guarded by a comparison against the latest version");
});

ok("the install dir is moved onto the release branch, not left on whatever it was", () => {
  assert.match(installer, /currentBranch -ne \$Branch/,
    "an install parked on another branch can never reach the latest version");
  assert.match(installer, /\$remoteRef\.\.HEAD/,
    "before switching branches it must check for commits that exist nowhere on the remote");
});

// -- optional: the local deploy folder (gitignored) ------------------------

const indexPath = path.join(root, "website", "index.html");

optional(indexPath, "the banner's fallback version matches package.json", () => {
  const html = fs.readFileSync(indexPath, "utf8");
  const m = /id="omni-version"[^>]*>v([0-9]+\.[0-9]+\.[0-9]+)</.exec(html);
  assert.ok(m, "could not find the version span in website/index.html");
  assert.equal(
    m[1], pkg.version,
    `website banner fallback is v${m[1]} but package.json is ${pkg.version} — ` +
    "bump the fallback in website/index.html and redeploy the site",
  );
});

optional(indexPath, "the banner still fetches the live version rather than trusting the fallback", () => {
  const html = fs.readFileSync(indexPath, "utf8");
  assert.match(html, /raw\.githubusercontent\.com\/tattooinmtl\/omni\/main\/package\.json/,
    "the banner must read the version from main so a push updates it");
  assert.match(html, /cache:\s*['"]no-store['"]/,
    "without no-store the banner can serve a stale cached version");
});

optional(path.join(root, "website", "install.ps1"), "the deployed shim copy has not drifted from install/web-install.ps1", () => {
  const deployed = fs.readFileSync(path.join(root, "website", "install.ps1"), "utf8").replace(/\r\n/g, "\n").trim();
  const source = fs.readFileSync(shimPath, "utf8").replace(/\r\n/g, "\n").trim();
  assert.equal(deployed, source,
    "website/install.ps1 differs from install/web-install.ps1 — redeploy it, or the public one-liner runs stale bootstrap logic");
});

console.log(`\n${pass} passed, ${fail} failed${skip ? `, ${skip} skipped` : ""}`);
process.exit(fail ? 1 : 0);
