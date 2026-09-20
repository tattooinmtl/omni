// Local-model prompt companion — appended to the system message per turn
// whenever the active model is served locally (llama.cpp on this machine,
// Ollama, or any loopback baseUrl). Mirrors src/core/okfnav.mjs so both
// live in the same "swap-per-turn on model change" family.
//
// Why per-turn (not baked into buildSystemPrompt): the user can /model
// between a local GGUF and a frontier provider mid-session. Cloud models
// don't need — and shouldn't be paying tokens for — the strict small-model
// rails; local models do. Marker + strip-and-reinsert is the same trick
// okfnav uses.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isLocalModel } from "./okfnav.mjs";
import { parseFrontmatter } from "./frontmatter.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INSTALL_ROOT = path.resolve(__dirname, "..", "..");

const START = "<!-- local-model-prompt:start -->";
const END = "<!-- local-model-prompt:end -->";
const BLOCK_RE = /\n*<!-- local-model-prompt:start -->[\s\S]*?<!-- local-model-prompt:end -->\n*/g;

const DEFAULT_LOCAL_PROMPT_FILE = "skills/agent-orchestration/local-llama-instructions.md";

// Load once per process — the file only changes on `omni update`, never
// mid-session. mtime check would burn a syscall per turn for no benefit.
let _cache = null;

// Read the configured prompt file and cache it. Returns "" when the file
// is missing, the config points at nothing, or the config explicitly
// disables the feature (localPromptFile: "").
export function loadLocalPromptBody(config) {
  if (_cache !== null) return _cache;
  const rel = typeof config?.localPromptFile === "string"
    ? config.localPromptFile
    : DEFAULT_LOCAL_PROMPT_FILE;
  if (!rel) { _cache = ""; return _cache; }
  const abs = path.isAbsolute(rel) ? rel : path.join(INSTALL_ROOT, rel);
  try {
    const raw = fs.readFileSync(abs, "utf8");
    // The model doesn't need the loaded_by/audience metadata, it just adds
    // tokens. Uses the shared parser rather than a local `startsWith("---\n")`
    // check, which silently did nothing on a Windows checkout — .md files come
    // off the wire CRLF, so every local-model turn shipped the raw YAML.
    _cache = parseFrontmatter(raw).body.trim();
  } catch {
    _cache = "";
  }
  return _cache;
}

// Test hook: forget the cached body so the next loadLocalPromptBody call
// re-reads from disk. Not intended for production code.
export function _resetCache() { _cache = null; }

// Idempotent injector: adds the local-prompt block to messages[0] when the
// active model is local; strips it otherwise. Safe to call every turn.
// Returns true if the block is present after this call.
export function syncLocalPromptGuidance(messages, model, config) {
  if (!Array.isArray(messages) || !messages.length || messages[0].role !== "system") return false;
  const base = String(messages[0].content || "").replace(BLOCK_RE, "\n").replace(/\n+$/, "");
  const body = isLocalModel(model) ? loadLocalPromptBody(config) : "";
  const content = body
    ? base + "\n\n" + START + "\n" + body + "\n" + END
    : base;
  if (content !== messages[0].content) {
    messages[0] = { ...messages[0], content };
  }
  return !!body;
}
