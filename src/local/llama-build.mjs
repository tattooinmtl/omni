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
// is missing or does not answer.
export function installedBuild(exePath) {
  if (!exePath || !fs.existsSync(exePath)) return null;
  const r = spawnSync(exePath, ["--version"], {
    cwd: path.dirname(exePath),
    encoding: "utf8",
    windowsHide: true,
    timeout: 20000,
  });
  return parseBuildVersion(`${r.stdout || ""}\n${r.stderr || ""}`);
}

const platformKey = () => `${process.platform}-${process.arch}`;
export function pinnedAsset(key = platformKey()) {
  return LLAMA_BUILD.builds[key] || null;
}

// Download, verify, stage, prove, swap. `binDir` is the folder Omni spawns
// llama-server from. Returns { from, to, binDir, backup }.
export async function installPinnedBuild(binDir, { onProgress, onStep, fetchImpl, key, probe = installedBuild } = {}) {
  const asset = pinnedAsset(key);
  if (!asset) {
    throw new Error(
      `no pinned llama.cpp build for ${key || platformKey()} — download one from https://github.com/ggml-org/llama.cpp/releases and set llama.binDir`
    );
  }
  const exeName = process.platform === "win32" || (key || "").startsWith("win32") ? "llama-server.exe" : "llama-server";
  const from = probe(path.join(binDir, exeName));

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `omni-llama-${LLAMA_BUILD.tag}-`));
  const zip = path.join(tmp, path.basename(new URL(asset.url).pathname));
  const staged = `${binDir}.new`;
  const backup = `${binDir}.old`;
  try {
    onStep?.(`downloading ${LLAMA_BUILD.tag} (${(asset.size / 1048576).toFixed(1)} MB)`);
    await downloadVerified(asset.url, zip, asset.sha256, { onProgress, fetchImpl, maxBytes: asset.size });

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
    return { from, to, binDir, backup: hadOld ? backup : null };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(staged, { recursive: true, force: true });
  }
}
