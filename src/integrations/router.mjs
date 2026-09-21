// src/router.mjs — Intent router for Omni Agent.
//
// Two things live here:
//   1. PERSONAS  — coding vs assistant persona definitions (system prompt +
//                  loop budget). Both see the full shared tool registry.
//   2. Router    — classifyIntent() talks to the warm Python sidecar
//                  (router/service.py) over stdin/stdout JSON.  If the
//                  sidecar is absent / slow / dead it falls back instantly
//                  to JS regex heuristics, so a turn is NEVER slower or
//                  more fragile than the current pure-Node path.
//
// The sidecar is spawned lazily on first classify call and kept warm across
// all turns.  Node kills it on exit alongside MCP/llama teardown.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { systemPrompt as codingSystemPrompt } from "../core/agent.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SIDECAR_SCRIPT = path.join(__dirname, "..", "..", "router", "service.py");

// ---------------------------------------------------------------------------
// Persona definitions
// ---------------------------------------------------------------------------
// Both personas expose the FULL shared tool registry (src/tools.mjs + any
// loaded extensions/MCP/Omni).  The difference is system prompt + budget.

export const PERSONAS = {
  coding: {
    id: "coding",
    label: "coding",
    statusLabel: "coding",
    maxIterations: 30,
    systemPrompt: codingSystemPrompt,   // reuse the existing agent.mjs prompt
  },
  assistant: {
    id: "assistant",
    label: "assistant",
    statusLabel: "assistant",
    maxIterations: 12,
    systemPrompt() {
      return [
        "You are Omni, a knowledgeable AI assistant.",
        "Help the user with questions, explanations, research, planning, and analysis.",
        `Working directory: ${process.cwd()}`,
        "",
        "Guidelines:",
        "- Prefer clear, concise explanations over lengthy prose.",
        "- Use tools (web_search, read_file, etc.) when they'd give a better answer.",
        "- If the user's request is actually a coding task, say so and switch approach.",
        "- Keep answers focused and actionable.",
      ].join("\n");
    },
  },
};

// ---------------------------------------------------------------------------
// JS regex heuristics (used when sidecar is unavailable)
// ---------------------------------------------------------------------------
const CODING_RE = /\b(fix|bug|error|exception|traceback|refactor|implement|build|compile|debug|test|lint|deploy|migrate|patch|commit|rebase|merge|dockerfile|webpack|vite|npm|pip|cargo|gradle|cmake|makefile)\b|\.(py|js|ts|mjs|rs|go|java|cpp|c|cs|rb|php|sh|sql|yml|yaml|toml|json)\b|```[\w]*\n|def\s+\w+\s*\(|function\s+\w+\s*\(|class\s+\w+[\s:(]|import\s+\w|from\s+\w+\s+import|(File|line)\s+\d+/i;

// Creative/translation asks are assistant work even when they mention code —
// "write me a poem about debugging" is a poem, not a debugging task. These
// outrank the coding signals.
const CREATIVE_RE = /^(write\s+(me\s+)?(a\s+)?(poem|song|story|joke|haiku|limerick)|translate\b)/i;

// Generic conversational openers. These are WEAK: they say how the sentence
// starts, not what it's about. "How do I…", "Can you…" and "Give me…" open
// plenty of real build requests, so a coding signal in the rest of the
// message outranks them.
const OPENER_RE = /^(what\s+is|what\s+are|who\s+is|explain|summarize|describe|tell\s+me|how\s+do\s+i|can\s+you|compare|list\s+the|give\s+me|pros\s+and\s+cons|what'?s\s+the\s+difference)/i;

// Build/scaffold vocabulary that CODING_RE misses. It keys on repair verbs
// ("fix", "bug", "refactor") and file extensions, so a from-scratch request
// like "make a chat app with websockets" carries no signal at all and used to
// fall through to whichever branch matched first.
// Bare "app" and "site" are deliberately absent: they appear in plenty of
// prose questions ("summarize the twelve-factor app") and turned those into
// coding turns. Compound and framework terms carry the build intent instead.
const BUILD_RE = /\b(api|backend|frontend|full[\s-]?stack|database|schema|endpoint|web\s?app|mobile\s+app|website|dashboard|landing\s+page|scaffold|boilerplate|crud|authentication|component|micro-?service|e-?commerce|saas|react|next\.?js|vue|svelte|express|fastapi|django|flask|rails|postgres|mysql|sqlite|mongo|tailwind|websocket)\b/i;

export function jsHeuristic(message) {
  const text = String(message || "");
  // Creative first — it must win even when the topic is code.
  if (CREATIVE_RE.test(text)) return { persona: "assistant", confidence: 0.80, method: "js-heuristic" };
  // Then real work signals. Checking these BEFORE the generic openers is the
  // fix: previously ASSISTANT_RE ran first, so "how do i build a full stack
  // app with auth" and "can you create a next.js dashboard" were classified
  // assistant — a 425-char prompt with no workflow, no VERIFY step, no skill
  // guidance and 12 tool iterations instead of 30. This path is the fallback
  // whenever the Python sidecar is missing, so it has to stand on its own.
  if (CODING_RE.test(text) || BUILD_RE.test(text)) {
    return { persona: "coding", confidence: 0.80, method: "js-heuristic" };
  }
  // A bare conversational question with no work signal really is assistant.
  if (OPENER_RE.test(text)) return { persona: "assistant", confidence: 0.75, method: "js-heuristic" };
  return { persona: "coding", confidence: 0.50, method: "js-default" };
}

// ---------------------------------------------------------------------------
// Sidecar management
// ---------------------------------------------------------------------------
let _proc = null;       // the Python sidecar child process
let _rl   = null;       // readline on its stdout
let _pending = new Map(); // id -> { resolve, timer } for every in-flight call
let _nextId = 1;
let _dead  = false;     // true once the interpreter is known to be missing

const TIMEOUT_MS = 150; // fall back to JS heuristic after this long

function _spawnSidecar(pythonExe) {
  if (_dead) return;
  try {
    _proc = spawn(pythonExe, [SIDECAR_SCRIPT], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    _proc.on("error", (err) => {
      // ENOENT means the configured interpreter doesn't exist — retrying on
      // every turn just burns a process spawn each time. Any other failure
      // may be transient, so the sidecar stays respawnable.
      if (err?.code === "ENOENT") _dead = true;
      _handleDeath();
    });
    _proc.on("exit",  _handleDeath);
    _proc.stdin.on("error", () => {}); // EPIPE if it died mid-write
    _proc.stderr.on("data", () => {}); // suppress; errors come back as JSON

    _rl = createInterface({ input: _proc.stdout });
    _rl.on("line", (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      // The sidecar echoes `_id`. A response without one (an older sidecar
      // build) is matched to the oldest in-flight call, which is correct
      // whenever there is only one — and there usually is.
      const id = msg?._id ?? _pending.keys().next().value;
      const entry = _pending.get(id);
      if (!entry) return;
      _pending.delete(id);
      clearTimeout(entry.timer);
      entry.resolve(msg);
    });
  } catch {
    _proc = null;
    _rl   = null;
  }
}

function _handleDeath() {
  _proc = null;
  _rl   = null;
  for (const { resolve, timer } of _pending.values()) {
    clearTimeout(timer);
    resolve(null); // callers all treat null as "fall back"
  }
  _pending.clear();
}

// Resolves with the sidecar's reply, or null on timeout / write failure /
// death. Every caller falls back to a local path when it gets null, so this
// never rejects.
function _send(req, timeoutMs) {
  if (!_proc || _proc.exitCode !== null) return Promise.resolve(null);
  const id = _nextId++;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      // Drop the slot so a late reply isn't handed to the NEXT caller — the
      // old single-slot channel did exactly that, so a slow classify could
      // resolve a later render_template call with the wrong payload.
      _pending.delete(id);
      resolve(null);
    }, timeoutMs);
    timer.unref?.();
    _pending.set(id, { resolve, timer });
    try {
      _proc.stdin.write(JSON.stringify({ ...req, _id: id }) + "\n");
    } catch {
      _pending.delete(id);
      clearTimeout(timer);
      resolve(null);
    }
  });
}

async function _sidecarCall(req, pythonExe, timeoutMs = TIMEOUT_MS) {
  if (!_proc && !_dead) _spawnSidecar(pythonExe);
  if (!_proc) return null;
  return _send(req, timeoutMs);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Classify the user's turn. Returns a persona object from PERSONAS. */
export async function classifyIntent({ message, history = [], settings = {} }) {
  const routerCfg  = settings.router  || {};
  const pythonExe  = routerCfg.python?.interpreter || "python";
  const threshold  = routerCfg.python?.confidenceThreshold ?? 0.60;

  const result = await _sidecarCall(
    { type: "classify", message, confidence_threshold: threshold },
    pythonExe
  );

  const persona = (result?.persona && PERSONAS[result.persona])
    ? result.persona
    : jsHeuristic(message).persona;

  return PERSONAS[persona];
}

/** Trim a system prompt for local model inference (delegates to sidecar). */
export async function trimSystemPrompt(content, { settings = {}, maxChars = 8000 } = {}) {
  const routerCfg = settings.router || {};
  const pythonExe = routerCfg.python?.interpreter || "python";

  const result = await _sidecarCall({ type: "trim", content, max_chars: maxChars }, pythonExe);
  return result?.content ?? content;
}

/** Warm-start the sidecar so the first real turn has no latency. */
export function warmSidecar(settings = {}) {
  const pythonExe = settings.router?.python?.interpreter || "python";
  if (!_proc && !_dead) _spawnSidecar(pythonExe);
  // Ping it so any load errors surface early (fire-and-forget).
  _sidecarCall({ type: "ping" }, pythonExe).catch(() => {});
}

/** Kill the sidecar on Omni exit. */
export function killSidecar() {
  if (_proc) {
    const proc = _proc;
    _handleDeath(); // settles in-flight calls and clears their timers
    try { proc.kill(); } catch { /* already dead */ }
  }
}

// Test hook: how many sidecar calls are still in flight. A timeout must free
// its slot, otherwise a late reply gets handed to an unrelated later call.
export function _sidecarPendingForTest() {
  return _pending.size;
}

/**
 * Render a Jinja2 chat template via the Python sidecar.
 * messages must be in OpenAI format; tool_call arguments are auto-converted
 * from JSON strings to objects so the template can iterate over them.
 * Mid-conversation system messages (compact notices etc.) are coerced to
 * user messages since the Qwythos template requires system to be first-only.
 * Returns the rendered prompt string, or throws on error.
 */
export async function renderTemplate(templatePath, messages, tools = [], settings = {}) {
  const pythonExe = settings.router?.python?.interpreter || "python";

  // Coerce non-first system messages and unwrap tool_call arguments
  const renderMessages = messages.map((msg, i) => {
    if (msg.role === "system" && i > 0) {
      return { role: "user", content: `[${msg.content}]` };
    }
    if (msg.role === "assistant" && msg.tool_calls?.length) {
      return {
        ...msg,
        tool_calls: msg.tool_calls.map((tc) => ({
          ...tc,
          function: {
            ...tc.function,
            arguments: (() => {
              try {
                return typeof tc.function.arguments === "string"
                  ? JSON.parse(tc.function.arguments)
                  : tc.function.arguments;
              } catch { return {}; }
            })(),
          },
        })),
      };
    }
    return msg;
  });

  const result = await _sidecarCall(
    {
      type: "render_template",
      template_path: templatePath,
      messages: renderMessages,
      tools: tools.length ? tools : null,
      opts: { add_generation_prompt: true },
    },
    pythonExe,
    5000,   // template rendering can take a bit; 5 s is generous
  );

  if (!result) throw new Error("sidecar unavailable for template rendering");
  if (result.error) throw new Error(`Template render: ${result.error}`);
  return result.rendered;
}
