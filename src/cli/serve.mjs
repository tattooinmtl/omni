// src/cli/serve.mjs — `omni --serve`: Omni as an OpenAI-compatible API on this PC.
//
//   omni --serve [--port 8765] [--token <secret>]
//
//   GET  /v1/models              "omni" (the session's model) and every configured model key
//   POST /v1/chat/completions    { model, messages, stream } → one agent run, with tools
//   GET  /health                 { status: "ok" } (no token needed)
//
// Each request is a fresh conversation: Omni's own system prompt, then the
// client's messages (its system messages come after Omni's). The agent works
// in the folder Omni was started in, with its tools, under the same rules as
// a headless run: tools set to "ask" are refused (no one is there to OK them),
// and --mode picks the permission mode (default unless given). The answer is
// the agent's last reply; with stream: true its words stream as they come
// (think blocks left out).
//
// It listens on 127.0.0.1 only, every request needs the bearer token
// (--token, OMNI_SERVE_TOKEN, or one made at start and printed once), and a
// request from a web page (an Origin header) is refused, so a site open in a
// browser can't drive the agent. Requests run one at a time.

import http from "node:http";
import crypto from "node:crypto";
import { runTurn } from "../core/agent.mjs";
import { Session, resolveModel, turnMaxIterations } from "../core/config.mjs";
import { registerHook, clearHooks } from "../core/hooks.mjs";
import { stripThink } from "../core/toolcalls.mjs";

const MAX_BODY = 5 * 1024 * 1024;

export function parseServeArgs(args) {
  const opt = { port: 8765, token: process.env.OMNI_SERVE_TOKEN || "" };
  const take = (flag) => { const i = args.indexOf(flag); if (i === -1) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
  const p = take("--port");
  if (p != null) opt.port = Number(p);
  const t = take("--token");
  if (t != null) opt.token = t;
  if (!Number.isInteger(opt.port) || opt.port < 0 || opt.port > 65535) throw new Error("--port takes a number from 0 to 65535");
  if (opt.token && opt.token.length < 16) throw new Error("--token must be at least 16 characters");
  return opt;
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === "string" ? p : p?.type === "text" ? p.text || "" : "")).filter(Boolean).join("\n");
  return "";
}

// The client's messages, as the conversation after Omni's system prompt.
export function clientMessages(list = []) {
  const out = [];
  for (const m of Array.isArray(list) ? list : []) {
    const text = textOf(m?.content);
    if (!text) continue;
    if (m.role === "system" || m.role === "developer") out.push({ role: "system", content: `# Instructions from the API client\n${text}` });
    else if (m.role === "assistant") out.push({ role: "assistant", content: text });
    else if (m.role === "user") out.push({ role: "user", content: text });
  }
  return out;
}

// Streams words, leaving out <think>…</think>.
export function thinkFilter(write) {
  let inThink = false;
  let buf = "";
  const feed = (token) => {
    buf += token;
    for (;;) {
      if (inThink) {
        const end = buf.indexOf("</think>");
        if (end === -1) { buf = buf.slice(-8); return; }
        buf = buf.slice(end + 8);
        inThink = false;
      } else {
        const start = buf.indexOf("<think>");
        if (start === -1) {
          // Keep a possible partial "<think" at the end for the next token.
          const keep = buf.lastIndexOf("<");
          const safe = keep !== -1 && "<think>".startsWith(buf.slice(keep)) ? keep : buf.length;
          if (safe) write(buf.slice(0, safe));
          buf = buf.slice(safe);
          return;
        }
        if (start) write(buf.slice(0, start));
        buf = buf.slice(start + 7);
        inThink = true;
      }
    }
  };
  // The end of the reply: what was held back in case it started <think>.
  feed.flush = () => { if (!inThink && buf) write(buf); buf = ""; };
  return feed;
}

function lastAssistantText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant" && textOf(m.content).trim()) return stripThink(textOf(m.content)).trim();
  }
  return "";
}

const FINISH = { done: "stop", max_iterations: "length", turn_limit: "length", aborted: "stop", error: "stop" };

export async function startServe(ctx, opt = {}, { log = (s) => process.stderr.write(s + "\n"), listen = true } = {}) {
  const token = opt.token || crypto.randomBytes(24).toString("base64url");
  let queue = Promise.resolve();
  let streamWrite = null;
  // One StreamToken hook for the server; it writes to whichever request is running.
  clearHooks("omni-serve");
  registerHook({ event: "StreamToken", name: "omni-serve", source: "omni-serve", fn: ({ token: t }) => { streamWrite?.(t); } });

  const send = (res, status, obj) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  const apiError = (res, status, message, type = "invalid_request_error", code = null) => send(res, status, { error: { message, type, code } });

  const modelList = () => [
    { id: "omni", object: "model", created: 0, owned_by: "omni", description: `the session's model (${ctx.model.key})` },
    ...Object.keys(ctx.settings.models || {}).map((id) => ({ id, object: "model", created: 0, owned_by: ctx.settings.models[id].provider || "omni" })),
  ];

  async function completion(req, res, body) {
    const wanted = String(body.model || "omni");
    let model;
    try { model = wanted === "omni" ? ctx.model : resolveModel(ctx.settings, wanted); }
    catch { return apiError(res, 404, `no model "${wanted}" (GET /v1/models lists them)`, "invalid_request_error", "model_not_found"); }
    const convo = clientMessages(body.messages);
    if (!convo.some((m) => m.role === "user")) return apiError(res, 400, "messages needs at least one user message with text");

    const id = `chatcmpl-omni-${crypto.randomBytes(6).toString("hex")}`;
    const created = Math.floor(Date.now() / 1000);
    const stream = body.stream === true;
    const abort = new AbortController();
    res.on("close", () => { if (!res.writableEnded) abort.abort(); });
    const chunk = (delta, finish = null) => res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: model.key, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    if (stream) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      chunk({ role: "assistant" });
    }

    const session = new Session({ kind: "api" });
    const messages = [{ ...ctx.messages[0] }, ...convo];
    streamWrite = stream ? thinkFilter((t) => chunk({ content: t })) : null;
    let outcome;
    try {
      outcome = await runTurn({
        model: { ...model }, settings: ctx.settings, messages, session,
        maxIterations: turnMaxIterations(model, ctx.settings),
        permissions: ctx.settings.permissions, confirmTool: null,
        signal: abort.signal, contextMode: ctx.contextMode, diffPreview: false,
      });
    } catch (e) {
      outcome = { stop: "error", error: e.message || String(e) };
    } finally {
      streamWrite?.flush?.();
      streamWrite = null;
    }
    const text = lastAssistantText(messages);
    const finish = FINISH[outcome?.stop] || "stop";
    const c = session.cost || {};
    const usage = { prompt_tokens: c.promptTokens || 0, completion_tokens: c.completionTokens || 0, total_tokens: c.totalTokens || 0 };
    if (outcome?.stop === "error" && !text) {
      if (stream) { chunk({ content: `[error: ${outcome.error}]` }, "stop"); res.write("data: [DONE]\n\n"); res.end(); return; }
      return apiError(res, 502, outcome.error || "the agent run failed", "api_error");
    }
    if (stream) {
      chunk({}, finish);
      res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: model.key, choices: [], usage })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    send(res, 200, {
      id, object: "chat.completion", created, model: model.key,
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: finish }],
      usage, omni: { stop: outcome?.stop || "done", session: session.file || null },
    });
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { status: "ok" });
    // A web page in a browser sends Origin; a local program doesn't.
    if (req.headers.origin) return apiError(res, 403, "requests from web pages are refused", "permission_error");
    const auth = String(req.headers.authorization || "");
    const given = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const ok = given.length === token.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(token));
    if (!ok) return apiError(res, 401, "missing or wrong bearer token", "authentication_error");
    if (req.method === "GET" && url.pathname === "/v1/models") return send(res, 200, { object: "list", data: modelList() });
    if (req.method !== "POST" || url.pathname !== "/v1/chat/completions") return apiError(res, 404, `no route ${req.method} ${url.pathname}`);
    let raw = "";
    let tooBig = false;
    req.on("data", (d) => { if (raw.length + d.length > MAX_BODY) { tooBig = true; req.destroy(); } else raw += d; });
    req.on("end", () => {
      if (tooBig) return;
      let body;
      try { body = JSON.parse(raw || "{}"); } catch { return apiError(res, 400, "the body is not JSON"); }
      // One run at a time: they share the folder, and the stream hook.
      queue = queue.then(() => completion(req, res, body)).catch((e) => { if (!res.headersSent) apiError(res, 500, e.message, "api_error"); else res.end(); });
    });
  });

  if (listen) {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(opt.port ?? 8765, "127.0.0.1", resolve);
    });
    const { port } = server.address();
    log(`Omni API on http://127.0.0.1:${port}/v1 (this PC only) — model "omni" is ${ctx.model.key}, in ${process.cwd()}`);
    if (!opt.token) log(`token (send as "Authorization: Bearer <token>"; made for this run): ${token}`);
    log("tools set to \"ask\" are refused; Ctrl+C stops the server");
  }
  return { server, token };
}
