// Session-context marker — wraps the tail of the system prompt that is built
// once at startup (environment, skill catalog, memory preamble) so it can
// survive the per-turn persona swap in core/agent.mjs.
//
// Lives in its own module rather than in integrations/extras.mjs because
// extras.mjs already imports agent.mjs (for the fallback prompt); having
// agent.mjs import back would close a cycle.
//
// Same marker + strip-and-reinsert trick as core/local-prompt.mjs and
// core/okfnav.mjs, minus the strip — the block is replaced wholesale by
// whoever rebuilds it, not re-derived per turn.

export const SESSION_CONTEXT_START = "<!-- omni:session-context:start -->";
export const SESSION_CONTEXT_END = "<!-- omni:session-context:end -->";

const SESSION_CONTEXT_RE =
  /\n*<!-- omni:session-context:start -->[\s\S]*?<!-- omni:session-context:end -->\n*/;

// Pull the session-context block out of a built system prompt. Returns "" when
// the prompt has none (a bare persona prompt, or a caller that never built one).
export function extractSessionContext(content) {
  const m = SESSION_CONTEXT_RE.exec(String(content || ""));
  return m ? m[0].replace(/^\n+|\n+$/g, "") : "";
}

// Wrap an already-rendered context body in the marker.
export function wrapSessionContext(body) {
  return [SESSION_CONTEXT_START, String(body || "").trim(), SESSION_CONTEXT_END].join("\n");
}
