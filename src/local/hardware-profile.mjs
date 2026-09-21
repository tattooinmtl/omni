// Detect and cache a hardware profile so /llama-start (Phase C) can pick the
// right backend (cpu vs vulkan) and thread count without re-scanning every
// boot. The full scan spawns PowerShell/nvidia-smi/dxdiag and takes 500-800ms;
// the cheap fingerprint (cores + arch + totalmem) takes <5ms and hits on 90%+
// of boots. Full scan runs only when the cheap fingerprint drifts (hardware
// changed) or the user forces it via `/hardware rescan`.
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
  return !!cached && cached.fingerprint === cheapFingerprint();
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

async function detectGpuWindows() {
  // Try nvidia-smi first — accurate on NVIDIA and returns MB directly.
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

  // WMI (AdapterRAM caps at ~4GB but always available and returns *a* card).
  const wmi = await runCapture("powershell", [
    "-NoProfile", "-Command",
    "Get-CimInstance Win32_VideoController | Select-Object -First 1 -Property Name,AdapterRAM | ConvertTo-Json -Compress",
  ]);
  let wmiName = null;
  let wmiBytes = null;
  if (wmi.ok && wmi.stdout.trim()) {
    try {
      const parsed = JSON.parse(wmi.stdout.trim());
      wmiName = parsed.Name || null;
      wmiBytes = Number.isFinite(parsed.AdapterRAM) ? parsed.AdapterRAM : null;
    } catch { /* leave nulls */ }
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
        const txt = fs.readFileSync(tmp, "utf8");
        const m = /Dedicated Memory:\s*(\d+)\s*MB/i.exec(txt);
        if (m) dxMB = parseInt(m[1], 10);
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

// ── Full scan ────────────────────────────────────────────────────────────

export async function scanHardware() {
  const logical = os.cpus().length;
  const totalRamGB = +(os.totalmem() / 1024 ** 3).toFixed(1);
  const { physical, source: coreSource } = await detectCpuCoresPhysical();

  let gpu = { name: "n/a", vramGB: 0, vramSource: "unsupported-platform" };
  if (process.platform === "win32") gpu = await detectGpuWindows();

  const recommendedBackend = gpu.vramGB >= VRAM_FLOOR_GB ? "vulkan" : "cpu";
  const notes = [];
  if (gpu.vramGB < VRAM_FLOOR_GB) {
    notes.push(`gpuVramGB=${gpu.vramGB}<${VRAM_FLOOR_GB} → recommendedBackend forced to cpu`);
  }
  if (coreSource !== "Win32_Processor" && process.platform === "win32") {
    notes.push(`cpu physical-core source: ${coreSource} (fallback)`);
  }

  return {
    scannedAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    cpuCores: physical,
    cpuThreads: logical,
    totalRamGB,
    gpuName: gpu.name,
    gpuVramGB: gpu.vramGB,
    gpuVramSource: gpu.vramSource,
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
