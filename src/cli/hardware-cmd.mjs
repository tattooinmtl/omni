// /hardware — inspect the cached hardware profile (see hardware-profile.mjs).
// `/hardware`                     → show the machine and the settings Omni chose for it
// `/hardware rescan`              → force a full re-scan (use after swapping a GPU)
// `/hardware clear`               → delete the cache (next boot will rescan)
// `/hardware set <setting> <value|auto>` → override one automatic choice

import fs from "node:fs";
import { c, infoLine, warnLine } from "../ui.mjs";
import { saveSettings } from "../core/config.mjs";
import {
  ensureHardwareProfile,
  readCachedProfile,
  isCacheFresh,
  deriveSettings,
  applyMachineEnv,
  HARDWARE_SETTINGS,
  PROFILE_PATH,
} from "../local/hardware-profile.mjs";

function printProfile(p, overrides, { stale = false } = {}) {
  const label = stale ? c.dim("(stale cache — hardware or Omni version changed)") : "";
  infoLine(`hardware profile ${label}`);
  console.log(`    scanned:  ${c.dim(p.scannedAt)}`);
  console.log(`    platform: ${p.osName || p.platform} ${p.arch}`);
  console.log(`    cpu:      ${p.cpuName ? p.cpuName + " — " : ""}${p.cpuCores} physical / ${p.cpuThreads} logical`);
  console.log(`    ram:      ${p.totalRamGB} GB${p.freeDiskGB != null ? `   disk free: ${p.freeDiskGB} GB` : ""}`);
  console.log(`    gpu:      ${p.gpuName}  ${p.gpuVramGB} GB  ${c.dim(`(${p.gpuKind || "unknown"}, via ${p.gpuVramSource})`)}`);
  if (p.display?.width) console.log(`    display:  ${p.display.width}×${p.display.height} @ ${p.display.refreshHz} Hz`);
  if (p.battery) {
    const b = p.battery.present ? (p.battery.onBattery ? `on battery (${p.battery.chargePercent ?? "?"}%)` : "plugged in") : "no battery";
    console.log(`    power:    ${b}${p.powerPlan ? `   plan: ${p.powerPlan}` : ""}`);
  }
  if (p.tools) {
    const t = Object.entries(p.tools).filter(([k]) => k !== "browser")
      .map(([k, v]) => (v ? c.green(k) : c.dim(`no ${k}`))).join("  ");
    console.log(`    tools:    ${t}  ${p.tools.browser ? c.green(p.tools.browser) : c.dim("no browser")}`);
  }

  const eff = deriveSettings(p, overrides);
  infoLine("settings for this PC");
  for (const d of eff.decisions) {
    const src = d.auto ? c.dim("auto") : c.bold("set");
    console.log(`    ${d.label.padEnd(20)} ${c.bold(d.value.padEnd(7))} ${src}  ${c.dim(d.why)}`);
  }
  console.log(`    ${"local-model threads".padEnd(20)} ${c.bold(String(eff.localThreads || "auto").padEnd(7))} ${c.dim("auto")}  ${c.dim("physical cores")}`);
  console.log(`    ${"video tools".padEnd(20)} ${c.bold((eff.videoTools ? "on" : "off").padEnd(7))} ${c.dim("auto")}  ${c.dim(eff.videoTools ? "ffmpeg found" : "install ffmpeg to enable")}`);
  console.log(c.dim(`    change one: /hardware set <${Object.keys(HARDWARE_SETTINGS).join("|")}> <value|auto>`));
  if (Array.isArray(p.notes) && p.notes.length) {
    for (const n of p.notes) console.log(`    note:     ${c.dim(n)}`);
  }
  console.log(`    cache:    ${c.dim(PROFILE_PATH)}`);
}

async function setOverride(ctx, key, value) {
  const name = Object.keys(HARDWARE_SETTINGS).find((k) => k.toLowerCase() === String(key || "").toLowerCase());
  if (!name) {
    warnLine(`unknown setting "${key || ""}" — one of: ${Object.keys(HARDWARE_SETTINGS).join(", ")}`);
    return;
  }
  const v = String(value || "").toLowerCase();
  const allowed = [...HARDWARE_SETTINGS[name].values, "auto"];
  if (!allowed.includes(v)) {
    warnLine(`${name} takes one of: ${allowed.join(", ")}`);
    return;
  }
  const settings = ctx.settings;
  const hw = { ...(settings.hardware || {}) };
  if (v === "auto") delete hw[name];
  else hw[name] = v;
  if (Object.keys(hw).length) settings.hardware = hw;
  else delete settings.hardware;
  await saveSettings(settings);

  const profile = readCachedProfile();
  if (profile) applyMachineEnv(deriveSettings(profile, settings.hardware));
  infoLine(`${HARDWARE_SETTINGS[name].label}: ${v === "auto" ? "back to automatic" : v}`);
  if (name === "browserGpu") infoLine(c.dim("takes effect the next time the browser starts (browser_close or /browser close)"));
}

export async function hardwareCommand(ctx, sub) {
  const parts = String(sub || "").trim().split(/\s+/).filter(Boolean);
  const action = (parts[0] || "").toLowerCase();
  const overrides = ctx?.settings?.hardware;

  if (action === "set") {
    await setOverride(ctx, parts[1], parts[2]);
    return;
  }

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
    infoLine("re-scanning hardware (a few seconds)…");
    const p = await ensureHardwareProfile({ force: true });
    printProfile(p, overrides);
    return;
  }

  const cached = readCachedProfile();
  if (cached && isCacheFresh(cached)) {
    printProfile(cached, overrides);
    return;
  }

  if (cached) {
    // Cache exists but is stale — show what we have, then refresh.
    printProfile(cached, overrides, { stale: true });
    infoLine("profile is stale — refreshing…");
  } else {
    infoLine("no cached profile yet — scanning…");
  }
  const p = await ensureHardwareProfile();
  printProfile(p, overrides);
}
