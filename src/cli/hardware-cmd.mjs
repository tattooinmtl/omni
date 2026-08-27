// /hardware — inspect the cached hardware profile (see hardware-profile.mjs).
// `/hardware`         → show current profile (from cache if fresh, else scan)
// `/hardware rescan`  → force a full re-scan (use after swapping a GPU)
// `/hardware clear`   → delete the cache (next boot will rescan)

import fs from "node:fs";
import { c, infoLine, warnLine } from "../ui.mjs";
import {
  ensureHardwareProfile,
  readCachedProfile,
  isCacheFresh,
  PROFILE_PATH,
} from "../local/hardware-profile.mjs";

function printProfile(p, { stale = false } = {}) {
  const label = stale ? c.dim("(stale cache — hardware fingerprint changed)") : "";
  infoLine(`hardware profile ${label}`);
  console.log(`    scanned:  ${c.dim(p.scannedAt)}`);
  console.log(`    platform: ${p.platform} ${p.arch}`);
  console.log(`    cpu:      ${p.cpuCores} physical / ${p.cpuThreads} logical  (recommend -t ${p.recommendedThreads})`);
  console.log(`    ram:      ${p.totalRamGB} GB`);
  console.log(`    gpu:      ${p.gpuName}  ${p.gpuVramGB} GB  ${c.dim(`(via ${p.gpuVramSource})`)}`);
  console.log(`    backend:  ${c.bright(p.recommendedBackend)}  ${c.dim(`(pass to /llama-start; --force overrides)`)}`);
  if (Array.isArray(p.notes) && p.notes.length) {
    for (const n of p.notes) console.log(`    note:     ${c.dim(n)}`);
  }
  console.log(`    cache:    ${c.dim(PROFILE_PATH)}`);
}

export async function hardwareCommand(_ctx, sub) {
  const action = (sub || "").trim().toLowerCase();

  if (action === "clear") {
    try {
      fs.unlinkSync(PROFILE_PATH);
      infoLine(`removed ${PROFILE_PATH}`);
    } catch (err) {
      if (err && err.code === "ENOENT") infoLine("no cached profile to remove");
      else warnLine(`could not remove cache: ${err.message}`);
    }
    return;
  }

  if (action === "rescan" || action === "refresh") {
    infoLine("re-scanning hardware (may take up to a second)…");
    const p = await ensureHardwareProfile({ force: true });
    printProfile(p);
    return;
  }

  const cached = readCachedProfile();
  if (cached && isCacheFresh(cached)) {
    printProfile(cached);
    return;
  }

  if (cached) {
    // Cache exists but fingerprint drifted — show what we have, then refresh.
    printProfile(cached, { stale: true });
    infoLine("fingerprint drift detected — refreshing…");
  } else {
    infoLine("no cached profile yet — scanning…");
  }
  const p = await ensureHardwareProfile();
  printProfile(p);
}
