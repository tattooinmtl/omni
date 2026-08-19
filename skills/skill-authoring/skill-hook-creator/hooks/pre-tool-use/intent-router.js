/**
 * hooks/pre-tool-use/intent-router.js
 *
 * PreToolUse hook — classifies the user's current message before tool execution
 * and injects persona context into the system prompt.
 *
 * Protocol (Omni PreToolUse hook):
 *   Input:  { message: string, tools: string[], turnIndex: number }
 *   Output: { systemPromptPatch?: string, persona: string, confidence: number }
 *
 * The hook runs the router service (service.py) via stdin/stdout NDJSON.
 * If the service is unavailable, it falls back to a built-in heuristic so the
 * agent never blocks on a missing sidecar.
 */

const { spawn } = require("node:child_process");
const path = require("node:path");
const os = require("node:os");

// ---------------------------------------------------------------------------
// Paths — resolve relative to the hook file itself
// ---------------------------------------------------------------------------
const HOOK_DIR = __dirname; // hooks/pre-tool-use/
const ROUTER_DIR = path.resolve(HOOK_DIR, "../../../router");
const SERVICE_PY = path.join(ROUTER_DIR, "service.py");
const PYTHON = process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3");

// ---------------------------------------------------------------------------
// Built-in heuristic fallback (used when service.py is unavailable)
// ---------------------------------------------------------------------------
const CODING_RE = RegExp(
  [
    "\\b(fix|bug|error|exception|traceback|refactor|implement|build|compile|",
    "debug|test|lint|deploy|migrate|patch|diff|commit|rebase|merge|",
    "dockerfile|webpack|vite|npm|pip|cargo|gradle|cmake|makefile|ci)\\b",
    "| \\.(py|js|ts|mjs|rs|go|java|cpp|c|cs|rb|php|sh|sql|yml|yaml|toml|json)\\b",
    "| ```[\\w]*\\n",
    "| def\\s+\\w+\\s*\\(",
    "| function\\s+\\w+\\s*\\(",
    "| class\\s+\\w+[\\s:(]",
    "| import\\s+\\w",
    "| from\\s+\\w+\\s+import",
    "| (File|line)\\s+\\d+",
  ].join(""),
  "i",
);

const ASSISTANT_RE = RegExp(
  [
    "^(what\\s+is|what\\s+are|who\\s+is|explain|summarize|describe|",
    "tell\\s+me|how\\s+do\\s+I|can\\s+you|write\\s+a\\s+poem|",
    "translate|compare|list\\s+the|give\\s+me\\s+(a\\s+)?list|",
    "pros\\s+and\\s+cons|what'?s\\s+the\\s+difference)",
  ].join(""),
  "i",
);

function heuristicClassify(message) {
  const msg = (message || "").trim();
  if (CODING_RE.test(msg) && msg.length > 5) {
    return { persona: "coding", confidence: 0.85 };
  }
  if (ASSISTANT_RE.test(msg)) {
    return { persona: "assistant", confidence: 0.80 };
  }
  return { persona: "coding", confidence: 0.50 }; // default
}

// ---------------------------------------------------------------------------
// Router service client (NDJSON over stdin/stdout)
// ---------------------------------------------------------------------------
function classifyViaService(message) {
  return new Promise((resolve) => {
    const proc = spawn(PYTHON, [SERVICE_PY], {
      cwd: ROUTER_DIR,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    let output = "";
    proc.stdout.on("data", (chunk) => {
      output += chunk.toString();
      // First complete line is our response
      const lines = output.split("\n");
      if (lines.length >= 2) {
        const respLine = lines[lines.length - 2]; // last complete line
        try {
          const resp = JSON.parse(respLine);
          if (resp.persona) {
            resolve(resp);
            proc.kill();
            return;
          }
        } catch (_) {}
      }
    });

    proc.stderr.on("data", () => {
      // Ignore stderr — service may print warnings
    });

    proc.on("close", (code) => {
      // If we didn't get a response yet, try parsing whatever we have
      try {
        const lines = output.trim().split("\n");
        const last = lines[lines.length - 1];
        const resp = JSON.parse(last);
        if (resp.persona) {
          resolve(resp);
          return;
        }
      } catch (_) {}
      // Service died — fall through to heuristic
      resolve(null);
    });

    // Send the classify request
    const req = JSON.stringify({ type: "classify", message });
    proc.stdin.write(req + "\n");

    // Safety timeout — if service is slow, kill and use heuristic
    setTimeout(() => {
      proc.kill();
      resolve(null);
    }, 3000);
  });
}

// ---------------------------------------------------------------------------
// Persona context patches
// ---------------------------------------------------------------------------
const PERSONA_PATCHES = {
  coding: [
    "You are in CODING mode. Prioritize precise, technical responses.",
    "Focus on code, tools, debugging, and implementation details.",
    "Use concrete examples and reference actual files when possible.",
  ].join(" "),
  assistant: [
    "You are in ASSISTANT mode. Provide clear, educational explanations.",
    "Focus on concepts, comparisons, and understanding over implementation.",
    "Use analogies and structured breakdowns for complex topics.",
  ].join(" "),
};

// ---------------------------------------------------------------------------
// Main hook entry point
// ---------------------------------------------------------------------------
async function main() {
  // Read hook input from stdin (Omni passes JSON)
  let inputData;
  try {
    const raw = await new Promise((resolve, reject) => {
      let data = "";
      process.stdin.on("data", (chunk) => { data += chunk; });
      process.stdin.on("end", () => resolve(data));
      process.stdin.on("error", reject);
    });
    inputData = JSON.parse(raw.trim());
  } catch (e) {
    // No valid input — return neutral
    return JSON.stringify({ persona: "coding", confidence: 0.50, systemPromptPatch: "" });
  }

  const { message, tools, turnIndex } = inputData;

  // Classify the message
  let result = await classifyViaService(message);

  // Fallback to heuristic if service unavailable
  if (!result) {
    result = heuristicClassify(message);
  }

  const { persona, confidence, method = result.method || "fallback" } = result;

  // Build system prompt patch
  const patch = PERSONA_PATCHES[persona] || PERSONA_PATCHES.coding;

  const output = {
    persona,
    confidence,
    method,
    systemPromptPatch: patch,
    turnIndex,
  };

  process.stdout.write(JSON.stringify(output) + "\n");
}

main().catch((err) => {
  console.error("Intent router hook error:", err.message);
  process.exit(1);
});
