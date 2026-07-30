// Workspace selection + folder trust.
//
// Omni Agent's file tools are sandboxed to process.cwd() (see assertInsideWorkspace
// in tools/index.mjs), so *choosing* the cwd at startup is the whole security
// story. Two launch modes:
//
//   1. Launched from a "nowhere" directory (home, the install dir, Documents
//      itself, a drive root) → chdir into the workflow hub, a dedicated root
//      for every project Omni Agent creates. Default: Documents\OmniWorkflow.
//      If Documents is OneDrive-synced the user is offered a local
//      C:\OmniWorkflow instead (sync churn + file locks make OneDrive a
//      poor place for build output). The choice persists in settings.workspace.root.
//
//   2. Launched inside a real project folder (`omni` in a repo) → one-time
//      trust prompt, cached per-realpath in <home>/folder-trust.json — same
//      pattern as the MCP server trust cache. Declining falls back to the hub.
//
// The sandbox itself can be widened with settings.workspace.scope = "system"
// (/workspace scope system), which getWorkspaceScope exposes to tools/index.mjs.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { INSTALL_ROOT } from "../paths.mjs";
import { HOME, saveSettings } from "./config.mjs";
import { c, infoLine, warnLine, errorLine } from "../ui.mjs";

const TRUST_PATH = path.join(HOME, "folder-trust.json");
const HUB_NAME = "OmniWorkflow";

// Local (never-synced) fallback hub, offered when Documents lives in OneDrive.
const LOCAL_HUB = process.platform === "win32"
  ? "C:\\" + HUB_NAME
  : path.join(os.homedir(), HUB_NAME);

// ── write scope ──────────────────────────────────────────────────────────────
// "folder" (default): file tools are confined to the workspace root.
// "system": containment checks are skipped — the agent may touch the whole
// machine. Only settable by the human via /workspace scope system.

let _scope = "folder";

export function getWorkspaceScope() {
  return _scope;
}

export function setWorkspaceScope(scope) {
  _scope = scope === "system" ? "system" : "folder";
  return _scope;
}

// ── Documents / OneDrive detection ──────────────────────────────────────────

// The real Documents location comes from the registry, not %USERPROFILE%\Documents —
// OneDrive's "Known Folder Move" redirects it for a large share of Windows users.
export function resolveDocumentsDir() {
  if (process.platform === "win32") {
    const r = spawnSync("reg", [
      "query",
      "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders",
      "/v", "Personal",
    ], { encoding: "utf8" });
    const m = /Personal\s+REG(?:_EXPAND)?_SZ\s+(.+)/.exec(r.stdout || "");
    if (m) {
      const expanded = m[1].trim().replace(/%([^%]+)%/g, (_, v) =>
        process.env[v] ?? process.env[v.toUpperCase()] ?? "%" + v + "%");
      if (path.isAbsolute(expanded)) return expanded;
    }
  }
  return path.join(os.homedir(), "Documents");
}

export function isOneDrivePath(p) {
  const norm = String(p).toLowerCase();
  for (const v of ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"]) {
    const base = process.env[v];
    if (base && norm.startsWith(base.toLowerCase())) return true;
  }
  return /\bonedrive\b/i.test(norm);
}

// ── folder trust cache ───────────────────────────────────────────────────────
// Keyed by realpath (lowercased on win32 — NTFS is case-insensitive) so
// re-entering the same folder via a different casing or symlink still hits.

function trustKey(dir) {
  let real;
  try { real = fs.realpathSync(dir); } catch { real = path.resolve(dir); }
  return process.platform === "win32" ? real.toLowerCase() : real;
}

function readTrust() {
  try { return JSON.parse(fs.readFileSync(TRUST_PATH, "utf8")); } catch { return {}; }
}

export function isFolderTrusted(dir) {
  return Boolean(readTrust()[trustKey(dir)]);
}

export function trustFolder(dir) {
  const trust = readTrust();
  trust[trustKey(dir)] = { trustedAt: new Date().toISOString() };
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(TRUST_PATH, JSON.stringify(trust, null, 2));
}

export function untrustFolder(dir) {
  const trust = readTrust();
  const key = trustKey(dir);
  if (!(key in trust)) return false;
  delete trust[key];
  fs.writeFileSync(TRUST_PATH, JSON.stringify(trust, null, 2));
  return true;
}

// Confirm we can actually create files here before promising the agent it can.
export function probeWriteAccess(dir) {
  const probe = path.join(dir, `omni-probe-${process.pid}`);
  try {
    fs.writeFileSync(probe, "ok");
    fs.readFileSync(probe);
    fs.unlinkSync(probe);
    return true;
  } catch {
    try { fs.unlinkSync(probe); } catch { /* never created */ }
    return false;
  }
}

// ── startup flow ─────────────────────────────────────────────────────────────

function samePath(a, b) {
  if (!a || !b) return false;
  return trustKey(a) === trustKey(b);
}

function isInsidePath(child, parent) {
  if (!parent) return false;
  const rel = path.relative(trustKey(parent), trustKey(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

// "Nowhere" directories: launching from these means the user didn't pick a
// project folder, so we route them into the hub instead of sandboxing the
// agent to their entire home directory or drive root. The install dir counts
// as nowhere only when it isn't a git checkout — a shortcut's "Start in"
// lands there, but a developer hacking on Omni Agent itself wants the trust
// flow, not a teleport to the hub.
function isNowhereCwd(cwd, documentsDir) {
  const candidates = [
    os.homedir(),
    documentsDir,
    path.parse(cwd).root,
    process.env.SystemRoot || "C:\\Windows",
  ];
  if (!fs.existsSync(path.join(INSTALL_ROOT, ".git"))) candidates.push(INSTALL_ROOT);
  return candidates.some((p) => samePath(cwd, p));
}

async function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function chooseHubLocation(docsHub) {
  console.log(c.yellow("  your Documents folder is synced by OneDrive."));
  console.log("  where should Omni Agent keep its projects?");
  console.log(`    1) ${docsHub}  ${c.dim("(synced to OneDrive)")}`);
  console.log(`    2) ${LOCAL_HUB}  ${c.dim("(local only — skips OneDrive sync)")}`);
  const answer = await ask(c.yellow("  choose [1/2] (default 1): "));
  return answer === "2" ? LOCAL_HUB : docsHub;
}

// Ensure the hub exists, is writable, and becomes the cwd. Falls back to
// LOCAL_HUB, then to staying put, so startup never dies over a folder.
function enterHub(root) {
  for (const candidate of [root, LOCAL_HUB]) {
    try {
      fs.mkdirSync(candidate, { recursive: true });
      if (!probeWriteAccess(candidate)) throw new Error("not writable");
      process.chdir(candidate);
      if (candidate !== root) warnLine(`${root} was not writable — using ${candidate} instead`);
      return candidate;
    } catch { /* try next */ }
  }
  warnLine(`could not create a workspace folder — staying in ${process.cwd()}`);
  return process.cwd();
}

// Decide the workspace for this run. Must run before anything cwd-dependent
// (.mcp.json discovery, session slugs, project detection). Returns
// { root, mode: "hub" | "trusted" | "untrusted" }.
export async function initWorkspace({ settings, interactive }) {
  const wsCfg = settings.workspace || (settings.workspace = { root: "", scope: "folder" });
  setWorkspaceScope(wsCfg.scope);

  const cwd = process.cwd();
  const documentsDir = resolveDocumentsDir();

  // Already inside the hub (or a project under it) — the hub is ours, no prompt.
  if (wsCfg.root && isInsidePath(cwd, wsCfg.root)) {
    return { root: cwd, mode: "hub" };
  }

  // Launched inside a specific folder → trust flow.
  if (!isNowhereCwd(cwd, documentsDir)) {
    if (isFolderTrusted(cwd)) return { root: cwd, mode: "trusted" };
    if (!interactive) {
      // One-shot / piped runs can't prompt; the user launched here on purpose,
      // so keep pre-trust behavior but say so (mirrors the MCP trust rule).
      warnLine(`working in untrusted folder ${cwd} (non-interactive — trust it from a REPL session)`);
      return { root: cwd, mode: "untrusted" };
    }
    console.log(c.yellow(`  Omni Agent was started in: ${cwd}`));
    console.log(c.dim("  trusting it lets the agent read, write and run commands inside this folder (and only here)."));
    const answer = await ask(c.yellow("  trust this folder? [y/N] "));
    if (/^(y|yes)$/i.test(answer)) {
      if (!probeWriteAccess(cwd)) warnLine("heads up: this folder is not writable — reads will work, writes will fail");
      trustFolder(cwd);
      infoLine(`trusted ${cwd} (revoke with /workspace untrust)`);
      return { root: cwd, mode: "trusted" };
    }
    infoLine("okay — using your OmniWorkflow folder instead.");
  }

  // Hub flow: first run picks (and persists) the hub location.
  let { root } = wsCfg;
  if (!root) {
    const docsHub = path.join(documentsDir, HUB_NAME);
    root = interactive && isOneDrivePath(docsHub) ? await chooseHubLocation(docsHub) : docsHub;
    wsCfg.root = root;
    await saveSettings(settings);
  }
  root = enterHub(root);
  infoLine(`workspace: ${root}`);
  return { root, mode: "hub" };
}

// Persist a scope change (called by /workspace scope <folder|system>).
export async function setAndSaveScope(settings, scope) {
  const next = setWorkspaceScope(scope);
  settings.workspace = settings.workspace || { root: "", scope: "folder" };
  settings.workspace.scope = next;
  await saveSettings(settings);
  if (next === "system") {
    errorLine("workspace scope is now SYSTEM — file tools may read/write anywhere on this PC.");
  }
  return next;
}
