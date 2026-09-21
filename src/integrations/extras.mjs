// Loads project-level config: omni.config.json, the system prompt file,
// and skills (skills/<name>/SKILL.md with frontmatter). Extensions are loaded
// separately by tools.registerExtensions.

import fs from "node:fs";
import path from "node:path";
import { atomicWriteFileSync } from "../core/atomic-write.mjs";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fdPath, INSTALL_ROOT } from "../paths.mjs";
import { systemPrompt as fallbackPrompt } from "../core/agent.mjs";
import { HOME } from "../core/config.mjs";
import { wrapSessionContext } from "../core/session-context.mjs";
import { parseFrontmatter } from "../core/frontmatter.mjs";

export { INSTALL_ROOT } from "../paths.mjs";

const CONFIG_PATH = path.join(INSTALL_ROOT, "omni.config.json");

export function loadProjectConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

// Persist a shallow patch into omni.config.json (read-modify-write so we
// never clobber concurrent edits to other keys). Used by the package installer
// to add/remove `extensions` and `mcpServers` entries. Pretty-printed UTF-8.
export function writeProjectConfig(patch) {
  let current = {};
  try {
    current = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    /* start from empty if missing/unparseable */
  }
  const next = { ...current, ...patch };
  // Atomic: this file configures MCP servers and the router; a truncated
  // one reads back as invalid JSON and silently reverts to defaults.
  atomicWriteFileSync(CONFIG_PATH, JSON.stringify(next, null, 2) + "\n");
  return next;
}

// Registry-installed "mcp" packages write straight into omni.config.json's
// mcpServers (see registry.mjs placePackage) — that command/args came from
// a downloaded package, not something the person running Omni typed
// themselves, so it deserves the exact same one-time confirmation as a
// .mcp.json-sourced server, not silent inherited trust. <HOME>/packages.json
// already records "mcpServers.<name>" in installedPaths for these (used by
// uninstallPackage to clean up); reuse that same ledger here instead of
// tracking it twice.
function registryInstalledMcpNames() {
  const names = new Set();
  try {
    const installed = JSON.parse(fs.readFileSync(path.join(HOME, "packages.json"), "utf8"));
    for (const rec of Object.values(installed)) {
      for (const p of rec.installedPaths || []) {
        if (p.startsWith("mcpServers.")) names.add(p.slice("mcpServers.".length));
      }
    }
  } catch {
    /* no packages.json yet — fine */
  }
  return names;
}

// Merge MCP server definitions from omni.config.json and a project-local
// .mcp.json (the vendor-neutral standard). .mcp.json wins on name collisions.
// Returns { servers: { <name>: def }, settings: {...}, untrusted: Set<name> }.
//
// `untrusted` names every server sourced from .mcp.json, plus every server
// added via the package registry (see registryInstalledMcpNames above).
// .mcp.json travels with a cloned repo, so it can name a server the repo's
// author chose, not the person running Omni Agent; a registry package is
// similarly something a human hasn't hand-vetted the exact command/args of.
// mcp.mjs requires a one-time human confirmation before ever connecting to
// either (see setMcpConfirm / the trust-fingerprint cache), so neither can
// silently spawn a process or call out to an attacker-controlled endpoint
// using this machine's credentials.
export function loadMcpConfig(config = loadProjectConfig()) {
  const servers = { ...(config.mcpServers || {}) };
  const settings = { idleTimeout: 10, directTools: false, ...(config.mcp || {}) };
  const untrusted = registryInstalledMcpNames();
  try {
    const dotMcp = JSON.parse(fs.readFileSync(path.join(process.cwd(), ".mcp.json"), "utf8"));
    for (const name of Object.keys(dotMcp.mcpServers || {})) untrusted.add(name);
    Object.assign(servers, dotMcp.mcpServers || {});
    if (dotMcp.settings) Object.assign(settings, dotMcp.settings);
  } catch {
    /* no .mcp.json in cwd — fine */
  }
  return { servers, settings, untrusted };
}

function readPromptText(config) {
  if (!config.promptFile) return null;
  try {
    return fs.readFileSync(path.join(INSTALL_ROOT, config.promptFile), "utf8").trim();
  } catch {
    return null;
  }
}

function discoverSkills() {
  const skillsRoot = path.join(INSTALL_ROOT, "skills");
  if (!fs.existsSync(skillsRoot)) return [];

  const r = spawnSync(
    fdPath(),
    ["SKILL.md", "skills", "--type", "f", "--hidden", "--no-ignore", "--color", "never"],
    { cwd: INSTALL_ROOT, encoding: "utf8", maxBuffer: 1024 * 1024 * 16 }
  );

  if (!r.error && r.status === 0) {
    return (r.stdout || "")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((p) => path.dirname(p.replace(/\\/g, "/")));
  }

  // Fallback for environments where fd is unavailable.
  const out = [];
  const top = fs.readdirSync(skillsRoot, { withFileTypes: true });
  for (const item of top) {
    if (!item.isDirectory()) continue;
    const rel = path.posix.join("skills", item.name);
    const skillFile = path.join(INSTALL_ROOT, rel, "SKILL.md");
    if (fs.existsSync(skillFile)) out.push(rel);
  }
  return out;
}

// Frontmatter parsing lives in core/frontmatter.mjs — core/skill-index.mjs
// needs the same parser, and importing it from here would close the
// extras -> agent -> tools cycle.

// Skills come from one place only: <INSTALL_ROOT>/skills/. Per-user skill
// dirs under the home directory (e.g. ~/.kimi-code/skills, ~/.agents/skills)
// are NOT consulted — keeping Omni's skill library entirely under version
// control means a clone is fully functional out of the box and a user
// can't accidentally shadow a built-in with a personal copy that
// drifts out of sync. If a user wants a custom skill, they add it
// to skills/ directly or via `omni install <skill-package>`.
export function loadSkills(config) {
  const configured = Array.isArray(config.skills) ? config.skills : [];
  const discovered = config.autoDiscoverSkills ? discoverSkills() : [];
  // Order matters: configured → discovered. Later entries shadow earlier
  // ones by command, so a configured `omni.config.json` entry overrides
  // an auto-discovered built-in with the same command.
  const entries = [...configured, ...discovered];
  const skills = [];
  for (const entry of entries) {
    const isAbs = path.isAbsolute(entry);
    const base = isAbs ? entry : path.join(INSTALL_ROOT, entry);
    const file = entry.endsWith("SKILL.md") ? base : path.join(base, "SKILL.md");
    try {
      const raw = fs.readFileSync(file, "utf8");
      const { meta, body } = parseFrontmatter(raw);
      const dir = path.dirname(file);
      const name = meta.name || path.basename(dir);
      skills.push({
        name,
        command: meta.command || "/" + name,
        description: meta.description || "",
        body,
        dir,
        // Derive a category from the directory so the system prompt can group
        // skills rather than dumping one flat 200-line list (TODO #1). For
        // built-ins the category is the first path segment under skills/
        // (e.g. skills/agent-orchestration/cmux → "agent-orchestration"); a
        // top-level skill where the category equals the skill name falls
        // into its own group. User-scope skills (under ~/.agents/skills or
        // ~/.kimi-code/skills) collapse to "Process skills" so the
        // superpowers-style process skills don't get lost in a wall of
        // built-ins.
        category: categoryForSkillDir(dir),
      });
    } catch {
      /* skip missing skill */
    }
  }
  // Dedupe by command — last one wins (user skill overrides built-in).
  const byCommand = new Map();
  for (const s of skills) byCommand.set(s.command, s);
  return [...byCommand.values()];
}

// First path segment under skills/ is the category, or "Process skills"
// for user-scope (per-user) installs. Returns null for a built-in skill
// whose directory IS the category (single-skill categories like
// skills/code-review/SKILL.md where dir ends in `skills/<category>`).
function categoryForSkillDir(dir) {
  const rel = path.relative(INSTALL_ROOT, dir).replace(/\\/g, "/");
  if (rel.startsWith("skills/")) {
    const segs = rel.split("/").slice(1); // drop "skills/"
    if (segs.length === 1) return titleCase(segs[0]); // skills/<category>/SKILL.md — category IS the skill
    return titleCase(segs[0]); // skills/<category>/<skill>/SKILL.md — first segment is the category
  }
  // User-scope install (per-user skill dir like ~/.agents/skills/...).
  return "Process skills";
}

// Hyphen-to-space, capitalize every word. Keeps the names short — the
// section headers in the system prompt render as "## Agent Orchestration",
// "## Process Skills", etc.
function titleCase(slug) {
  return String(slug || "").replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// Build the full system prompt: prompt file (or fallback) + runtime context +
// skills + any extra context (memory preamble). Everything after `base` is
// wrapped in the session-context marker so the per-turn persona swap in
// core/agent.mjs can carry it across instead of discarding it.
export function buildSystemPrompt(config, skills, extra = "") {
  const base = readPromptText(config) || fallbackPrompt();
  const ctx = [
    "# Environment",
    `Working directory: ${process.cwd()}`,
    `Platform: ${process.platform}`,
    `Omni Agent install root (your own extensions/, skills/, docs/): ${INSTALL_ROOT}`,
  ].join("\n");
  let sk = "";
  if (skills && skills.length) {
    sk = "\n\n" + renderSkillsSection(skills);
  }
  const tail = String(extra || "").trim();
  return base + "\n\n" + wrapSessionContext(ctx + sk + (tail ? "\n\n" + tail : ""));
}

// skills-master stub. Previously this dumped every skill (command + one-line
// description) grouped by category — ~24KB / ~6K tokens shipped on EVERY turn
// regardless of what the model was doing. That drowned attention and burned
// context budget. Now: one small block naming the total, the category list,
// and the two tools the model uses to discover/invoke a skill on demand.
// Skill bodies still load via /<cmd> or find_skill → invoke_skill, and they
// are evicted after the turn so a session never carries multiple full bodies.
function renderSkillsSection(skills) {
  if (!skills || !skills.length) return "";
  const byCategory = new Map();
  for (const s of skills) {
    const cat = s.category || "Other";
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat).push(s);
  }
  const cats = [...byCategory.keys()].sort((a, b) => {
    if (a === "Process skills") return -1;
    if (b === "Process skills") return 1;
    if (a === "Other") return 1;
    if (b === "Other") return -1;
    return a.localeCompare(b);
  });
  const catLine = cats.map((c) => `${c} (${byCategory.get(c).length})`).join(", ");
  return [
    "# Skills",
    `${skills.length} skills available across ${cats.length} categories: ${catLine}.`,
    "Skill bodies are NOT loaded ambiently — call find_skill(query) to search descriptions,",
    "then the user or you can invoke one with /<command>. The skill body is loaded only",
    "for the invocation turn and evicted afterward, so it never persists across turns.",
  ].join("\n");
}
