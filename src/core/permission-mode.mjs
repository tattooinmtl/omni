// Permission modes — how much the agent may do without asking.
//
//   default       your /perm settings exactly as they are
//   accept-edits  file edits run without asking (a "deny" still denies);
//                 shell commands and everything else follow your settings
//   plan          read-only: the agent investigates and proposes a plan with
//                 exit_plan_mode; nothing changes until you approve it
//   auto          nothing asks ("ask" counts as "allow"; "deny" still denies).
//                 The high-risk shell gate and create_tool still ask.
//
// Shift+Tab cycles default → accept-edits → plan. auto is only set on
// purpose (/mode auto, --mode auto, settings.permissionMode).
//
// The mode is process-wide, so a sub-agent spawned in plan mode is read-only
// too.

export const MODES = ["default", "accept-edits", "plan", "auto"];
const CYCLE = ["default", "accept-edits", "plan"];

let mode = "default";
let beforePlan = "default";
const listeners = new Set();

export function getPermissionMode() { return mode; }

export function normalizeMode(name) {
  const m = String(name || "").trim().toLowerCase().replace(/[_\s]+/g, "-");
  if (m === "acceptedits" || m === "edits" || m === "accept") return "accept-edits";
  if (m === "yolo" || m === "bypass") return "auto";
  if (m === "normal" || m === "ask") return "default";
  return MODES.includes(m) ? m : null;
}

export function setPermissionMode(name) {
  const next = normalizeMode(name);
  if (!next) throw new Error(`unknown mode "${name}" (one of ${MODES.join(", ")})`);
  if (next === mode) return mode;
  if (next === "plan") beforePlan = mode;
  const prev = mode;
  mode = next;
  for (const fn of listeners) { try { fn(next, prev); } catch { /* a listener must not break the switch */ } }
  return mode;
}

// The mode plan mode was entered from, where an approved plan returns to.
export function modeBeforePlan() { return beforePlan === "plan" ? "default" : beforePlan; }

export function cyclePermissionMode() {
  const i = CYCLE.indexOf(mode);
  return setPermissionMode(CYCLE[(i + 1) % CYCLE.length] || "default");
}

export function onPermissionModeChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function modeLabel(m = mode) {
  return { default: "default", "accept-edits": "accept edits", plan: "plan mode", auto: "auto" }[m] || m;
}

// Tools that only read. In plan mode these run; everything else is refused.
// Unknown tools (extensions, mcp) are refused too: their effects aren't known.
export const READ_ONLY_TOOLS = new Set([
  "read_file", "read_many_files", "list_dir", "find_files", "search", "find_symbol", "lsp",
  "git_status", "git_diff", "git_log", "project_inspect", "rag_search", "rag_index", "jq_query",
  "diff_files", "where_is", "system_info", "dev_env_report", "security_scan",
  "web_search", "web_fetch", "youtube_transcript",
  "memory_search", "memory_list", "memory_explain", "memory_atoms", "session_search",
  "find_skill", "invoke_skill", "ask_user", "agent_status", "process_status",
  "read_media_file", "read_video_file", "self_review", "project_todo", "spawn_agent",
  "browser_navigate", "browser_get_text", "browser_get_html", "browser_screenshot", "browser_extract", "browser_status",
  "exit_plan_mode", "goal_complete",
]);

// Edits accept-edits mode lets through without asking.
export const EDIT_TOOLS = new Set([
  "write_file", "edit_file", "edit_lines", "apply_patch", "find_replace", "move_file", "copy_file", "make_dir", "rename_symbol",
]);

// Shell commands that only look. One command, no chaining or redirection.
const READ_ONLY_COMMAND = /^\s*(?:git\s+(?:status|log|diff|show|branch|remote\s+-v|rev-parse|ls-files|blame)\b|ls|dir|pwd|cat|type|head|tail|wc|tree|rg|grep|findstr|where|which|Get-ChildItem|Get-Content|Get-Location|Select-String|Test-Path|node\s+(?:-v|--version)|npm\s+(?:ls|view|-v|--version)|python\s+--version|cargo\s+--version)\b/i;

export function isReadOnlyCommand(command) {
  const cmd = String(command || "");
  if (!cmd.trim() || /[;&|>`]|\$\(|\r|\n/.test(cmd)) return false;
  return READ_ONLY_COMMAND.test(cmd);
}

// Is this call allowed in plan mode?
export function planModeAllows(name, args = {}) {
  if (READ_ONLY_TOOLS.has(name)) return true;
  if (name === "deps") return true; // detect / list / outdated / audit only read
  if (name === "run_shell") return isReadOnlyCommand(args?.command) && !args?.allow_unsafe;
  return false;
}

// Does this call change anything? (Checkpoints are taken before the first one.)
export function isMutatingCall(name, args = {}) {
  if (name === "run_shell") return !isReadOnlyCommand(args?.command);
  if (name === "project_todo" || name === "spawn_agent" || name === "self_review" || name === "rag_index") return false;
  return !planModeAllows(name, args);
}

export const PLAN_DENIED =
  "DENIED (plan mode): this call would change something. In plan mode you only investigate: read files, search, " +
  "and run read-only commands. When you know what to do, call exit_plan_mode with the plan, and the user decides.";

// Per-turn note in the system prompt so the model knows the mode it is in.
const START = "<!-- omni:mode:start -->";
const END = "<!-- omni:mode:end -->";
const BLOCK_RE = /\n*<!-- omni:mode:start -->[\s\S]*?<!-- omni:mode:end -->\n*/;

const NOTES = {
  plan: [
    "# Plan mode",
    "The user switched you to PLAN MODE. Do not change anything: no file writes, no edits, no state-changing commands. They will be refused.",
    "Investigate with read-only tools until you understand the task. Then call exit_plan_mode with a concrete plan: the steps as a numbered list, the files each touches, and how you will verify it. The user approves it or tells you what to change.",
    "If the request is still vague, ask the user (ask_user) instead of guessing.",
  ].join("\n"),
  "accept-edits": "# Mode: accept edits\nFile edits run without asking the user. Shell commands still follow their permission settings.",
  auto: "# Mode: auto\nTools run without asking the user, except high-risk shell commands. Be deliberate: check before you change or delete anything the user did not point you at.",
};

export function syncModeGuidance(messages, m = mode) {
  const sys = messages?.[0];
  if (!sys || sys.role !== "system" || typeof sys.content !== "string") return false;
  const base = sys.content.replace(BLOCK_RE, "\n").replace(/\n+$/, "");
  const note = NOTES[m];
  const content = note ? `${base}\n\n${START}\n${note}\n${END}` : base;
  if (content !== sys.content) messages[0] = { ...sys, content };
  return Boolean(note);
}

// The numbered or bulleted steps in a plan, for project_todo.
export function planSteps(plan, max = 15) {
  const steps = [];
  for (const line of String(plan || "").split(/\r?\n/)) {
    const m = /^\s*(?:\d+[.)]|[-*•])\s+(.+?)\s*$/.exec(line);
    if (m && m[1].length > 2) steps.push(m[1].replace(/\*\*/g, "").slice(0, 160));
    if (steps.length >= max) break;
  }
  return steps;
}
