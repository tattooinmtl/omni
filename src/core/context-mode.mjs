// contextMode helpers — one place to resolve/persist the "classic" vs "lean"
// switch and to hold the session-scoped state files (state.json, metrics.jsonl,
// tool-body cache) that lean mode writes to agent/sessions/<sessionId>/.
//
// The mode is read project-first (an omni.config.json at cwd), falling back
// to the global settings.contextMode. This lets a solo dev A/B lean on one
// repo while classic is still the default everywhere else — the flip is a
// per-project decision, not a global one.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { HOME, SESSIONS_DIR } from "./config.mjs";

const CWD_CONFIG = () => path.join(process.cwd(), "omni.config.json");

// Read the current mode. Project cwd wins over global settings — the whole
// point of a per-project flag is that it works without touching settings.json.
export function readContextMode(settings) {
  try {
    const raw = fs.readFileSync(CWD_CONFIG(), "utf8");
    const cfg = JSON.parse(raw);
    if (cfg && typeof cfg.contextMode === "string") return cfg.contextMode;
  } catch { /* no project config or unreadable — fall through */ }
  const g = settings?.contextMode;
  return g === "lean" ? "lean" : "classic";
}

// Persist the mode into the project's omni.config.json (creating the file
// if missing). The global settings copy is left alone — that's just the
// fallback default. Returns the effective mode written.
export function writeProjectContextMode(mode) {
  const file = CWD_CONFIG();
  let current = {};
  try { current = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* start from empty */ }
  current.contextMode = mode === "lean" ? "lean" : "classic";
  fs.writeFileSync(file, JSON.stringify(current, null, 2) + "\n", "utf8");
  return current.contextMode;
}

// Session state directory — mirrors Session.file's naming ("<ts>.jsonl"
// under sessions/<cwd-slug>/). We derive the sessionId from the session
// file basename so state.json/metrics.jsonl land next to it.
export function sessionStateDir(session) {
  if (!session?.file) return null;
  const dir = path.join(path.dirname(session.file), path.basename(session.file, ".jsonl"));
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* best-effort */ }
  return dir;
}

// Same slug shape as agent/rag/--C-...--.json — a stable per-project identifier
// atoms tag themselves with so currentAtoms() can filter to just this project's
// memory. Empty string means "no project scope" (kept for tests / non-cwd use).
export function projectSlug() {
  try {
    return "--" + process.cwd().replace(/[:\\/]+/g, "-").replace(/^-+|-+$/g, "") + "--";
  } catch {
    return "";
  }
}

// Append one metrics record per provider response. Best-effort: a broken
// disk should never take the turn down — the metrics are for the user's own
// A/B comparison, not for correctness.
export function appendMetrics(session, record) {
  const dir = sessionStateDir(session);
  if (!dir) return;
  try {
    fs.appendFileSync(path.join(dir, "metrics.jsonl"), JSON.stringify({ ts: new Date().toISOString(), ...record }) + "\n");
  } catch { /* silent */ }
}

// Write the compact per-turn state.json — enough for /compare-personality and
// the next launch to know what this session was working on without re-reading
// the whole JSONL log.
export function writeState(session, state) {
  const dir = sessionStateDir(session);
  if (!dir) return;
  try {
    fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(state, null, 2), "utf8");
  } catch { /* silent */ }
}

// Full path + hash for an offloaded tool body. Lean mode shrinks old tool
// results in the outbound provider payload but keeps the full text on disk
// so `/expand <hash>` can re-inject it as a fresh user message.
export function toolBodyPath(session, hash) {
  const dir = sessionStateDir(session);
  if (!dir) return null;
  return path.join(dir, `tool-${hash}.txt`);
}

export function hashToolBody(text) {
  return crypto.createHash("sha256").update(String(text || "")).digest("hex").slice(0, 12);
}

// Read the tail of metrics.jsonl for /compare-personality. Returns [] on
// any failure — callers should treat missing metrics as "no data yet".
export function readMetrics(session) {
  const dir = sessionStateDir(session);
  if (!dir) return [];
  try {
    return fs.readFileSync(path.join(dir, "metrics.jsonl"), "utf8")
      .split(/\r?\n/).filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}
