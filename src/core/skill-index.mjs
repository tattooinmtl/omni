// External skill index — makes skills discovered by an out-of-tree scanner
// reachable from find_skill / invoke_skill.
//
// The scan-now hook (hooks/scan-now.json) runs on SessionStart and writes an
// index of every SKILL.md it found — by default under C:/.skills/skills, or
// under any folder the user points it at with `--root <dir>`. Until now
// nothing read that file: the hook indexed hundreds of skills each session
// and Omni could not see a single one, because loadSkills() only walks
// <INSTALL_ROOT>/skills.
//
// This module closes that loop. Bundled skills still win on a name collision
// — they are version-controlled with the install and can't drift — and an
// external skill is always labelled as such in find_skill output so it is
// obvious where a body is about to come from.
//
// Index shape (written by scan-now.js):
//   { source, generatedAt, count, entries: [{ name, path }],
//     nestedCount, nested: [{ id, name, path, parentPack, depth }] }

import fs from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "./frontmatter.mjs";

// Reading N SKILL.md frontmatters costs N small reads. Do it once per
// process, lazily — a session that never calls find_skill pays nothing.
let _cache = null;
let _cacheKey = null;

// Test hook: forget the cached index so the next load re-reads from disk.
export function _resetCache() { _cache = null; _cacheKey = null; }

// Opt-in only: the index path must come from omni.config.json `skillIndex`.
// Deliberately NOT defaulted to the scanner's usual C:/.skills/skills.json —
// a machine-specific absolute path baked into source would mean any caller
// without project config (a sub-agent, a test, a fresh clone on another OS)
// silently picks up whatever that machine happens to have indexed. The
// default lives in omni.config.json, where a machine-specific path belongs.
export function skillIndexPath(config) {
  const configured = config?.skillIndex;
  return typeof configured === "string" && configured.trim() ? configured.trim() : null;
}

function readIndexFile(indexPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(indexPath, "utf8"));
    const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
    const nested = Array.isArray(parsed?.nested) ? parsed.nested : [];
    return { entries: [...entries, ...nested], generatedAt: parsed?.generatedAt || null, source: parsed?.source || null };
  } catch {
    // Missing or malformed index is the normal case on a machine where the
    // scanner was never installed — stay silent, return nothing.
    return null;
  }
}

// Read one scanned skill's SKILL.md and shape it like a loadSkills() entry.
// Returns null when the file is gone (index is a snapshot; folders move).
function hydrate(entry) {
  const dir = String(entry?.path || "");
  if (!dir) return null;
  const file = path.join(dir, "SKILL.md");
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); } catch { return null; }
  const { meta, body } = parseFrontmatter(raw);
  const name = meta.name || entry.name || path.basename(dir);
  return {
    name,
    // Namespaced so an external skill can never be confused with, or shadow,
    // a bundled one at the call site.
    command: "/" + name,
    description: meta.description || "",
    category: entry.parentPack ? `External · ${entry.parentPack}` : "External",
    external: true,
    path: file,
    body,
  };
}

// Load every skill named by the index. Bundled skills passed in as
// `bundled` win on a name collision and are excluded from the result.
export function loadScannedSkills(config, bundled = []) {
  const indexPath = skillIndexPath(config);
  if (!indexPath) return [];
  const key = indexPath;
  if (_cache && _cacheKey === key) return _cache;

  const index = readIndexFile(indexPath);
  if (!index) { _cache = []; _cacheKey = key; return _cache; }

  const taken = new Set(bundled.map((s) => String(s.command || "").toLowerCase()));
  const out = [];
  const seen = new Set();
  for (const entry of index.entries) {
    const skill = hydrate(entry);
    if (!skill) continue;
    const cmd = skill.command.toLowerCase();
    if (taken.has(cmd) || seen.has(cmd)) continue; // bundled wins; dedupe nested vs top-level
    seen.add(cmd);
    out.push(skill);
  }
  _cache = out;
  _cacheKey = key;
  return out;
}

// Count without hydrating bodies — for a cheap status line.
export function scannedSkillCount(config) {
  const indexPath = skillIndexPath(config);
  if (!indexPath) return 0;
  const index = readIndexFile(indexPath);
  return index ? index.entries.length : 0;
}
