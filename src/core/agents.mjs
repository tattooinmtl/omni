// Named sub-agents: a Markdown file describes a specialist that spawn_agent
// (or `omni -p --agent <name>`) can run.
//
// Where they come from, later ones replacing earlier ones of the same name:
//   <install>/agents/*.md     shipped with Omni (explorer, reviewer, tester)
//   <HOME>/agents/*.md        yours, in every project
//   .omni/agents/*.md         this project's
//
// ---
// name: reviewer                    (defaults to the file name)
// description: Reviews a change …   (what the main agent reads to pick one)
// tools: read_file, search, git_diff  (only these; omit or "*" for all)
// readonly: true                    (read-only tools only, like plan mode)
// model: agnes/agnes-2.5-flash      (its own provider: a separate rate limit)
// isolation: worktree               (work on its own git branch by default)
// ---
// The body is the agent's role, added to Omni's own system prompt.
//
// A sub-agent can only be narrower than its parent: the parent's "deny"
// settings still apply, and a tool the parent would ask about still asks.

import fs from "node:fs";
import path from "node:path";
import { HOME } from "./config.mjs";
import { INSTALL_ROOT } from "../paths.mjs";
import { parseFrontmatter } from "./frontmatter.mjs";
import { READ_ONLY_TOOLS } from "./permission-mode.mjs";

const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/i;
// Tools a read-only agent still doesn't get: it shouldn't start more agents
// or answer for the user's plan.
const NOT_FOR_READONLY = new Set(["spawn_agent", "exit_plan_mode", "invoke_skill"]);

function bool(v) {
  return v === true || /^(true|yes|1|on)$/i.test(String(v || "").trim());
}

function readAgent(file, scope) {
  let raw;
  try { raw = fs.readFileSync(file, "utf8").replace(/^﻿/, ""); } catch { return null; }
  const { meta, body } = parseFrontmatter(raw);
  const name = String(meta.name || path.basename(file, ".md")).trim().toLowerCase();
  if (!NAME_RE.test(name)) return null;
  const toolsField = String(meta.tools || "").trim();
  const tools = !toolsField || toolsField === "*" ? null : toolsField.split(/[\s,]+/).map((t) => t.trim()).filter(Boolean);
  const isolation = String(meta.isolation || "").trim().toLowerCase() === "worktree" ? "worktree" : "shared";
  return {
    name,
    description: String(meta.description || body.split(/\r?\n/).find((l) => l.trim() && !l.startsWith("#")) || "").trim().slice(0, 200),
    tools,
    readonly: bool(meta.readonly),
    model: meta.model ? String(meta.model).trim() : null,
    isolation,
    role: body.trim(),
    file,
    scope,
  };
}

// Every agent definition, keyed by name.
export function loadAgents({ cwd = process.cwd(), home = HOME, installRoot = INSTALL_ROOT } = {}) {
  const map = new Map();
  const add = (dir, scope) => {
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".md")); } catch { return; }
    for (const f of files.sort()) {
      const a = readAgent(path.join(dir, f), scope);
      if (a) map.set(a.name, a);
    }
  };
  if (installRoot) add(path.join(installRoot, "agents"), "built-in");
  if (home) add(path.join(home, "agents"), "personal");
  add(path.join(cwd, ".omni", "agents"), "project");
  return map;
}

// The tool names the agent may use, or null for "all of them".
export function agentAllowedTools(agent) {
  if (!agent) return null;
  let set = agent.tools ? new Set(agent.tools) : null;
  if (agent.readonly) {
    const ro = [...READ_ONLY_TOOLS].filter((t) => !NOT_FOR_READONLY.has(t));
    set = new Set(set ? ro.filter((t) => set.has(t)) : ro);
  }
  return set;
}

// The parent's permissions narrowed to what the agent may use. Never wider:
// a parent "deny" (per tool or "*") stays a deny, and an "ask" stays an ask.
export function agentPermissions(agent, parent = null) {
  const allowed = agentAllowedTools(agent);
  if (!allowed) return parent;
  const base = parent || {};
  const out = { "*": "deny" };
  for (const t of allowed) out[t] = base[t] ?? base["*"] ?? "allow";
  return out;
}

// The system prompt for a sub-agent running as `agent`.
export function agentSystemPrompt(base, agent) {
  if (!agent) return base;
  const limits = [
    agent.readonly ? "You are read-only: investigate and report; you cannot change files or run commands that change anything." : "",
    agent.tools ? `You can use only these tools: ${agent.tools.join(", ")}.` : "",
  ].filter(Boolean).join(" ");
  return `${base}\n\n# Your role: ${agent.name}\n${agent.role}${limits ? `\n\n${limits}` : ""}\n\nWhen you finish, your last message is what the agent that started you receives: make it a complete, self-contained report.`;
}

// One line per agent, for spawn_agent's description and /agents.
export function agentCatalog(agents) {
  return [...agents.values()]
    .map((a) => `${a.name}${a.readonly ? " (read-only)" : ""}${a.isolation === "worktree" ? " (own git branch)" : ""}: ${a.description}`)
    .join("; ");
}
