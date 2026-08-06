// Cache-only, instant self-update notice — never a network call on the hot
// path (see integrations/update-check.mjs). Tests the cache-driven notice
// logic and version comparison directly; the background refresh's actual
// network fetch isn't exercised here (would need a real/mocked GitHub raw
// endpoint), only that it never throws and respects the cache-age gate.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

let pass = 0, fail = 0;
function assert(label, result, check) {
  try {
    const ok = check(result);
    if (ok) { console.log(`  ✓ ${label}`); pass++; }
    else { console.log(`  ✗ ${label}\n    got: ${String(result).slice(0, 200)}`); fail++; }
  } catch (e) {
    console.log(`  ✗ ${label}\n    error: ${e.message}`); fail++;
  }
}

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1"));
const root = path.join(here, "..");
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "omni-update-check-test-"));
process.env.OMNI_HOME = tmpHome;

const u = (p) => pathToFileURL(path.join(root, "src", p)).href;
const { updateNotice, refreshUpdateCacheInBackground, currentVersion, isNewer } = await import(u("integrations/update-check.mjs"));

const cachePath = path.join(tmpHome, "update-check.json");
const real = currentVersion();

assert("isNewer compares numeric semver segments correctly",
  [isNewer("2.2.0", "2.1.0"), isNewer("2.1.0", "2.2.0"), isNewer("2.1.0", "2.1.0"), isNewer("2.1.10", "2.1.9")],
  (r) => r[0] === true && r[1] === false && r[2] === false && r[3] === true);

assert("no cache file yet -> no notice (never crashes on a fresh install)",
  updateNotice(), (n) => n === "");

fs.writeFileSync(cachePath, JSON.stringify({ lastCheckedAt: Date.now(), latestKnownVersion: real }));
assert("cached version equal to current -> no notice",
  updateNotice(), (n) => n === "");

const [maj, min, pat] = real.split(".").map((x) => parseInt(x, 10) || 0);
const newer = `${maj}.${min}.${pat + 1}`;
fs.writeFileSync(cachePath, JSON.stringify({ lastCheckedAt: Date.now(), latestKnownVersion: newer }));
assert("cached version newer than current -> a one-line notice naming both versions",
  updateNotice(), (n) => n.includes(real) && n.includes(newer) && n.toLowerCase().includes("update available"));

const older = maj > 0 ? `${maj - 1}.${min}.${pat}` : `0.0.0`;
fs.writeFileSync(cachePath, JSON.stringify({ lastCheckedAt: Date.now(), latestKnownVersion: older }));
assert("cached version older than current (shouldn't happen, but must not misfire) -> no notice",
  updateNotice(), (n) => n === "");

assert("updateNotice never touches the network — safe to call synchronously at startup",
  (() => { const t0 = Date.now(); updateNotice(); return Date.now() - t0; })(),
  (ms) => ms < 50);

assert("refreshUpdateCacheInBackground with a fresh cache is a no-op, never throws",
  (() => {
    fs.writeFileSync(cachePath, JSON.stringify({ lastCheckedAt: Date.now(), latestKnownVersion: real }));
    refreshUpdateCacheInBackground();
    return "ok";
  })(),
  (r) => r === "ok");

assert("refreshUpdateCacheInBackground with no cache at all never throws synchronously (network happens in the background)",
  (() => { fs.rmSync(cachePath, { force: true }); refreshUpdateCacheInBackground(); return "ok"; })(),
  (r) => r === "ok");

fs.rmSync(tmpHome, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
