// Detect and cache a hardware profile so /llama-start (Phase C) can pick the
// right backend (cpu vs vulkan) and thread count without re-scanning every
// boot. The full scan spawns PowerShell/nvidia-smi/dxdiag and takes 500-800ms;
// the cheap fingerprint (cores + arch + totalmem) takes <5ms and hits on 90%+
// of boots. Full scan runs only when the cheap fingerprint drifts (hardware
// changed) or the user forces it via `/hardware rescan`.
//
// Beyond the llama backend, the profile also records what the agent should
// know about the machine it runs on (GPU kind, display refresh, battery,
// installed tools), and deriveSettings() turns it into per-PC settings
// (browser GPU, local-model backend) that the user can override with
// `/hardware set`. Nothing here is tuned to one machine: every install scans
// its own hardware on first launch and again whenever the fingerprint drifts.
//
// Cache lives at <HOME>/hardware-profile.json (same dir as settings.json).
// Human-readable JSON on purpose so users can eyeball what the heuristic saw
// if a backend pick surprises them.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { atomicWriteFileSync } from "../core/atomic-write.mjs";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { HOME } from "../core/config.mjs";

export const PROFILE_PATH = path.join(HOME, "hardware-profile.json");

// Below this VRAM threshold, /llama-start recommends "cpu" even if a Vulkan
// binary is available — the GPU init overhead + slow bus transfers usually
// make sub-6GB cards slower than plain CPU inference in practice (user's
// 3GB card is the reference point).
const VRAM_FLOOR_GB = 6;

// Bump when scanHardware() gains fields, so caches written by an older Omni
// count as stale and get rescanned instead of silently lacking them.
export const PROFILE_SCHEMA = 2;

// Below this much RAM the agent is told not to stack heavy processes.
const LOW_RAM_GB = 8;

// Chromium-family browsers browser-use.js can drive, in preference order.
// Lives here so the scan and the browser extension agree on what "a browser
// is installed" means.
export function browserCandidates() {
  return [
    process.env.OMNI_BROWSER_EXE,
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Chromium\\Application\\chrome.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
    "/usr/bin/microsoft-edge",
  ].filter(Boolean);
}

// ── Cheap fingerprint ────────────────────────────────────────────────────
// Anything that would invalidate a cached backend recommendation must be in
// here. Total RAM is rounded to whole GB so tiny fluctuations don't churn.

function cheapFingerprint() {
  const bits = [
    process.platform,
    process.arch,
    String(os.cpus().length),
    String(Math.round(os.totalmem() / 1024 ** 3)),
  ].join("|");
  return crypto.createHash("sha256").update(bits).digest("hex").slice(0, 16);
}

// ── Cache read/write ─────────────────────────────────────────────────────

export function readCachedProfile() {
  try {
    const raw = fs.readFileSync(PROFILE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.fingerprint) return parsed;
  } catch { /* no cache yet, corrupted, or unreadable — treat as miss */ }
  return null;
}

function writeCachedProfile(profile) {
  try {
    fs.mkdirSync(HOME, { recursive: true });
    // Was a hand-rolled tmp+rename with a FIXED tmp name: two Omni
    // processes writing at once clobbered each other's tmp file, and a
    // failed rename left it behind. The shared helper uniquifies the tmp
    // name, cleans up on failure, and retries a transient Windows EPERM.
    atomicWriteFileSync(PROFILE_PATH, JSON.stringify(profile, null, 2));
  } catch { /* non-fatal — profile stays in memory only */ }
}

// True if the cached fingerprint matches the current cheap fingerprint. Used
// on every boot; cache-hit path is entirely sync and takes <5ms.
export function isCacheFresh(cached) {
  return !!cached && cached.schema === PROFILE_SCHEMA && cached.fingerprint === cheapFingerprint();
}

// ── Subprocess helpers ───────────────────────────────────────────────────

function runCapture(cmd, args, timeoutMs = 4000) {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let done = false;
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      resolve({ ok: false, stdout: "", stderr: "spawn failed" });
      return;
    }
    const timer = setTimeout(() => {
      if (!done) { done = true; try { child.kill(); } catch {} resolve({ ok: false, stdout: out, stderr: "timeout" }); }
    }, timeoutMs);
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.stderr.on("data", (d) => { err += d.toString(); });
    child.on("error", () => {
      if (!done) { done = true; clearTimeout(timer); resolve({ ok: false, stdout: out, stderr: err || "error" }); }
    });
    child.on("exit", (code) => {
      if (!done) { done = true; clearTimeout(timer); resolve({ ok: code === 0, stdout: out, stderr: err }); }
    });
  });
}

// ── Detection: CPU physical cores ────────────────────────────────────────

async function detectCpuCoresPhysical() {
  const logical = os.cpus().length;
  if (process.platform !== "win32") return { physical: logical, source: "os.cpus" };
  const res = await runCapture("powershell", [
    "-NoProfile", "-Command",
    "(Get-CimInstance Win32_Processor | Measure-Object -Property NumberOfCores -Sum).Sum",
  ]);
  const n = parseInt(String(res.stdout).trim(), 10);
  if (res.ok && Number.isFinite(n) && n > 0) return { physical: n, source: "Win32_Processor" };
  // HT-assumption fallback: most modern x86 has 2 threads/core.
  return { physical: Math.max(1, Math.floor(logical / 2)), source: "logical/2" };
}

// ── Detection: GPU + VRAM (Windows only, with fallback chain) ────────────

// Best adapter from a Win32_VideoController list (one object or an array):
// highest GPU class first, then most AdapterRAM.
export function pickBestAdapter(list) {
  const arr = (Array.isArray(list) ? list : [list]).filter((a) => a && a.Name);
  return arr.sort((a, b) =>
    (GPU_RANK[classifyGpu(b.Name)] - GPU_RANK[classifyGpu(a.Name)]) ||
    ((Number(b.AdapterRAM) || 0) - (Number(a.AdapterRAM) || 0)))[0] || null;
}

// dxdiag /t lists one "Card name:" block per display device; take the
// "Dedicated Memory" from the block for `name` (else the largest), not just
// the first device in the file.
export function dedicatedMBFromDxdiag(txt, name) {
  const blocks = String(txt).split(/(?=^\s*Card name:)/mi).slice(1);
  const parsed = blocks.map((b) => ({
    name: (/Card name:\s*(.+)/i.exec(b)?.[1] || "").trim(),
    mb: parseInt(/Dedicated Memory:\s*(\d+)\s*MB/i.exec(b)?.[1], 10),
  })).filter((x) => Number.isFinite(x.mb));
  const match = name && parsed.find((x) => x.name.toLowerCase() === String(name).trim().toLowerCase());
  if (match) return match.mb;
  return parsed.length ? Math.max(...parsed.map((x) => x.mb)) : null;
}

async function detectGpuWindows() {
  const nv = await detectNvidia();
  if (nv) return nv;
  return detectGpuWindowsWmi();
}

// nvidia-smi is accurate and returns MB directly, on Windows and Linux.
async function detectNvidia() {
  const nv = await runCapture("nvidia-smi", [
    "--query-gpu=name,memory.total", "--format=csv,noheader,nounits",
  ]);
  if (nv.ok && nv.stdout.trim()) {
    const line = nv.stdout.trim().split(/\r?\n/)[0];
    const parts = line.split(",").map((s) => s.trim());
    const mb = parseInt(parts[1], 10);
    if (Number.isFinite(mb) && mb > 0) {
      return { name: parts[0] || "NVIDIA GPU", vramGB: +(mb / 1024).toFixed(1), vramSource: "nvidia-smi" };
    }
  }
  return null;
}

async function detectGpuWindowsWmi() {
  // WMI (AdapterRAM caps at ~4GB but always available). Read every adapter
  // and keep the best one, the same pick scanHardware makes for gpuKind —
  // hybrid laptops often list the iGPU first.
  const wmi = await runCapture("powershell", [
    "-NoProfile", "-Command",
    "@(Get-CimInstance Win32_VideoController | Select-Object -Property Name,AdapterRAM) | ConvertTo-Json -Compress",
  ]);
  let wmiName = null;
  let wmiBytes = null;
  if (wmi.ok && wmi.stdout.trim()) {
    try {
      const best = pickBestAdapter(JSON.parse(wmi.stdout.trim()));
      if (best) {
        wmiName = best.Name || null;
        wmiBytes = Number.isFinite(best.AdapterRAM) ? best.AdapterRAM : null;
      }
    } catch { /* leave nulls */ }
  }

  // AdapterRAM is a 32-bit field: it only under-reports cards with 4 GB or
  // more. Below that it is exact, so skip dxdiag — it costs ~7s, which now
  // matters because a new install waits for its first scan.
  if (wmiBytes && wmiBytes > 0 && wmiBytes < 4 * 1024 ** 3 - 64 * 1024 ** 2) {
    return { name: wmiName || "GPU", vramGB: +(wmiBytes / 1024 ** 3).toFixed(1), vramSource: "Win32_VideoController.AdapterRAM" };
  }

  // dxdiag as the tie-breaker when AdapterRAM under-reports (>4GB cards).
  const tmp = path.join(os.tmpdir(), `omni-dxdiag-${process.pid}.txt`);
  const dx = await runCapture("dxdiag", ["/t", tmp], 6000);
  let dxMB = null;
  if (dx.ok || dx.stderr === "timeout") {
    try {
      // dxdiag /t returns immediately but writes the file async on some
      // systems — give it a moment.
      for (let i = 0; i < 20 && !fs.existsSync(tmp); i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      if (fs.existsSync(tmp)) {
        dxMB = dedicatedMBFromDxdiag(fs.readFileSync(tmp, "utf8"), wmiName);
        try { fs.unlinkSync(tmp); } catch { /* leave temp file */ }
      }
    } catch { /* dxdiag missing or unreadable */ }
  }

  if (dxMB && Number.isFinite(dxMB) && dxMB > 0) {
    return { name: wmiName || "GPU", vramGB: +(dxMB / 1024).toFixed(1), vramSource: "dxdiag" };
  }
  if (wmiBytes && wmiBytes > 0) {
    return { name: wmiName || "GPU", vramGB: +(wmiBytes / 1024 ** 3).toFixed(1), vramSource: "Win32_VideoController.AdapterRAM" };
  }
  return { name: wmiName || "unknown", vramGB: 0, vramSource: "none" };
}

// ── Detection: the rest of the machine ───────────────────────────────────

// Sort a GPU adapter name into discrete / integrated / software / virtual.
// "virtual" adapters (remote-desktop and VM display drivers) lose to any real
// one; "software" means no hardware acceleration at all.
export function classifyGpu(name) {
  const n = String(name || "").trim();
  if (!n) return "software";
  if (/parsec|virtual display|remote display|indirect display|spacedesk|citrix|meta virtual/i.test(n)) return "virtual";
  if (/microsoft basic (display|render)|swiftshader|llvmpipe|softpipe|vmware svga|virtualbox|hyper-v|qxl|cirrus/i.test(n)) return "software";
  // Intel Arc A-series cards are discrete; "Intel(R) Arc(TM) Graphics" is the
  // Core Ultra iGPU, and every other Intel adapter is integrated.
  if (/^intel/i.test(n)) return /arc(\(tm\))? [ab]\d/i.test(n) ? "discrete" : "integrated";
  if (/^amd radeon(\(tm\))?( \d+m)? graphics$|radeon\(tm\) (vega|\d{3}m|\d{4}s)|radeon (vega|\d{3}m|\d{4}s)\b|^apple\b/i.test(n)) return "integrated";
  return "discrete";
}

const GPU_RANK = { discrete: 3, integrated: 2, software: 1, virtual: 0 };

// Pure parser for the Windows CIM query below — split out so tests can feed
// it the shapes PowerShell actually produces (one object vs an array, nulls).
export function parseWindowsMachine(raw) {
  let j;
  try { j = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return null; }
  if (!j || typeof j !== "object") return null;
  const list = Array.isArray(j.gpus) ? j.gpus : j.gpus ? [j.gpus] : [];
  const gpus = list
    .filter((g) => g && g.name)
    .map((g) => ({
      name: String(g.name).trim(),
      kind: classifyGpu(g.name),
      refreshHz: Number(g.hz) > 1 ? Number(g.hz) : null,
      width: Number(g.w) > 0 ? Number(g.w) : null,
      height: Number(g.h) > 0 ? Number(g.h) : null,
    }));
  // Windows reports 59.94 Hz panels as 59, 143.9 as 143, …; show the nominal rate.
  for (const g of gpus) {
    if (g.refreshHz && [60, 75, 90, 120, 144, 165, 240].includes(g.refreshHz + 1)) g.refreshHz += 1;
  }
  const withDisplay = gpus.find((g) => g.refreshHz);
  // Win32_Battery.BatteryStatus: 1 discharging, 4 low, 5 critical → on battery.
  const b = j.battery;
  const battery = b && typeof b === "object"
    ? {
        present: true,
        onBattery: [1, 4, 5].includes(Number(b.status)),
        chargePercent: b.charge != null && Number.isFinite(Number(b.charge)) ? Number(b.charge) : null,
      }
    : { present: false, onBattery: false, chargePercent: null };
  return {
    cpuName: j.cpu ? String(j.cpu).trim() : null,
    osName: j.os ? String(j.os).trim() : null,
    gpus,
    display: withDisplay
      ? { width: withDisplay.width, height: withDisplay.height, refreshHz: withDisplay.refreshHz }
      : null,
    battery,
    powerPlan: j.plan ? String(j.plan).trim() : null,
  };
}

async function detectMachineWindows() {
  const ps = [
    "$ErrorActionPreference='SilentlyContinue';",
    "$cpu=(Get-CimInstance Win32_Processor | Select-Object -First 1).Name;",
    "$g=@(Get-CimInstance Win32_VideoController | ForEach-Object { @{name=$_.Name; hz=$_.CurrentRefreshRate; w=$_.CurrentHorizontalResolution; h=$_.CurrentVerticalResolution} });",
    "$b=Get-CimInstance Win32_Battery | Select-Object -First 1;",
    "$bat=$null; if ($b) { $bat=@{status=$b.BatteryStatus; charge=$b.EstimatedChargeRemaining} };",
    "$plan=$null; $pc=(powercfg /getactivescheme) -join ' '; if ($pc -match '\\(([^)]+)\\)') { $plan=$Matches[1] };",
    "$os=(Get-CimInstance Win32_OperatingSystem).Caption;",
    "@{cpu=$cpu; gpus=$g; battery=$bat; plan=$plan; os=$os} | ConvertTo-Json -Compress -Depth 4",
  ].join(" ");
  const res = await runCapture("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], 8000);
  return parseWindowsMachine(res.stdout.trim());
}

// `lspci` lines like "00:02.0 VGA compatible controller: Intel Corporation …".
export function parseLspci(txt) {
  return String(txt || "").split(/\r?\n/)
    .filter((l) => /VGA compatible controller|3D controller|Display controller/i.test(l))
    .map((l) => l.replace(/^.*?(VGA compatible controller|3D controller|Display controller)[^:]*:\s*/i, "").trim())
    .filter(Boolean)
    .map((name) => ({ name, kind: classifyGpu(name), refreshHz: null, width: null, height: null }));
}

// `system_profiler SPDisplaysDataType -json` on macOS.
export function parseMacDisplays(raw) {
  let j;
  try { j = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return { gpus: [], display: null }; }
  const gpus = [];
  let display = null;
  for (const card of j?.SPDisplaysDataType || []) {
    const name = card.sppci_model || card._name;
    if (name) gpus.push({ name, kind: classifyGpu(name), refreshHz: null, width: null, height: null });
    for (const d of card.spdisplays_ndrvs || []) {
      const m = /(\d+)\s*x\s*(\d+)(?:.*?@\s*([\d.]+)\s*Hz)?/i.exec(d._spdisplays_resolution || d.spdisplays_resolution || "");
      if (m && !display) display = { width: +m[1], height: +m[2], refreshHz: m[3] ? Math.round(+m[3]) : null };
    }
  }
  return { gpus, display };
}

async function detectMachineOther() {
  const cpuName = os.cpus()[0]?.model?.trim() || null;
  let battery = { present: false, onBattery: false, chargePercent: null };
  if (process.platform === "linux") {
    try {
      const dir = "/sys/class/power_supply";
      const bat = fs.readdirSync(dir).find((d) => /^BAT/i.test(d));
      if (bat) {
        const status = fs.readFileSync(path.join(dir, bat, "status"), "utf8").trim();
        const cap = parseInt(fs.readFileSync(path.join(dir, bat, "capacity"), "utf8"), 10);
        battery = { present: true, onBattery: /discharging/i.test(status), chargePercent: Number.isFinite(cap) ? cap : null };
      }
    } catch { /* no sysfs battery info */ }
  }
  let gpus = [];
  let display = null;
  if (process.platform === "linux") {
    const r = await runCapture("lspci", [], 4000);
    if (r.ok) gpus = parseLspci(r.stdout);
  } else if (process.platform === "darwin") {
    const r = await runCapture("system_profiler", ["SPDisplaysDataType", "-json"], 8000);
    if (r.ok) ({ gpus, display } = parseMacDisplays(r.stdout));
    // Apple Silicon always has an on-die GPU.
    if (!gpus.length && process.arch === "arm64") {
      gpus = [{ name: "Apple GPU", kind: "integrated", refreshHz: null, width: null, height: null }];
    }
  }
  return { cpuName, osName: `${os.type()} ${os.release()}`, gpus, display, battery, powerPlan: null };
}

// Tools the agent would otherwise assume exist. Presence only; versions are
// what dev_env_report is for.
const TOOL_PROBES = {
  python: ["python", "python3", "py"],
  git: ["git"],
  ffmpeg: ["ffmpeg"],
  ollama: ["ollama"],
  docker: ["docker"],
  "nvidia-smi": ["nvidia-smi"],
};

async function detectTools() {
  const finder = process.platform === "win32" ? "where.exe" : "which";
  const entries = await Promise.all(Object.entries(TOOL_PROBES).map(async ([tool, names]) => {
    for (const n of names) {
      const r = await runCapture(finder, [n], 3000);
      // where.exe also lists the Microsoft Store "python" alias, which only
      // opens the Store — a WindowsApps-only hit counts as not installed.
      const hits = r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
        .filter((l) => !/\\WindowsApps\\/i.test(l));
      if (r.ok && hits.length) return [tool, true];
    }
    return [tool, false];
  }));
  const tools = Object.fromEntries(entries);
  const exe = browserCandidates().find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
  tools.browser = exe ? path.basename(exe).replace(/\.exe$/i, "") : null;
  return tools;
}

function freeDiskGB(dir) {
  try {
    const st = fs.statfsSync(dir);
    return +((st.bavail * st.bsize) / 1024 ** 3).toFixed(1);
  } catch { return null; }
}

// ── Full scan ────────────────────────────────────────────────────────────

export async function scanHardware() {
  const logical = os.cpus().length;
  const totalRamGB = +(os.totalmem() / 1024 ** 3).toFixed(1);
  const { physical, source: coreSource } = await detectCpuCoresPhysical();

  const isWin = process.platform === "win32";
  const [gpuRes, machineRes, tools] = await Promise.all([
    isWin ? detectGpuWindows() : detectNvidia(),
    isWin ? detectMachineWindows() : detectMachineOther(),
    detectTools(),
  ]);
  const machine = machineRes || await detectMachineOther();
  // Best adapter wins: a graphics card over the iGPU, a real GPU over a
  // remote-desktop or VM display driver.
  const primary = [...machine.gpus].sort((a, b) => GPU_RANK[b.kind] - GPU_RANK[a.kind])[0] || null;
  // Off Windows only nvidia-smi reports VRAM; otherwise name the GPU from
  // lspci / system_profiler with no VRAM figure (so local models stay on CPU).
  const gpu = gpuRes || { name: primary ? primary.name : "unknown", vramGB: 0, vramSource: primary ? "none" : "unsupported-platform" };

  const recommendedBackend = gpu.vramGB >= VRAM_FLOOR_GB ? "vulkan" : "cpu";
  const notes = [];
  if (gpu.vramGB < VRAM_FLOOR_GB) {
    notes.push(`gpuVramGB=${gpu.vramGB}<${VRAM_FLOOR_GB} → recommendedBackend forced to cpu`);
  }
  if (coreSource !== "Win32_Processor" && process.platform === "win32") {
    notes.push(`cpu physical-core source: ${coreSource} (fallback)`);
  }

  return {
    schema: PROFILE_SCHEMA,
    scannedAt: new Date().toISOString(),
    platform: process.platform,
    osName: machine.osName,
    cpuName: machine.cpuName,
    arch: process.arch,
    cpuCores: physical,
    cpuThreads: logical,
    totalRamGB,
    gpuName: gpu.name,
    gpuVramGB: gpu.vramGB,
    gpuVramSource: gpu.vramSource,
    gpuKind: primary ? primary.kind : (gpu.name && gpu.name !== "n/a" && gpu.name !== "unknown" ? classifyGpu(gpu.name) : "unknown"),
    gpus: machine.gpus,
    display: machine.display,
    battery: machine.battery,
    powerPlan: machine.powerPlan,
    freeDiskGB: freeDiskGB(HOME),
    tools,
    fingerprint: cheapFingerprint(),
    recommendedBackend,
    recommendedThreads: physical,
    notes,
  };
}

// ── Public API ───────────────────────────────────────────────────────────

// Sync entry point for anything that needs a profile *right now* (e.g., the
// /llama-start command). Returns the cached profile if fresh, else null —
// callers should degrade to os.cpus()/no-GPU-info when null.
export function getHardwareProfileSync() {
  const cached = readCachedProfile();
  if (isCacheFresh(cached)) return cached;
  return null;
}

// Async entry point that guarantees a profile: hits cache if fresh, else runs
// the full scan, writes the cache, returns the profile. Used by /hardware
// commands and by the boot-time refresh below (via refreshInBackground).
export async function ensureHardwareProfile({ force = false } = {}) {
  const cached = readCachedProfile();
  if (!force && isCacheFresh(cached)) return cached;
  const fresh = await scanHardware();
  writeCachedProfile(fresh);
  return fresh;
}

// Fire-and-forget refresh, safe to call at boot. Never throws, never blocks.
export function refreshInBackground() {
  const cached = readCachedProfile();
  if (isCacheFresh(cached)) return; // nothing to do
  ensureHardwareProfile().catch(() => { /* non-fatal */ });
}

// Boot entry point: the profile (cached, or one scan if missing/stale), the
// settings derived from it plus the user's overrides, and the prompt block.
// Never throws — a failed or slow scan means the session starts without
// machine context (onFail says so), the way it did before.
//
// The cheap fingerprint can't see a swapped GPU, a new monitor or a tool
// installed since the last scan, so a cached profile older than a day is
// also rescanned — in the background, for the next session, never blocking
// this one.
const BACKGROUND_RESCAN_MS = 24 * 60 * 60 * 1000;
export async function loadMachineContext(overrides = {}, { onScan, onFail, timeoutMs = 20000 } = {}) {
  let profile = getHardwareProfileSync();
  if (profile) {
    const age = Date.now() - Date.parse(profile.scannedAt || 0);
    if (!(age < BACKGROUND_RESCAN_MS)) ensureHardwareProfile({ force: true }).catch(() => { /* next boot retries */ });
  } else {
    try { onScan?.(); } catch { /* display only */ }
    let timer;
    let why = "timed out";
    try {
      profile = await Promise.race([
        ensureHardwareProfile(),
        new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); }),
      ]);
    } catch (e) { profile = null; why = e?.message || "failed"; }
    clearTimeout(timer);
    if (!profile) { try { onFail?.(why); } catch { /* display only */ } }
  }
  if (!profile) return { profile: null, settings: null, summary: "" };
  const settings = deriveSettings(profile, overrides);
  return { profile, settings, summary: summarizeForPrompt(profile, settings) };
}

// Export the derived settings to the environment the extensions read. An
// OMNI_BROWSER_GPU the user set before launching (shell or .env) always wins,
// including over a later `/hardware set` (which calls this again). Captured
// on the first call, not at import: main.mjs calls this after loadSettings()
// has loaded .env, which happens after this module is imported.
const userSetEnv = new WeakMap();
export function applyMachineEnv(settings, env = process.env) {
  if (!settings) return;
  if (!userSetEnv.has(env)) userSetEnv.set(env, env.OMNI_BROWSER_GPU !== undefined);
  if (userSetEnv.get(env)) return;
  env.OMNI_BROWSER_GPU = settings.browserGpu ? "1" : "0";
}

// ── Per-PC settings ──────────────────────────────────────────────────────
// Turn a profile into the settings Omni runs with on this machine. Pure, so
// it can be tested against profiles of PCs we don't have. `overrides` is
// settings.hardware from settings.json (written by `/hardware set`); any key
// missing or invalid there falls back to the automatic choice.

export const HARDWARE_SETTINGS = {
  browserGpu:   { values: ["on", "off"],     label: "browser GPU" },
  localBackend: { values: ["cpu", "vulkan"], label: "local-model backend" },
};

export function deriveSettings(profile, overrides = {}) {
  const p = profile || {};
  const o = overrides && typeof overrides === "object" ? overrides : {};
  const decisions = [];
  const pick = (key, autoValue, why) => {
    const valid = HARDWARE_SETTINGS[key].values.includes(o[key]);
    const value = valid ? o[key] : autoValue;
    decisions.push({ key, label: HARDWARE_SETTINGS[key].label, value, auto: !valid, why: valid ? "set with /hardware set" : why });
    return value;
  };

  const kind = p.gpuKind || "unknown";
  const hasGpu = kind === "discrete" || kind === "integrated";
  const browserGpu = pick("browserGpu", hasGpu ? "on" : "off",
    hasGpu ? `${kind} GPU found (${p.gpuName || "GPU"})`
      : kind === "unknown" ? "GPU could not be detected — software rendering is the safe default"
      : "no hardware GPU — software rendering");
  const vulkan = p.recommendedBackend === "vulkan";
  const localBackend = pick("localBackend", vulkan ? "vulkan" : "cpu",
    vulkan ? `${p.gpuVramGB} GB VRAM ≥ ${VRAM_FLOOR_GB} GB`
      : `${p.gpuVramGB ?? 0} GB VRAM < ${VRAM_FLOOR_GB} GB — CPU is faster`);

  return {
    browserGpu: browserGpu === "on",
    localBackend,
    localThreads: p.recommendedThreads || p.cpuCores || null,
    videoTools: !!p.tools?.ffmpeg,
    lowMemory: Number(p.totalRamGB) > 0 && Number(p.totalRamGB) < LOW_RAM_GB,
    onBattery: !!p.battery?.onBattery,
    refreshHz: p.display?.refreshHz || null,
    decisions,
  };
}

// Short block for the system prompt so the agent knows the machine it runs
// on instead of guessing. Kept to a few lines — it rides on every turn.
export function summarizeForPrompt(profile, eff) {
  const p = profile;
  if (!p) return "";
  const e = eff || deriveSettings(p);
  const lines = [`# This machine (scanned ${String(p.scannedAt || "").slice(0, 10)}; the user can run /hardware)`];
  lines.push(`- CPU: ${p.cpuName ? `${p.cpuName} — ` : ""}${p.cpuCores} cores / ${p.cpuThreads} threads · RAM ${p.totalRamGB} GB` +
    (p.freeDiskGB != null ? ` · ${p.freeDiskGB} GB free disk` : "") + (p.osName ? ` · ${p.osName}` : ""));
  const vram = p.gpuVramGB ? `, ${p.gpuVramGB} GB` : "";
  const disp = p.display?.width ? ` · display ${p.display.width}×${p.display.height} @ ${p.display.refreshHz} Hz` : "";
  lines.push(`- GPU: ${p.gpuName || "unknown"} (${p.gpuKind || "unknown"}${vram})${disp}`);
  const bat = p.battery?.present
    // Plugged-in state changes between sessions, so it is reported as of the
    // scan, not as the current state.
    ? `laptop (has a battery; ${p.battery.onBattery ? `on battery${p.battery.chargePercent != null ? ` at ${p.battery.chargePercent}%` : ""}` : "plugged in"} at scan time)`
    : "no battery";
  lines.push(`- Power: ${bat}${p.powerPlan ? ` · plan ${p.powerPlan}` : ""}`);
  const t = p.tools || {};
  const have = Object.keys(TOOL_PROBES).filter((k) => t[k] === true);
  // nvidia-smi missing is only news on an NVIDIA machine.
  const missing = Object.keys(TOOL_PROBES).filter((k) => t[k] === false)
    .filter((k) => k !== "nvidia-smi" || /nvidia/i.test(p.gpuName || ""));
  lines.push(`- Installed: ${have.join(", ") || "none detected"}` +
    (missing.length ? ` · not installed: ${missing.join(", ")}` : "") +
    ` · browser: ${t.browser || "none found"}`);
  lines.push(`- Omni settings here: browser GPU ${e.browserGpu ? "on" : "off"}; local models ${e.localBackend} backend, ${e.localThreads || "auto"} threads`);

  const notes = [];
  if (p.gpuKind === "integrated") notes.push("integrated GPU — keep games/WebGL scenes light; performance here is lower than on PCs with a graphics card");
  if (p.gpuKind === "software" || p.gpuKind === "unknown") notes.push("no hardware GPU detected — WebGL/canvas FPS measured here is not meaningful");
  if (e.refreshHz) notes.push(`the display refreshes at ${e.refreshHz} Hz, so FPS in a visible browser tops out there (the headless browser is not capped by it)`);
  if (p.battery?.present) notes.push("laptop — unplugged, the CPU/GPU throttle; benchmarks are only representative when plugged in");
  if (e.lowMemory) notes.push(`under ${LOW_RAM_GB} GB RAM — avoid running dev servers, local models and the browser all at once`);
  if (e.localBackend === "cpu") notes.push(`local LLMs run on CPU — prefer small quantized models (${Number(p.totalRamGB) >= 16 ? "≤ 8B" : "≤ 3B"} at Q4)`);
  if (missing.length) {
    const viaPack = missing.filter((k) => k === "ffmpeg");
    notes.push(`don't assume ${missing.join("/")} exist; tell the user to install one if the task needs it` +
      (viaPack.length ? ` (${viaPack.join(", ")}: /runtime install ${viaPack.join(" ")} adds it to Omni without admin rights)` : ""));
  }
  if (notes.length) lines.push(`- Notes: ${notes.join("; ")}.`);
  return lines.join("\n");
}
