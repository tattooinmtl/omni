// Index-first OKF navigation guidance — injected for LOCAL models only.
//
// Small models served by the bundled llama.cpp server (or another loopback
// endpoint like Ollama) need explicit rails to use the hierarchical OKF
// knowledge index without hallucinating folder paths or card ids. Frontier
// hosted models (NVIDIA, OpenAI, Claude via OpenRouter, …) don't need the
// method forced on them, so this block is added/removed from the system
// message per turn based on the ACTIVE model — switching models mid-session
// with /model updates it on the next turn.

const START = "<!-- okf-local-nav:start -->";
const END = "<!-- okf-local-nav:end -->";
const BLOCK_RE = /\n*<!-- okf-local-nav:start -->[\s\S]*?<!-- okf-local-nav:end -->\n*/g;

// A model is "local" when it is served from this machine: the bundled
// llama.cpp provider (named "local"), Ollama, or any loopback baseUrl.
export function isLocalModel(model) {
  const name = String(model?.providerName || "").toLowerCase();
  if (name === "local" || name === "ollama") return true;
  return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])([:/]|$)/i.test(
    String(model?.provider?.baseUrl || "")
  );
}

// Short and imperative on purpose: small models follow numbered rules far more
// reliably than prose, and every token here is paid on every request.
export function okfNavGuidance() {
  return [
    START,
    "# Knowledge base navigation (local model rules)",
    "A persistent OKF knowledge base is available through the okf tools (okf_browse, okf_get, okf_search, okf_add — possibly named mcp__okf__okf_browse etc., or reachable via the mcp proxy tool).",
    "Follow these rules EXACTLY — they prevent invented results:",
    "1. To look something up, FIRST call okf_browse with no arguments to see the real root index, then descend with okf_browse({path:\"<folder shown>\"}).",
    "2. NEVER invent folder paths or card ids. Only use paths and ids copied verbatim from a previous okf tool result.",
    "3. Open cards only with okf_get({id}) using an id you saw in browse/search output.",
    "4. If two browse steps have not reached the topic, stop browsing and use okf_search({query}) instead.",
    "5. Before saving with okf_add, check the right folder with okf_browse and file the card there. If a similar card exists, extend it with okf_update({id, append}).",
    "6. If an okf tool returns an error, the error lists the valid options — correct the call from that list. Do not retry the same arguments and do not fabricate an answer from memory.",
    END,
  ].join("\n");
}

function hasOkfTools(toolList) {
  return (toolList || []).some((t) => {
    const n = t?.function?.name || "";
    return n === "mcp" || n.startsWith("mcp__okf__");
  });
}

// Add or remove the guidance block on the system message to match the active
// model. Idempotent; called at the top of every turn.
export function syncOkfNavGuidance(messages, model, toolList) {
  if (!Array.isArray(messages) || !messages.length || messages[0].role !== "system") return false;
  const base = String(messages[0].content || "").replace(BLOCK_RE, "\n").replace(/\n+$/, "");
  const wanted = isLocalModel(model) && hasOkfTools(toolList);
  const content = wanted ? base + "\n\n" + okfNavGuidance() : base;
  if (content !== messages[0].content) {
    messages[0] = { ...messages[0], content };
  }
  return wanted;
}
