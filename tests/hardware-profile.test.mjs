// Regression test for the hardware profile scanner + cache. Run directly:
//   node tests/hardware-profile.test.mjs
//
// We swap OMNI_HOME to a temp dir *before* importing the module so the cache
// file lands somewhere disposable. That means all imports have to happen
// after the env var is set — hence the dynamic import at the top of main().

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let pass = 0;
let fail = 0;
function ok(label, fn) {
  try {
    const p = fn();
    if (p && typeof p.then === "function") {
      return p.then(
        () => { console.log(`  ✓ ${label}`); pass++; },
        (err) => { console.log(`  ✗ ${label}\n      ${err.message}`); fail++; }
      );
    }
    console.log(`  ✓ ${label}`); pass++;
  } catch (err) {
    console.log(`  ✗ ${label}\n      ${err.message}`); fail++;
  }
}

async function main() {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "omni-hw-"));
  process.env.OMNI_HOME = tmpHome;

  const hw = await import("../src/local/hardware-profile.mjs");

  await ok("readCachedProfile returns null when no cache file exists", () => {
    assert.equal(hw.readCachedProfile(), null);
  });

  await ok("isCacheFresh(null) is false", () => {
    assert.equal(hw.isCacheFresh(null), false);
  });

  await ok("scanHardware returns all documented fields with sane types", async () => {
    const p = await hw.scanHardware();
    assert.equal(typeof p.scannedAt, "string");
    assert.match(p.scannedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(p.platform, process.platform);
    assert.equal(p.arch, process.arch);
    assert.ok(Number.isInteger(p.cpuCores) && p.cpuCores > 0, "cpuCores int > 0");
    assert.ok(Number.isInteger(p.cpuThreads) && p.cpuThreads > 0, "cpuThreads int > 0");
    assert.ok(p.cpuThreads >= p.cpuCores, "logical >= physical");
    assert.ok(p.totalRamGB > 0, "totalRamGB > 0");
    assert.equal(typeof p.gpuName, "string");
    assert.ok(p.gpuVramGB >= 0, "gpuVramGB >= 0");
    assert.equal(typeof p.gpuVramSource, "string");
    assert.equal(typeof p.fingerprint, "string");
    assert.ok(p.fingerprint.length >= 8, "fingerprint has content");
    assert.ok(["cpu", "vulkan"].includes(p.recommendedBackend), "recommendedBackend in {cpu, vulkan}");
    assert.equal(p.recommendedThreads, p.cpuCores);
    assert.ok(Array.isArray(p.notes), "notes is array");
  });

  await ok("VRAM<6 forces recommendedBackend=cpu with a note", async () => {
    const p = await hw.scanHardware();
    if (p.gpuVramGB < 6) {
      assert.equal(p.recommendedBackend, "cpu");
      assert.ok(p.notes.some((n) => /gpuVramGB.*→ recommendedBackend forced to cpu/i.test(n)),
        `expected VRAM-floor note in ${JSON.stringify(p.notes)}`);
    } else {
      assert.equal(p.recommendedBackend, "vulkan");
    }
  });

  await ok("ensureHardwareProfile writes the cache file", async () => {
    const p = await hw.ensureHardwareProfile({ force: true });
    assert.ok(fs.existsSync(hw.PROFILE_PATH), "cache file exists");
    const onDisk = JSON.parse(fs.readFileSync(hw.PROFILE_PATH, "utf8"));
    assert.equal(onDisk.fingerprint, p.fingerprint);
    assert.equal(onDisk.recommendedBackend, p.recommendedBackend);
  });

  await ok("cache round-trip: readCachedProfile matches what was written", () => {
    const cached = hw.readCachedProfile();
    assert.ok(cached, "cache present");
    assert.equal(typeof cached.fingerprint, "string");
    assert.ok(hw.isCacheFresh(cached), "cache fresh on same machine");
  });

  await ok("getHardwareProfileSync hits cache and returns profile", () => {
    const p = hw.getHardwareProfileSync();
    assert.ok(p, "sync fetch returned a profile");
    assert.equal(typeof p.recommendedBackend, "string");
  });

  await ok("fingerprint is stable across two consecutive scans (same hardware)", async () => {
    const a = await hw.scanHardware();
    const b = await hw.scanHardware();
    assert.equal(a.fingerprint, b.fingerprint);
  });

  await ok("isCacheFresh returns false for a cache with a mismatched fingerprint", () => {
    const fake = { ...hw.readCachedProfile(), fingerprint: "0000000000000000" };
    assert.equal(hw.isCacheFresh(fake), false);
  });

  await ok("ensureHardwareProfile without force reuses cache (no rescan)", async () => {
    const before = hw.readCachedProfile();
    const t0 = Date.now();
    const p = await hw.ensureHardwareProfile();
    const dt = Date.now() - t0;
    assert.equal(p.scannedAt, before.scannedAt, "same scannedAt → returned cached, no rescan");
    assert.ok(dt < 100, `cache-hit path fast (took ${dt}ms)`);
  });

  await ok("corrupted cache file falls back to null (no throw)", () => {
    fs.writeFileSync(hw.PROFILE_PATH, "{ not json");
    assert.equal(hw.readCachedProfile(), null);
  });

  await ok("refreshInBackground never throws when the cache is missing", () => {
    try { fs.unlinkSync(hw.PROFILE_PATH); } catch {}
    assert.doesNotThrow(() => hw.refreshInBackground());
  });

  // Cleanup — give refreshInBackground a moment to finish, then remove tmp.
  await new Promise((r) => setTimeout(r, 100));
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
