// Loads project-level config: omni.config.json, the system prompt file,
// and skills (skills/<name>/SKILL.md with frontmatter). Extensions are loaded
// separately by tools.registerExtensions.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fdPath, INSTALL_ROOT } from "../paths.mjs";
import { systemPrompt as fallbackPrompt } from "../core/agent.mjs";
import { HOME } from "../core/config.mjs";

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
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2) + "\n", "utf8");
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

// Frontmatter parser for the leading `---` ... `---` block. Handles
// `key: value` lines plus YAML block scalars (`|`, `|-`, `>`, `>-`):
// indented lines that follow are folded into a single value. The same form
// is used by every supported skill format, so all known frontmatter keys
// (name, command, description, license, maintainer, user-invocable, …) work
// uniformly — extras we don't consume are simply ignored.
function parseFrontmatter(text) {
  const m = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  const raw = m[1].split("\n");
  let i = 0;
  while (i < raw.length) {
    const line = raw[i];
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (!kv) { i++; continue; }
    const key = kv[1];
    let val = kv[2];
    // Block scalars (`|`, `|-`, `>`, `>-`) and a common author mistake —
    // a bare `description:` (empty value) followed by indented continuation
    // lines. Both fold the next run of indented/blank lines into a single
    // value.
    const isBlockScalar = val === "|" || val === "|-" || val === ">" || val === ">-";
    const isContinuationStart = val === "" && /^\s+\S/.test(raw[i + 1] || "");
    if (isBlockScalar || isContinuationStart) {
      const block = [];
      i++;
      while (i < raw.length) {
        const next = raw[i];
        if (next === "" || /^\s/.test(next)) {
          block.push(next.replace(/^\s+/, ""));
          i++;
        } else break;
      }
      val = block.join(" ").replace(/\s+/g, " ").trim();
    } else {
      i++;
    }
    meta[key] = val;
  }
  return { meta, body: m[2].trim() };
}

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

// Build the full system prompt: prompt file (or fallback) + runtime context + skills.
export function buildSystemPrompt(config, skills) {
  const base = readPromptText(config) || fallbackPrompt();
  const ctx = [
    "",
    "# Environment",
    `Working directory: ${process.cwd()}`,
    `Platform: ${process.platform}`,
    `Omni Agent install root (your own extensions/, skills/, docs/): ${INSTALL_ROOT}`,
  ].join("\n");
  let sk = "";
  if (skills && skills.length) {
    sk = "\n\n" + renderSkillsSection(skills);
  }
  return base + "\n" + ctx + sk;
}

// Group skills by category (TODO #1 — was a flat one-line-per-skill list
// that ran ~150 chars per skill for every turn). The list still shows the
// command + a one-line description so the model can pick a slash command,
// but it's now organised into sections the model can scan top-down rather
// than linearly. Skill bodies are NOT included — those load only when the
// user (or the dispatcher blurb in the prompt) invokes the skill.
function renderSkillsSection(skills) {
  const byCategory = new Map();
  for (const s of skills) {
    const cat = s.category || "Other";
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat).push(s);
  }
  const sortedCats = [...byCategory.keys()].sort((a, b) => {
    // "Process skills" first (the superpowers-style workflow skills live
    // there; they're the most relevant to every task), then everything else
    // alphabetically. "Other" last.
    if (a === "Process skills") return -1;
    if (b === "Process skills") return 1;
    if (a === "Other") return 1;
    if (b === "Other") return -1;
    return a.localeCompare(b);
  });
  const lines = [
    "# Skills",
    "The user can invoke these with slash commands. When invoked, you'll be given the skill's full instructions. Pick the category that matches the task and scan its section before improvising.",
  ];
  for (const cat of sortedCats) {
    const items = byCategory.get(cat).sort((a, b) => a.command.localeCompare(b.command));
    lines.push("", `## ${cat}`);
    for (const s of items) lines.push(`- ${s.command} — ${s.description}`);
  }
  return lines.join("\n");
}
