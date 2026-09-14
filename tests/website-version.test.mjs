// The website banner reads the live version from package.json on main, so it
// self-updates on push. The hardcoded value in the HTML is only the fallback
// for when that fetch can't run (offline, blocked, CSP) — which is exactly why
// it rotted unnoticed: it still said v2.2.4 while the project shipped 3.1.x,
// telling anyone who hit the fallback that the release was four minor versions
// older than it was.
//
// Nothing else can catch that drift, so the suite does.
//
// Run: node tests/website-version.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

let pass = 0, fail = 0;
function ok(label, fn) {
  try { fn(); console.log(`  PASS ${label}`); pass++; }
  catch (e) { console.log(`  FAIL ${label}\n    ${e.message}`); fail++; }
}

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1"));
const root = path.join(here, "..");

const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const html = fs.readFileSync(path.join(root, "website", "index.html"), "utf8");
const installer = fs.readFileSync(path.join(root, "install", "install.ps1"), "utf8");
const shim = fs.readFileSync(path.join(root, "website", "install.ps1"), "utf8");

ok("the banner's fallback version matches package.json", () => {
  const m = /id="omni-version"[^>]*>v([0-9]+\.[0-9]+\.[0-9]+)</.exec(html);
  assert.ok(m, "could not find the version span in website/index.html");
  assert.equal(
    m[1], pkg.version,
    `website banner fallback is v${m[1]} but package.json is ${pkg.version} — ` +
    "bump the fallback in website/index.html when you bump the version",
  );
});

ok("the banner still fetches the live version rather than trusting the fallback", () => {
  assert.match(html, /raw\.githubusercontent\.com\/tattooinmtl\/omni\/main\/package\.json/,
    "the banner must read the version from main so a push updates it");
  assert.match(html, /cache:\s*['"]no-store['"]/,
    "without no-store the banner can serve a stale cached version");
});

ok("the installer derives its version from package.json, never a hardcoded one", () => {
  assert.match(installer, /\$Branch\/package\.json/,
    "installer must read the version from package.json on the branch");
  assert.ok(
    !/\$Version\s*=\s*["']\d+\.\d+\.\d+["']/.test(installer),
    "a hardcoded version in the installer would drift from package.json",
  );
});

ok("the deployed shim points at the same repo and branch as the installer", () => {
  const owner = /\$RepoOwner\s*=\s*"([^"]+)"/.exec(shim);
  const repo = /\$RepoName\s*=\s*"([^"]+)"/.exec(shim);
  const branch = /\$Branch\s*=\s*"([^"]+)"/.exec(shim);
  assert.ok(owner && repo && branch, "shim must declare owner/repo/branch");
  assert.equal(owner[1], "tattooinmtl");
  assert.equal(repo[1], "omni");
  assert.equal(branch[1], "main");
  assert.match(shim, /install\/install\.ps1/, "the shim must hand off to the real installer");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
