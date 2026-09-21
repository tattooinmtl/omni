// Tool definitions (OpenAI function-calling schema) + implementations.
// File ops, shell, and code search — the core of a coding agent.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { rgPath, fdPath, jqPath, INSTALL_ROOT } from "../paths.mjs";
import { jqLite, formatJqResult, JqLiteError } from "./jq-lite.mjs";
import { HOME, loadSettings, saveSettings, resolveModel, Session } from "../core/config.mjs";
import { getWorkspaceScope } from "../core/workspace.mjs";
import {
  activeProviderFromDisk, layeredProvider, currentAtoms, formatMemoryRecord, explainAtomText,
} from "../core/memory-provider.mjs";
import { buildIndex as ragBuild, searchIndex as ragSearch } from "../integrations/rag.mjs";
import { rankChunks } from "../core/bm25.mjs";
import { loadScannedSkills } from "../core/skill-index.mjs";
import { markEphemeralSkill as markSkillEphemeral } from "../cli/helpers.mjs";
import { lspRequest, lspRenamePlan } from "../integrations/lsp.mjs";

const MAX_OUTPUT = 30000;
const PROCESS_LOG_LIMIT = 20000;
const managedProcesses = new Map();
let nextProcessId = 1;
const managedAgents = new Map();
let nextAgentId = 1;

// Live session context — set by main.mjs via setSessionCtx() after ctx is
// created. Lets settings-management tools update both disk and in-memory state
// so Omni can add models/providers without requiring a restart.
let _sessionCtx = null;
export function setSessionCtx(ctx) { _sessionCtx = ctx; }

function clip(s) {
  s = String(s);
  return s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + "\n…[truncated]" : s;
}

// Write `content` to `file` atomically: write to a tmp file in the same
// directory, then rename over the destination. A crash mid-write leaves the
// destination untouched (its previous content is still there) instead of a
// truncated/corrupt file. Same pattern as saveSettings in core/config.mjs.
// The tmp name is uniquified (pid + timestamp + random) so two concurrent
// writes to the same file don't collide on the tmp path.
function atomicWriteFileSync(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    throw e;
  }
}

// Cheap ReDoS heuristic: a quantifier (?, *, +, {n,m}) immediately inside a
// group that's itself quantified is the textbook shape for catastrophic
// backtracking. Not exhaustive (a worker-thread timeout would be), but
// catches the common patterns a model or pasted file is likely to supply:
//   (a+)+   (.*)*   ([a-z]+)?   (\d+){1,3}
// Anything more sophisticated (e.g. (a|a)+ with overlapping alternatives)
// slips through; the per-file work the regex does is bounded by file size
// so a slow case is annoying but not a hang.
function hasNestedQuantifier(pattern) {
  return /\([^)]*[+*?][^)]*\)[+*?{]/.test(pattern) || /\([^)]*\{[\d,]+\}[^)]*\)[+*?{]/.test(pattern);
}

// Build/install output directories that should never end up in git history
// unless the user explicitly opts in (TODO #19). Mirrors inspectProject's
// skip-list so the two tools agree on what counts as "heavy".
const HEAVY_DIRS = new Set([
  "node_modules", "bower_components",
  ".next", ".nuxt", ".svelte-kit", ".output", ".cache", ".parcel-cache",
  "dist", "build", "out", "coverage", "__pycache__",
  ".venv", "venv", "env",                    // Python
  "target",                                   // Rust
  "vendor",                                   // Go (deps/, NOT vendor/ for code)
  ".gradle", "build",                         // Gradle — duplicates build above
  "Pods",                                     // CocoaPods
  ".terraform",                               // TF
  "_site",                                    // Jekyll
]);

function isInHeavyDirectory(relPath) {
  // Normalise to forward slashes for matching (Windows backslashes).
  const parts = String(relPath || "").replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.some((seg) => HEAVY_DIRS.has(seg));
}

function workspaceRoot() {
  return path.resolve(process.cwd());
}

// Lexical containment first — cheap, and catches the common ".." escape.
// Then symlink-aware containment: path.relative doesn't follow links, so a
// symlink INSIDE cwd pointing OUTSIDE it would pass the lexical check and let
// read/write escape the workspace undetected. Realpath the nearest existing
// ancestor (the target may not exist yet — e.g. a new file being created) and
// reattach the not-yet-existing suffix before re-checking containment.
// Skills are part of the harness itself, not any one project — every project
// should be able to read the installed skill library (e.g. to use one
// skill's documented pattern as a reference while building something else),
// regardless of which folder is the current workspace. Read-only: this does
// NOT exempt writes, so authoring/editing a skill still goes through the
// normal per-project write scope.
const SKILLS_ROOT = path.resolve(INSTALL_ROOT, "skills");
function isUnderSkillsRoot(full) {
  const rel = path.relative(SKILLS_ROOT, full);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function assertInsideWorkspace(full, label = "path") {
  // "system" scope (settings.workspace.scope, set by the human via
  // /workspace scope system) lifts containment: the user has explicitly
  // granted the whole machine.
  if (getWorkspaceScope() === "system") return full;
  if (isUnderSkillsRoot(full)) return full;
  const root = workspaceRoot();
  const rel = path.relative(root, full);
  if (rel !== "" && (rel.startsWith("..") || path.isAbsolute(rel))) {
    throw new Error(`${label} escapes workspace: ${path.relative(root, full) || full}`);
  }

  const realRoot = fs.realpathSync(root);
  let dir = full;
  let suffix = "";
  let realDir;
  for (;;) {
    try {
      realDir = fs.realpathSync(dir);
      break;
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      const parent = path.dirname(dir);
      if (parent === dir) throw e; // reached filesystem root without finding anything real
      suffix = suffix ? path.join(path.basename(dir), suffix) : path.basename(dir);
      dir = parent;
    }
  }
  const realFull = suffix ? path.join(realDir, suffix) : realDir;
  const realRel = path.relative(realRoot, realFull);
  if (realRel !== "" && (realRel.startsWith("..") || path.isAbsolute(realRel))) {
    throw new Error(`${label} escapes workspace via a symlink: ${path.relative(root, full) || full}`);
  }
  return full;
}

function resolve(p = ".") {
  return assertInsideWorkspace(path.resolve(process.cwd(), p));
}

function resolveForCreate(p) {
  return assertInsideWorkspace(path.resolve(process.cwd(), p));
}

// ---------------------------------------------------------------------------
// Line endings
// ---------------------------------------------------------------------------
// Models emit "\n". Windows checkouts are "\r\n" (git's core.autocrlf defaults
// to true there). Comparing the two verbatim broke every editing tool on a
// CRLF file: edit_file threw "old_string not found in file" for any multi-line
// edit, apply_patch threw "Patch context not found", and edit_lines wrote
// LF-only lines into a CRLF file, leaving mixed endings that got worse with
// every edit. None of it reproduces on Linux, where the same files are LF.
//
// The rule everywhere below: MATCH on LF-normalized text, WRITE BACK in the
// file's own convention. An edit never changes a file's line-ending style as
// a side effect.

// The convention a file already uses. Ties and CRLF-majority go to CRLF;
// a file with no CRLF at all is LF.
function detectEol(text) {
  const s = String(text);
  const crlf = (s.match(/\r\n/g) || []).length;
  if (!crlf) return "\n";
  const bareLf = (s.match(/\n/g) || []).length - crlf;
  return crlf >= bareLf ? "\r\n" : "\n";
}

const toLf = (t) => String(t).replace(/\r\n/g, "\n");
const fromLf = (t, eol) => (eol === "\r\n" ? String(t).replace(/\n/g, "\r\n") : String(t));

// A required argument the model left out should come back as something it can
// act on. Without this, omitting `path` surfaced as "EISDIR: illegal operation
// on a directory" (read_file resolved undefined to the cwd), omitting
// `filename` as 'The "paths[1]" argument must be of type string', and omitting
// `pattern`/`query` as no error at all — a silent wrong answer, which is worse
// than either. The tool name and the argument name are what make the message
// actionable, so both go in.
function requireArg(tool, name, value) {
  if (typeof value === "string" ? value.trim() === "" : value === undefined || value === null) {
    throw new Error(`${tool}: "${name}" is required`);
  }
  return value;
}

// jq_query's no-binary path. Evaluates the filter with the built-in subset
// (src/tools/jq-lite.mjs) so reading a JSON file structurally still works on
// a machine with no jq. A filter outside the subset reports that plainly,
// along with why the real jq wasn't used, so the cause is never ambiguous.
function jqFallback(filter, full, raw, spawnError) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(full, "utf8"));
  } catch (e) {
    return `jq error: ${full} is not valid JSON — ${e.message}`;
  }
  try {
    const out = formatJqResult(jqLite(filter, data), { raw });
    return clip(out || "(null or empty result)");
  } catch (e) {
    if (e instanceof JqLiteError) {
      return `jq error: ${e.message}\n(the jq binary is unavailable — ${spawnError} — so the built-in subset was used)`;
    }
    throw e;
  }
}

// Each entry maps a pattern to a short, specific reason (shown to the human
// in the confirm prompt — see checkCommandRisk in agent.mjs) instead of one
// generic "destructive" label, so a registry edit reads differently than a
// recursive delete.
const BLOCKED_PATTERNS = [
  { re: /\brm\s+(-[^\n]*r|--recursive)/, reason: "recursively deletes files — irreversible" },
  { re: /\bremove-item\b[^\n]*(\s-r|\s-recurse|recursive)/, reason: "recursively deletes files — irreversible" },
  { re: /\brmdir\b[^\n]*(\/s|-r|--recursive)/, reason: "recursively deletes a directory — irreversible" },
  { re: /\bdel\b[^\n]*(\/s|\/q)/, reason: "force/recursively deletes files — irreversible" },
  { re: /\bgit\s+(reset\s+--hard|clean\s+-[^\n]*[xfd])/, reason: "discards uncommitted work irreversibly" },
  { re: /\bformat\b\s+[a-z]:/, reason: "formats a disk volume — irreversible data loss" },
  { re: /\bshutdown\b/, reason: "shuts down or restarts the computer" },
  // Windows Registry — autostart entries, security settings, installed-software
  // config all live here; this is also a classic persistence/tampering target.
  { re: /\breg(?:\.exe)?\s+(add|import|copy|restore|delete)\b/, reason: "modifies the Windows Registry (autostart/security settings)" },
  { re: /\bregedit\b[^\n]*\/s\b/, reason: "silently imports a .reg file into the Registry" },
  { re: /\b(set|new|remove)-itemproperty\b[^\n]*\bhk(lm|cu|cr|u|cc)\b/, reason: "modifies the Windows Registry (autostart/security settings)" },
  { re: /\b(new|remove)-item\b[^\n]*\bhk(lm|cu|cr|u|cc):/, reason: "modifies the Windows Registry (autostart/security settings)" },
  // Persistence mechanisms
  { re: /\bschtasks\b[^\n]*\/create\b/, reason: "creates a scheduled task (persistence)" },
  { re: /\bsc(?:\.exe)?\s+create\b/, reason: "creates a Windows service (persistence)" },
  { re: /\bnew-service\b/, reason: "creates a Windows service (persistence)" },
  // Security posture
  { re: /\bset-executionpolicy\b/, reason: "changes PowerShell's execution policy" },
  { re: /\bset-mppreference\b/, reason: "changes Windows Defender/antivirus settings" },
  { re: /\bnetsh\s+advfirewall/, reason: "modifies Windows Firewall rules" },
  { re: /\bnew-netfirewallrule\b/, reason: "adds a Windows Firewall rule" },
  { re: /\bbcdedit\b/, reason: "modifies Windows boot configuration" },
];

export function commandRisk(command) {
  const c = String(command || "").toLowerCase();
  const hit = BLOCKED_PATTERNS.find(({ re }) => re.test(c));
  if (hit) return { level: "blocked", reason: hit.reason };
  const elevated = [
    /\bnpm\s+(install|i)\b/,
    /\bpnpm\s+(install|add)\b/,
    /\byarn\s+(install|add)\b/,
    /\bpip\s+install\b/,
    /\bdocker\s+(run|compose|build|pull|push)\b/,
    /\bgh\s+pr\s+(merge|close)\b/,
  ].some((re) => re.test(c));
  if (elevated) return { level: "caution", reason: "may change dependencies, external services, or network state" };
  return { level: "normal", reason: "no high-risk pattern detected" };
}

// Helper to run a shell command (used by run_shell and run_test)
function runShellCommand({ command, timeout_ms = 120000, allow_unsafe = false, dry_run = false }) {
  const risk = commandRisk(command);
  if (dry_run) {
    return [
      `DRY RUN: ${command}`,
      `risk: ${risk.level}`,
      `reason: ${risk.reason}`,
      `cwd: ${process.cwd()}`,
    ].join("\n");
  }
  if (!allow_unsafe && risk.level === "blocked") {
    return [
      "BLOCKED: command looks destructive or irreversible.",
      "Use safer dedicated tools when possible, or set allow_unsafe=true only when the user explicitly authorized this exact action.",
      `Risk reason: ${risk.reason}`,
      `Command: ${command}`,
    ].join("\n");
  }
  const isWin = process.platform === "win32";
  const shell = isWin ? "powershell.exe" : "/bin/sh";
  const args = isWin ? ["-NoProfile", "-NonInteractive", "-Command", command] : ["-c", command];
  const r = spawnSync(shell, args, {
    encoding: "utf8",
    timeout: timeout_ms,
    maxBuffer: 1024 * 1024 * 16,
    cwd: process.cwd(),
  });
  let out = "";
  if (r.stdout) out += r.stdout;
  if (r.stderr) out += (out ? "\n" : "") + r.stderr;
  if (r.error) out += `\n[spawn error: ${r.error.message}]`;
  if (r.status === null && r.error?.killed) out += "\n[timeout: command exceeded time limit]";
  out += `\n[exit code: ${r.status ?? "null"}]`;
  return clip(out.trim());
}

// Read-only dependency commands per package manager (used by the deps tool).
// Installs/updates stay in run_shell where the risk gate applies.
const DEPS_COMMANDS = {
  npm:      { list: "npm ls --depth=0", outdated: "npm outdated", audit: "npm audit" },
  pnpm:     { list: "pnpm ls --depth 0", outdated: "pnpm outdated", audit: "pnpm audit" },
  yarn:     { list: "yarn list --depth=0", outdated: "yarn outdated", audit: "yarn audit" },
  bun:      { list: "bun pm ls", outdated: "bun outdated", audit: "bun audit" },
  pip:      { list: "pip list", outdated: "pip list --outdated", audit: "pip-audit" },
  cargo:    { list: "cargo tree --depth 1", outdated: "cargo update --dry-run", audit: "cargo audit" },
  go:       { list: "go list -m all", outdated: "go list -u -m all", audit: "govulncheck ./..." },
  composer: { list: "composer show --direct", outdated: "composer outdated --direct", audit: "composer audit" },
  bundler:  { list: "bundle list", outdated: "bundle outdated", audit: "bundle audit check" },
  dotnet:   { list: "dotnet list package", outdated: "dotnet list package --outdated", audit: "dotnet list package --vulnerable" },
};

// Pick the coverage runner that matches the project's stack (test_coverage).
function coverageCommand() {
  const cwd = process.cwd();
  const has = (f) => fs.existsSync(path.join(cwd, f));
  if (has("package.json")) {
    let pkg = {};
    try { pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8")); } catch { /* unparseable */ }
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    if (deps.vitest) return "npx vitest run --coverage";
    if (deps.jest) return "npx jest --coverage --coverageReporters=text-summary";
    if (deps.nyc) return "npx nyc --reporter=text-summary npm test";
    return "npx --yes c8 --reporter=text-summary npm test";
  }
  if (has("pyproject.toml") || has("requirements.txt") || has("Pipfile")) {
    return "python -m pytest --cov --cov-report=term-missing:skip-covered";
  }
  if (has("go.mod")) return "go test ./... -cover";
  if (has("Cargo.toml")) return "cargo llvm-cov --summary-only";
  try {
    if (fs.readdirSync(cwd).some((f) => f.endsWith(".csproj") || f.endsWith(".sln"))) {
      return 'dotnet test --collect:"XPlat Code Coverage"';
    }
  } catch { /* unreadable cwd */ }
  return null;
}

// Pick the lint/format command that matches the project's setup (lint_check).
// Same detection idiom as coverageCommand: package.json scripts first, then
// tool config files. `target` is a pre-validated, pre-quoted path scope ("" =
// whole project). Returns null when nothing is detected.
function lintCommand({ fix = false, target = "" } = {}) {
  const cwd = process.cwd();
  const has = (f) => fs.existsSync(path.join(cwd, f));
  if (has("package.json")) {
    let pkg = {};
    try { pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8")); } catch { /* unparseable */ }
    const scripts = pkg.scripts || {};
    const pm = has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : has("bun.lockb") || has("bun.lock") ? "bun" : "npm";
    const run = pm === "yarn" ? "yarn" : `${pm} run`;
    for (const script of ["lint", "format", "format:check"]) {
      if (!scripts[script]) continue;
      // `-- --fix` is the npm/pnpm/bun arg-passthrough idiom for the fix
      // variant of a lint script; a `format` script already writes by default.
      let cmd = `${run} ${script}`;
      if (fix && script !== "format") cmd += " -- --fix";
      if (target) cmd += ` -- ${target}`;
      return cmd;
    }
  }
  let entries = [];
  try { entries = fs.readdirSync(cwd); } catch { /* unreadable cwd */ }
  const someFile = (re) => entries.some((f) => re.test(f));
  if (has("biome.json") || has("biome.jsonc")) return `npx biome check${fix ? " --write" : ""} ${target || "."}`;
  if (someFile(/^\.eslintrc(\.|$)/) || someFile(/^eslint\.config\./)) return `npx eslint ${target || "."}${fix ? " --fix" : ""}`;
  if (someFile(/^\.prettierrc(\.|$)/) || someFile(/^prettier\.config\./)) return `npx prettier --${fix ? "write" : "check"} ${target || "."}`;
  let ruff = has("ruff.toml") || has(".ruff.toml");
  if (!ruff && has("pyproject.toml")) {
    try { ruff = /\[tool\.ruff[.\]]/.test(fs.readFileSync(path.join(cwd, "pyproject.toml"), "utf8")); } catch { /* unreadable */ }
  }
  if (ruff) return `ruff check${fix ? " --fix" : ""} ${target || "."}`;
  if (has(".rubocop.yml")) return `rubocop${fix ? " -A" : ""}${target ? ` ${target}` : ""}`;
  return null;
}

// Secret-detection rules for security_scan: [label, ripgrep regex].
// Matches are reported as file:line + rule only; values are never echoed.
const SECRET_RULES = [
  ["AWS access key", "\\bAKIA[0-9A-Z]{16}\\b"],
  ["GitHub token", "\\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\\b|github_pat_[A-Za-z0-9_]{22,}"],
  ["Slack token", "\\bxox[baprs]-[A-Za-z0-9-]{10,}\\b"],
  ["OpenAI-style key", "\\bsk-[A-Za-z0-9_-]{32,}\\b"],
  // The non-`sk-` provider formats. These were already in config.mjs's
  // SECRET_PATTERNS (the session-log redactor) precisely because NVIDIA and
  // Groq keys turned up in plaintext there — but the file scanner never
  // learned them, so `security_scan` reported "clean" on a file holding an
  // nvapi-/gsk_/xai-/AIza key. Kept in sync with that list deliberately.
  ["NVIDIA key", "\\bnvapi-[A-Za-z0-9_-]{20,}\\b"],
  ["Groq key", "\\bgsk_[A-Za-z0-9]{40,}\\b"],
  ["xAI key", "\\bxai-[A-Za-z0-9]{20,}\\b"],
  ["Google API key", "\\bAIza[0-9A-Za-z_-]{30,}\\b"],
  ["Private key block", "-----BEGIN [A-Z ]*PRIVATE KEY-----"],
  ["Hardcoded credential", "(?i)(?:api[_-]?key|secret|token|password|passwd)[\"']?\\s*[:=]\\s*[\"'][^\"'\\s]{8,}[\"']"],
];

function detectPackageManagers() {
  const has = (f) => fs.existsSync(path.join(process.cwd(), f));
  const managers = [];
  if (has("package.json")) {
    if (has("pnpm-lock.yaml")) managers.push("pnpm");
    else if (has("yarn.lock")) managers.push("yarn");
    else if (has("bun.lockb") || has("bun.lock")) managers.push("bun");
    else managers.push("npm");
  }
  if (has("requirements.txt") || has("pyproject.toml") || has("Pipfile")) managers.push("pip");
  if (has("Cargo.toml")) managers.push("cargo");
  if (has("go.mod")) managers.push("go");
  if (has("composer.json")) managers.push("composer");
  if (has("Gemfile")) managers.push("bundler");
  try {
    if (fs.readdirSync(process.cwd()).some((f) => f.endsWith(".csproj") || f.endsWith(".sln"))) managers.push("dotnet");
  } catch { /* unreadable cwd — skip */ }
  return managers;
}

export const tools = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a text file. Returns up to ~2000 lines with line numbers.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path (relative to cwd or absolute)" },
          offset: { type: "integer", description: "1-based start line (optional)" },
          limit: { type: "integer", description: "Max lines to read (optional, default 2000)" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_many_files",
      description: "Read several text files at once. Use this to gather project context efficiently before editing.",
      parameters: {
        type: "object",
        properties: {
          paths: { type: "array", items: { type: "string" }, description: "Workspace-relative file paths" },
          limit_per_file: { type: "integer", description: "Max lines per file, default 400" },
        },
        required: ["paths"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Create or overwrite a file with the given content.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to write (relative to cwd or absolute). Parent directories are created as needed." },
          content: { type: "string", description: "Full file body to write. Replaces any existing content — use edit_file or edit_lines for a partial change." },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "Replace an exact substring in a file. old_string must appear exactly once.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the file to edit (relative to cwd or absolute)." },
          old_string: { type: "string", description: "Exact text to replace. Must appear EXACTLY once in the file — include surrounding context to make it unique. Line endings are matched flexibly, so \n works against a CRLF file." },
          new_string: { type: "string", description: "Replacement text. Written back using the file's existing line-ending convention." },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_lines",
      description:
        "Replace a 1-based, inclusive line range of a file with new content (new_string may be empty to delete the lines). To INSERT without replacing, pass end_line < start_line — the new lines go in before start_line. To APPEND to the end, pass start_line = (number of lines + 1); the existing last line is kept. Use when edit_file's exact-match replacement is awkward (old_string missing or repeated).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path (relative to cwd or absolute)" },
          start_line: { type: "integer", description: "First line to replace (1-based). One past the last line appends to the end of the file." },
          end_line: { type: "integer", description: "Last line to replace (inclusive); past the last line means through the end of the file. Pass a value < start_line to insert before start_line instead." },
          new_string: { type: "string", description: "Replacement lines; empty string deletes the range. A single trailing newline is a line terminator, not an extra line." },
        },
        required: ["path", "start_line", "end_line", "new_string"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "apply_patch",
      description:
        "Apply a multi-file patch using Begin/End Patch syntax. Supports Add File, Update File, and Delete File. Prefer this for multi-hunk edits.",
      parameters: {
        type: "object",
        properties: {
          patch: {
            type: "string",
            description:
              "Patch text beginning with *** Begin Patch and ending with *** End Patch. Update hunks use lines prefixed with space, -, or +.",
          },
        },
        required: ["patch"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_dir",
      description: "List files and folders in a directory.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory (default cwd)" },
          recursive: { type: "boolean", description: "List recursively (optional, default false)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search",
      description: "Search file contents with a regex (ripgrep). Returns matching lines with paths.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regex pattern" },
          path: { type: "string", description: "Directory or file to search (default cwd)" },
          glob: { type: "string", description: "Optional glob filter, e.g. *.ts" },
          case_insensitive: { type: "boolean", description: "Case-insensitive search (default false)" },
          context: { type: "integer", description: "Number of context lines before/after each match (default 0)" },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_replace",
      description:
        "Find-and-replace across every matching file in one call (ripgrep-powered) — for renames search+edit_file can't do semantically: string literals, config keys, comments, non-code text. Prefer rename_symbol for a code identifier when a language server is available; use this for everything else, or as a fallback. Literal substring match by default; set regex=true for a pattern with capture groups ($1, $2, ... in replacement). Use dry_run=true to preview affected files/counts before writing.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Text to find — literal substring by default, or a regex when regex=true" },
          replacement: { type: "string", description: "Replacement text. In regex mode, $1/$2/$& backreferences work; in literal mode, inserted exactly as given." },
          path: { type: "string", description: "Directory or file to search (default cwd)" },
          glob: { type: "string", description: "Optional glob filter, e.g. *.ts" },
          case_insensitive: { type: "boolean", description: "Case-insensitive match (default false)" },
          regex: { type: "boolean", description: "Treat pattern as a regex instead of a literal string (default false)" },
          dry_run: { type: "boolean", description: "Preview affected files/occurrence counts without writing" },
        },
        required: ["pattern", "replacement"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_files",
      description: "Find files/directories quickly using fd. Pattern supports regex (default) or glob-like wildcards.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regex pattern, or glob-style pattern with * ? []" },
          path: { type: "string", description: "Directory to search (default cwd)" },
          type: { type: "string", description: "Optional entry type: f|d|symlink" },
          max_depth: { type: "integer", description: "Optional max depth" },
          extension: { type: "string", description: "Filter by file extension (without dot), e.g. 'ts' or 'js'" },
          respect_gitignore: { type: "boolean", description: "Honor .gitignore rules (default false)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "jq_query",
      description: "Query or transform JSON data using jq. Runs a jq filter on a JSON file and returns the result. When the jq binary isn't installed, a built-in subset handles paths, pipes, select() and the common builtins (keys, length, type, add, sort, unique, first, last, …); a filter outside that subset says so rather than guessing.",
      parameters: {
        type: "object",
        properties: {
          filter: { type: "string", description: "jq filter expression, e.g. '.dependencies', '.[] | select(.name == \"foo\")'" },
          path: { type: "string", description: "Path to JSON file (relative to cwd or absolute)" },
          raw: { type: "boolean", description: "Output raw strings (no quotes) for scalar results (default false)" },
        },
        required: ["filter", "path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "project_inspect",
      description:
        "Inspect the workspace and summarize likely stack, package scripts, dependency managers, test/build commands, and important config files.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory to inspect, default cwd" },
          max_depth: { type: "integer", description: "Directory scan depth, default 2" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_status",
      description: "Show concise git branch and working tree status for the current workspace.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "git_diff",
      description: "Show a git diff for the workspace, optionally staged or limited to one path.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Optional workspace path to diff" },
          staged: { type: "boolean", description: "Show staged diff instead of unstaged diff" },
          stat: { type: "boolean", description: "Show --stat summary instead of full patch" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "diff_files",
      description:
        "Unified diff between any two files (unlike git_diff, the files need not be git-tracked). Uses git diff --no-index, with a simple built-in line-diff fallback when git is unavailable.",
      parameters: {
        type: "object",
        properties: {
          path_a: { type: "string", description: "First file (relative to cwd or absolute)" },
          path_b: { type: "string", description: "Second file (relative to cwd or absolute)" },
          context: { type: "integer", description: "Context lines around each change (default 3)" },
        },
        required: ["path_a", "path_b"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_commit",
      description:
        "Stage selected workspace paths and create a git commit. Use only after reviewing git_status/git_diff and when the user asked to commit.",
      parameters: {
        type: "object",
        properties: {
          message: { type: "string", description: "Commit message" },
          paths: { type: "array", items: { type: "string" }, description: "Paths to stage. Omit when all=true." },
          all: { type: "boolean", description: "Stage all tracked/untracked changes in the workspace" },
          allow_unsafe: {
            type: "boolean",
            description: "Set true only when the user explicitly authorized staging heavy build directories (node_modules, .venv, target, …).",
          },
        },
        required: ["message"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "project_todo",
      description:
        "Maintain a persistent project todo list in omni/todos.json. Use it to plan, track, and close multi-step implementation work.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", description: "list | add | update | done | remove | clear" },
          id: { type: "string", description: "Todo id for update/done/remove" },
          title: { type: "string", description: "Todo title for add/update" },
          status: { type: "string", description: "pending | in_progress | done" },
          notes: { type: "string", description: "Optional detail or result notes" },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_shell",
      description:
        "Run a shell command (PowerShell on Windows) in the cwd and return stdout/stderr. Use for build, test, git, etc. " +
        "The default timeout is 120s — raise timeout_ms for scaffolding and dependency installs " +
        "(npx create-*, npm/pnpm install, cargo build, docker build routinely exceed it); a timeout kills the " +
        "command mid-run and can leave a half-written project directory.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to run, in the workspace directory. Obviously destructive commands are blocked unless allow_unsafe is set and a human confirms." },
          timeout_ms: { type: "integer", description: "Timeout in ms, default 120000. Use 300000-600000 for scaffolding or dependency installs." },
          allow_unsafe: {
            type: "boolean",
            description: "Set true only when the user explicitly authorized a destructive or irreversible command.",
          },
          dry_run: {
            type: "boolean",
            description: "Return command risk/cwd details without executing.",
          },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_test",
      description:
        "Run a test command (e.g., npm test, vitest, jest) in the cwd and return output. " +
        "Default timeout is 120s — raise timeout_ms for a slow or full suite.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Test command to run (default: npm test)" },
          timeout_ms: { type: "integer", description: "Timeout in ms, default 120000. Raise it for a slow suite." },
          allow_unsafe: {
            type: "boolean",
            description: "Set true only when the user explicitly authorized a destructive or irreversible command.",
          },
          dry_run: {
            type: "boolean",
            description: "Return command risk/cwd details without executing.",
          },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "start_process",
      description:
        "Start a long-running background process such as a dev server. Use process_status to read logs and stop_process to stop it.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Command to run in the system shell" },
          cwd: { type: "string", description: "Optional workspace-relative cwd" },
          name: { type: "string", description: "Optional friendly process name" },
          allow_unsafe: {
            type: "boolean",
            description: "Set true only when the user explicitly authorized a destructive or irreversible command.",
          },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "process_status",
      description: "List managed background processes or show one process with recent logs.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Optional process id" },
          logs: { type: "boolean", description: "Include recent stdout/stderr logs, default true for a single process" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "stop_process",
      description: "Stop a managed background process started by start_process.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Process id returned by start_process" },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "process_input",
      description:
        "Send a line of stdin to a running background process started by start_process — answer an interactive prompt or drive a REPL. Returns output captured shortly after the input is sent, so you can see its effect.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Process id returned by start_process" },
          input: { type: "string", description: "Text to write to the process's stdin" },
          newline: { type: "boolean", description: "Append a trailing newline (default true)" },
        },
        required: ["id", "input"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "spawn_agent",
      description:
        "Spawn an independent sub-agent on a self-contained sub-task, running in the BACKGROUND in parallel with you — you keep working, then check agent_status later for its result. Give it a `model` (e.g. 'agnes/agnes-2.5-flash') to run it on a different provider than your own, so the two run truly concurrently instead of competing for the same rate limit. The sub-agent shares this workspace and has the same tools you do, but its own isolated conversation — write the prompt so it makes sense with zero context from this conversation (what to do, relevant file paths, what \"done\" looks like). Caution: it can read/write the SAME files you can, at the same time — only spawn one for a sub-task that doesn't overlap files you're actively touching, to avoid both of you editing the same file at once.",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "Full, self-contained task description for the sub-agent — it has no memory of this conversation." },
          model: { type: "string", description: "Model key to run it on, e.g. 'agnes/agnes-2.5-flash' or 'nvidia/nemotron-3-ultra-550b-a55b'. Defaults to the default model if omitted." },
          name: { type: "string", description: "Optional short label shown in agent_status." },
        },
        required: ["prompt"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "self_review",
      description:
        "Have an independent critic review the change you just made, BEFORE you report it as done. " +
        "It runs a separate agent that sees only the original task and your diff — never your reasoning — and returns " +
        "findings as [BLOCKER|MAJOR|MINOR] file:line with concrete fixes, ending in a VERDICT line. It cannot modify anything. " +
        "This blocks until the review comes back, then you act on it. " +
        "Running the tests proves the code executes; this is what catches a requirement you missed, a case you didn't handle, " +
        "or behaviour you broke somewhere else. Use it after implementing anything non-trivial, and again after a substantial revision. " +
        "Pass `model` to review on a different model than your own — a second opinion from the same model tends to agree with itself.",
      parameters: {
        type: "object",
        properties: {
          task: {
            type: "string",
            description: "What the change was supposed to accomplish, in the user's terms. The critic judges the diff against THIS, so state the actual requirement, including anything the user asked for that you chose not to do.",
          },
          diff_from: {
            type: "string",
            enum: ["unstaged", "staged", "head"],
            description: "What to review: 'unstaged' (default, working-tree changes), 'staged', or 'head' (everything since the last commit).",
          },
          paths: {
            type: "array",
            items: { type: "string" },
            description: "Optional paths to limit the review to. Omit to review the whole diff.",
          },
          focus: {
            type: "string",
            description: "Optional — anything you're specifically unsure about and want scrutinised.",
          },
          model: {
            type: "string",
            description: "Optional model key to run the critic on, e.g. 'xkiro/mistral-large'. Defaults to the default model.",
          },
          timeout_ms: {
            type: "integer",
            description: "Max wait in ms (default 240000, max 600000).",
          },
        },
        required: ["task"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "agent_status",
      description: "Check on a sub-agent started by spawn_agent: still running, or its final result. Omit id to list every spawned sub-agent.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Optional sub-agent id returned by spawn_agent" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "stop_agent",
      description: "Cancel a running sub-agent started by spawn_agent.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Sub-agent id returned by spawn_agent" },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ask_user",
      description:
        "Ask the user a clarifying question mid-task and wait for the answer. Use when a requirement is genuinely ambiguous and guessing wrong would be costly. Where no interactive user exists (one-shot runs, goal mode, background sub-agents) the tool does not block — it tells you to proceed on a stated assumption instead.",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "The question to ask the user" },
          options: { type: "array", items: { type: "string" }, description: "Optional choices to present" },
        },
        required: ["question"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "memory_save",
      description:
        "Save a durable fact to persistent memory (survives across sessions and projects). Use for user preferences, project goals, decisions, and lessons learned — not for things already in the code or this conversation.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "The fact to remember, written so it makes sense out of context" },
          tags: { type: "array", items: { type: "string" }, description: "Optional topic tags, e.g. ['preferences','omni']" },
        },
        required: ["text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "memory_search",
      description: "Search persistent memory by keywords. Returns the best-matching saved facts with their ids.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Keywords to search for" },
          limit: { type: "integer", description: "Max results, default 8" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "memory_list",
      description: "List the most recent persistent memories.",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "integer", description: "Max entries, default 20" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "memory_forget",
      description: "Delete a persistent memory by its id (use when a saved fact is wrong or obsolete).",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Memory id, e.g. 'm1a2b3c4'" },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "memory_deprecate",
      description: "Mark a memory atom deprecated (wrong, obsolete, or no longer relevant) without deleting its history.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Id of the atom to deprecate (from memory_search or memory_atoms)." },
          reason: { type: "string", description: "Why this atom no longer holds — kept on the record so the change is auditable." },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "memory_explain",
      description: "Show the full lifecycle of a memory atom: its status history, sources, and which atoms it contradicts, is contradicted by, or supersedes. Use this before trusting or acting on a surprising recalled memory.",
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: "Id of the atom to explain (from memory_search or memory_atoms)." } },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "memory_atoms",
      description: "List layered-okf memory atoms (weight-ranked, heaviest first), optionally filtered by status (active|superseded|deprecated) or type.",
      parameters: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["active", "superseded", "deprecated"], description: "Only return atoms in this lifecycle state (default: all)." },
          type: { type: "string", description: "Only return atoms of this type, e.g. 'reference', 'decision', 'gotcha'." },
          limit: { type: "integer", description: "Max atoms to return (default 20)." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "rag_search",
      description:
        "Retrieve the most relevant code/doc chunks from the workspace RAG index (BM25 over chunked files, camelCase-aware). Use during EXPLORE to find where something lives when you don't know the exact file. Auto-builds/refreshes the index on first use.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "What to look for — identifiers, phrases, or a short description" },
          k: { type: "integer", description: "Max chunks to return, default 6" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "rag_index",
      description:
        "(Re)build the workspace RAG index used by rag_search. Only needed to force a full rebuild — rag_search refreshes stale indexes automatically.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "find_symbol",
      description:
        "Code navigation: locate where a symbol (function, class, method, variable, type) is DEFINED, using language-aware patterns across JS/TS, Python, Go, Rust, C#, Java, PHP, Ruby and more. Set references=true to list every usage instead. Faster and more precise than plain search for jump-to-definition style questions.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Exact symbol name, e.g. 'resolveModel'" },
          kind: { type: "string", enum: ["any", "function", "class", "variable"], description: "Narrow the definition patterns; default any" },
          path: { type: "string", description: "Directory or file to search, default workspace root" },
          references: { type: "boolean", description: "true = list all usages instead of definitions" },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "deps",
      description:
        "Package-manager integration: auto-detects the project's manager(s) (npm/pnpm/yarn/bun, pip, cargo, go, composer, bundler, dotnet) and runs read-only dependency commands. Actions: detect (which managers apply), list (installed direct deps), outdated (available updates), audit (known vulnerabilities). Use run_shell for installs.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["detect", "list", "outdated", "audit"], description: "Default detect" },
          manager: { type: "string", description: "Override auto-detection, e.g. 'pip' in a mixed repo" },
          timeout_ms: { type: "integer", description: "Command timeout, default 120000" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "lsp",
      description:
        "Semantic code intelligence via a Language Server (TypeScript/JS, Python, Rust, Go, C#). Actions: definition (jump to where the symbol under a position is defined), references (all usages), hover (type/signature/docs), symbols (file outline), diagnostics (server-reported errors/warnings). Positions are 1-based. Requires the language server to be installed; the error message says how if it isn't. Prefer this over find_symbol when exact semantic answers matter.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["definition", "references", "hover", "symbols", "diagnostics"], description: "Which language-server query to run: jump to definition, list references, hover type info, document symbols, or current diagnostics." },
          path: { type: "string", description: "File to query" },
          line: { type: "integer", description: "1-based line (required for definition/references/hover)" },
          character: { type: "integer", description: "1-based column, default 1" },
        },
        required: ["action", "path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "rename_symbol",
      description:
        "Semantic rename via the Language Server — updates every reference across the whole workspace atomically (unlike search + edit_file per file). Point at one usage or the declaration; the server finds the rest. Same language support as lsp. Use dry_run=true to preview which files/how many edits before writing.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File containing the symbol" },
          line: { type: "integer", description: "1-based line of the symbol" },
          character: { type: "integer", description: "1-based column, default 1" },
          new_name: { type: "string", description: "The new identifier name" },
          dry_run: { type: "boolean", description: "Preview affected files/edit counts without writing" },
        },
        required: ["path", "line", "new_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "test_coverage",
      description:
        "Run the project's tests WITH coverage, auto-picking the right runner (vitest/jest/c8/nyc for Node, pytest --cov for Python, go test -cover, cargo llvm-cov, dotnet). Use dry_run=true to see the command without executing. Pass command to override.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Explicit coverage command; omit to auto-detect" },
          timeout_ms: { type: "integer", description: "Timeout, default 300000" },
          dry_run: { type: "boolean", description: "Only report which command would run" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "lint_check",
      description:
        "Run the project's linter/formatter, auto-detecting the setup: package.json scripts (lint, format, format:check) first, then config files (biome.json, .eslintrc*/eslint.config.*, .prettierrc*, ruff.toml or pyproject [tool.ruff], .rubocop.yml). Executes through the same risk-gated shell path as run_shell.",
      parameters: {
        type: "object",
        properties: {
          fix: { type: "boolean", description: "Run the fix/write variant instead of check-only (default false)" },
          path: { type: "string", description: "Optional file or directory inside the workspace to scope the run to" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "security_scan",
      description:
        "Security sweep of the workspace: (secrets) pattern-scan for hardcoded credentials, API keys, tokens and private keys — reports file:line and rule only, never the value — plus .env hygiene; (deps) run the package manager's vulnerability audit. scope=all runs both.",
      parameters: {
        type: "object",
        properties: {
          scope: { type: "string", enum: ["all", "secrets", "deps"], description: "Default all" },
          path: { type: "string", description: "Directory for the secrets scan, default workspace root" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "system_info",
      description:
        "Report the user's machine: OS version, CPU, RAM, GPU, disks, hostname, Node version, shell, cwd. Use when diagnosing environment-dependent problems.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "dev_env_report",
      description:
        "Probe ~85 developer toolchains in parallel across 16 categories (JS/TS, Python, PHP, Ruby, Rust, Go, JVM, .NET/C#, C/C++, Perl, other languages, shells/WSL, version control, containers, databases, utilities). Reports version and resolved PATH location for each, flags missing ones per category, and lists broken PATH entries. Use this FIRST when a problem might be a missing dependency or PATH issue.",
      parameters: {
        type: "object",
        properties: {
          tools: {
            type: "array",
            items: { type: "string" },
            description: "Optional subset of executables to probe (default: the full common toolchain list)",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "where_is",
      description: "Locate an executable on PATH (like `where` on Windows / `which -a` on Unix). Returns every match or 'not found'.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Executable name, e.g. 'python' or 'cargo'" },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_markdown_report",
      description: "Create a markdown report file with a given title and content.",
      parameters: {
        type: "object",
        properties: {
          filename: { type: "string", description: "File name (e.g., Audit52.md)" },
          title: { type: "string", description: "Title of the report" },
          content: { type: "string", description: "Markdown content to write" },
        },
        required: ["filename", "title", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "settings_add_model",
      description:
        "Add (or update) a model in the active session and persist it to settings.json. " +
        "The model is available immediately — no restart needed. " +
        "Use this instead of editing settings.json directly, which only changes disk and leaves the running session stale. " +
        "The provider must already exist (check with the provider field of existing models, or see settings.json).",
      parameters: {
        type: "object",
        properties: {
          key:      { type: "string",  description: "Model key used in /model commands, e.g. 'groq/llama-3.3-70b'" },
          provider: { type: "string",  description: "Provider name, e.g. 'groq', 'nvidia', 'openrouter'" },
          model_id: { type: "string",  description: "The provider's own model ID, e.g. 'llama-3.3-70b-versatile'" },
          max_tokens: { type: "integer", description: "Max output tokens (default 8192)" },
        },
        required: ["key", "provider", "model_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "settings_set_apikey",
      description:
        "Set or update an API key for an existing provider in the active session and persist it to settings.json. " +
        "Takes effect immediately — no restart needed. " +
        "Use this instead of editing settings.json directly.",
      parameters: {
        type: "object",
        properties: {
          provider: { type: "string", description: "Provider name, e.g. 'groq', 'openrouter'" },
          api_key:  { type: "string", description: "The API key to set" },
        },
        required: ["provider", "api_key"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_skill",
      description:
        "Search the skill catalog by keyword. Returns up to `limit` skills ranked by relevance to `query`, " +
        "each shown as `command — description`. Skill bodies are NOT ambient — call this whenever you're " +
        "about to improvise a workflow to see if a matching skill exists. Then call invoke_skill(command) to " +
        "load that skill's full instructions for the current turn (body is evicted afterward).",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Keywords describing the task (e.g. 'html game', 'code review', 'okf memory')" },
          limit: { type: "integer", description: "Max results to return (default 5, max 20)" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "invoke_skill",
      description:
        "Load a skill's full instructions into the current turn — equivalent to the user typing /<command>. " +
        "The body is ephemeral: it's dropped after this turn's tool loop finishes, so it doesn't re-bill on " +
        "subsequent turns. Use find_skill first to discover the exact command name. Once loaded, follow the " +
        "skill's instructions to complete the user's task.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Skill command, with or without the leading slash (e.g. '/code-review' or 'code-review')" },
          args: { type: "string", description: "Optional arguments to pass to the skill" },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_tool",
      description:
        "Create a brand-new tool for yourself, right now — no restart needed. Write the " +
        "full source of an Omni Agent extension module: an ESM file that default-exports " +
        "{ name, tools: [...OpenAI function-tool schemas], impl: { toolName: fn } }. " +
        "It's written to extensions/<name>.js, hot-loaded into THIS session immediately " +
        "(the new tool name(s) are callable on your very next turn), and persisted to " +
        "omni.config.json so it survives restarts. Calling this again with the same " +
        "`name` replaces the previous version — old tool names from that file are dropped " +
        "first, so you can iterate on a broken tool without leaving stale duplicates. " +
        "impl functions receive the parsed args object, may be sync or async, and whatever " +
        "they return is stringified and sent back to the model as the tool result; a thrown " +
        "error becomes the error message the model sees. Prefer node: built-ins only (no " +
        "npm packages available). Scope any filesystem access to the workspace.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Extension name — alnum/dash/underscore only. File becomes extensions/<name>.js.",
          },
          code: {
            type: "string",
            description: "Full ESM module source implementing the { name, tools, impl } contract.",
          },
        },
        required: ["name", "code"],
      },
    },
  },
];

export const impl = {
  async read_file({ path: p, offset = 1, limit = 2000 }) {
    requireArg("read_file", "path", p);
    const full = resolve(p);
    if (!fs.existsSync(full)) throw new Error(`File not found: ${p}`);
    const stat = fs.statSync(full);
    if (stat.size > 5 * 1024 * 1024) throw new Error(`File too large (${(stat.size / 1024 / 1024).toFixed(1)} MB): ${p}`);
    const start = Math.max(1, offset);
    const end = start + limit;
    const lines = [];
    let lineNum = 0;
    let isFirstEmittedLine = true; // strip UTF-8 BOM from the very first emitted line only (TODO #15)

    const stream = createReadStream(full, { encoding: "utf8" });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    for await (const line of rl) {
      lineNum++;
      if (lineNum >= end) break; // got all we need — stop reading
      if (lineNum >= start) {
        const cleaned = isFirstEmittedLine ? line.replace(/^\uFEFF/, "") : line;
        isFirstEmittedLine = false;
        lines.push(`${String(lineNum).padStart(5)}\t${cleaned}`);
      } else {
        // Track even pre-start lines so the BOM only survives on the first
        // emitted line, not on the first file line. Once we've passed the
        // start, isFirstEmittedLine is set false on the next iteration.
        if (lineNum >= start - 1) isFirstEmittedLine = false;
      }
    }

    stream.destroy(); // ensure file handle is released
    return clip(lines.join("\n") || "(empty file)");
  },

  // Search the skill catalog by keywords. Ranks skills by BM25 against
  // "<command> <description> <category>" — no bodies sent to the model.
  //
  // Searches the bundled catalog (<INSTALL_ROOT>/skills, attached to ctx by
  // main.mjs) AND any skills the scan-now hook indexed from an external
  // folder. The scanner has always written that index; nothing read it until
  // now, so hundreds of scanned skills were invisible every session.
  find_skill({ query, limit = 5 }) {
    if (!query || !String(query).trim()) throw new Error("query is required");
    const bundled = _sessionCtx?.skills || [];
    const external = loadScannedSkills(_sessionCtx?.project, bundled);
    const skills = [...bundled, ...external];
    if (!skills.length) return "(no skills loaded in this session)";
    const cap = Math.min(Math.max(1, Number(limit) || 5), 20);
    const haystack = skills.map((s) => `${s.command} ${s.description || ""} ${s.category || ""}`);
    const ranked = rankChunks(String(query), haystack);
    const top = ranked.slice(0, cap);
    if (!top.length || top[0].score === 0) return `(no skills match "${query}" — try broader keywords)`;
    // rankChunks already returns the source index — use it directly instead
    // of an O(N²) indexOf lookup that also mis-selects on duplicate haystack
    // strings.
    return top
      .map((r) => {
        const s = skills[r.index];
        const tag = s.external ? " [external]" : "";
        return `${s.command}${tag} — ${(s.description || "").slice(0, 200)}`;
      })
      .join("\n");
  },

  // Load a skill's body for the current turn (equivalent to the user typing
  // /<command>). The body is marked ephemeral: it lives for the turn that
  // triggered it, then evicted by the REPL after runAgentTurns finishes.
  // Enables autonomous flows (goal mode, sub-agents) to self-serve on skills
  // without needing a human to type the slash command.
  invoke_skill({ command, args = "" }) {
    if (!command || !String(command).trim()) throw new Error("command is required (e.g. '/code-review' or 'code-review')");
    const ctx = _sessionCtx;
    if (!ctx || !Array.isArray(ctx.skills)) throw new Error("no active session context — skill invocation only works inside an interactive session");
    const wanted = String(command).trim();
    const norm = wanted.startsWith("/") ? wanted : "/" + wanted;
    // Bundled first (they win on a name collision), then anything the
    // scan-now hook indexed from an external folder.
    const skill =
      ctx.skills.find((s) => s.command === norm) ||
      loadScannedSkills(ctx.project, ctx.skills).find((s) => s.command === norm);
    if (!skill) return `unknown skill: ${norm}. Call find_skill(query) to list matching commands.`;
    // Push the skill body straight into the live conversation. The REPL's
    // post-turn eviction (evictEphemeralSkillMessages) will drop it once
    // this turn's loop returns to plain-text.
    const sysMsg = { role: "system", content: `# Skill: ${skill.name}\n${skill.body}` };
    markSkillEphemeral(sysMsg);
    ctx.messages.push(sysMsg);
    return `Loaded skill "${skill.name}" for this turn (${(skill.body || "").length} chars). Follow its instructions${args ? ` with these arguments: ${args}` : ""}.`;
  },

  rag_search({ query, k = 6 }) {
    requireArg("rag_search", "query", query);
    const hits = ragSearch(query, Math.min(Math.max(k, 1), 20));
    if (!hits.length) return "(no matching chunks — try different keywords, or rag_index to rebuild)";
    return clip(hits
      .map((h) => `--- ${h.file}:${h.startLine}-${h.endLine} (score ${h.score.toFixed(2)}) ---\n${h.text}`)
      .join("\n\n"));
  },

  rag_index() {
    const { files, chunks, skipped } = ragBuild();
    return `Indexed ${files} file(s) into ${chunks} chunk(s)${skipped ? ` (${skipped} skipped: too large or over limits)` : ""}.`;
  },

  find_symbol({ name, kind = "any", path: p = ".", references = false }) {
    if (!name || !/^[\w$.]+$/.test(name)) throw new Error("name must be a plain symbol (letters, digits, _, $, .)");
    const n = name.replace(/[.$]/g, "\\$&");

    // Definition patterns by symbol kind, covering the common languages.
    // Keyword-led declarations are the reliable core; assignment and method
    // forms catch JS/TS arrow functions and class bodies.
    const PATTERNS = {
      function: [
        `(?:function|def|fn|func|sub|proc)\\s+(?:\\([^)]*\\)\\s*)?${n}\\b`,
        `${n}\\s*[:=]\\s*(?:async\\s+)?(?:function\\b|\\()`,
        `^\\s*(?:public|private|protected|internal|static|final|override|virtual|async|export)[\\w<>\\[\\], ]*\\s${n}\\s*\\(`,
        `^\\s*(?:async\\s+)?${n}\\s*\\([^)]*\\)\\s*\\{`,
      ],
      class: [
        `(?:class|struct|enum|trait|interface|type|module|impl|protocol|record)\\s+${n}\\b`,
      ],
      variable: [
        `(?:const|let|var|val|static|readonly)\\s+(?:mut\\s+)?${n}\\b`,
        `^\\s*${n}\\s*[:=][^=]`,
      ],
    };
    const patterns = references
      ? [`\\b${n}\\b`]
      : kind === "any"
        ? [...PATTERNS.function, ...PATTERNS.class, ...PATTERNS.variable]
        : PATTERNS[kind] || [];
    if (!patterns.length) throw new Error(`kind must be any, function, class, or variable`);

    const args = ["--line-number", "--no-heading", "--color", "never"];
    for (const pat of patterns) args.push("-e", pat);
    if (references) args.push("--max-count", "50");
    args.push(resolve(p));
    const r = spawnSync(rgPath(), args, { encoding: "utf8", maxBuffer: 1024 * 1024 * 16 });
    if (r.error) return "find_symbol unavailable: " + r.error.message;
    if (r.status === 1 || !r.stdout) {
      return references
        ? `(no references to "${name}" found)`
        : `(no definition of "${name}" found — try references=true or a broader path)`;
    }
    const label = references ? `References to "${name}"` : `Definitions of "${name}"`;
    return clip(`${label}:\n${r.stdout.trim()}`);
  },

  deps({ action = "detect", manager, timeout_ms = 120000 }) {
    const detected = detectPackageManagers();
    if (action === "detect") {
      return detected.length
        ? `Detected package manager(s): ${detected.join(", ")}\nAvailable actions: list, outdated, audit.`
        : "(no package-manager manifests found in this workspace)";
    }
    const mgr = String(manager || detected[0] || "").toLowerCase();
    if (!mgr) return "(no package manager detected — nothing to run)";
    const commands = DEPS_COMMANDS[mgr];
    if (!commands) throw new Error(`unsupported manager "${mgr}" (known: ${Object.keys(DEPS_COMMANDS).join(", ")})`);
    const command = commands[action];
    if (!command) throw new Error("action must be detect, list, outdated, or audit");
    return `$ ${command}\n` + runShellCommand({ command, timeout_ms });
  },

  async read_many_files({ paths = [], limit_per_file = 400 }) {
    if (!Array.isArray(paths) || paths.length === 0) throw new Error("paths must be a non-empty array");
    const parts = [];
    for (const p of paths.slice(0, 25)) {
      try {
        const content = await impl.read_file({ path: p, offset: 1, limit: limit_per_file });
        parts.push(`--- ${p} ---\n${content}`);
      } catch (e) {
        parts.push(`--- ${p} ---\nERROR: ${e.message}`);
      }
    }
    return clip(parts.join("\n\n"));
  },

  write_file({ path: p, content }) {
    // Without this, a missing or non-string body reached fs.writeFileSync and
    // came back as a TypeError about "the data argument" — which names nothing
    // the model can act on, so it retries the same broken call. Say what's
    // wrong instead. Numbers/booleans are a harmless stringify; an object is
    // not (String(obj) would quietly write "[object Object]").
    if (content === undefined || content === null) {
      throw new Error("content is required — pass the full file body as a string");
    }
    if (typeof content === "object") {
      throw new Error("content must be a string (the file body), not an object — serialize it first");
    }
    const text = typeof content === "string" ? content : String(content);
    const full = resolveForCreate(p);
    atomicWriteFileSync(full, text);
    const lines = text.split("\n").length;
    return `Wrote ${text.length} bytes (${lines} lines) to ${p}`;
  },

  edit_file({ path: p, old_string, new_string }) {
    if (old_string === undefined) throw new Error("old_string is required");
    if (new_string === undefined) throw new Error("new_string is required");
    const full = resolve(p);
    if (!fs.existsSync(full)) throw new Error(`File not found: ${p}`);
    const raw = fs.readFileSync(full, "utf8");
    // Match on LF-normalized text so a model's "\n" finds a file's "\r\n".
    const eol = detectEol(raw);
    const text = toLf(raw);
    const needle = toLf(old_string);
    const count = text.split(needle).length - 1;
    if (count === 0) throw new Error("old_string not found in file");
    if (count > 1) throw new Error(`old_string matched ${count} times; make it unique`);
    // Use a function replacer so `$&`, `$\``, `$'`, `$1`, `$$` in new_string are
    // inserted literally instead of being interpreted as replacement patterns.
    const newText = text.replace(needle, () => toLf(new_string));
    atomicWriteFileSync(full, fromLf(newText, eol));
    const diff = new_string.length - old_string.length;
    const sign = diff >= 0 ? "+" : "";
    return `Edited ${p} (${sign}${diff} chars)`;
  },

  edit_lines({ path: p, start_line, end_line, new_string }) {
    if (new_string === undefined) throw new Error("new_string is required");
    if (!Number.isInteger(start_line) || start_line < 1) throw new Error("start_line must be a positive integer (1-based)");
    if (!Number.isInteger(end_line)) throw new Error("end_line must be an integer (pass end_line < start_line to insert before start_line)");
    const full = resolve(p);
    if (!fs.existsSync(full)) throw new Error(`File not found: ${p}`);
    const raw = fs.readFileSync(full, "utf8");
    // Normalize to LF for the line math, then write back in the file's own
    // convention. Letting the "\r" ride along on each line (the previous
    // approach) kept untouched lines byte-identical but spliced the model's
    // LF-only new_string in beside them, so every edit left the file a bit
    // more mixed.
    const eol = detectEol(raw);
    const text = toLf(raw);
    // A trailing "\n" is the last line's terminator, not an extra empty line.
    const hadFinalNewline = text.endsWith("\n");
    const lines = text === "" ? [] : text.split("\n");
    if (hadFinalNewline) lines.pop();
    const total = lines.length;
    // Two ways to land past the last line, and both mean "add to the end":
    //   - the explicit insert form, end_line < start_line
    //   - start_line === total + 1, which names the first line that doesn't
    //     exist yet — what every model reaches for when it wants to append.
    // The second one used to be a hard error, and the model's reflex on that
    // error is to retry with start_line = total, which REPLACES the last line.
    // So an append was a failed write followed by a silent deletion of the
    // line it was trying to write after. Treat it as the append it is.
    const appending = start_line === total + 1;
    const inserting = appending || end_line < start_line;
    if (inserting) {
      if (start_line > total + 1) {
        throw new Error(`cannot insert before line ${start_line}: ${p} has ${total} line(s) (valid insert range is 1-${total + 1})`);
      }
    } else {
      if (start_line > total) {
        throw new Error(`start_line ${start_line} out of range: ${p} has ${total} line(s) (use start_line ${total + 1} to append to the end)`);
      }
      // An end_line past the last line can only mean "through the end of the
      // file" — the old hard error just made the model retry with `total`.
      if (end_line > total) end_line = total;
    }
    // A single trailing newline in new_string terminates the last replacement
    // line; it does not add an empty line after it.
    const incoming = toLf(new_string);
    const body = incoming.endsWith("\n") ? incoming.slice(0, -1) : incoming;
    const newLines = body === "" ? [] : body.split("\n");
    const removed = inserting ? 0 : end_line - start_line + 1;
    lines.splice(start_line - 1, removed, ...newLines);
    let out = lines.join("\n");
    if (hadFinalNewline && out !== "") out += "\n"; // preserve trailing-newline state
    atomicWriteFileSync(full, fromLf(out, eol));
    if (appending) return `Edited ${p}: appended ${newLines.length} line(s) (${total} → ${lines.length} lines)`;
    if (inserting) return `Edited ${p}: inserted ${newLines.length} line(s) before line ${start_line} (${total} → ${lines.length} lines)`;
    if (!newLines.length) return `Edited ${p}: deleted lines ${start_line}-${end_line} (${total} → ${lines.length} lines)`;
    return `Edited ${p}: replaced lines ${start_line}-${end_line} with ${newLines.length} line(s) (${total} → ${lines.length} lines)`;
  },

  apply_patch({ patch }) {
    return applyPatchText(patch);
  },

  list_dir({ path: p = ".", recursive = false }) {
    const full = resolve(p);
    if (!fs.existsSync(full)) throw new Error(`Directory not found: ${p}`);
    if (!fs.statSync(full).isDirectory()) throw new Error(`Not a directory: ${p}`);
    if (recursive) {
      const args = [
        ".",
        ".",
        "--type",
        "f",
        "--type",
        "d",
        "--hidden",
        "--no-ignore",
        "--color",
        "never",
      ];
      const r = spawnSync(fdPath(), args, {
        cwd: full,
        encoding: "utf8",
        maxBuffer: 1024 * 1024 * 16,
      });
      if (!r.error && r.status === 0) {
        const entries = (r.stdout || "")
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => line.replace(/\\/g, "/").replace(/^\.\//, ""))
          .map((rel) => {
            const clean = rel.replace(/\/+$/, "");
            if (!clean) return clean;
            try {
              return fs.statSync(path.join(full, clean)).isDirectory() ? `${clean}/` : clean;
            } catch {
              return clean;
            }
          })
          .filter(Boolean)
          .sort();
        return clip(entries.join("\n") || "(empty)");
      }

      // Fallback to recursive Node walk if fd is unavailable.
      const fallbackEntries = [];
      function walk(dir, prefix) {
        const items = fs.readdirSync(dir, { withFileTypes: true });
        for (const item of items.sort()) {
          const rel = prefix ? `${prefix}/${item.name}` : item.name;
          if (item.isDirectory()) {
            fallbackEntries.push(rel + "/");
            try { walk(path.join(dir, item.name), rel); } catch { /* skip */ }
          } else {
            fallbackEntries.push(rel);
          }
        }
      }
      walk(full);
      return clip(fallbackEntries.join("\n") || "(empty)");
    }
    const entries = fs.readdirSync(full, { withFileTypes: true });
    return clip(
      entries
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .sort()
        .join("\n") || "(empty)"
    );
  },

  search({ pattern, path: p = ".", glob, case_insensitive = false, context = 0 }) {
    requireArg("search", "pattern", pattern);
    const args = ["--line-number", "--no-heading", "--color", "never", "-e", pattern];
    if (case_insensitive) args.push("-i");
    if (context > 0) args.push("-C", String(context));
    if (glob) args.push("--glob", glob);
    args.push(resolve(p));
    const r = spawnSync(rgPath(), args, { encoding: "utf8", maxBuffer: 1024 * 1024 * 16 });
    if (r.error) {
      // Node.js fallback when rg is unavailable.
      try {
        return clip(searchFallback(pattern, resolve(p), glob, case_insensitive));
      } catch (e) {
        return "search unavailable: " + r.error.message;
      }
    }
    if (r.status === 1) return "(no matches)";
    return clip(r.stdout || r.stderr || "(no matches)");
  },

  find_replace({ pattern, replacement, path: p = ".", glob, case_insensitive = false, regex = false, dry_run = false }) {
    if (!pattern) throw new Error("pattern is required");
    if (replacement == null) throw new Error("replacement is required");
    // ReDoS guard (TODO #17) — check BEFORE ripgrep, so a malicious regex
    // is rejected even when no files match (otherwise we'd return
    // "(no matches)" and let the bad pattern through).
    if (regex && hasNestedQuantifier(pattern)) {
      throw new Error(`pattern contains a nested quantifier (ReDoS risk) — rephrase to avoid (X+)+ / (X*)* / (X+)? shapes`);
    }
    const root = resolve(p);

    // Find candidate files with ripgrep (same conventions as `search`); the
    // actual substitution happens in JS below so this needs the file list,
    // not per-line matches.
    const args = ["--files-with-matches", "--color", "never"];
    if (case_insensitive) args.push("-i");
    if (!regex) args.push("--fixed-strings");
    if (glob) args.push("--glob", glob);
    args.push("-e", pattern, root);
    const r = spawnSync(rgPath(), args, { encoding: "utf8", maxBuffer: 1024 * 1024 * 16 });
    if (r.error) throw new Error("find_replace requires ripgrep: " + r.error.message);
    if (r.status === 1) return "(no matches)";
    if (r.status !== 0) return clip(r.stderr || `ripgrep exited with code ${r.status}`);

    const files = (r.stdout || "").split("\n").map((s) => s.trim()).filter(Boolean);
    if (!files.length) return "(no matches)";

    let re;
    try {
      const source = regex ? pattern : pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      re = new RegExp(source, case_insensitive ? "gi" : "g");
    } catch (e) {
      throw new Error(`invalid pattern: ${e.message}`);
    }

    const results = [];
    for (const file of files) {
      let content;
      try { content = fs.readFileSync(file, "utf8"); } catch { continue; }
      if (content.includes("\0")) continue; // binary file — skip

      let updated;
      let count;
      if (regex) {
        // Regex mode: replacement can use $1/$2/$&/$$ backreferences against
        // capture groups — the string form of .replace() handles that natively.
        const matches = content.match(re);
        if (!matches) continue;
        count = matches.length;
        updated = content.replace(re, replacement);
      } else {
        // Literal mode: insert replacement exactly as given. A function
        // replacer means a literal "$1" or "$&" the user typed isn't
        // mistaken for a backreference (matches edit_file's convention).
        count = 0;
        updated = content.replace(re, () => { count++; return replacement; });
      }
      if (!count) continue;
      // Keep `content` on the result so the rollback journal below can put
      // the file back exactly as it was if a later write in the batch fails.
      results.push({ file, rel: path.relative(process.cwd(), file).replace(/\\/g, "/"), content, updated, count });
    }
    if (!results.length) return "(no matches)";

    const totalCount = results.reduce((n, r2) => n + r2.count, 0);
    const summary = results.map((r2) => `  ${r2.rel} (${r2.count} occurrence${r2.count === 1 ? "" : "s"})`).join("\n");

    if (dry_run) {
      return `DRY RUN — would replace ${totalCount} occurrence(s) across ${results.length} file(s):\n${summary}`;
    }

    // Validate every touched path against the workspace boundary before
    // writing anything — same all-or-nothing discipline as rename_symbol.
    for (const r2 of results) assertInsideWorkspace(r2.file, "replace target");

    // Rollback journal: for every file we touch, keep the original content so
    // a mid-write failure can put the workspace back exactly as it was. The
    // `original` is the text we read above to compute `updated` — already in
    // memory, so rollback is cheap.
    const journal = results.map((r2) => ({ path: r2.file, original: r2.content, updated: r2.updated, rel: r2.rel }));
    const written = [];
    try {
      for (const r2 of journal) {
        atomicWriteFileSync(r2.path, r2.updated);
        written.push(r2);
      }
    } catch (e) {
      // Restore every file we already wrote. Best-effort — if a rollback
      // write itself fails (e.g. permission changed mid-flight), the
      // secondary error is appended to the message so the user can
      // identify the file that's still in the wrong state.
      const rollbackErrors = [];
      for (const r2 of written) {
        try {
          atomicWriteFileSync(r2.path, r2.original);
        } catch (re) {
          rollbackErrors.push(`${r2.rel}: ${re.message}`);
        }
      }
      const completed = written.map((r2) => r2.rel).join(", ") || "(none)";
      const remaining = journal.slice(written.length).map((r2) => r2.rel).join(", ");
      throw new Error(
        `replaced in ${written.length}/${results.length} file(s) before failing: ${e.message}\n` +
        `Rolled back: ${completed}\n` +
        `Not written: ${remaining}` +
        (rollbackErrors.length ? `\nRollback errors (workspace NOT fully restored): ${rollbackErrors.join("; ")}` : "")
      );
    }
    return `Replaced ${totalCount} occurrence(s) across ${results.length} file(s):\n${summary}`;
  },

  find_files({ pattern = ".", path: p = ".", type, max_depth, extension, respect_gitignore = false }) {
    const full = resolve(p);
    if (!fs.existsSync(full)) throw new Error(`Directory not found: ${p}`);
    if (!fs.statSync(full).isDirectory()) throw new Error(`Not a directory: ${p}`);

    const args = ["--color", "never", "--hidden"];
    if (!respect_gitignore) args.push("--no-ignore");
    if (Number.isInteger(max_depth) && max_depth >= 0) {
      args.push("--max-depth", String(max_depth));
    }

    if (type) {
      const t = String(type).toLowerCase();
      if (t === "f" || t === "file") args.push("--type", "f");
      else if (t === "d" || t === "dir" || t === "directory") args.push("--type", "d");
      else if (t === "symlink" || t === "l") args.push("--type", "l");
      else throw new Error(`Unsupported type: ${type}. Use f, d, or symlink.`);
    }

    if (extension) {
      for (const ext of String(extension).split(",").map(s => s.trim()).filter(Boolean)) {
        args.push("--extension", ext);
      }
    }

    if (/[*?\[\]{}]/.test(pattern)) args.push("--glob");

    args.push(pattern, ".");

    const r = spawnSync(fdPath(), args, {
      cwd: full,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 16,
    });
    if (r.error) return "find_files unavailable: " + r.error.message;
    if (r.status === 1) return "(no matches)";
    if (r.status && r.status !== 0) return clip(r.stderr || `fd exited with code ${r.status}`);

    const out = (r.stdout || "")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => line.replace(/\\/g, "/").replace(/^\.\//, ""))
      .join("\n");
    return clip(out || "(no matches)");
  },

  run_shell({ command, timeout_ms = 120000, allow_unsafe = false, dry_run = false }) {
    return runShellCommand({ command, timeout_ms, allow_unsafe, dry_run });
  },

  run_test({ command = "npm test", timeout_ms = 120000, allow_unsafe = false, dry_run = false }) {
    return runShellCommand({ command, timeout_ms, allow_unsafe, dry_run });
  },

  async lsp({ action, path: p, line, character }) {
    // Unlike every other read tool here, lspRequest itself never checked
    // containment — it just path.resolve()'d whatever it was given, so it
    // could read/analyze any file on disk with a supported extension. Same
    // workspace boundary as resolve() uses everywhere else.
    resolve(p);
    return clip(await lspRequest({ action, path: p, line, character }));
  },

  async rename_symbol({ path: p, line, character, new_name, dry_run = false }) {
    const { files, totalEdits } = await lspRenamePlan({ path: p, line, character, newName: new_name });
    if (!files.length) return "No edits — the server found nothing to rename (wrong position, or the symbol has no other references).";

    // Validate every touched path against the workspace boundary BEFORE
    // writing anything, exactly like every other write tool — a language
    // server response is still untrusted input as far as the workspace guard
    // is concerned. All-or-nothing: if any file fails containment, nothing
    // is written.
    for (const f of files) assertInsideWorkspace(f.absPath, "rename target");

    const summary = files.map((f) => `  ${f.relPath} (${f.editCount} edit${f.editCount === 1 ? "" : "s"})`).join("\n");
    if (dry_run) {
      return `DRY RUN — would rename across ${files.length} file(s), ${totalEdits} edit(s):\n${summary}`;
    }

    // Rollback journal: read each file's current content first so a mid-write
    // failure can put it back exactly as it was. Same discipline as
    // find_replace — the LSP response is trusted but the disk is not.
    const journal = [];
    for (const f of files) {
      let original = "";
      try { original = fs.readFileSync(f.absPath, "utf8"); } catch { /* new file */ }
      journal.push({ absPath: f.absPath, relPath: f.relPath, original, newContent: f.newContent });
    }

    const written = [];
    try {
      for (const j of journal) {
        atomicWriteFileSync(j.absPath, j.newContent);
        written.push(j);
      }
    } catch (e) {
      const rollbackErrors = [];
      for (const j of written) {
        try {
          atomicWriteFileSync(j.absPath, j.original);
        } catch (re) {
          rollbackErrors.push(`${j.relPath}: ${re.message}`);
        }
      }
      const completed = written.map((j) => j.relPath).join(", ") || "(none)";
      const remaining = journal.slice(written.length).map((j) => j.relPath).join(", ");
      throw new Error(
        `renamed ${written.length}/${files.length} file(s) before failing: ${e.message}\n` +
        `Rolled back: ${completed}\n` +
        `Not written: ${remaining}` +
        (rollbackErrors.length ? `\nRollback errors (workspace NOT fully restored): ${rollbackErrors.join("; ")}` : "")
      );
    }
    return `Renamed across ${files.length} file(s), ${totalEdits} edit(s):\n${summary}`;
  },

  test_coverage({ command, timeout_ms = 300000, dry_run = false }) {
    const cmd = command || coverageCommand();
    if (!cmd) return "(could not detect a test stack — pass an explicit coverage command)";
    if (dry_run) return `Would run: ${cmd}\ncwd: ${process.cwd()}`;
    return `$ ${cmd}\n` + runShellCommand({ command: cmd, timeout_ms });
  },

  lint_check({ fix = false, path: p } = {}) {
    // The command is assembled from a fixed whitelist (detected script names
    // and linter invocations), so the only model-influenced part is the path
    // scope — validate it hard before letting it near a shell string.
    let target = "";
    if (p) {
      const rel = path.relative(process.cwd(), resolve(p)).replace(/\\/g, "/");
      if (!/^[\w ./-]+$/.test(rel)) throw new Error(`path "${rel}" contains characters that are unsafe in a shell command`);
      target = `"${rel}"`;
    }
    const cmd = lintCommand({ fix: Boolean(fix), target });
    if (!cmd) return "(could not detect a lint/format setup — no lint/format/format:check script in package.json and no supported linter config found)";
    // Same gate as run_shell/run_test: runShellCommand applies the
    // unsafe-command blocklist (commandRisk) before executing — there is no
    // allow_unsafe here, so a blocked pattern is always refused.
    return `$ ${cmd}\n` + runShellCommand({ command: cmd, timeout_ms: 300000 });
  },

  security_scan({ scope = "all", path: p = "." }) {
    const sections = [];

    if (scope === "all" || scope === "secrets") {
      const findings = [];
      for (const [rule, pattern] of SECRET_RULES) {
        const args = [
          "--line-number", "--no-heading", "--color", "never", "--max-count", "20",
          "--glob", "!*.example*", "--glob", "!*.sample*", "--glob", "!*lock*",
          "-e", pattern, resolve(p),
        ];
        const r = spawnSync(rgPath(), args, { encoding: "utf8", maxBuffer: 1024 * 1024 * 16 });
        if (r.status !== 0 || !r.stdout) continue;
        for (const line of r.stdout.trim().split("\n")) {
          const m = line.match(/^(.*?):(\d+):(.*)$/);
          if (!m) continue;
          // Skip obvious placeholders to keep the report actionable.
          if (/not-needed|changeme|placeholder|example|your[-_]|<[^>]+>|xxxx/i.test(m[3])) continue;
          const rel = path.relative(process.cwd(), m[1]) || m[1];
          findings.push(`  [${rule}] ${rel}:${m[2]}`);
        }
      }
      const hygiene = [];
      if (fs.existsSync(path.join(process.cwd(), ".env"))) {
        let ignored = false;
        try { ignored = /^\s*\.?\/?\.env\b/m.test(fs.readFileSync(path.join(process.cwd(), ".gitignore"), "utf8")); } catch { /* no .gitignore */ }
        if (!ignored) hygiene.push("  .env exists but is not listed in .gitignore — real keys may get committed");
      }
      sections.push(
        `Secrets scan — ${findings.length} finding(s)${findings.length ? ":\n" + findings.join("\n") + "\n  (matched values are never printed — open each file:line to review)" : " (clean)"}` +
        (hygiene.length ? "\nHygiene:\n" + hygiene.join("\n") : "")
      );
    }

    if (scope === "all" || scope === "deps") {
      const managers = detectPackageManagers();
      if (!managers.length) {
        sections.push("Dependency audit: no package manager detected");
      } else {
        for (const mgr of managers) {
          const cmd = DEPS_COMMANDS[mgr]?.audit;
          if (!cmd) continue;
          sections.push(`Dependency audit (${mgr}) — $ ${cmd}\n` + runShellCommand({ command: cmd, timeout_ms: 180000 }));
        }
      }
    }

    return clip(sections.join("\n\n"));
  },

  jq_query({ filter, path: p, raw = false }) {
    requireArg("jq_query", "filter", filter);
    requireArg("jq_query", "path", p);
    const full = resolve(p);
    if (!fs.existsSync(full)) throw new Error(`File not found: ${p}`);
    const args = [filter];
    if (raw) args.push("-r");
    args.push(full);
    const r = spawnSync(jqPath(), args, {
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 16,
      cwd: process.cwd(),
    });
    // No jq binary (not bundled in vendor/, not on PATH — the normal state of
    // a stock Windows box). Fall back to the built-in evaluator rather than
    // handing back "jq unavailable", which left the model with no structural
    // way to read a JSON file at all.
    if (r.error) return jqFallback(filter, full, raw, r.error.message);
    if (r.status !== 0) return clip(r.stderr || `jq exited with code ${r.status}`);
    const out = (r.stdout || "").trimEnd();
    return clip(out || "(null or empty result)");
  },

  project_inspect({ path: p = ".", max_depth = 2 } = {}) {
    return inspectProject(p, max_depth);
  },

  git_status() {
    const branch = runGit(["branch", "--show-current"]);
    const status = runGit(["status", "--short"]);
    return clip(`branch: ${branch.trim() || "(detached or unknown)"}\n${status.trim() || "working tree clean"}`);
  },

  git_diff({ path: p, staged = false, stat = false } = {}) {
    const args = ["diff"];
    if (staged) args.push("--staged");
    if (stat) args.push("--stat");
    if (p) {
      // Defensive filter against option-shaped paths (TODO #14). `git diff
      // -- <path>` usually treats <path> as a literal, but git is forgiving
      // and can interpret options like `--upload-pack=…` even after `--`.
      // Reject any path that starts with `-`; the user can prefix with `./`
      // if they really need a dash-prefixed filename.
      if (String(p).startsWith("-")) throw new Error(`git_diff path "${p}" starts with '-' which git may interpret as an option; rename the file or pass "./${p}"`);
      resolve(p);
      args.push("--", p);
    }
    return runGit(args) || "(no diff)";
  },

  diff_files({ path_a, path_b, context = 3 }) {
    if (!path_a) throw new Error("path_a is required");
    if (!path_b) throw new Error("path_b is required");
    const fullA = resolve(path_a);
    const fullB = resolve(path_b);
    if (!fs.existsSync(fullA)) throw new Error(`File not found: ${path_a}`);
    if (!fs.existsSync(fullB)) throw new Error(`File not found: ${path_b}`);
    const ctx = Math.max(0, Math.min(Number.isInteger(context) ? context : 3, 50));
    // Array-form spawn (no shell string), same as extensions/git-ops.js.
    const r = spawnSync("git", ["diff", "--no-index", "--no-color", `--unified=${ctx}`, "--", fullA, fullB], {
      cwd: process.cwd(),
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 16,
    });
    if (r.error) {
      // git unavailable — built-in fallback over the raw file contents.
      const a = fs.readFileSync(fullA, "utf8");
      const b = fs.readFileSync(fullB, "utf8");
      return clip(simpleLineDiff(path_a, a, path_b, b));
    }
    // `git diff --no-index` exit codes: 0 = identical, 1 = differences found
    // (NOT an error), anything else = real failure.
    if (r.status === 0) return "(identical — no differences)";
    if (r.status === 1) return clip((r.stdout || "").trimEnd() || "(files differ, but git produced no patch — binary files?)");
    throw new Error((r.stderr || "").trim() || `git diff --no-index exited with code ${r.status}`);
  },

  git_commit({ message, paths = [], all = false, allow_unsafe = false }) {
    if (!message || !String(message).trim()) throw new Error("commit message is required");

    let candidates;
    if (all) {
      runGit(["add", "-A"]);
      candidates = runGit(["diff", "--staged", "--name-only"]).split("\n").map((s) => s.trim()).filter(Boolean);
    } else {
      const selected = Array.isArray(paths) ? paths : [];
      if (!selected.length) throw new Error("provide paths or set all=true");
      for (const p of selected) resolve(p);
      runGit(["add", "--", ...selected]);
      candidates = selected;
    }

    // Heavy-directory safety net for `all=true` (TODO #19). `git add -A`
    // stages everything; if .gitignore is missing or wrong, the entire
    // node_modules (or .venv / target / dist / …) gets committed. Refuse
    // unless the user explicitly opts in via allow_unsafe — the same gate
    // the destructive-command path uses (see checkCommandRisk). Listing
    // here matches inspectProject's skip-list so the two tools agree on
    // what counts as a build dir.
    if (!allow_unsafe) {
      const heavy = candidates.filter(isInHeavyDirectory);
      if (heavy.length) {
        runGit(["reset", "--", ...heavy]);
        candidates = candidates.filter((p) => !heavy.includes(p));
        // Surface the warning — same UX as the secret-file branch below.
        if (!candidates.length) {
          throw new Error(
            `nothing to commit — only heavy-directory files (node_modules, .venv, target, dist, …) would be staged. ` +
            `Add to .gitignore, or pass allow_unsafe=true to force.\nRefused: ${heavy.slice(0, 10).join(", ")}${heavy.length > 10 ? ` (+${heavy.length - 10} more)` : ""}`
          );
        }
      }
    }

    // Secret-looking filenames that aren't gitignored get unstaged before the
    // commit happens — a live key belongs in .gitignore, not in git history
    // forever, and git history is effectively permanent. See security audit L3.
    const risky = candidates.filter((p) => looksLikeSecretFile(p) && !isGitIgnored(p));
    if (risky.length) runGit(["reset", "--", ...risky]);

    const stagedNow = runGit(["diff", "--staged", "--name-only"]).trim();
    if (!stagedNow) {
      throw new Error(
        risky.length
          ? `nothing to commit — the only staged change(s) looked like secret file(s) and were unstaged: ${risky.join(", ")}`
          : "nothing to commit — no changes staged"
      );
    }

    const out = runGit(["commit", "-m", String(message)]);
    const warning = risky.length
      ? `\n\n⚠ Skipped staging ${risky.length} secret-looking file(s), not committed: ${risky.join(", ")} — add to .gitignore, or stage explicitly if this is a false positive.`
      : "";
    return clip(out) + warning;
  },

  project_todo(args) {
    return projectTodo(args);
  },

  start_process({ command, cwd = ".", name, allow_unsafe = false }) {
    return startManagedProcess({ command, cwd, name, allow_unsafe });
  },

  process_status({ id, logs } = {}) {
    return processStatus({ id, logs });
  },

  stop_process({ id }) {
    return stopManagedProcess(id);
  },

  async process_input({ id, input, newline = true }) {
    if (!id) throw new Error("id is required");
    if (input === undefined) throw new Error("input is required");
    const rec = managedProcesses.get(id);
    if (!rec) throw new Error(`process not found: ${id}`);
    if (rec.status !== "running") throw new Error(`process ${id} is ${rec.status} — cannot send input to it`);
    const stdin = rec.child.stdin;
    if (!stdin || stdin.destroyed || stdin.writableEnded) throw new Error(`process ${id} stdin is closed`);
    const before = rec.log.length;
    stdin.write(newline === false ? String(input) : String(input) + "\n");
    // Give the child a beat to react so the result shows the effect of the
    // input (a prompt answered, a REPL evaluation) instead of a stale log.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const fresh = rec.log.slice(before).trim();
    return clip(fresh || `(input sent to ${id}; no new output yet)`);
  },

  spawn_agent({ prompt, model, name }, context) {
    return spawnSubAgent({ prompt, model, name, permissions: context?.permissions, confirmTool: context?.confirmTool });
  },

  self_review(args) {
    return runSelfReview(args || {});
  },

  agent_status({ id }) {
    return subAgentStatus({ id });
  },

  stop_agent({ id }) {
    return stopSubAgent(id);
  },

  async ask_user({ question, options = [] }) {
    if (!question || !String(question).trim()) throw new Error("question is required");
    // The REPL wires ctx.askUser via setSessionCtx; one-shot runs, goal mode
    // and background sub-agents have no question channel. Fall back to a text
    // result instead of throwing — the model proceeds on a stated assumption.
    if (_sessionCtx && typeof _sessionCtx.askUser === "function") {
      return String(await _sessionCtx.askUser({ question: String(question), options: Array.isArray(options) ? options.map(String) : [] }));
    }
    return "No interactive user available. Proceed with the most reasonable assumption, state it explicitly, and continue.";
  },
  // Routed through the active memory provider (settings.memory.provider —
  // "legacy-jsonl" by default, or "layered-okf"). See core/memory-provider.mjs.
  memory_save({ text, tags = [] }) {
    if (!text || !String(text).trim()) throw new Error("text is required");
    const provider = activeProviderFromDisk();
    // An explicit save is a stronger signal than a heuristic cue-phrase
    // match, so it outweighs (and, on conflict, supersedes) an extracted
    // atom about the same subject — see memory-provider.mjs's weighting.
    const rec = provider.name === "layered-okf"
      ? provider.propose({ type: "fact", text, tags, confidence: 0.85 })
      : provider.propose({ text, tags });
    return `Saved memory ${rec.id}: ${String(rec.text).slice(0, 120)}`;
  },

  memory_search({ query, limit = 8 }) {
    if (!query || !String(query).trim()) throw new Error("query is required");
    const provider = activeProviderFromDisk();
    const hits = provider.search(query, {}, { limit: Math.max(1, Math.min(Number(limit) || 8, 50)) });
    if (!hits.length) return `(no memories matched "${query}")`;
    return clip(hits.map(formatMemoryRecord).join("\n"));
  },

  memory_list({ limit = 20 } = {}) {
    const provider = activeProviderFromDisk();
    const n = Math.max(1, Math.min(Number(limit) || 20, 100));
    // Pull the full set once and sort by createdAt desc — the previous
    // implementation just took the top-N from `provider.search("", ...)`,
    // which sorts by weight (layered-okf) or recency (legacy). On layered-
    // okf a heavy old atom dominated, so the label "most recent first" lied
    // (TODO #10). Sort ourselves so the order matches the label across
    // both providers.
    const all = provider.search("", {}, { limit: 1e6 });
    const total = all.length;
    if (!total) return "(no memories saved yet)";
    const recent = all
      .slice()
      .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
      .slice(0, n);
    return clip(`${total} memories total (provider: ${provider.name}), most recent first:\n` + recent.map(formatMemoryRecord).join("\n"));
  },

  memory_forget({ id }) {
    if (!id) throw new Error("id is required");
    const rec = activeProviderFromDisk().deprecate(id);
    return `Forgot memory ${rec.id || id}`;
  },

  // --- layered-okf atom inspection/correction (read-only + deprecate; there
  // is deliberately no tool to hand-author or approve an atom — every atom
  // is placed automatically by memory_save or the heuristic extractor and
  // weighed by the indexer, never by manual curation) -------------------------
  memory_deprecate({ id, reason = "" }) {
    if (!id) throw new Error("id is required");
    const atom = layeredProvider.deprecate(id, reason);
    return `Deprecated atom ${atom.id}.`;
  },

  memory_explain({ id }) {
    if (!id) throw new Error("id is required");
    return clip(explainAtomText(id));
  },

  memory_atoms({ status = "", type = "", limit = 20 } = {}) {
    const atoms = currentAtoms()
      .filter((a) => (!status || a.status === status) && (!type || a.type === type))
      .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0) || String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)))
      .slice(0, Math.max(1, Math.min(Number(limit) || 20, 100)));
    if (!atoms.length) return "(no atoms match)";
    return clip(atoms.map(formatMemoryRecord).join("\n"));
  },

  system_info() {
    return systemInfo();
  },

  dev_env_report({ tools: subset } = {}) {
    return devEnvReport(subset);
  },

  where_is({ name }) {
    return whereIs(name);
  },

  create_markdown_report({ filename, title, content }) {
    requireArg("create_markdown_report", "filename", filename);
    requireArg("create_markdown_report", "title", title);
    requireArg("create_markdown_report", "content", content);
    const full = resolveForCreate(filename);
    const markdown = `# ${title}

${content}`;
    atomicWriteFileSync(full, markdown);
    return `Created markdown report ${filename} with title "${title}"`;
  },

  async settings_add_model({ key, provider, model_id, max_tokens }) {
    if (!_sessionCtx) throw new Error("No active session context — this tool is only usable inside an interactive session.");
    const prov = _sessionCtx.settings.providers[provider];
    if (!prov) throw new Error(`Unknown provider "${provider}". Known providers: ${Object.keys(_sessionCtx.settings.providers).join(", ")}`);
    _sessionCtx.settings.models[key] = { provider, id: model_id, maxTokens: max_tokens || 8192 };
    await saveSettings(_sessionCtx.settings);
    return `Added model ${key} (provider: ${provider}, id: ${model_id}, maxTokens: ${max_tokens || 8192}). Switch with /model ${key}`;
  },

  async settings_set_apikey({ provider, api_key }) {
    if (!_sessionCtx) throw new Error("No active session context — this tool is only usable inside an interactive session.");
    const prov = _sessionCtx.settings.providers[provider];
    if (!prov) throw new Error(`Unknown provider "${provider}". Known providers: ${Object.keys(_sessionCtx.settings.providers).join(", ")}`);
    const { setProviderKey } = await import("../core/config.mjs");
    setProviderKey(prov, api_key);
    await saveSettings(_sessionCtx.settings);
    return `API key set for provider "${provider}" and saved. Key: ${api_key.slice(0, 6)}…`;
  },

  create_tool({ name, code }) {
    return createTool(name, code);
  },
};

function stripPatchLine(line, expected) {
  if (!line.startsWith(expected)) throw new Error(`Malformed patch line: ${line}`);
  return line.slice(1);
}

function collectPatchBody(lines, i) {
  const body = [];
  while (i < lines.length && !lines[i].startsWith("*** ")) {
    body.push(lines[i]);
    i++;
  }
  return { body, i };
}

function patchChunks(body) {
  const chunks = [];
  let current = [];
  for (const line of body) {
    if (line.startsWith("@@")) {
      if (current.length) chunks.push(current);
      current = [];
    } else {
      current.push(line);
    }
  }
  if (current.length) chunks.push(current);
  return chunks.length ? chunks : [body];
}

function applyUpdateChunk(text, file, body) {
  const oldLines = [];
  const newLines = [];
  for (const line of body) {
    if (line.startsWith(" ")) {
      oldLines.push(line.slice(1));
      newLines.push(line.slice(1));
    } else if (line.startsWith("-")) {
      oldLines.push(line.slice(1));
    } else if (line.startsWith("+")) {
      newLines.push(line.slice(1));
    } else if (line === "\\ No newline at end of file") {
      continue;
    } else {
      throw new Error(`Malformed update line: ${line}`);
    }
  }
  const oldText = oldLines.join("\n");
  const newText = newLines.join("\n");
  const count = oldText ? text.split(oldText).length - 1 : 0;
  if (!oldText) throw new Error("Update patch has no context/removal lines");
  if (count === 0) throw new Error(`Patch context not found in ${path.relative(workspaceRoot(), file)}`);
  if (count > 1) throw new Error(`Patch context matched ${count} times in ${path.relative(workspaceRoot(), file)}; add more context`);
  return text.replace(oldText, () => newText);
}

function applyPatchText(patch) {
  const lines = String(patch || "").replace(/\r\n/g, "\n").split("\n");
  if (lines[0] !== "*** Begin Patch") throw new Error("Patch must start with *** Begin Patch");
  if (lines[lines.length - 1] === "") lines.pop();
  if (lines[lines.length - 1] !== "*** End Patch") throw new Error("Patch must end with *** End Patch");

  // Two passes — first parse every operation into an explicit plan, then
  // execute. Lets us pre-resolve paths, pre-compute "did this file exist?"
  // for rollback, and report which operations had been applied if a later
  // one fails. Without the parse-first pass, a failure mid-patch left the
  // workspace half-edited (TODO #5).
  const ops = [];
  let i = 1;
  while (i < lines.length - 1) {
    const header = lines[i++];
    if (header.startsWith("*** Add File: ")) {
      const rel = header.slice("*** Add File: ".length).trim();
      const full = resolveForCreate(rel);
      const { body, i: next } = collectPatchBody(lines, i);
      i = next;
      ops.push({ kind: "add", rel, full, body });
    } else if (header.startsWith("*** Update File: ")) {
      const rel = header.slice("*** Update File: ".length).trim();
      const full = resolve(rel);
      const { body, i: next } = collectPatchBody(lines, i);
      i = next;
      ops.push({ kind: "update", rel, full, body });
    } else if (header.startsWith("*** Delete File: ")) {
      const rel = header.slice("*** Delete File: ".length).trim();
      const full = resolve(rel);
      ops.push({ kind: "delete", rel, full });
    } else if (!header.trim()) {
      continue;
    } else {
      throw new Error(`Unsupported patch header: ${header}`);
    }
  }

  // Validate every op up front. A throw here means nothing was changed
  // yet, so no rollback needed.
  for (const op of ops) {
    if (op.kind === "add" && fs.existsSync(op.full)) throw new Error(`File already exists: ${op.rel}`);
    if (op.kind === "update" && !fs.existsSync(op.full)) throw new Error(`File not found: ${op.rel}`);
    if (op.kind === "delete" && !fs.existsSync(op.full)) throw new Error(`File not found: ${op.rel}`);
  }

  // Rollback journal: for every applied op, record enough to undo it.
  //   add    — file didn't exist before; rollback = unlink
  //   update — original content; rollback = restore
  //   delete — original content; rollback = restore
  const journal = [];
  const changed = [];
  try {
    for (const op of ops) {
      if (op.kind === "add") {
        fs.mkdirSync(path.dirname(op.full), { recursive: true });
        const content = op.body.map((line) => stripPatchLine(line, "+")).join("\n") + "\n";
        atomicWriteFileSync(op.full, content);
        journal.push({ kind: "add", full: op.full, rel: op.rel });
        changed.push(`added ${op.rel}`);
      } else if (op.kind === "update") {
        const original = fs.readFileSync(op.full, "utf8");
        // The patch body was normalized to LF when it was parsed, so the file
        // has to be too or the context never matches on a CRLF checkout.
        // `original` stays raw — rollback must restore the exact bytes.
        const eol = detectEol(original);
        let text = toLf(original);
        for (const chunk of patchChunks(op.body)) {
          text = applyUpdateChunk(text, op.full, chunk);
        }
        atomicWriteFileSync(op.full, fromLf(text, eol));
        journal.push({ kind: "update", full: op.full, rel: op.rel, original });
        changed.push(`updated ${op.rel}`);
      } else if (op.kind === "delete") {
        const original = fs.readFileSync(op.full, "utf8");
        fs.unlinkSync(op.full);
        journal.push({ kind: "delete", full: op.full, rel: op.rel, original });
        changed.push(`deleted ${op.rel}`);
      }
    }
  } catch (e) {
    // Undo everything we already did, in reverse order.
    const rollbackErrors = [];
    for (let k = journal.length - 1; k >= 0; k--) {
      const j = journal[k];
      try {
        if (j.kind === "add") {
          fs.unlinkSync(j.full);
        } else {
          atomicWriteFileSync(j.full, j.original);
        }
      } catch (re) {
        rollbackErrors.push(`${j.rel}: ${re.message}`);
      }
    }
    const completed = journal.map((j) => j.rel).join(", ") || "(none)";
    const remaining = ops.slice(journal.length).map((o) => o.rel).join(", ") || "(none)";
    throw new Error(
      `applied ${journal.length}/${ops.length} operation(s) before failing: ${e.message}\n` +
      `Rolled back: ${completed}\n` +
      `Not applied: ${remaining}` +
      (rollbackErrors.length ? `\nRollback errors (workspace NOT fully restored): ${rollbackErrors.join("; ")}` : "")
    );
  }

  return changed.length ? `Patch applied: ${changed.join(", ")}` : "Patch had no changes";
}

// Filenames that almost always mean "secret material" if committed.
// Deliberately conservative — a false skip just means re-staging it
// explicitly after reading why; a false negative means a live secret
// preserved in git history forever.
const SECRET_FILE_PATTERNS = [
  /^\.env(\..+)?$/i,           // .env, .env.local, .env.production, …
  /^\.envrc$/i,                // direnv
  /\.pem$/i,
  /\.key$/i,
  /\.pfx$/i,
  /\.p12$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)$/i,
  /^credentials\.json$/i,
  /^secrets?\.json$/i,         // secrets.json / secret.json
  /^service[-_]?account.*\.json$/i,
  /^apikeys?.*\.txt$/i,        // apikey.txt / apikeys.txt
  /^aws[-_]?credentials$/i,    // ~/.aws/credentials conventions
  /^\.npmrc$/i,                // often contains npm tokens
  /^\.netrc$/i,                // contains plaintext login credentials
  /^.*[-_.]secret.*\.(json|ya?ml|txt|env|ini)$/i,  // any *-secret*.{json,yaml,…}
];
const SECRET_FILE_ALLOWLIST_RE = /\.(example|sample|template)$/i;

function looksLikeSecretFile(relPath) {
  const base = path.basename(String(relPath || ""));
  if (SECRET_FILE_ALLOWLIST_RE.test(base)) return false;
  return SECRET_FILE_PATTERNS.some((re) => re.test(base));
}

function isGitIgnored(relPath) {
  const r = spawnSync("git", ["check-ignore", "-q", "--", relPath], { cwd: process.cwd() });
  return r.status === 0;
}

function runGit(args) {
  const r = spawnSync("git", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 16,
  });
  if (r.error) throw new Error(`git unavailable: ${r.error.message}`);
  const out = [r.stdout, r.stderr].filter(Boolean).join("\n").trim();
  if (r.status !== 0) throw new Error(out || `git exited with code ${r.status}`);
  return clip(out);
}

// Built-in fallback for diff_files when git is unavailable: trim the common
// head and tail, then report the differing middle as -/+ blocks. Not a full
// LCS — interleaved changes collapse into one replace block — but it is
// dependency-free and honest about what changed.
function simpleLineDiff(labelA, a, labelB, b) {
  const la = a.split("\n");
  const lb = b.split("\n");
  let start = 0;
  while (start < la.length && start < lb.length && la[start] === lb[start]) start++;
  let endA = la.length;
  let endB = lb.length;
  while (endA > start && endB > start && la[endA - 1] === lb[endB - 1]) { endA--; endB--; }
  if (start === la.length && start === lb.length) return "(identical — no differences)";
  const out = [
    `--- ${labelA}`,
    `+++ ${labelB}`,
    `@@ lines ${start + 1}-${endA} of ${la.length} → lines ${start + 1}-${endB} of ${lb.length} (simple diff — git unavailable) @@`,
  ];
  for (let i = start; i < endA; i++) out.push(`-${la[i]}`);
  for (let i = start; i < endB; i++) out.push(`+${lb[i]}`);
  return out.join("\n");
}

function readJsonIfExists(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function findExisting(root, names) {
  return names.filter((name) => fs.existsSync(path.join(root, name)));
}

function inspectProject(p = ".", maxDepth = 2) {
  const root = resolve(p);
  if (!fs.statSync(root).isDirectory()) throw new Error(`Not a directory: ${p}`);
  const files = new Set();
  function walk(dir, depth) {
    if (depth > maxDepth) return;
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      if ([".git", "node_modules", ".next", "dist", "build", "__pycache__"].includes(item.name)) continue;
      const full = path.join(dir, item.name);
      const rel = path.relative(root, full).replace(/\\/g, "/");
      if (item.isDirectory()) {
        files.add(rel + "/");
        walk(full, depth + 1);
      } else {
        files.add(rel);
      }
    }
  }
  walk(root, 0);

  const entries = [...files].sort();
  const important = findExisting(root, [
    "package.json", "pnpm-lock.yaml", "yarn.lock", "package-lock.json", "bun.lockb",
    "pyproject.toml", "requirements.txt", "Pipfile", "poetry.lock",
    "Cargo.toml", "go.mod", "composer.json", "Gemfile",
    "Dockerfile", "docker-compose.yml", "compose.yml",
    "vercel.json", "next.config.js", "next.config.mjs", "vite.config.js", "vite.config.ts",
    "tsconfig.json", ".env.example", ".mcp.json",
  ]);

  const stack = [];
  const commands = [];
  const pkg = readJsonIfExists(path.join(root, "package.json"));
  if (pkg) {
    stack.push("Node.js");
    if (pkg.dependencies?.next || pkg.devDependencies?.next) stack.push("Next.js");
    if (pkg.dependencies?.react || pkg.devDependencies?.react) stack.push("React");
    if (pkg.devDependencies?.vite || pkg.dependencies?.vite) stack.push("Vite");
    if (pkg.dependencies?.express) stack.push("Express");
    for (const [name, cmd] of Object.entries(pkg.scripts || {})) commands.push(`npm run ${name}  # ${cmd}`);
  }
  if (important.includes("pyproject.toml") || important.includes("requirements.txt")) stack.push("Python");
  if (important.includes("Cargo.toml")) stack.push("Rust");
  if (important.includes("go.mod")) stack.push("Go");
  if (entries.some((e) => e.endsWith(".csproj") || e.endsWith(".sln"))) stack.push(".NET");
  if (important.includes("Dockerfile") || important.includes("docker-compose.yml") || important.includes("compose.yml")) stack.push("Docker");

  const packageManager = important.includes("pnpm-lock.yaml")
    ? "pnpm"
    : important.includes("yarn.lock")
      ? "yarn"
      : important.includes("bun.lockb")
        ? "bun"
        : pkg
          ? "npm"
          : "(none detected)";

  const testHints = commands.filter((c) => /\b(test|lint|check|typecheck|build)\b/i.test(c));
  return clip([
    `root: ${root}`,
    `stack: ${[...new Set(stack)].join(", ") || "(unknown)"}`,
    `package manager: ${packageManager}`,
    "",
    "important files:",
    important.length ? important.map((x) => `- ${x}`).join("\n") : "- (none detected)",
    "",
    "likely verification commands:",
    testHints.length ? testHints.map((x) => `- ${x}`).join("\n") : "- inspect package/config files first",
    "",
    "top-level scan:",
    entries.slice(0, 120).map((x) => `- ${x}`).join("\n") || "- (empty)",
  ].join("\n"));
}

function appendProcessLog(rec, chunk) {
  rec.log += chunk;
  if (rec.log.length > PROCESS_LOG_LIMIT) rec.log = rec.log.slice(-PROCESS_LOG_LIMIT);
}

function startManagedProcess({ command, cwd = ".", name, allow_unsafe = false }) {
  const risk = commandRisk(command);
  if (!allow_unsafe && risk.level === "blocked") {
    return `BLOCKED: ${risk.reason}\nCommand: ${command}`;
  }
  const procCwd = resolve(cwd);
  const isWin = process.platform === "win32";
  const shell = isWin ? "powershell.exe" : "/bin/sh";
  const args = isWin ? ["-NoProfile", "-NonInteractive", "-Command", command] : ["-c", command];
  const child = spawn(shell, args, {
    cwd: procCwd,
    stdio: ["pipe", "pipe", "pipe"], // stdin piped so process_input can answer prompts / drive REPLs
    windowsHide: true,
  });
  // Swallow stdin errors (EPIPE when the child closes stdin early or exits)
  // so a process_input write to a dying child can't crash the whole session —
  // the exit handler below records the state either way.
  child.stdin.on("error", () => { /* logged via the exit handler */ });
  const id = `P${String(nextProcessId++).padStart(3, "0")}`;
  const rec = {
    id,
    name: name || command,
    command,
    cwd: procCwd,
    startedAt: new Date().toISOString(),
    status: "running",
    exitCode: null,
    log: "",
    child,
  };
  child.stdout.on("data", (d) => appendProcessLog(rec, String(d)));
  child.stderr.on("data", (d) => appendProcessLog(rec, String(d)));
  child.on("error", (e) => {
    rec.status = "error";
    appendProcessLog(rec, `\n[process error: ${e.message}]`);
  });
  child.on("exit", (code, signal) => {
    rec.status = "exited";
    rec.exitCode = code;
    appendProcessLog(rec, `\n[exited code=${code} signal=${signal || ""}]`);
  });
  managedProcesses.set(id, rec);
  return `started ${id}: ${rec.name}\nrisk: ${risk.level} (${risk.reason})\ncwd: ${procCwd}`;
}

function summarizeProcess(rec, includeLogs = false) {
  const base = [
    `${rec.id} [${rec.status}] ${rec.name}`,
    `command: ${rec.command}`,
    `cwd: ${rec.cwd}`,
    `started: ${rec.startedAt}`,
    `exitCode: ${rec.exitCode ?? ""}`,
  ].join("\n");
  return includeLogs ? `${base}\nlogs:\n${rec.log.trim() || "(no logs yet)"}` : base;
}

function processStatus({ id, logs } = {}) {
  if (id) {
    const rec = managedProcesses.get(id);
    if (!rec) throw new Error(`process not found: ${id}`);
    return clip(summarizeProcess(rec, logs !== false));
  }
  if (!managedProcesses.size) return "(no managed processes)";
  return clip([...managedProcesses.values()].map((rec) => summarizeProcess(rec, Boolean(logs))).join("\n\n"));
}

function stopManagedProcess(id) {
  const rec = managedProcesses.get(id);
  if (!rec) throw new Error(`process not found: ${id}`);
  if (rec.status === "running") {
    rec.child.kill();
    rec.status = "stopping";
    return `stopping ${id}`;
  }
  return `${id} is already ${rec.status}`;
}

// ---------------------------------------------------------------------------
// Sub-agents — spawn_agent / agent_status / stop_agent. Mirrors the
// start_process/process_status/stop_process pattern: the spawning call
// returns immediately, the sub-agent's own runTurn() loop runs in the
// background (can be on a different provider/model entirely — that's what
// makes it genuinely parallel instead of just competing for the same rate
// limit), and agent_status polls for the result.
//
// Dynamic import of core/agent.mjs (not a static top-level import) is
// deliberate: agent.mjs imports this file for `tools`/`runTool`, so a
// static import here would be a circular import. Deferring it to call time
// (well after both modules have finished loading) avoids that entirely.
// ---------------------------------------------------------------------------

function lastAssistantText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant" && typeof m.content === "string" && m.content.trim()) return m.content.trim();
  }
  return "";
}

// ── self_review: an adversarial second pass over your own work ────────────
//
// VERIFY (run the tests) answers "does it execute". It cannot answer "is this
// what was asked for", "did this miss a requirement", or "did this quietly
// break something adjacent" — nothing in the loop ever challenged the work
// itself, so a confidently wrong change sailed through as long as the suite
// was green.
//
// The critic is a separate conversation that never sees the author's
// reasoning — only the original task and the resulting diff. That is the
// whole point: the author has already convinced itself, so re-reading its own
// justification would just reconfirm it. Fresh eyes on the artifact alone.

// Read-only allowlist. The critic gets a hard deny-by-default so it can
// investigate but cannot "helpfully" fix anything — a critic that edits is no
// longer an independent check, and its edits would land unreviewed.
const CRITIC_PERMISSIONS = {
  "*": "deny",
  read_file: "allow",
  read_many_files: "allow",
  list_dir: "allow",
  search: "allow",
  find_files: "allow",
  find_symbol: "allow",
  git_diff: "allow",
  git_status: "allow",
  rag_search: "allow",
  deps: "allow",
  project_inspect: "allow",
  diff_files: "allow",
  jq_query: "allow",
  where_is: "allow",
};

const CRITIC_PROMPT = [
  "You are a code reviewer. You are reviewing someone else's change. You did not write it and you have no stake in it being correct.",
  "",
  "You are given the task that was requested and the diff that was produced. Your job is to find what is WRONG with it — not to summarize it, not to praise it.",
  "",
  "Check, in this order:",
  "1. REQUIREMENT — does the change actually do what the task asked? Name anything asked for that is missing, partial, or quietly reinterpreted into something easier.",
  "2. CORRECTNESS — bugs, wrong logic, off-by-one, bad error handling, unhandled null/empty/failure cases, race conditions, wrong types. Give a concrete input or state that produces the wrong result.",
  "3. REGRESSION — does it break or contradict existing behaviour, callers, or tests? Read the surrounding code to check; do not assume the diff is self-contained.",
  "4. EVIDENCE — does the claimed verification actually prove the change works, or was something asserted without being run?",
  "",
  "You may read files to investigate. You cannot modify anything — do not try.",
  "",
  "Output format — findings first, most severe first:",
  "  [BLOCKER|MAJOR|MINOR] file:line — what is wrong, why it matters, and the concrete fix.",
  "End with one line: `VERDICT: BLOCKERS` / `VERDICT: MAJOR` / `VERDICT: MINOR` / `VERDICT: CLEAN`.",
  "",
  "Only say VERDICT: CLEAN if you genuinely found nothing, and in that case list what you checked so the author can see the review had teeth.",
  "Do not invent problems to look thorough — a fabricated finding wastes more time than it saves. Report what you can point at in the code.",
].join("\n");

async function runSelfReview({ task, diff_from = "unstaged", paths = [], model, focus, timeout_ms = 240000 }) {
  if (!task || !String(task).trim()) {
    throw new Error("task is required — state what the change was supposed to accomplish, in the user's terms, so the critic can judge whether it does");
  }

  // Gather the artifact under review.
  let diff = "";
  let artifactLabel = "Diff produced";
  let artifactFence = "diff";
  const scope = Array.isArray(paths) && paths.length ? paths : [null];
  try {
    for (const p of scope) {
      const args = ["diff"];
      if (diff_from === "staged") args.push("--staged");
      else if (diff_from === "head") args.push("HEAD");
      if (p) {
        if (String(p).startsWith("-")) throw new Error(`path "${p}" starts with '-'`);
        args.push("--", p);
      }
      const out = runGit(args);
      if (out) diff += (diff ? "\n" : "") + out;
    }
  } catch (e) {
    // Plenty of real work happens in folders that were never `git init`ed. The
    // critic doesn't need version control — it needs the artifact. Without a
    // repo there is no diff to take, so review the named files as they stand.
    // (This used to surface git's usage dump as the tool's error, which told
    // the model nothing and simply made it retry the same call.)
    if (!/not a git repository/i.test(e?.message || "")) throw e;
    if (!(Array.isArray(paths) && paths.length)) {
      return "(nothing to review — this folder is not a git repository, so there is no diff to take. Re-run self_review with paths:[…] naming the files you changed and they will be reviewed as they stand.)";
    }
    artifactLabel = "Files under review (full current contents — this folder is not a git repository, so no diff is available)";
    artifactFence = "";
    diff = "";
    for (const p of paths) {
      let body;
      try {
        body = fs.readFileSync(resolve(p), "utf8");
      } catch (readErr) {
        body = `(could not read: ${readErr.message})`;
      }
      diff += (diff ? "\n\n" : "") + `--- ${p} ---\n${body}`;
    }
  }
  if (!diff.trim()) {
    return "(nothing to review — no diff found. If the work is uncommitted new files, `git add -N <path>` first so they appear in the diff; if it was already committed, pass diff_from:\"head\".)";
  }
  // Keep the critic inside its context window; a 200KB diff would blow it.
  const MAX_DIFF = 60000;
  let noteTruncated = "";
  if (diff.length > MAX_DIFF) {
    noteTruncated = `\n\n[truncated at ${MAX_DIFF} of ${diff.length} chars — review what is shown and say so if you need the rest]`;
    diff = diff.slice(0, MAX_DIFF);
  }

  const { runTurn } = await import("../core/agent.mjs");
  const settings = await loadSettings();
  const resolved = resolveModel(settings, model || settings.defaultModel);
  const messages = [
    { role: "system", content: CRITIC_PROMPT },
    {
      role: "user",
      content: [
        "## Task that was requested",
        String(task).trim(),
        focus ? `\n## The author specifically wants scrutiny on\n${String(focus).trim()}` : "",
        `\n## ${artifactLabel}`,
        "```" + artifactFence,
        diff,
        "```" + noteTruncated,
      ].filter(Boolean).join("\n"),
    },
  ];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(30000, Math.min(Number(timeout_ms) || 240000, 600000)));
  try {
    await runTurn({
      model: resolved,
      settings,
      messages,
      session: new Session(),
      maxIterations: 12,
      diffPreview: false,
      signal: controller.signal,
      permissions: CRITIC_PERMISSIONS,
      confirmTool: null,
    });
  } catch (e) {
    if (controller.signal.aborted) {
      return `(self_review timed out after ${Math.round((Number(timeout_ms) || 240000) / 1000)}s on ${resolved.key} — treat the change as UNREVIEWED. Re-run with a smaller paths scope, or review it yourself against the task.)`;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }

  const verdict = lastAssistantText(messages);
  if (!verdict) {
    return `(the critic on ${resolved.key} returned nothing — treat the change as UNREVIEWED rather than approved.)`;
  }
  return [
    `Independent review of your change by ${resolved.key} (it saw only the task and the work itself, not your reasoning):`,
    "",
    verdict,
    "",
    "Now act on this: fix what is real, and for anything you disagree with, say why in your summary rather than silently ignoring it. A CLEAN verdict is not permission to skip running the tests.",
  ].join("\n");
}

function spawnSubAgent({ prompt, model, name, permissions = null, confirmTool = null }) {
  if (!prompt || !String(prompt).trim()) throw new Error("prompt is required");
  const id = `A${String(nextAgentId++).padStart(3, "0")}`;
  const rec = {
    id,
    name: name || String(prompt).slice(0, 60),
    prompt,
    model: model || "(default)",
    startedAt: new Date().toISOString(),
    status: "running",
    result: null,
    error: null,
    controller: new AbortController(),
  };
  managedAgents.set(id, rec);

  (async () => {
    try {
      const { runTurn, systemPrompt } = await import("../core/agent.mjs");
      const settings = await loadSettings();
      const resolved = resolveModel(settings, model || settings.defaultModel);
      rec.model = resolved.key;
      const messages = [
        { role: "system", content: systemPrompt() },
        { role: "user", content: String(prompt) },
      ];
      const session = new Session();
      // Forward the parent's permission gate to the sub-agent's runTurn.
      // Without this, runTurn defaults permissions=null → checkPermission
      // defaults to "allow" for every tool, and run_shell/start_process skip
      // every "ask" check. confirmTool falls back to null too, so a non-
      // interactive parent correctly produces a non-interactive sub-agent.
      await runTurn({
        model: resolved,
        settings,
        messages,
        session,
        maxIterations: 20,
        diffPreview: false,
        signal: rec.controller.signal,
        permissions,
        confirmTool,
      });
      rec.status = "done";
      rec.result = lastAssistantText(messages) || "(sub-agent finished with no final text)";
    } catch (e) {
      rec.status = rec.status === "stopping" ? "stopped" : "error";
      rec.error = e?.message || String(e);
    }
  })();

  return `spawned ${id}${name ? ` (${name})` : ""} on model ${model || "(default)"} — running in parallel, check with agent_status({id:"${id}"})`;
}

function summarizeAgent(rec) {
  const base = [`${rec.id} [${rec.status}] ${rec.name}`, `model: ${rec.model}`, `started: ${rec.startedAt}`].join("\n");
  if (rec.status === "done") return `${base}\nresult:\n${rec.result}`;
  if (rec.status === "error" || rec.status === "stopped") return `${base}\nerror: ${rec.error || "(cancelled)"}`;
  return base;
}

function subAgentStatus({ id } = {}) {
  if (id) {
    const rec = managedAgents.get(id);
    if (!rec) throw new Error(`sub-agent not found: ${id}`);
    return clip(summarizeAgent(rec));
  }
  if (!managedAgents.size) return "(no sub-agents spawned)";
  return clip([...managedAgents.values()].map(summarizeAgent).join("\n\n"));
}

function stopSubAgent(id) {
  const rec = managedAgents.get(id);
  if (!rec) throw new Error(`sub-agent not found: ${id}`);
  if (rec.status === "running") {
    rec.status = "stopping";
    rec.controller.abort();
    return `stopping ${id}`;
  }
  return `${id} is already ${rec.status}`;
}

function todoPath() {
  return resolveForCreate(path.join("omni", "todos.json"));
}

function readTodos() {
  try {
    const data = JSON.parse(fs.readFileSync(todoPath(), "utf8"));
    const todos = Array.isArray(data.todos) ? data.todos : [];
    const nextSeq = Number.isFinite(data.nextSeq) ? data.nextSeq : null;
    return { todos, nextSeq };
  } catch {
    return { todos: [], nextSeq: null };
  }
}

function writeTodos(todos, nextSeq = null) {
  const file = todoPath();
  const payload = { todos };
  if (nextSeq != null) payload.nextSeq = nextSeq;
  atomicWriteFileSync(file, JSON.stringify(payload, null, 2) + "\n");
}

function formatTodos(todos) {
  if (!todos.length) return "(no todos)";
  return todos.map((t) => `${t.id} [${t.status}] ${t.title}${t.notes ? ` — ${t.notes}` : ""}`).join("\n");
}

function projectTodo({ action, id, title, status, notes } = {}) {
  const { todos, nextSeq: persistedSeq } = readTodos();
  const now = new Date().toISOString();
  const act = String(action || "").toLowerCase();
  if (act === "list") return formatTodos(todos);
  if (act === "add") {
    if (!title) throw new Error("title is required for add");
    // Pick the next id from MAX(existing, persistedSeq) + 1 (TODO #12).
    // The old formula reused T001 after `clear`, so a /todo done T001 was
    // ambiguous between the pre-clear and post-clear tasks. We track the
    // next sequence number in the file itself so it survives `clear` —
    // re-using IDs across clear-and-re-add is the foot-gun the TODO flags.
    const maxFromTodos = todos.reduce((m, t) => {
      const n = parseInt(String(t.id || "").replace(/^T/, ""), 10);
      return Number.isFinite(n) ? Math.max(m, n) : m;
    }, 0);
    const maxN = Math.max(maxFromTodos, persistedSeq || 0);
    const nextId = `T${String(maxN + 1).padStart(3, "0")}`;
    const todo = { id: nextId, title, status: status || "pending", notes: notes || "", createdAt: now, updatedAt: now };
    todos.push(todo);
    writeTodos(todos, maxN + 1);
    return `Added ${nextId}: ${title}`;
  }
  if (act === "update" || act === "done" || act === "remove") {
    const idx = todos.findIndex((t) => t.id === id);
    if (idx === -1) throw new Error(`todo not found: ${id}`);
    if (act === "remove") {
      const [removed] = todos.splice(idx, 1);
      writeTodos(todos, persistedSeq);
      return `Removed ${removed.id}: ${removed.title}`;
    }
    if (title) todos[idx].title = title;
    if (notes !== undefined) todos[idx].notes = notes;
    todos[idx].status = act === "done" ? "done" : status || todos[idx].status;
    todos[idx].updatedAt = now;
    writeTodos(todos, persistedSeq);
    return `Updated ${todos[idx].id}: ${todos[idx].status} ${todos[idx].title}`;
  }
  if (act === "clear") {
    // Preserve the sequence counter so a post-clear add doesn't reuse T001.
    // (TODO #12.) The persistedSeq value survives the empty write below
    // because writeTodos only writes nextSeq when it's not null.
    writeTodos([], persistedSeq);
    return "Cleared project todos";
  }
  throw new Error("action must be list, add, update, done, remove, or clear");
}

export async function runTool(name, args, context = null) {
  const fn = impl[name];
  if (!fn) {
    throw new Error(`Unknown tool: ${name}. Valid tools: ${Object.keys(impl).sort().join(", ")}`);
  }
  // Tools that need to spawn further turns (currently just spawn_agent) read
  // context.permissions / context.confirmTool and forward them to runTurn, so
  // a sub-agent inherits the parent's permission gate instead of running with
  // permissions=null (which would default to "allow" for everything and skip
  // every "ask"/"deny" check — see checkPermission in core/agent.mjs).
  return await fn(args || {}, context);
}

// ---------------------------------------------------------------------------
// Persistent memory — routed through core/memory-provider.mjs. Default
// provider is legacy-jsonl (<HOME>/memory.jsonl, one record per line,
// unchanged since before the memory-provider split). layered-okf adds L1
// atoms with status/provenance in <HOME>/memory-atoms.jsonl.
// ---------------------------------------------------------------------------

// Injected into the system prompt at startup so recent memories are always in
// context. Returns "" when nothing is saved.
export function memoryPreamble(limit = 15) {
  const provider = activeProviderFromDisk();
  const recent = provider.search("", {}, { limit });
  if (!recent.length) return "";
  const header = provider.name === "layered-okf"
    ? [
      "",
      "# Persistent memories (layered-okf)",
      `You have ${recent.length} active memory atoms shown below (weight-ranked, heaviest first). Use memory_search for others,`,
      "memory_explain <id> to see why an atom is active/superseded, memory_save for a durable fact (weighted straight in,",
      "no review step), and memory_deprecate <id> to correct a wrong one.",
    ]
    : [
      "",
      "# Persistent memories",
      `You have ${recent.length} saved memories shown below (most recent first). Use memory_search for older ones,`,
      "memory_save to record new durable facts, and memory_forget to remove wrong/obsolete ones.",
    ];
  return [...header, ...recent.map(formatMemoryRecord)].join("\n");
}

// ---------------------------------------------------------------------------
// System / environment diagnostics
// ---------------------------------------------------------------------------

function systemInfo() {
  const gb = (b) => (b / 1024 ** 3).toFixed(1) + " GB";
  const cpus = os.cpus();
  const lines = [
    `hostname: ${os.hostname()}`,
    `platform: ${process.platform} ${os.release()} (${os.arch()})`,
    `cpu: ${cpus[0]?.model?.trim() || "unknown"} × ${cpus.length} logical cores`,
    `memory: ${gb(os.freemem())} free of ${gb(os.totalmem())}`,
    `node: ${process.version}`,
    `shell: ${process.platform === "win32" ? "powershell.exe" : process.env.SHELL || "/bin/sh"}`,
    `cwd: ${process.cwd()}`,
    `home: ${os.homedir()}`,
  ];
  if (process.platform === "win32") {
    const ps = [
      "$o = Get-CimInstance Win32_OperatingSystem;",
      "$g = (Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name) -join ', ';",
      "$d = Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object { '{0} {1:N0} GB free of {2:N0} GB' -f $_.DeviceID, ($_.FreeSpace/1GB), ($_.Size/1GB) };",
      "@{ os = ($o.Caption + ' build ' + $o.BuildNumber); gpu = $g; disks = @($d) } | ConvertTo-Json -Compress",
    ].join(" ");
    const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], {
      encoding: "utf8",
      timeout: 20000,
      windowsHide: true,
    });
    try {
      const info = JSON.parse(r.stdout);
      lines.push(`os: ${info.os}`);
      lines.push(`gpu: ${info.gpu || "unknown"}`);
      const disks = Array.isArray(info.disks) ? info.disks : [info.disks].filter(Boolean);
      lines.push(`disks: ${disks.join(" | ")}`);
    } catch { lines.push("(detailed OS/GPU/disk info unavailable — CIM query failed)"); }
  } else {
    const r = spawnSync("uname", ["-a"], { encoding: "utf8", timeout: 5000 });
    if (!r.error && r.stdout) lines.push(`uname: ${r.stdout.trim()}`);
  }
  return clip(lines.join("\n"));
}

// Comprehensive toolchain matrix, grouped by category. Value is the version
// argument; null means "detect presence only" (the version command is too slow
// or unreliable to run — e.g. flutter/gradle/sbt boot a VM).
const TOOLCHAINS = [
  ["JavaScript / TypeScript", { node: "--version", npm: "--version", pnpm: "--version", yarn: "--version", bun: "--version", deno: "--version", tsc: "--version", nvm: "version" }],
  ["Python", { python: "--version", py: "--version", pip: "--version", pipx: "--version", poetry: "--version", uv: "--version", conda: "--version" }],
  ["PHP", { php: "-v", composer: "--version" }],
  ["Ruby", { ruby: "--version", gem: "--version", bundle: "--version", rails: null }],
  ["Rust", { rustc: "--version", cargo: "--version", rustup: "--version" }],
  ["Go", { go: "version", gofmt: null }],
  ["JVM (Java/Kotlin/Scala)", { java: "-version", javac: "-version", mvn: "--version", gradle: null, kotlin: null, kotlinc: null, scala: null, sbt: null }],
  [".NET / C#", { dotnet: "--version", msbuild: "-version", nuget: null }],
  ["C / C++", { gcc: "--version", "g++": "--version", clang: "--version", "clang++": "--version", cl: null, cmake: "--version", make: "--version", ninja: "--version", gdb: "--version", vcpkg: null, conan: "--version" }],
  ["Perl", { perl: "-v", cpan: null }],
  ["Other languages", { lua: "-v", julia: "--version", dart: "--version", flutter: null, swift: null, zig: "version", nim: "--version", elixir: null, erl: null, ghc: "--version", Rscript: "--version" }],
  ["Shells & OS", { pwsh: "--version", powershell: null, bash: "--version", wsl: "--status", ssh: "-V" }],
  ["Version control", { git: "--version", gh: "--version", svn: "--version" }],
  ["Containers & infra", { docker: "--version", "docker-compose": "--version", podman: "--version", kubectl: null, helm: null, terraform: null }],
  ["Databases", { mysql: "--version", psql: "--version", sqlite3: "--version", mongosh: null, "redis-cli": "--version" }],
  ["Utilities", { curl: "--version", wget: "--version", tar: "--version", jq: "--version", code: null }],
];

// Run a shell command, capture stdout+stderr, resolve "" on error/timeout.
// shell:true so Windows .cmd/.bat shims (npm, tsc, ...) resolve via PATHEXT.
function runQuiet(cmd, timeout = 5000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, [], { shell: true, windowsHide: true });
    } catch {
      return resolve("");
    }
    let out = "";
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, timeout);
    child.stdout.on("data", (d) => { if (out.length < 8192) out += d; });
    child.stderr.on("data", (d) => { if (out.length < 8192) out += d; });
    child.on("error", () => { clearTimeout(timer); resolve(""); });
    child.on("close", () => { clearTimeout(timer); resolve(out); });
  });
}

// resolveOnPath/probeVersion build a shell:true command string (needed so
// Windows .cmd/.bat shims like npm/tsc resolve via PATHEXT), and both are
// reachable with a caller-supplied name (where_is's `name`, dev_env_report's
// optional `tools` list) — without this check, a name like "x & calc.exe"
// or "x; rm -rf ~" would be interpreted by the shell instead of treated as
// a literal (missing) executable. Real executable names and version flags
// never need anything outside this charset.
const SAFE_EXEC_ARG_RE = /^[A-Za-z0-9_.+-]+$/;
function assertSafeExecArg(value, label) {
  const s = String(value);
  if (!SAFE_EXEC_ARG_RE.test(s)) {
    throw new Error(`${label} "${s}" contains characters not allowed in an executable/argument name`);
  }
  return s;
}

async function resolveOnPath(name) {
  assertSafeExecArg(name, "executable name");
  const isWin = process.platform === "win32";
  const out = await runQuiet(isWin ? `where.exe ${name}` : `which -a ${name}`, 8000);
  // wsl and friends can emit UTF-16 (strip NULs); keep only path-shaped lines.
  return out
    .replace(/\u0000/g, "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => /^([A-Za-z]:[\\/]|\/)/.test(s));
}

async function probeVersion(name, versionArg) {
  assertSafeExecArg(name, "executable name");
  assertSafeExecArg(versionArg, "version argument");
  // java/perl/ssh print the version to stderr; strip UTF-16 NULs (wsl).
  const out = (await runQuiet(`${name} ${versionArg}`, 5000)).replace(/\u0000/g, "");
  const first = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] || "";
  return first.slice(0, 100);
}

// Run fn over items with bounded concurrency (order-preserving results).
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function devEnvReport(subset) {
  // Flatten the matrix; unknown names from an explicit subset still get probed.
  const wanted = Array.isArray(subset) && subset.length ? new Set(subset.map(String)) : null;
  const probes = [];
  for (const [cat, items] of TOOLCHAINS) {
    for (const [name, versionArg] of Object.entries(items)) {
      if (!wanted || wanted.has(name)) probes.push({ cat, name, versionArg });
    }
  }
  if (wanted) {
    for (const name of wanted) {
      if (!probes.some((p) => p.name === name)) probes.push({ cat: "Requested", name, versionArg: "--version" });
    }
  }

  const results = await mapLimit(probes, 10, async (p) => {
    const paths = await resolveOnPath(p.name);
    if (!paths.length) return { ...p, found: false };
    const version = p.versionArg == null ? "" : await probeVersion(p.name, p.versionArg);
    return { ...p, found: true, paths, version };
  });

  const categories = [...TOOLCHAINS.map(([cat]) => cat), "Requested"];
  const lines = [];
  let foundCount = 0;
  for (const cat of categories) {
    const group = results.filter((r) => r.cat === cat);
    if (!group.length) continue;
    const found = group.filter((r) => r.found);
    const missing = group.filter((r) => !r.found).map((r) => r.name);
    foundCount += found.length;
    lines.push(`[${cat}]`);
    for (const r of found) {
      const extra = r.paths.length > 1 ? ` (+${r.paths.length - 1} more)` : "";
      lines.push(`  ${r.name.padEnd(15)} ${(r.version || "(installed)").padEnd(42)} ${r.paths[0]}${extra}`);
    }
    if (missing.length) lines.push(`  missing: ${missing.join(", ")}`);
    lines.push("");
  }

  // PATH health: flag entries pointing at directories that don't exist.
  const pathEntries = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const broken = pathEntries.filter((p) => { try { return !fs.existsSync(p); } catch { return true; } });

  return clip([
    `Developer environment — ${foundCount} of ${probes.length} toolchains found`,
    "",
    ...lines,
    `PATH entries: ${pathEntries.length}${broken.length ? ` — ${broken.length} point at missing directories:` : " (all directories exist)"}`,
    ...broken.map((p) => `  broken: ${p}`),
  ].join("\n"));
}

async function whereIs(name) {
  if (!name || !String(name).trim()) throw new Error("name is required");
  const paths = await resolveOnPath(String(name).trim());
  if (!paths.length) return `${name}: not found on PATH`;
  return clip(paths.join("\n"));
}

function searchFallback(pattern, searchPath, glob, caseInsensitive) {
  const flags = caseInsensitive ? "gi" : "g";
  const re = new RegExp(pattern, flags);
  const results = [];
  const globRe = glob ? globToRegex(glob) : null;

  function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && entry.name !== ".git") walk(full);
      } else if (entry.isFile()) {
        if (globRe && !globRe.test(entry.name)) continue;
        try {
          const content = fs.readFileSync(full, "utf8");
          const lines = content.split(/\r?\n/);
          const rel = path.relative(searchPath, full).replace(/\\/g, "/");
          for (let i = 0; i < lines.length; i++) {
            if (re.test(lines[i])) {
              results.push(`${rel}:${i + 1}:${lines[i]}`);
              if (results.length > 500) return;
            }
            re.lastIndex = 0;
          }
        } catch { /* skip unreadable files */ }
      }
    }
  }

  if (fs.statSync(searchPath).isFile()) {
    const content = fs.readFileSync(searchPath, "utf8");
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) results.push(`${i + 1}:${lines[i]}`);
      re.lastIndex = 0;
    }
  } else {
    walk(searchPath);
  }
  return results.length ? results.join("\n") : "(no matches)";
}

function globToRegex(g) {
  const s = g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${s}$`, "i");
}

// Which tool names each extension file (relative path) most recently
// registered — lets a hot reload drop stale entries before re-adding.
const extensionToolNames = new Map();

function unregisterExtensionTools(rel) {
  const prev = extensionToolNames.get(rel);
  if (!prev) return;
  for (const name of prev) {
    const idx = tools.findIndex((t) => t.function?.name === name);
    if (idx !== -1) tools.splice(idx, 1);
    delete impl[name];
  }
  extensionToolNames.delete(rel);
}

// Import one extension file and merge its tools + impls into the live
// registry. Cache-busted so re-importing the same path (hot reload) picks up
// new file contents instead of Node's ESM module cache.
async function loadExtensionFile(root, rel) {
  unregisterExtensionTools(rel);
  const url = pathToFileURL(path.join(root, rel)).href + `?t=${Date.now()}`;
  const mod = await import(url);
  const ext = mod.default || mod;
  const names = [];
  if (Array.isArray(ext.tools)) {
    for (const t of ext.tools) {
      tools.push(t);
      if (t.function?.name) names.push(t.function.name);
    }
  }
  if (ext.impl && typeof ext.impl === "object") {
    Object.assign(impl, ext.impl);
  }
  extensionToolNames.set(rel, names);
  return ext.name || rel;
}

// Load extension modules and merge their tools + impls into the registry.
// Each extension default-exports { name, tools: [...], impl: { name: fn } }.
export async function registerExtensions(root, files = []) {
  const loaded = [];
  for (const rel of files) {
    try {
      loaded.push(await loadExtensionFile(root, rel));
    } catch (e) {
      loaded.push(`${rel} (failed: ${e.message})`);
    }
  }
  return loaded;
}

function omniConfigPath() {
  return path.join(INSTALL_ROOT, "omni.config.json");
}

// Read-modify-write omni.config.json's `extensions` array (never clobbers
// other keys). Mirrors the same pattern used by the package installer.
function addExtensionToConfig(rel) {
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(omniConfigPath(), "utf8"));
  } catch {
    /* start fresh if missing/unparseable */
  }
  const extensions = [...new Set([...(cfg.extensions || []), rel])];
  atomicWriteFileSync(omniConfigPath(), JSON.stringify({ ...cfg, extensions }, null, 2) + "\n");
}

// Backing implementation for the create_tool tool: write an extension's
// source, hot-load it into this session, and persist it so it survives
// restarts. See the create_tool tool schema above for the module contract.
async function createTool(name, code) {
  if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error("name must be alnum/dash/underscore only (used as extensions/<name>.js)");
  }
  if (!code || !String(code).trim()) throw new Error("code is required");

  const rel = `extensions/${name}.js`;
  const full = path.join(INSTALL_ROOT, rel);
  atomicWriteFileSync(full, code);

  let registeredName;
  try {
    registeredName = await loadExtensionFile(INSTALL_ROOT, rel);
  } catch (e) {
    throw new Error(`wrote ${rel} but it failed to load: ${e.message}`);
  }

  const toolNames = extensionToolNames.get(rel) || [];
  if (!toolNames.length) {
    throw new Error(`${rel} loaded but exported no tools — check the module's default export`);
  }

  addExtensionToConfig(rel);

  return (
    `Created and loaded extension "${registeredName}" (${rel}) — new tool(s) available now: ` +
    `${toolNames.join(", ")}. Persisted to omni.config.json so it survives restarts.`
  );
}
