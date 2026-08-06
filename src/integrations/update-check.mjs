// Lightweight, non-blocking "is a newer version available" notice — same
// idea as npm/gh/deno's startup check, but the notice itself never costs a
// network round trip: updateNotice() reads only a small on-disk cache, so
// it's instant and safe to call synchronously at startup. The cache is
// refreshed in the BACKGROUND (fire-and-forget, silent on any failure) once
// a day, for the *next* launch to read — this launch is never delayed by it.

import fs from "node:fs";
import path from "node:path";
import { HOME } from "../core/config.mjs";
import { INSTALL_ROOT } from "../paths.mjs";

const CACHE_PATH = path.join(HOME, "update-check.json");
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // once a day
const FETCH_TIMEOUT_MS = 3000;
const PKG_URL = "https://raw.githubusercontent.com/tattooinmtl/omni/main/package.json";

function readCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_PATH, "utf8")); } catch { return {}; }
}

function writeCache(data) {
  try {
    fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(data));
  } catch { /* best-effort — caching itself must never affect startup */ }
}

export function currentVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(INSTALL_ROOT, "package.json"), "utf8")).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// Simple numeric semver compare — good enough for "x.y.z", tolerant of
// missing/non-numeric segments rather than throwing on an odd version string.
export function isNewer(candidate, base) {
  const a = String(candidate || "").split(".").map((n) => parseInt(n, 10) || 0);
  const b = String(base || "").split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0, y = b[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

// Cache-only, synchronous, instant — call this freely at startup.
export function updateNotice() {
  const cache = readCache();
  if (!cache.latestKnownVersion) return "";
  const current = currentVersion();
  if (!isNewer(cache.latestKnownVersion, current)) return "";
  return `update available: v${current} → v${cache.latestKnownVersion} — re-run the installer to upgrade (see README)`;
}

// Fire-and-forget: only actually hits the network when the cache is stale
// (or missing), and never throws or blocks the caller — offline, a GitHub
// outage, or a slow connection just means "try again next time".
export function refreshUpdateCacheInBackground() {
  const cache = readCache();
  const age = Date.now() - (cache.lastCheckedAt || 0);
  if (age < CHECK_INTERVAL_MS) return;
  (async () => {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      const res = await fetch(PKG_URL, { signal: controller.signal, headers: { "User-Agent": "omni-update-check" } });
      clearTimeout(timer);
      if (!res.ok) return;
      const pkg = await res.json();
      if (pkg?.version) writeCache({ lastCheckedAt: Date.now(), latestKnownVersion: pkg.version });
    } catch { /* offline / timeout / GitHub down — silently skip */ }
  })();
}
