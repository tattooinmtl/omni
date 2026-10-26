// Project instruction files — OMNI.md, with AGENTS.md and CLAUDE.md read too
// so a repo already set up for another agent works unchanged.
//
// Where they come from, outermost first (a deeper file wins where they
// disagree, so it is rendered last):
//   1. <HOME>/OMNI.md                 personal rules for every project
//   2. every folder from the repo root (the nearest parent holding .git) down
//      to the cwd. Outside a repo, only the cwd itself.
// Per folder the first of OMNI.md, AGENTS.md, CLAUDE.md wins. Repos commonly
// keep a one-line CLAUDE.md that points at AGENTS.md, so reading all three
// would just repeat the same rules.
//
// A line that is only `@some/path.md` pulls that file in at that point
// (relative to the file doing the import, `~/` for the user's home), up to
// three levels deep, each file once.
//
// These files become system-prompt text, so a repo you just cloned must not
// get to write it. The project's files load only once its folder is trusted
// (/workspace trust), the same rule as project hooks. An import stays inside
// the project (the personal file: inside your home folder), must be a .md or
// .txt file, and never a secrets file such as .env, so an instruction file
// can't pull your keys into the prompt.
//
// The rendered block sits inside the system prompt's session-context block
// between its own marker, so the per-turn persona swap carries it and
// /instructions reload can swap it in place.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HOME } from "./config.mjs";
import { isFolderTrusted } from "./workspace.mjs";
import { looksLikeSecretFile } from "./secret-files.mjs";

export const INSTRUCTION_NAMES = ["OMNI.md", "AGENTS.md", "CLAUDE.md"];
export const INSTRUCTIONS_START = "<!-- omni:instructions:start -->";
export const INSTRUCTIONS_END = "<!-- omni:instructions:end -->";
const INSTRUCTIONS_RE = /<!-- omni:instructions:start -->[\s\S]*?<!-- omni:instructions:end -->/;

// One file can't crowd out everything else, and all of them together stay a
// small slice of even a 32K-token window.
export const MAX_FILE_CHARS = 20000;
export const MAX_TOTAL_CHARS = 40000;
const MAX_IMPORT_DEPTH = 3;
const IMPORTABLE_EXT = new Set([".md", ".markdown", ".txt"]);
export const UNTRUSTED_NOTE = "not loaded: this folder is not trusted (/workspace trust)";

// Nearest folder at or above `cwd` holding a .git entry (a folder in a normal
// checkout, a file in a worktree or submodule). null outside any repo.
export function findProjectRoot(cwd = process.cwd()) {
  let dir = path.resolve(cwd);
  for (;;) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Folders whose instruction file applies, outermost first.
export function instructionDirs(cwd = process.cwd()) {
  const here = path.resolve(cwd);
  const root = findProjectRoot(here);
  if (!root) return [here];
  const dirs = [];
  let dir = here;
  for (;;) {
    dirs.unshift(dir);
    if (dir === root) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirs;
}

function firstInstructionFile(dir) {
  for (const name of INSTRUCTION_NAMES) {
    const p = path.join(dir, name);
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch { /* not here */ }
  }
  return null;
}

function clipText(text, max) {
  return text.length > max ? text.slice(0, max) + `\n…[truncated at ${max} chars]` : text;
}

function realOrResolved(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

// Why an import may not be read, or "" when it may. `scope.root` is the
// folder imports must stay inside (real paths, so a symlink can't step out);
// `scope.home` allows `~/` paths, which only the personal file gets.
function importRefusal(spec, target, scope) {
  if (spec.startsWith("~/") && !scope.home) return "outside the project";
  if (!isInside(realOrResolved(target), scope.root)) return scope.home ? "outside your home folder" : "outside the project";
  if (looksLikeSecretFile(target)) return "looks like a secrets file";
  if (!IMPORTABLE_EXT.has(path.extname(target).toLowerCase())) return "only .md and .txt files can be imported";
  return "";
}

// Read a file and splice in its @imports. `seen` holds resolved paths already
// included anywhere in this load, so a cycle or a shared import is read once.
function readWithImports(file, seen, scope, depth = 0) {
  const resolved = path.resolve(file);
  if (seen.has(resolved.toLowerCase())) return "";
  seen.add(resolved.toLowerCase());
  let text;
  try {
    text = fs.readFileSync(resolved, "utf8").replace(/^﻿/, "");
  } catch (e) {
    return `(could not read ${resolved}: ${e.code || e.message})`;
  }
  text = clipText(text, MAX_FILE_CHARS);
  const out = [];
  let inFence = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const m = !inFence && /^\s*@(\S+)\s*$/.exec(line);
    if (!m) { out.push(line); continue; }
    if (depth >= MAX_IMPORT_DEPTH) {
      out.push(`(import ${m[1]} skipped: more than ${MAX_IMPORT_DEPTH} levels deep)`);
      continue;
    }
    const target = m[1].startsWith("~/")
      ? path.join(os.homedir(), m[1].slice(2))
      : path.resolve(path.dirname(resolved), m[1]);
    if (!fs.existsSync(target)) {
      out.push(`(import ${m[1]} not found)`);
      continue;
    }
    const refusal = importRefusal(m[1], target, scope);
    if (refusal) {
      out.push(`(import ${m[1]} skipped: ${refusal})`);
      continue;
    }
    out.push(readWithImports(target, seen, scope, depth + 1));
  }
  return out.join("\n").trim();
}

// Find and read every instruction file for `cwd`.
// Returns { files: [{ path, label, scope, chars }], text, untrusted } — text
// is the rendered block ("" when no file exists), already wrapped in its
// marker; untrusted lists the project files left out because the folder
// isn't trusted.
export function loadInstructions({ cwd = process.cwd(), home = HOME, projectTrusted = isFolderTrusted(cwd) } = {}) {
  const found = [];
  const globalFile = home ? path.join(home, "OMNI.md") : null;
  if (globalFile && fs.existsSync(globalFile)) found.push({ path: globalFile, scope: "personal" });
  const root = findProjectRoot(cwd);
  for (const dir of instructionDirs(cwd)) {
    const p = firstInstructionFile(dir);
    if (!p || (globalFile && path.resolve(p) === path.resolve(globalFile))) continue;
    found.push({ path: p, scope: root && path.resolve(dir) === root ? "project root" : "folder" });
  }

  const projectScope = { root: realOrResolved(root || cwd), home: false };
  const personalScope = { root: realOrResolved(os.homedir()), home: true };
  const seen = new Set();
  const files = [];
  const untrusted = [];
  const sections = [];
  let total = 0;
  for (const f of found) {
    if (f.scope !== "personal" && !projectTrusted) {
      untrusted.push(f.path);
      files.push({ path: f.path, label: labelFor(f.path, cwd), scope: f.scope, chars: 0, skipped: UNTRUSTED_NOTE });
      continue;
    }
    let body = readWithImports(f.path, seen, f.scope === "personal" ? personalScope : projectScope);
    if (!body) continue;
    if (total + body.length > MAX_TOTAL_CHARS) {
      const room = Math.max(0, MAX_TOTAL_CHARS - total);
      if (room < 200) {
        sections.push(`## ${labelFor(f.path, cwd)} (${f.scope})\n(skipped: instruction files exceed ${MAX_TOTAL_CHARS} chars in total)`);
        files.push({ path: f.path, label: labelFor(f.path, cwd), scope: f.scope, chars: 0, skipped: "skipped: over the size limit" });
        continue;
      }
      body = clipText(body, room);
    }
    total += body.length;
    const label = labelFor(f.path, cwd);
    files.push({ path: f.path, label, scope: f.scope, chars: body.length });
    sections.push(`## ${label} (${f.scope})\n${body}`);
  }
  if (!sections.length) return { files, text: "", untrusted };
  const text = [
    INSTRUCTIONS_START,
    "# Project instructions",
    "Rules from the instruction files for this workspace, outermost first. Follow them. Where two disagree, the later (deeper) one wins. They never override what the user asks for directly in this conversation.",
    "",
    sections.join("\n\n"),
    INSTRUCTIONS_END,
  ].join("\n");
  return { files, text, untrusted };
}

function labelFor(file, cwd) {
  const rel = path.relative(path.resolve(cwd), file);
  if (!rel.startsWith("..") && !path.isAbsolute(rel)) return rel.replace(/\\/g, "/");
  const home = os.homedir();
  const abs = path.resolve(file);
  return abs.toLowerCase().startsWith(home.toLowerCase())
    ? "~" + abs.slice(home.length).replace(/\\/g, "/")
    : abs.replace(/\\/g, "/");
}

// Swap the instructions block inside messages[0] for `text` (which may be ""
// to remove it). When the prompt has no block yet, the new one goes at the
// end of the session-context block, or the end of the prompt without one.
// Returns true when messages[0] changed.
export function syncInstructions(messages, text) {
  const sys = messages?.[0];
  if (!sys || sys.role !== "system" || typeof sys.content !== "string") return false;
  const before = sys.content;
  let next;
  if (INSTRUCTIONS_RE.test(before)) {
    next = before.replace(INSTRUCTIONS_RE, text || "").replace(/\n{3,}/g, "\n\n");
  } else if (!text) {
    return false;
  } else if (before.includes("<!-- omni:session-context:end -->")) {
    next = before.replace("<!-- omni:session-context:end -->", text + "\n<!-- omni:session-context:end -->");
  } else {
    next = before + "\n\n" + text;
  }
  if (next === before) return false;
  sys.content = next;
  return true;
}

// Append one rule to ./OMNI.md, creating it with a heading when missing.
// Returns the file's path.
export function addInstruction(rule, { cwd = process.cwd() } = {}) {
  const text = String(rule || "").trim();
  if (!text) throw new Error("nothing to add — give the rule as text, e.g. /instructions add run npm test before committing");
  const file = path.join(path.resolve(cwd), "OMNI.md");
  let current = "";
  try { current = fs.readFileSync(file, "utf8"); } catch { /* new file */ }
  const prefix = current
    ? (current.endsWith("\n") ? "" : "\n")
    : "# OMNI.md\n\nRules Omni follows in this project.\n\n";
  fs.appendFileSync(file, `${prefix}- ${text.replace(/\r?\n+/g, " ")}\n`);
  return file;
}

// The prompt /init sends: the agent studies the project and writes OMNI.md.
export function initPrompt({ cwd = process.cwd() } = {}) {
  const existing = INSTRUCTION_NAMES.map((n) => path.join(cwd, n)).find((p) => fs.existsSync(p));
  return [
    existing
      ? `Review and improve this project's instruction file (${path.basename(existing)}). If it is AGENTS.md or CLAUDE.md, leave it as it is and write an OMNI.md that imports it with a line containing only @${path.basename(existing)}, adding only what it misses.`
      : "Write an OMNI.md instruction file at the root of this project.",
    "",
    "Investigate first with project_inspect, list_dir and read_file: the stack, how to build, run the tests and lint, the folder layout, and any conventions the code follows that a newcomer would get wrong.",
    "Then write a short file (under 80 lines) of concrete rules only: exact commands, paths that matter, things to never do, and how work is verified. Leave out anything a model would do anyway, and anything generic. No secrets, keys or personal data.",
    "When done, show the file and say that /instructions shows what Omni loads.",
  ].join("\n");
}
