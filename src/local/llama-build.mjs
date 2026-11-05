// The llama.cpp build Omni runs, pinned to one release and verified.
//
// `/llama update` downloads the pinned Windows CPU build from the official
// ggml-org/llama.cpp release, checks it against the SHA-256 GitHub publishes
// for that asset, unpacks it next to the current server folder, proves the
// new llama-server.exe runs and reports the expected build, and only then
// swaps it in. The previous folder is kept as `<binDir>.old` for rollback.
//
// Nothing downloads on its own: the user runs `/llama update`.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { downloadVerified, extractZip } from "./runtime-pack.mjs";

// b12125 (2026-11-05). Spark X2.6 (arch spark2_5) needs b10828 or later; the
// b8996 that older installs carry refuses to load it.
export const LLAMA_BUILD = {
  build: 12125,
  tag: "b12125",
  builds: {
    "win32-x64": {
      url: "https://github.com/ggml-org/llama.cpp/releases/download/b12125/llama-b12125-bin-win-cpu-x64.zip",
      sha256: "968091ccb8c230e0cf7e0eed386310703bebae4a4fd4375f0c57db53958307d8",
      size: 24730921,
    },
  },
};

// Oldest build that can run the official model (see model-profiles.mjs).
export const MIN_BUILD_FOR_SPARK = 10828;

// Parse the build number out of `llama-server --version`. Two shapes exist:
//   new: "version: 0.9.0-dev (build 12125, commit 7d516e25e)"
//   old: "version: 8996 (c3c150539)"
export function parseBuildVersion(text) {
  const s = String(text || "");
  const m = s.match(/\(build\s+(\d+)/i) || s.match(/version:\s*(\d+)\b/i);
  return m ? Number(m[1]) : null;
}

// Ask a llama-server binary which build it is. Returns null when the binary
// is missing or does not answer. The first run of a freshly unpacked exe can
// stall while antivirus scans it (seen: one /llama update probe got no answer
// at all, the retry took 2.9 s), so allow a long timeout and try twice.
export function installedBuild(exePath, { attempts = 2, timeout = 60000, run = spawnSync } = {}) {
  if (!exePath || !fs.existsSync(exePath)) return null;
  for (let i = 0; i < attempts; i++) {
    const r = run(exePath, ["--version"], {
      cwd: path.dirname(exePath),
      encoding: "utf8",
      windowsHide: true,
      timeout,
    });
    const build = parseBuildVersion(`${r.stdout || ""}\n${r.stderr || ""}`);
    if (build !== null) return build;
  }
  return null;
}

const platformKey = () => `${process.platform}-${process.arch}`;
export function pinnedAsset(key = platformKey()) {
  return LLAMA_BUILD.builds[key] || null;
}

// The swap renames binDir → binDir.old, then binDir.new → binDir. If the
// process dies between the two, binDir is missing and .old holds the last
// good build: put it back. Called before every update and every server start.
export function recoverInterruptedUpdate(binDir) {
  const backup = `${binDir}.old`;
  if (!fs.existsSync(binDir) && fs.existsSync(backup)) {
    fs.renameSync(backup, binDir);
    return true;
  }
  return false;
}

// One update per server folder at a time: both would share .new and .old.
// A lock older than 30 minutes is a leftover from a crashed update.
function takeLock(binDir) {
  const lock = `${binDir}.update.lock`;
  try {
    if (Date.now() - fs.statSync(lock).mtimeMs > 30 * 60 * 1000) fs.rmSync(lock, { force: true });
  } catch { /* no lock */ }
  try {
    fs.closeSync(fs.openSync(lock, "wx"));
  } catch (e) {
    if (e.code === "EEXIST") throw new Error(`another llama.cpp update is already running for ${binDir} (lock: ${lock})`);
    throw e;
  }
  return () => fs.rmSync(lock, { force: true });
}

// A stalled connection must not leave /llama update hanging forever; the
// signal also bounds the body stream.
export const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

// Download, verify, stage, prove, swap. `binDir` is the folder Omni spawns
// llama-server from. Returns { from, to, binDir, backup, leftBehind }, where
// leftBehind lists split backend binaries (llama-server-vulkan.exe …) the CPU
// archive doesn't carry: they stay in the backup, since they link against the
// old build's DLLs and would break next to the new ones.
export async function installPinnedBuild(binDir, { onProgress, onStep, fetchImpl = fetch, key, probe = installedBuild, timeoutMs = DOWNLOAD_TIMEOUT_MS } = {}) {
  const asset = pinnedAsset(key);
  if (!asset) {
    throw new Error(
      `no pinned llama.cpp build for ${key || platformKey()} — download one from https://github.com/ggml-org/llama.cpp/releases and set llama.binDir`
    );
  }
  const release = takeLock(binDir);
  try {
    recoverInterruptedUpdate(binDir);
    return await installLocked(binDir, asset, { onProgress, onStep, fetchImpl, key, probe, timeoutMs });
  } finally {
    release();
  }
}

async function installLocked(binDir, asset, { onProgress, onStep, fetchImpl, key, probe, timeoutMs }) {
  const exeName = process.platform === "win32" || (key || "").startsWith("win32") ? "llama-server.exe" : "llama-server";
  const from = probe(path.join(binDir, exeName));

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `omni-llama-${LLAMA_BUILD.tag}-`));
  const zip = path.join(tmp, path.basename(new URL(asset.url).pathname));
  const staged = `${binDir}.new`;
  const backup = `${binDir}.old`;
  const timedFetch = (url, opts = {}) => fetchImpl(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
  try {
    onStep?.(`downloading ${LLAMA_BUILD.tag} (${(asset.size / 1048576).toFixed(1)} MB)`);
    try {
      await downloadVerified(asset.url, zip, asset.sha256, { onProgress, fetchImpl: timedFetch, maxBytes: asset.size });
    } catch (e) {
      if (e.name === "TimeoutError" || e.name === "AbortError") {
        throw new Error(`the download stalled and was stopped after ${Math.round(timeoutMs / 60000)} min; nothing was installed — run /llama update again`);
      }
      throw e;
    }

    onStep?.("checksum ok — unpacking");
    fs.rmSync(staged, { recursive: true, force: true });
    extractZip(zip, staged);
    const stagedExe = path.join(staged, exeName);
    if (!fs.existsSync(stagedExe)) throw new Error(`the archive has no ${exeName}; nothing was installed`);

    const to = probe(stagedExe);
    if (to !== LLAMA_BUILD.build) {
      throw new Error(`the new ${exeName} reports build ${to ?? "?"} instead of ${LLAMA_BUILD.build}; nothing was installed`);
    }

    onStep?.("swapping it in");
    fs.rmSync(backup, { recursive: true, force: true });
    const hadOld = fs.existsSync(binDir);
    if (hadOld) fs.renameSync(binDir, backup);
    try {
      fs.renameSync(staged, binDir);
    } catch (e) {
      if (hadOld) fs.renameSync(backup, binDir); // roll back
      throw e;
    }
    const leftBehind = hadOld
      ? fs.readdirSync(backup).filter((f) => /^llama-server-.+\.exe$|^llama-server-[^.]+$/i.test(f) && !fs.existsSync(path.join(binDir, f)))
      : [];
    return { from, to, binDir, backup: hadOld ? backup : null, leftBehind };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(staged, { recursive: true, force: true });
  }
}
