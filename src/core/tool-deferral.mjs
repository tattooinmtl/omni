// Deferred tool definitions.
//
// Every step sends every tool's definition, and with the bundled extensions
// that is ~93 tools, about 14k tokens, before the conversation even starts.
// Most steps use a handful of them. So only CORE_TOOLS (and tools loaded
// this session) are sent; the rest are listed by name in one small
// `load_tools` tool, which loads their definitions for the following steps.
// A deferred tool the model calls directly still runs, and is loaded too.
//
// settings.deferTools: false sends everything, as before;
// settings.alwaysLoadTools: ["name", ...] adds tools to the core set.

export const LOAD_TOOLS = "load_tools";

// The everyday coding loop: read, search, edit, run, git, plan, review.
export const CORE_TOOLS = new Set([
  "read_file", "read_many_files", "list_dir", "find_files", "search", "rag_search", "find_symbol",
  "write_file", "edit_file", "apply_patch",
  "run_shell", "run_test", "start_process", "process_status", "stop_process",
  "git_status", "git_diff", "git_commit",
  "project_inspect", "project_todo", "self_review",
  "find_skill", "invoke_skill", "ask_user", "exit_plan_mode", "goal_complete",
  "memory_save", "memory_search",
  "web_search", "web_fetch",
  "mcp",
]);

// Tools offered on this step. `all` is the live registry (or a sub-agent's
// allowed slice); `loaded` is the session's set of loaded tool names.
export function offeredTools(all, { settings = null, loaded = null } = {}) {
  const list = (all || []).filter((t) => t.function?.name !== LOAD_TOOLS);
  if (settings?.deferTools === false) return { offered: list, deferred: [] };
  const always = new Set([...CORE_TOOLS, ...(Array.isArray(settings?.alwaysLoadTools) ? settings.alwaysLoadTools : [])]);
  const offered = [];
  const deferred = [];
  for (const t of list) {
    const n = t.function?.name;
    // MCP tools only reach the registry when a server is set to directTools,
    // which is the user asking for them up front.
    if (always.has(n) || loaded?.has(n) || n?.startsWith("mcp__")) offered.push(t);
    else deferred.push(t);
  }
  if (!deferred.length) return { offered, deferred };
  return { offered: [...offered, loadToolsDef(deferred)], deferred };
}

export function loadToolsDef(deferred) {
  const names = deferred.map((t) => t.function.name).sort();
  return {
    type: "function",
    function: {
      name: LOAD_TOOLS,
      description:
        "More tools exist than are shown; their definitions are left out to save tokens. " +
        `Not loaded yet: ${names.join(", ")}. ` +
        "Load the ones you need with load_tools({ names: [...] }), or find them with load_tools({ query: \"words\" }); " +
        "they are callable from your next step. Load several at once rather than one per step.",
      parameters: {
        type: "object",
        properties: {
          names: { type: "array", items: { type: "string" }, description: "Exact names of the tools to load" },
          query: { type: "string", description: "Words to match against tool names and descriptions (any word matches); loads up to 8 matches" },
        },
      },
    },
  };
}

const firstSentence = (s) => {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  const m = /^(.{1,160}?[.!?])(\s|$)/.exec(t);
  return m ? m[1] : t.slice(0, 160);
};

// Run load_tools: mark the requested (or matching) tools loaded and say what
// each does. Their full definitions go out with the next request.
export function loadTools(args, deferred, loaded) {
  const byName = new Map(deferred.map((t) => [t.function.name, t]));
  const picked = [];
  const missing = [];
  for (const raw of Array.isArray(args?.names) ? args.names : typeof args?.names === "string" ? args.names.split(/[,\s]+/) : []) {
    const n = String(raw).trim();
    if (!n) continue;
    if (byName.has(n)) picked.push(byName.get(n));
    else if (!loaded.has(n)) missing.push(n);
  }
  const words = String(args?.query || "").toLowerCase().split(/\W+/).filter((w) => w.length > 1);
  if (words.length) {
    const scored = deferred
      .map((t) => {
        const hay = `${t.function.name} ${t.function.description || ""}`.toLowerCase();
        return { t, score: words.reduce((s, w) => s + (t.function.name.includes(w) ? 3 : hay.includes(w) ? 1 : 0), 0) };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);
    for (const { t } of scored) if (!picked.includes(t)) picked.push(t);
  }
  for (const t of picked) loaded.add(t.function.name);
  const lines = [];
  if (picked.length) {
    lines.push(`Loaded ${picked.length} tool(s); call them from your next step:`);
    for (const t of picked) lines.push(`- ${t.function.name}: ${firstSentence(t.function.description)}`);
  } else {
    lines.push(words.length ? `No unloaded tool matches "${args.query}".` : "Nothing to load: pass names or a query.");
  }
  if (missing.length) lines.push(`Not found: ${missing.join(", ")} (already loaded, or no such tool).`);
  return lines.join("\n");
}
