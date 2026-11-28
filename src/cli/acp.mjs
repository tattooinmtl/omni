// src/cli/acp.mjs — `omni --acp`: Omni as an agent for editors that speak the
// Agent Client Protocol (Zed, and VS Code / JetBrains through ACP plugins).
//
// JSON-RPC 2.0, one message per line on stdin/stdout (the terminal UI goes to
// stderr). What Omni answers:
//   initialize         protocolVersion 1, text and embedded-context prompts
//   session/new        { cwd } → { sessionId }: a fresh conversation in that folder
//   session/prompt     { sessionId, prompt: [blocks] } → { stopReason } once the turn ends;
//                      meanwhile session/update notifications stream the reply
//                      (agent_message_chunk), and each tool call (tool_call, then
//                      tool_call_update when it finishes)
//   session/cancel     stop that session's turn (stopReason "cancelled")
// What Omni asks the editor: session/request_permission, when a tool needs the
// user's OK (a tool set to "ask", or a high-risk command); the editor's
// allow once / allow always / reject becomes y / a / n.
//
// The editor's own MCP server list in session/new is not used: Omni connects
// the servers in its own config. Prompts run one at a time.

import readline from "node:readline";
import crypto from "node:crypto";
import path from "node:path";
import { runTurn } from "../core/agent.mjs";
import { Session, turnMaxIterations } from "../core/config.mjs";
import { registerHook, clearHooks } from "../core/hooks.mjs";
import { currentVersion } from "../integrations/update-check.mjs";
import { thinkFilter } from "./serve.mjs";

export const PROTOCOL_VERSION = 1;

const KIND = {
  read_file: "read", read_many_files: "read", list_dir: "read", project_inspect: "read", git_status: "read", git_diff: "read", git_log: "read",
  edit_file: "edit", write_file: "edit", apply_patch: "edit", edit_lines: "edit", find_replace: "edit", rename_symbol: "edit",
  delete_path: "delete", move_file: "move",
  search: "search", find_files: "search", rag_search: "search", find_symbol: "search", search_pc: "search", memory_search: "search",
  run_shell: "execute", run_test: "execute", start_process: "execute",
  web_fetch: "fetch", web_search: "fetch", http_request: "fetch", youtube_transcript: "fetch",
};
export const toolKind = (name) => KIND[name] || "other";

const clip = (s, n) => { const t = String(s ?? ""); return t.length > n ? t.slice(0, n) + `…[${t.length - n} more characters]` : t; };

function parseArgs(raw) {
  if (raw && typeof raw === "object") return raw;
  try { return JSON.parse(raw || "{}"); } catch { return {}; }
}

// A short human title for a tool call, and the files it touches.
export function describeCall(name, args = {}, cwd = process.cwd()) {
  const p = args.path || args.file || args.from || null;
  const abs = p ? path.resolve(cwd, String(p)) : null;
  let title = name;
  if (args.command) title = `${name}: ${clip(args.command, 80)}`;
  else if (p) title = `${name} ${p}`;
  else if (args.query || args.pattern) title = `${name} ${clip(args.query || args.pattern, 60)}`;
  else if (args.url) title = `${name} ${clip(args.url, 80)}`;
  return { title, kind: toolKind(name), locations: abs ? [{ path: abs }] : [] };
}

// The prompt blocks an editor sends → one user message.
export function promptText(blocks = []) {
  const parts = [];
  for (const b of Array.isArray(blocks) ? blocks : []) {
    if (b?.type === "text" && b.text) parts.push(b.text);
    else if (b?.type === "resource" && b.resource) {
      const r = b.resource;
      if (r.text != null) parts.push(`Context from ${r.uri || "the editor"}:\n\`\`\`\n${r.text}\n\`\`\``);
      else if (r.uri) parts.push(`(the editor attached ${r.uri})`);
    } else if (b?.type === "resource_link" && b.uri) {
      parts.push(`(the editor refers to ${b.uri}${b.name ? ` — ${b.name}` : ""})`);
    }
  }
  return parts.join("\n\n").trim();
}

const STOP = { done: "end_turn", aborted: "cancelled", max_iterations: "max_turn_requests", turn_limit: "max_turn_requests", error: "end_turn" };

export function startAcp(ctx, { emit, input = process.stdin, onExit = () => process.exit(0) } = {}) {
  const sessions = new Map();     // sessionId → { messages, session, cwd, abort }
  const waiting = new Map();      // our request id → resolve
  let nextId = 1;
  let queue = Promise.resolve();
  let current = null;             // the session whose turn is running

  const reply = (id, result) => emit({ jsonrpc: "2.0", id, result });
  const fail = (id, code, message) => emit({ jsonrpc: "2.0", id, error: { code, message } });
  const notify = (sessionId, update) => emit({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
  const request = (method, params) => new Promise((resolve) => {
    const id = `omni-${nextId++}`;
    waiting.set(id, resolve);
    emit({ jsonrpc: "2.0", id, method, params });
  });

  // Streamed words go to the session whose turn is running.
  let write = null;
  clearHooks("omni-acp");
  registerHook({ event: "StreamToken", name: "omni-acp", source: "omni-acp", fn: ({ token }) => { write?.(token); } });

  // The editor's permission dialog stands in for the terminal's y/N/a.
  ctx.confirmToolUse = async (tool, summary) => {
    if (!current) return "n";
    const toolCallId = `perm_${crypto.randomBytes(4).toString("hex")}`;
    const r = await request("session/request_permission", {
      sessionId: current.id,
      toolCall: { toolCallId, title: `${tool}${summary ? `: ${clip(summary, 200)}` : ""}`, kind: toolKind(tool), status: "pending" },
      options: [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "allow-always", name: "Allow for this session", kind: "allow_always" },
        { optionId: "reject-once", name: "Reject", kind: "reject_once" },
      ],
    });
    const o = r?.result?.outcome;
    if (o?.outcome !== "selected") return "n";
    return o.optionId === "allow-always" ? "a" : o.optionId === "allow-once" ? "y" : "n";
  };
  ctx.askUser = async () => "(the user can't answer questions from the editor's agent panel: decide yourself, or say in your reply what you need)";

  // Tool calls and results, from the session log as the turn writes it.
  function watch(s) {
    const append = s.session.append.bind(s.session);
    s.session.append = async (rec) => {
      try {
        if (rec?.type === "assistant" && rec.message?.tool_calls?.length) {
          for (const c of rec.message.tool_calls) {
            const d = describeCall(c.function?.name, parseArgs(c.function?.arguments), s.cwd);
            notify(s.id, { sessionUpdate: "tool_call", toolCallId: c.id, title: d.title, kind: d.kind, status: "in_progress", locations: d.locations });
          }
        } else if (rec?.type === "tool" && rec.tool_call_id) {
          const text = typeof rec.result === "string" ? rec.result : String(rec.result?.text ?? "");
          const failed = /^(ERROR|DENIED|BLOCKED)\b/.test(text);
          notify(s.id, { sessionUpdate: "tool_call_update", toolCallId: rec.tool_call_id, status: failed ? "failed" : "completed",
            content: [{ type: "content", content: { type: "text", text: clip(text, 4000) } }] });
        }
      } catch { /* the log matters more than the panel */ }
      return append(rec);
    };
  }

  async function runPrompt(id, params) {
    const s = sessions.get(params?.sessionId);
    if (!s) return fail(id, -32602, `no session ${params?.sessionId} (call session/new first)`);
    const text = promptText(params.prompt);
    if (!text) return fail(id, -32602, "the prompt has no text");
    if (path.resolve(process.cwd()) !== path.resolve(s.cwd)) process.chdir(s.cwd);
    s.messages.push({ role: "user", content: text });
    await s.session.append({ type: "user", content: text });
    s.abort = new AbortController();
    current = s;
    write = thinkFilter((t) => notify(s.id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: t } }));
    let outcome;
    try {
      outcome = await runTurn({
        model: ctx.model, settings: ctx.settings, messages: s.messages, session: s.session,
        maxIterations: turnMaxIterations(ctx.model, ctx.settings),
        permissions: ctx.settings.permissions, confirmTool: ctx.confirmToolUse,
        signal: s.abort.signal, contextMode: ctx.contextMode, diffPreview: false,
      });
    } catch (e) {
      outcome = { stop: "error", error: e.message || String(e) };
    } finally {
      write?.flush?.();
      write = null;
      current = null;
    }
    if (outcome?.stop === "error" && outcome.error) {
      notify(s.id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `\n\n[Omni: ${outcome.error}]` } });
    }
    reply(id, { stopReason: s.abort.signal.aborted ? "cancelled" : STOP[outcome?.stop] || "end_turn" });
  }

  const methods = {
    initialize: (id) => reply(id, {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: { loadSession: false, promptCapabilities: { image: false, audio: false, embeddedContext: true }, mcpCapabilities: { http: false, sse: false } },
      authMethods: [],
      agentInfo: { name: "omni", title: "Omni", version: currentVersion() },
    }),
    "session/new": (id, p) => {
      const cwd = p?.cwd && path.isAbsolute(p.cwd) ? p.cwd : process.cwd();
      const sessionId = `sess_${crypto.randomBytes(8).toString("hex")}`;
      const before = process.cwd();
      process.chdir(cwd);
      const system = { ...ctx.messages[0] };
      if (typeof system.content === "string") system.content = system.content.split(`Working directory: ${before}`).join(`Working directory: ${cwd}`);
      const s = { id: sessionId, cwd, messages: [system], session: new Session({ kind: "acp" }), abort: null };
      watch(s);
      sessions.set(sessionId, s);
      reply(id, { sessionId });
    },
    "session/prompt": (id, p) => {
      const job = queue.then(() => runPrompt(id, p));
      queue = job.catch((e) => fail(id, -32603, e.message || String(e)));
    },
    "session/cancel": (_id, p) => { sessions.get(p?.sessionId)?.abort?.abort(); },
    authenticate: (id) => reply(id, {}),
  };

  const rl = readline.createInterface({ input });
  rl.on("line", (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.method === undefined && msg.id != null) {     // the editor's answer to one of ours
      const resolve = waiting.get(msg.id);
      waiting.delete(msg.id);
      resolve?.(msg);
      return;
    }
    const fn = methods[msg.method];
    if (!fn) { if (msg.id != null) fail(msg.id, -32601, `method not found: ${msg.method}`); return; }
    Promise.resolve().then(() => fn(msg.id, msg.params || {})).catch((e) => { if (msg.id != null) fail(msg.id, -32603, e.message || String(e)); });
  });
  rl.on("close", () => {
    for (const s of sessions.values()) s.abort?.abort();
    queue.finally(onExit);
  });
  return { sessions, rl };
}
