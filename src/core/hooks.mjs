// Lifecycle hooks — run your own command (or extension code) when the agent
// reaches a point in its loop, and let it allow, block, rewrite or annotate.
//
// Events and what a hook can do there:
//   SessionStart      add context to the system prompt
//   UserPromptSubmit  block the prompt, or add context to it
//   PreToolUse        block the call, or rewrite its args      (matcher: tool name)
//   PostToolUse       add a note to the tool result            (matcher: tool name)
//   PreCompact        cancel the compaction, or add focus for the summary
//   Stop              keep the agent going with a reason (e.g. "tests fail")
//   SubagentStop      add a note to a finished sub-agent's result
//
// A command hook gets the event as JSON on stdin (and OMNI_HOOK_EVENT in its
// env). It answers the way Claude Code hooks do, so existing scripts port:
//   exit 0, no output             carry on
//   exit 0, plain text on stdout  that text is added as context
//   exit 0, JSON on stdout        { "decision": "deny"|"block"|"allow",
//                                   "reason": "…", "args": {…},
//                                   "additionalContext": "…" }
//   exit 2                        deny / block, stderr is the reason
//   any other exit                the hook failed; the agent carries on
// "background": true runs it detached and ignores what it says.
//
// Hooks come from hook files named in omni.config.json's "hooks" (under
// <install>/hooks/), "hooks" in agent/settings.json, a trusted project's
// .omni/hooks.json, and extensions exporting `hooks: { Event: fn }`.
// OMNI_NO_HOOKS=1 turns them all off.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { publishActivity } from "../local/activity-bus.mjs";
import { TOOLS_HUB_ID } from "../local/graph-ids.mjs";

export const HOOK_EVENTS = [
  "SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PreCompact", "Stop", "SubagentStop",
];
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_OUTPUT = 64 * 1024;

const registry = [];

function normalizeEvent(name) {
  const hit = HOOK_EVENTS.find((e) => e.toLowerCase() === String(name || "").toLowerCase());
  if (!hit) throw new Error(`unknown hook event "${name}" (one of ${HOOK_EVENTS.join(", ")})`);
  return hit;
}

function toMatcher(m) {
  if (m == null || m === "" || m === "*") return null;
  if (m instanceof RegExp) return m;
  return new RegExp(`^(?:${String(m)})$`);
}

// Add one hook. `def` is { event|trigger, command | fn, matcher?, name?,
// background?, timeout_ms?, source? }. Returns the stored entry.
export function registerHook(def) {
  if (!def || typeof def !== "object") throw new Error("hook must be an object");
  const event = normalizeEvent(def.event || def.trigger);
  if (!def.command && typeof def.fn !== "function") throw new Error(`hook for ${event} needs a "command"`);
  const entry = {
    name: String(def.name || (def.command ? String(def.command).split(/\s+/).slice(0, 2).join(" ") : "extension")).slice(0, 60),
    event,
    matcher: toMatcher(def.matcher),
    command: def.command ? String(def.command) : null,
    fn: typeof def.fn === "function" ? def.fn : null,
    background: def.background === true,
    timeoutMs: Math.max(1000, Math.min(Number(def.timeout_ms ?? def.timeoutMs) || DEFAULT_TIMEOUT_MS, 600000)),
    source: def.source || "settings",
  };
  registry.push(entry);
  return entry;
}

// Drop hooks from one source (an extension being hot-reloaded), or all.
export function clearHooks(source) {
  for (let i = registry.length - 1; i >= 0; i--) {
    if (source === undefined || registry[i].source === source) registry.splice(i, 1);
  }
}

export function listHooks() {
  return registry.map(({ fn, ...rest }) => ({ ...rest, matcher: rest.matcher ? rest.matcher.source : null, kind: fn ? "extension" : "command" }));
}

export function hasHooks(event) {
  return !process.env.OMNI_NO_HOOKS && registry.some((h) => h.event === event);
}

// A hook file holds one hook object or an array of them.
function readHookFile(file, source) {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const defs = Array.isArray(raw) ? raw : Array.isArray(raw?.hooks) ? raw.hooks : [raw];
  const out = [];
  for (const d of defs) out.push(registerHook({ ...d, source }));
  return out;
}

// Load every configured hook. Returns { loaded, errors } for /hooks and startup.
export function loadHooks({ installRoot, files = [], settingsHooks = [], cwd = process.cwd(), projectTrusted = false } = {}) {
  // Extension hooks belong to their extension's load/reload cycle; keep them.
  for (let i = registry.length - 1; i >= 0; i--) {
    if (!registry[i].source.startsWith("extension:")) registry.splice(i, 1);
  }
  const errors = [];
  let loaded = 0;
  for (const rel of Array.isArray(files) ? files : []) {
    const file = path.isAbsolute(rel) ? rel : path.join(installRoot || "", "hooks", rel);
    try { loaded += readHookFile(file, `hooks/${path.basename(file)}`).length; }
    catch (e) { errors.push(`${rel}: ${e.message}`); }
  }
  for (const d of Array.isArray(settingsHooks) ? settingsHooks : []) {
    try { registerHook({ ...d, source: "settings" }); loaded++; }
    catch (e) { errors.push(`settings.hooks: ${e.message}`); }
  }
  // A project's own hooks run commands from a repo you may have just cloned,
  // so they load only once the folder is trusted.
  const projectFile = path.join(cwd, ".omni", "hooks.json");
  if (fs.existsSync(projectFile)) {
    if (!projectTrusted) errors.push(".omni/hooks.json ignored: this folder is not trusted (/workspace trust)");
    else {
      try { loaded += readHookFile(projectFile, "project").length; }
      catch (e) { errors.push(`.omni/hooks.json: ${e.message}`); }
    }
  }
  return { loaded, errors };
}

function killTree(child) {
  if (!child?.pid) return;
  try {
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    else child.kill("SIGKILL");
  } catch { /* already gone */ }
}

function runCommand(hook, payload) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(hook.command, {
        shell: true,
        cwd: process.cwd(),
        windowsHide: true,
        env: { ...process.env, OMNI_HOOK_EVENT: hook.event, OMNI_PROJECT_DIR: process.cwd() },
        stdio: ["pipe", "pipe", "pipe"],
        detached: hook.background && process.platform !== "win32",
      });
    } catch (e) {
      resolve({ code: null, stdout: "", stderr: e.message, error: e.message });
      return;
    }
    if (hook.background) {
      child.on("error", () => {});
      try { child.stdin.end(JSON.stringify(payload)); } catch { /* ignore */ }
      child.stdout.resume();
      child.stderr.resume();
      child.unref?.();
      const t = setTimeout(() => killTree(child), hook.timeoutMs);
      t.unref?.();
      child.on("close", () => clearTimeout(t));
      resolve({ code: 0, stdout: "", stderr: "", background: true });
      return;
    }
    let stdout = "", stderr = "", done = false;
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    const timer = setTimeout(() => {
      killTree(child);
      finish({ code: null, stdout, stderr, error: `timed out after ${Math.round(hook.timeoutMs / 1000)}s` });
    }, hook.timeoutMs);
    child.stdout.on("data", (d) => { if (stdout.length < MAX_OUTPUT) stdout += d; });
    child.stderr.on("data", (d) => { if (stderr.length < MAX_OUTPUT) stderr += d; });
    child.on("error", (e) => finish({ code: null, stdout, stderr, error: e.message }));
    child.on("close", (code) => finish({ code, stdout, stderr }));
    // A hook that never reads stdin closes the pipe early; that is fine.
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(payload));
  });
}

// Turn a command's exit code and output into a decision.
export function interpretCommandResult({ code, stdout = "", stderr = "", error }) {
  if (error) return { error };
  if (code === 2) return { decision: "deny", reason: (stderr || stdout).trim() || "blocked by hook" };
  if (code !== 0) return { error: `exited ${code}${stderr.trim() ? `: ${stderr.trim().split(/\r?\n/)[0]}` : ""}` };
  const out = stdout.trim();
  if (!out) return {};
  if (out.startsWith("{")) {
    try { return normalizeReply(JSON.parse(out)); } catch { /* not JSON, treat as text */ }
  }
  return { additionalContext: out };
}

function normalizeReply(r) {
  if (!r || typeof r !== "object") return {};
  const decision = String(r.decision || r.permissionDecision || "").toLowerCase();
  return {
    decision: decision === "deny" || decision === "block" ? "deny" : decision === "allow" ? "allow" : undefined,
    reason: r.reason != null ? String(r.reason) : undefined,
    args: r.args && typeof r.args === "object" ? r.args : (r.updatedInput && typeof r.updatedInput === "object" ? r.updatedInput : undefined),
    additionalContext: r.additionalContext != null ? String(r.additionalContext) : undefined,
  };
}

async function runOne(hook, payload) {
  if (hook.fn) {
    let timer;
    try {
      const reply = await Promise.race([
        Promise.resolve().then(() => hook.fn(payload)),
        new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`timed out after ${Math.round(hook.timeoutMs / 1000)}s`)), hook.timeoutMs); }),
      ]);
      if (typeof reply === "string") return { additionalContext: reply };
      return normalizeReply(reply);
    } catch (e) {
      return { error: e?.message || String(e) };
    } finally {
      clearTimeout(timer);
    }
  }
  return interpretCommandResult(await runCommand(hook, payload));
}

// UserPromptSubmit for a typed prompt. Returns { denied, reason, by, errors,
// content } where content is the prompt plus any context the hooks added.
export async function submitPromptHooks(prompt) {
  const r = await runHooks("UserPromptSubmit", { prompt });
  return { ...r, content: r.context ? `${prompt}\n\n${r.context}` : prompt };
}

// Run every hook for `event` whose matcher fits `payload.tool` (if any).
// Hooks run in registration order; a rewrite of `args` is handed to the next
// one. Returns { denied, reason, by, args, context, errors, ran }.
export async function runHooks(event, payload = {}) {
  const outcome = { denied: false, reason: "", by: "", args: undefined, context: "", errors: [], ran: 0 };
  if (process.env.OMNI_NO_HOOKS) return outcome;
  const hooks = registry.filter((h) => h.event === event && (!h.matcher || h.matcher.test(String(payload.tool || ""))));
  if (!hooks.length) return outcome;
  let current = { event, cwd: process.cwd(), ...payload };
  const notes = [];
  for (const hook of hooks) {
    outcome.ran++;
    publishActivity({ kind: "tool_call", tool: `hook:${hook.name}`, phase: "start", route: TOOLS_HUB_ID, intent: "scan" });
    const r = await runOne(hook, current);
    publishActivity({ kind: "tool_call", tool: `hook:${hook.name}`, phase: "done", route: TOOLS_HUB_ID, intent: "scan", ok: !r.error && r.decision !== "deny" });
    if (r.error) { outcome.errors.push(`${hook.name}: ${r.error}`); continue; }
    if (r.args && event === "PreToolUse") {
      outcome.args = r.args;
      current = { ...current, args: r.args };
    }
    if (r.additionalContext) notes.push(`[hook ${hook.name}] ${r.additionalContext.trim()}`);
    if (r.decision === "deny") {
      outcome.denied = true;
      outcome.reason = r.reason || "blocked by hook";
      outcome.by = hook.name;
      break;
    }
  }
  outcome.context = notes.join("\n");
  return outcome;
}
