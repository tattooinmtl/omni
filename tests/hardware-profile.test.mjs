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

  // ── Machine scan beyond the llama backend ─────────────────────────────

  await ok("scanHardware records schema, GPU kind, battery, display and tools", async () => {
    const p = await hw.scanHardware();
    assert.equal(p.schema, hw.PROFILE_SCHEMA);
    assert.ok(["discrete", "integrated", "software", "virtual", "unknown"].includes(p.gpuKind), p.gpuKind);
    assert.ok(Array.isArray(p.gpus));
    // When an adapter was found, gpuKind must be the best adapter's class,
    // not a fallback "unknown".
    if (p.gpus.length) {
      const rank = { discrete: 3, integrated: 2, software: 1, virtual: 0 };
      const best = [...p.gpus].sort((a, b) => rank[b.kind] - rank[a.kind])[0];
      assert.equal(p.gpuKind, best.kind);
      assert.equal(best.kind, hw.classifyGpu(best.name));
    }
    assert.equal(typeof p.battery.present, "boolean");
    assert.equal(typeof p.battery.onBattery, "boolean");
    assert.equal(typeof p.tools.git, "boolean");
    assert.ok(p.tools.browser === null || typeof p.tools.browser === "string");
    assert.ok(p.freeDiskGB === null || p.freeDiskGB >= 0);
  });

  await ok("a cache from an older Omni (no schema) is stale, so new installs' upgrades rescan", () => {
    const fake = { ...hw.readCachedProfile(), schema: undefined };
    assert.equal(hw.isCacheFresh(fake), false);
  });

  await ok("classifyGpu sorts real adapter names", () => {
    const cases = {
      "NVIDIA GeForce RTX 4070": "discrete",
      "AMD Radeon RX 6600M": "discrete",
      "Intel(R) Arc(TM) A770 Graphics": "discrete",
      "AMD Radeon(TM) Graphics": "integrated",
      "AMD Radeon(TM) 680M": "integrated",
      "AMD Radeon 780M Graphics": "integrated",
      "AMD Radeon(TM) Vega 8 Graphics": "integrated",
      "Intel(R) UHD Graphics 620": "integrated",
      "Intel(R) Iris(R) Xe Graphics": "integrated",
      "Intel(R) Arc(TM) Graphics": "integrated",
      "Intel(R) Arc(TM) B580 Graphics": "discrete",
      "AMD Radeon Graphics": "integrated",
      "AMD Radeon 8060S Graphics": "integrated",
      "Microsoft Basic Display Adapter": "software",
      "VMware SVGA 3D": "software",
      "Parsec Virtual Display Adapter": "virtual",
      "": "software",
    };
    for (const [name, kind] of Object.entries(cases)) assert.equal(hw.classifyGpu(name), kind, name);
  });

  await ok("parseWindowsMachine handles one GPU object, no battery, and 59 Hz panels", () => {
    const m = hw.parseWindowsMachine(JSON.stringify({
      cpu: "AMD Ryzen 7 5700U with Radeon Graphics ", os: "Microsoft Windows 11 Home", plan: "Balanced",
      gpus: { name: "AMD Radeon(TM) Graphics", hz: 59, w: 1920, h: 1080 }, battery: null,
    }));
    assert.equal(m.cpuName, "AMD Ryzen 7 5700U with Radeon Graphics");
    assert.equal(m.gpus.length, 1);
    assert.deepEqual(m.display, { width: 1920, height: 1080, refreshHz: 60 });
    assert.equal(m.battery.present, false);
    assert.equal(m.powerPlan, "Balanced");
  });

  await ok("parseWindowsMachine: laptop on battery with iGPU + dGPU", () => {
    const m = hw.parseWindowsMachine({
      gpus: [
        { name: "Intel(R) UHD Graphics", hz: 144, w: 2560, h: 1440 },
        { name: "NVIDIA GeForce RTX 3060 Laptop GPU", hz: null, w: null, h: null },
      ],
      battery: { status: 1, charge: 41 },
    });
    assert.equal(m.display.refreshHz, 144);
    assert.deepEqual(m.battery, { present: true, onBattery: true, chargePercent: 41 });
    assert.deepEqual(m.gpus.map((g) => g.kind), ["integrated", "discrete"]);
  });

  await ok("pickBestAdapter takes the graphics card on a hybrid laptop that lists the iGPU first", () => {
    const best = hw.pickBestAdapter([
      { Name: "Intel(R) UHD Graphics", AdapterRAM: 1073741824 },
      { Name: "NVIDIA GeForce RTX 3060 Laptop GPU", AdapterRAM: 4293918720 },
    ]);
    assert.equal(best.Name, "NVIDIA GeForce RTX 3060 Laptop GPU");
    assert.equal(hw.pickBestAdapter({ Name: "AMD Radeon(TM) Graphics", AdapterRAM: 3221225472 }).Name, "AMD Radeon(TM) Graphics");
    assert.equal(hw.pickBestAdapter([]), null);
  });

  await ok("dedicatedMBFromDxdiag reads the chosen card's block, not the first one", () => {
    const txt = [
      "Display Devices", "---------------",
      "          Card name: Intel(R) UHD Graphics", "   Dedicated Memory: 128 MB",
      "          Card name: NVIDIA GeForce RTX 3060 Laptop GPU", "   Dedicated Memory: 5996 MB",
    ].join("\r\n");
    assert.equal(hw.dedicatedMBFromDxdiag(txt, "NVIDIA GeForce RTX 3060 Laptop GPU"), 5996);
    assert.equal(hw.dedicatedMBFromDxdiag(txt, "Intel(R) UHD Graphics"), 128);
    assert.equal(hw.dedicatedMBFromDxdiag(txt, "something else"), 5996, "no name match → largest");
    assert.equal(hw.dedicatedMBFromDxdiag("", "x"), null);
  });

  await ok("parseLspci finds GPUs on Linux", () => {
    const g = hw.parseLspci([
      "00:00.0 Host bridge: Intel Corporation Device 9a14",
      "00:02.0 VGA compatible controller: Intel Corporation TigerLake-LP GT2 [Iris Xe Graphics] (rev 01)",
      "01:00.0 3D controller: NVIDIA Corporation GA107M [GeForce RTX 3050 Mobile] (rev a1)",
    ].join("\n"));
    assert.deepEqual(g.map((x) => x.kind), ["integrated", "discrete"]);
  });

  await ok("parseMacDisplays reads GPU and display from system_profiler", () => {
    const m = hw.parseMacDisplays({ SPDisplaysDataType: [{
      sppci_model: "Apple M2", spdisplays_ndrvs: [{ _spdisplays_resolution: "2560 x 1664 @ 60.00Hz" }],
    }] });
    assert.equal(m.gpus[0].kind, "integrated");
    assert.deepEqual(m.display, { width: 2560, height: 1664, refreshHz: 60 });
    assert.deepEqual(hw.parseMacDisplays("nope"), { gpus: [], display: null });
  });

  await ok("parseWindowsMachine returns null on garbage instead of throwing", () => {
    assert.equal(hw.parseWindowsMachine("not json"), null);
    assert.equal(hw.parseWindowsMachine(""), null);
  });

  // Profiles of PCs other people might install Omni on.
  const gamingDesktop = {
    scannedAt: "2026-10-13T00:00:00Z", cpuName: "AMD Ryzen 9 7950X", cpuCores: 16, cpuThreads: 32, totalRamGB: 64,
    gpuName: "NVIDIA GeForce RTX 4080", gpuKind: "discrete", gpuVramGB: 16, recommendedBackend: "vulkan", recommendedThreads: 16,
    display: { width: 2560, height: 1440, refreshHz: 165 }, battery: { present: false, onBattery: false, chargePercent: null },
    tools: { python: true, git: true, ffmpeg: true, ollama: true, docker: true, "nvidia-smi": true, browser: "chrome" },
  };
  const laptopOnBattery = {
    scannedAt: "2026-10-13T00:00:00Z", cpuName: "Intel Core i5-1135G7", cpuCores: 4, cpuThreads: 8, totalRamGB: 7.8,
    gpuName: "Intel(R) Iris(R) Xe Graphics", gpuKind: "integrated", gpuVramGB: 0.1, recommendedBackend: "cpu", recommendedThreads: 4,
    display: { width: 1920, height: 1080, refreshHz: 60 }, battery: { present: true, onBattery: true, chargePercent: 35 },
    tools: { python: false, git: true, ffmpeg: false, ollama: false, docker: false, "nvidia-smi": false, browser: "msedge" },
  };
  const vm = {
    scannedAt: "2026-10-13T00:00:00Z", cpuCores: 2, cpuThreads: 2, totalRamGB: 4,
    gpuName: "Microsoft Basic Display Adapter", gpuKind: "software", gpuVramGB: 0, recommendedBackend: "cpu", recommendedThreads: 2,
    display: null, battery: { present: false, onBattery: false, chargePercent: null }, tools: { git: false, browser: null },
  };

  await ok("deriveSettings: gaming desktop gets GPU browser + vulkan, no warnings", () => {
    const e = hw.deriveSettings(gamingDesktop);
    assert.equal(e.browserGpu, true);
    assert.equal(e.localBackend, "vulkan");
    assert.equal(e.localThreads, 16);
    assert.equal(e.videoTools, true);
    assert.equal(e.lowMemory, false);
    assert.equal(e.onBattery, false);
    assert.equal(e.refreshHz, 165);
    assert.ok(e.decisions.every((d) => d.auto));
  });

  await ok("deriveSettings: low-RAM laptop on battery keeps GPU on, flags battery + memory, no video tools", () => {
    const e = hw.deriveSettings(laptopOnBattery);
    assert.equal(e.browserGpu, true);
    assert.equal(e.localBackend, "cpu");
    assert.equal(e.videoTools, false);
    assert.equal(e.lowMemory, true);
    assert.equal(e.onBattery, true);
  });

  await ok("deriveSettings: VM with a software adapter turns browser GPU off", () => {
    const e = hw.deriveSettings(vm);
    assert.equal(e.browserGpu, false);
    assert.match(e.decisions.find((d) => d.key === "browserGpu").why, /no hardware GPU/);
  });

  await ok("deriveSettings: overrides win, invalid ones fall back to auto", () => {
    const e = hw.deriveSettings(gamingDesktop, { browserGpu: "off", localBackend: "turbo" });
    assert.equal(e.browserGpu, false);
    assert.equal(e.localBackend, "vulkan");
    const gpu = e.decisions.find((d) => d.key === "browserGpu");
    assert.equal(gpu.auto, false);
    assert.equal(e.decisions.find((d) => d.key === "localBackend").auto, true);
  });

  await ok("deriveSettings never throws on an empty or missing profile", () => {
    assert.equal(hw.deriveSettings(null).browserGpu, false);
    assert.equal(hw.deriveSettings({}).localBackend, "cpu");
  });

  await ok("summarizeForPrompt describes the machine and only the warnings that apply", () => {
    const desk = hw.summarizeForPrompt(gamingDesktop);
    assert.match(desk, /^# This machine/);
    assert.match(desk, /RTX 4080 \(discrete, 16 GB\)/);
    assert.match(desk, /refreshes at 165 Hz/);
    assert.match(desk, /headless browser is not capped/);
    assert.doesNotMatch(desk, /laptop|under 8 GB|not installed/);

    const lap = hw.summarizeForPrompt(laptopOnBattery);
    assert.match(lap, /on battery at 35% at scan time/);
    assert.match(lap, /only representative when plugged in/);
    assert.match(lap, /under 8 GB RAM/);
    assert.match(lap, /not installed: python, ffmpeg, ollama, docker(?!, nvidia)/);
    assert.match(lap, /≤ 3B/);

    assert.match(hw.summarizeForPrompt(vm), /not meaningful/);
    assert.equal(hw.summarizeForPrompt(null), "");
  });

  await ok("applyMachineEnv exports the browser GPU choice", () => {
    const env = {};
    hw.applyMachineEnv(hw.deriveSettings(gamingDesktop), env);
    assert.equal(env.OMNI_BROWSER_GPU, "1");
    hw.applyMachineEnv(hw.deriveSettings(vm), env);
    assert.equal(env.OMNI_BROWSER_GPU, "0");
    assert.doesNotThrow(() => hw.applyMachineEnv(null, env));
  });

  await ok("applyMachineEnv never overrides a value the user set (shell or .env, read at first call)", () => {
    const env = { OMNI_BROWSER_GPU: "0" }; // e.g. loaded from .env before the first call
    hw.applyMachineEnv(hw.deriveSettings(gamingDesktop), env);
    assert.equal(env.OMNI_BROWSER_GPU, "0");
    hw.applyMachineEnv(hw.deriveSettings(gamingDesktop, { browserGpu: "on" }), env);
    assert.equal(env.OMNI_BROWSER_GPU, "0");
  });

  await ok("loadMachineContext reports a failed scan through onFail", async () => {
    try { fs.unlinkSync(hw.PROFILE_PATH); } catch {}
    let failed = null;
    const m = await hw.loadMachineContext({}, { timeoutMs: 1, onFail: (why) => { failed = why; } });
    assert.equal(failed, "timed out");
    assert.deepEqual(m, { profile: null, settings: null, summary: "" });
    await hw.ensureHardwareProfile({ force: true }); // let the in-flight scan settle
  });

  await ok("loadMachineContext returns profile, settings and a prompt summary", async () => {
    await hw.ensureHardwareProfile({ force: true });
    let scanned = false;
    const m = await hw.loadMachineContext({ browserGpu: "off" }, { onScan: () => { scanned = true; } });
    assert.equal(scanned, false, "fresh cache → no scan");
    assert.equal(m.settings.browserGpu, false);
    assert.match(m.summary, /# This machine/);
  });

  await ok("browserCandidates honours OMNI_BROWSER_EXE first", () => {
    process.env.OMNI_BROWSER_EXE = "C:\\custom\\browser.exe";
    assert.equal(hw.browserCandidates()[0], "C:\\custom\\browser.exe");
    delete process.env.OMNI_BROWSER_EXE;
  });

  // Cleanup — give refreshInBackground a moment to finish, then remove tmp.
  await new Promise((r) => setTimeout(r, 100));
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
