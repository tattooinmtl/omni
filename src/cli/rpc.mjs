// RPC mode: `omni --rpc` drives the agent over stdio with JSON lines, for an
// editor, the OmniBots tray, or a script that wants a whole conversation
// rather than one headless prompt.
//
// You write one JSON object per line on stdin; Omni writes one per line on
// stdout (everything the terminal UI would print goes to stderr).
//
// Requests ({ "id": …, "method": …, "params": { … } }); each gets a reply
// { "id", "result" } or { "id", "error": { "message" } }:
//   prompt   { text }            run a turn; replies when it ends with
//                                { stop, result, session }. Prompts queue.
//   steer    { text }            a note for the running turn (like /btw)
//   abort                        stop the running turn
//   command  { line }            a slash command, e.g. "/compact" or "/mode plan"
//   status                       { model, mode, session, running, contextTokens }
//   confirm  { requestId, answer }   answer a "confirm" event: "y", "n" or "a"
//   answer   { requestId, text }     answer a "question" event
//   exit
//
// Events ({ "type": … }, no id): "ready" first; then, as they happen,
// "user", "assistant" (with toolCalls), "tool_result", "error" (the same
// shapes as `--output stream-json`); "confirm" when a tool needs your OK
// ({ requestId, tool, summary }); "question" when the agent asks you
// ({ requestId, question, options }).

import readline from "node:readline";
import { runTurn, steeringMessage } from "../core/agent.mjs";
import { turnMaxIterations, resolveModel } from "../core/config.mjs";
import { submitPromptHooks } from "../core/hooks.mjs";
import { getPermissionMode, setPermissionMode, modeLabel } from "../core/permission-mode.mjs";
import { Checkpointer } from "../core/checkpoints.mjs";
import { streamSessionEvents } from "./headless.mjs";
import { dispatchCommand, slashKind, findCommand } from "./commands.mjs";
import { applySkill, evictEphemeralSkillMessages } from "./helpers.mjs";
import { expandTemplate } from "../core/templates.mjs";
import { currentVersion } from "../integrations/update-check.mjs";

export async function startRpc(ctx, { emit, input = process.stdin, onExit = () => process.exit(0) } = {}) {
  let nextRequest = 1;
  const pending = new Map(); // requestId -> resolve
  let queue = Promise.resolve();
  let running = false;
  ctx.steerQueue = [];
  ctx.canRaw = false;

  const ask = (event) => new Promise((resolve) => {
    const requestId = nextRequest++;
    pending.set(requestId, resolve);
    emit({ ...event, requestId });
  });
  // The REPL asks in the prompt box; here the client answers by request id.
  ctx.confirmToolUse = (tool, summary) => ask({ type: "confirm", tool, summary: String(summary || "") });
  ctx.askUser = ({ question, options = [] }) => ask({ type: "question", question, options });
  ctx.askLine = (q) => ask({ type: "question", question: String(q).replace(/\x1b\[[0-9;]*m/g, "").trim(), options: [] });
  ctx.checkpointer = ctx.settings.checkpoints === false ? null : new Checkpointer();

  // Session records become events. /fork and /clear swap ctx.session, so
  // the wrap is checked before every turn.
  const watchSession = () => { if (!ctx.session.drainStream) streamSessionEvents(ctx.session, emit); };

  async function runPrompt(text) {
    watchSession();
    const line = String(text || "").trim();
    if (!line) throw new Error("text is required");
    const head = line.split(/\s+/)[0];
    const kind = line.startsWith("/") ? slashKind(ctx, line) : "text";
    if (kind === "skill") {
      await applySkill(ctx.skillByCommand.get(head), line.slice(head.length).trim(), ctx.messages, ctx.session, { contextMode: ctx.contextMode });
    } else {
      const body = kind === "template" ? expandTemplate(ctx.templates.get(head.toLowerCase()), line.slice(head.length)) : line;
      const hooked = await submitPromptHooks(body);
      if (hooked.denied) throw new Error(`prompt blocked by hook ${hooked.by}: ${hooked.reason}`);
      ctx.messages.push({ role: "user", content: hooked.content });
      await ctx.session.append({ type: "user", content: hooked.content });
    }
    running = true;
    ctx.currentAbort = new AbortController();
    let promptAt = ctx.messages.length - 1;
    while (promptAt > 0 && ctx.messages[promptAt].role !== "user") promptAt--;
    const turnStart = { messageIndex: promptAt, recordCount: Math.max(0, ctx.session.conversationLength - 1), label: line, session: ctx.session.file };
    try {
      const outcome = await runTurn({
        model: ctx.model,
        settings: ctx.settings,
        messages: ctx.messages,
        session: ctx.session,
        maxIterations: turnMaxIterations(ctx.model, ctx.settings),
        persona: ctx.activePersona,
        signal: ctx.currentAbort.signal,
        permissions: ctx.settings.permissions,
        confirmTool: ctx.confirmToolUse,
        contextMode: ctx.contextMode,
        takeSteering: () => ctx.steerQueue.splice(0),
        beforeMutation: () => {
          if (ctx.checkpointer && !ctx.checkpointer.disabled) {
            try { ctx.checkpointer.snapshot(turnStart); } catch { /* checkpoints turn themselves off */ }
          }
        },
      });
      evictEphemeralSkillMessages(ctx.messages);
      await ctx.session.drainStream?.();
      let result = "";
      for (let i = ctx.messages.length - 1; i >= 0; i--) {
        const m = ctx.messages[i];
        if (m.role === "assistant" && typeof m.content === "string" && m.content.trim()) { result = m.content.trim(); break; }
      }
      return { stop: outcome?.stop || "done", result, error: outcome?.error || null, session: ctx.session.code };
    } finally {
      running = false;
      ctx.currentAbort = null;
    }
  }

  const methods = {
    prompt: (p) => {
      // One turn at a time: a prompt sent during a turn waits its turn.
      const job = queue.then(() => runPrompt(p?.text));
      queue = job.catch(() => {});
      return job;
    },
    steer: (p) => {
      if (!running) throw new Error("no turn is running; send a prompt instead");
      ctx.steerQueue.push(String(p?.text || ""));
      return { queued: true, note: steeringMessage(p?.text) };
    },
    abort: () => { if (ctx.currentAbort) ctx.currentAbort.abort(); return { aborted: running }; },
    status: () => ({
      model: ctx.model.key, mode: getPermissionMode(), modeLabel: modeLabel(), session: ctx.session.code,
      running, contextTokens: ctx.session.contextTokens || 0, version: currentVersion(),
    }),
    command: async (p) => {
      const line = String(p?.line || "").trim();
      if (!line.startsWith("/")) throw new Error('line must be a slash command, e.g. "/mode plan"');
      const parts = line.split(/\s+/);
      if (!findCommand(parts[0].slice(1))) throw new Error(`unknown command ${parts[0]}`);
      if (parts[0] === "/exit" || parts[0] === "/quit") throw new Error('use the "exit" method');
      const r = await dispatchCommand(ctx, parts[0].slice(1), parts.slice(1).join(" "), parts);
      // A command that starts a turn (/init, /plan <text>, an extension's).
      if (r?.startTurn && r.prompt) return methods.prompt({ text: r.prompt });
      return { ok: true, mode: getPermissionMode(), session: ctx.session.code };
    },
    set_mode: (p) => ({ mode: setPermissionMode(p?.mode) }),
    set_model: (p) => { ctx.model = resolveModel(ctx.settings, p?.model); return { model: ctx.model.key }; },
    confirm: (p) => {
      const resolve = pending.get(p?.requestId);
      if (!resolve) throw new Error(`no confirm request ${p?.requestId}`);
      pending.delete(p.requestId);
      resolve(String(p.answer ?? "n"));
      return { ok: true };
    },
    answer: (p) => {
      const resolve = pending.get(p?.requestId);
      if (!resolve) throw new Error(`no question ${p?.requestId}`);
      pending.delete(p.requestId);
      resolve(String(p.text ?? ""));
      return { ok: true };
    },
    exit: () => { setImmediate(onExit); return { bye: true }; },
  };

  emit({ type: "ready", session: ctx.session.code, model: ctx.model.key, mode: getPermissionMode(), version: currentVersion(), cwd: process.cwd() });

  const rl = readline.createInterface({ input, crlfDelay: Infinity, terminal: false });
  rl.on("line", (raw) => {
    const text = raw.trim();
    if (!text) return;
    let msg;
    try { msg = JSON.parse(text); } catch { emit({ type: "error", message: "not JSON: send one JSON object per line" }); return; }
    const fn = methods[msg?.method];
    if (!fn) { emit({ id: msg?.id ?? null, error: { message: `unknown method "${msg?.method}"` } }); return; }
    Promise.resolve()
      .then(() => fn(msg.params || {}))
      .then((result) => emit({ id: msg.id ?? null, result }))
      .catch((e) => emit({ id: msg.id ?? null, error: { message: e?.message || String(e) } }));
  });
  // The client went away: wait for any queued turn, then leave.
  await new Promise((resolve) => rl.on("close", resolve));
  await queue;
  onExit();
}
