// Whole-PC name search — the one tool that may look outside the workspace.
//
// Every other file tool is confined to the workspace folder (see
// assertInsideWorkspace in tools/index.mjs). That left Omni unable to answer
// "where is my X project?" when X lived anywhere else. This tool closes that
// gap without widening anything else: it walks every drive (or the roots the
// caller names) and returns the *paths* whose file or folder name matches.
//
// What it can't do, by construction:
//   - read file contents (it only calls readdir, never open/read)
//   - write, move, delete or create anything
//   - run a process or a shell
// So it is safe to allow in every permission mode, plan mode included, and
// the /search command calls it directly with no model in the loop.
//
// The walk is breadth-first (shallow hits — usually the project folder
// itself — come first), never follows symlinks or junctions (no loops, no
// escaping into odd places), skips OS and package-cache folders that are huge
// and never hold a user's project, and stops at a result cap and a time
// budget so a full-disk sweep can't hang a turn.

import fs from "node:fs";
import path from "node:path";

export const DEFAULT_MAX_RESULTS = 50;
export const MAX_RESULTS_CAP = 500;
export const DEFAULT_TIME_LIMIT_S = 60;
export const TIME_LIMIT_CAP_S = 300;

// Folder names never descended into unless the caller asks (include_system).
// Lowercase; compared case-insensitively.
const SKIP_DIRS = new Set([
  "windows", "$recycle.bin", "system volume information", "$windows.~bt", "$windows.~ws",
  "programdata", "recovery", "config.msi", "msocache", "perflogs",
  "appdata", "node_modules", ".git", ".svn", ".hg", "__pycache__", ".cache",
  "_cacache", "winsxs",
]);
// Virtual filesystems, skipped only directly under "/" (a user's own
// C:\Users\me\dev folder must still be searched).
const SKIP_AT_UNIX_ROOT = new Set(["proc", "sys", "dev", "run"]);

// Every drive letter that is mounted, or "/" off Windows.
export function listDrives() {
  if (process.platform !== "win32") return ["/"];
  const out = [];
  for (let i = 67; i <= 90; i++) { // C..Z; A/B are floppy letters that can stall
    const root = String.fromCharCode(i) + ":\\";
    try { fs.accessSync(root); out.push(root); } catch { /* not mounted */ }
  }
  return out;
}

function isSkipped(parent, name) {
  const lower = name.toLowerCase();
  if (SKIP_DIRS.has(lower)) return true;
  return parent === "/" && SKIP_AT_UNIX_ROOT.has(lower);
}

function globToRegex(glob) {
  const src = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${src}$`, "i");
}

// "flywire|drosophila" → match either term. A term with * or ? is a glob on
// the whole name; otherwise it is a case-insensitive substring.
export function buildMatcher(query) {
  const terms = String(query || "").split("|").map((t) => t.trim()).filter(Boolean);
  if (!terms.length) throw new Error("search_pc: query is empty");
  const tests = terms.map((t) => {
    if (/[*?]/.test(t)) {
      const re = globToRegex(t);
      return (name) => re.test(name);
    }
    const needle = t.toLowerCase();
    return (name) => name.toLowerCase().includes(needle);
  });
  return (name) => tests.some((fn) => fn(name));
}

function clampInt(v, def, min, max) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

/**
 * Search the PC for files/folders by name.
 * @returns {Promise<{matches: {path: string, type: "dir"|"file"}[], scanned: number,
 *   truncated: boolean, timedOut: boolean, roots: string[]}>}
 */
export async function searchPc({
  query, roots, kind = "any", max_results, time_limit_s, include_system = false,
} = {}) {
  const matches = buildMatcher(query);
  const max = clampInt(max_results, DEFAULT_MAX_RESULTS, 1, MAX_RESULTS_CAP);
  const budgetMs = clampInt(time_limit_s, DEFAULT_TIME_LIMIT_S, 1, TIME_LIMIT_CAP_S) * 1000;
  const want = kind === "file" || kind === "dir" ? kind : "any";

  let rootList = Array.isArray(roots) ? roots : roots ? [roots] : [];
  rootList = rootList.map((r) => String(r)).filter(Boolean);
  for (const r of rootList) {
    if (!path.isAbsolute(r)) throw new Error(`search_pc: root must be an absolute path: ${r}`);
  }
  if (!rootList.length) rootList = listDrives();
  rootList = rootList.map((r) => path.resolve(r));

  const deadline = Date.now() + budgetMs;
  const found = [];
  let scanned = 0;
  let timedOut = false;
  let queue = [...rootList];

  outer:
  while (queue.length) {
    const next = [];
    for (const dir of queue) {
      if (Date.now() > deadline) { timedOut = true; break outer; }
      let entries;
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        continue; // access denied, vanished, not a dir — just skip
      }
      scanned++;
      for (const e of entries) {
        if (e.isSymbolicLink()) continue; // never follow links/junctions
        const isDir = e.isDirectory();
        const full = path.join(dir, e.name);
        if ((want === "any" || (want === "dir") === isDir) && matches(e.name)) {
          found.push({ path: full, type: isDir ? "dir" : "file" });
          if (found.length >= max) break outer;
        }
        if (isDir && (include_system || !isSkipped(dir, e.name))) next.push(full);
      }
    }
    queue = next;
  }

  return {
    matches: found,
    scanned,
    truncated: found.length >= max,
    timedOut,
    roots: rootList,
  };
}

export function formatPcSearch(query, r) {
  const lines = [];
  if (!r.matches.length) {
    lines.push(`No file or folder named like "${query}" found (${r.scanned} folders scanned in ${r.roots.join(", ")}).`);
  } else {
    lines.push(`${r.matches.length} match${r.matches.length === 1 ? "" : "es"} for "${query}":`);
    for (const m of r.matches) lines.push(`${m.type === "dir" ? "[dir] " : "      "}${m.path}`);
  }
  if (r.truncated) lines.push(`(stopped at ${r.matches.length} results — narrow the query or raise max_results)`);
  if (r.timedOut) lines.push(`(time limit reached after ${r.scanned} folders — results may be incomplete; pass roots or a longer time_limit_s)`);
  return lines.join("\n");
}
