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

const ASSISTANT_RE = /^(what\s+is|what\s+are|who\s+is|explain|summarize|describe|tell\s+me|how\s+do\s+i|can\s+you|write\s+(me\s+)?(a\s+)?(poem|song|story|joke|haiku)|translate|compare|list\s+the|give\s+me|pros\s+and\s+cons|what'?s\s+the\s+difference)/i;

function jsHeuristic(message) {
  // Check assistant-strong signals first so creative/conversational prompts that
  // happen to contain a coding keyword ("poem about debugging") route correctly.
  if (ASSISTANT_RE.test(message)) return { persona: "assistant", confidence: 0.75, method: "js-heuristic" };
  if (CODING_RE.test(message)) return { persona: "coding", confidence: 0.80, method: "js-heuristic" };
  return { persona: "coding", confidence: 0.50, method: "js-default" };
}

// ---------------------------------------------------------------------------
// Sidecar management
// ---------------------------------------------------------------------------
let _proc = null;       // the Python sidecar child process
let _rl   = null;       // readline on its stdout
let _pending = null;    // single in-flight promise (one call at a time)
let _dead  = false;     // true after a fatal crash — stops respawn loops

const TIMEOUT_MS = 150; // fall back to JS heuristic after this long

function _spawnSidecar(pythonExe) {
  if (_dead) return;
  try {
    _proc = spawn(pythonExe, [SIDECAR_SCRIPT], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    _proc.on("error", _handleDeath);
    _proc.on("exit",  _handleDeath);
    _proc.stderr.on("data", () => {}); // suppress; errors come back as JSON

    _rl = createInterface({ input: _proc.stdout });
    _rl.on("line", (line) => {
      if (_pending) {
        const { resolve } = _pending;
        _pending = null;
        try { resolve(JSON.parse(line)); } catch { resolve(null); }
      }
    });
  } catch {
    _proc = null;
    _rl   = null;
  }
}

function _handleDeath() {
  _proc = null;
  _rl   = null;
  if (_pending) {
    _pending.reject(new Error("sidecar died"));
    _pending = null;
  }
}

function _send(req) {
  if (!_proc || _proc.exitCode !== null) return null;
  return new Promise((resolve, reject) => {
    _pending = { resolve, reject };
    try {
      _proc.stdin.write(JSON.stringify(req) + "\n");
    } catch {
      _pending = null;
      reject(new Error("sidecar write failed"));
    }
  });
}

async function _sidecarCall(req, pythonExe, timeoutMs = TIMEOUT_MS) {
  if (!_proc && !_dead) _spawnSidecar(pythonExe);
  if (!_proc) return null;

  return Promise.race([
    _send(req),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("sidecar timeout")), timeoutMs)
    ),
  ]).catch(() => null);
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
    try { _proc.kill(); } catch { /* already dead */ }
    _proc = null;
    _rl   = null;
  }
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
