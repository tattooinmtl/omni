// src/cli/mcp-client-ui.mjs — what happens when an MCP server asks Omni
// something (src/integrations/mcp.mjs, setMcpClientHandlers).
//
// sampling/createMessage  The server wants the user's model to answer a
//                         prompt of its own. The user sees the prompt and
//                         OKs it (y, or a = this server for the session).
//                         The answer comes from the session's model with no
//                         tools and none of the conversation.
// elicitation/create      The server wants the user to fill in a small form.
//                         Each field is asked in the prompt box and checked
//                         against its type. A form that asks for a password,
//                         key, token or card number is refused: Omni doesn't
//                         collect those for anyone.

import { c, infoLine, warnLine } from "../ui.mjs";
import { chatStream } from "../core/provider.mjs";
import { stripThink } from "../core/toolcalls.mjs";

const SENSITIVE = /pass(word|wd|phrase)?\b|\bpin\b|secret|token|api[\s_-]?key|private[\s_-]?key|credential|card|cvv|cvc|\biban\b|\bssn\b|social security/i;
const clip = (s, n) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };

function textOf(content) {
  if (Array.isArray(content)) return content.map(textOf).filter(Boolean).join("\n");
  if (content && typeof content === "object") {
    if (content.type === "text") return String(content.text || "");
    return `[${content.type || "content"} omitted]`;
  }
  return String(content ?? "");
}

// The sensitive-looking fields of a requested form, by name.
export function sensitiveFields(schema = {}) {
  return Object.entries(schema.properties || {})
    .filter(([k, p]) => SENSITIVE.test(`${k} ${p?.title || ""} ${p?.description || ""}`) || p?.format === "password")
    .map(([k]) => k);
}

// One typed answer → { value } or { error }.
export function coerceField(raw, prop = {}) {
  const v = String(raw ?? "").trim();
  const choices = Array.isArray(prop.enum) ? prop.enum : null;
  if (choices) {
    const n = /^\d+$/.test(v) ? Number(v) : 0;
    if (n >= 1 && n <= choices.length) return { value: choices[n - 1] };
    const hit = choices.find((x) => String(x).toLowerCase() === v.toLowerCase());
    return hit !== undefined ? { value: hit } : { error: `pick one of: ${choices.join(", ")}` };
  }
  if (prop.type === "boolean") {
    if (/^(y|yes|true|1)$/i.test(v)) return { value: true };
    if (/^(n|no|false|0)$/i.test(v)) return { value: false };
    return { error: "answer y or n" };
  }
  if (prop.type === "number" || prop.type === "integer") {
    const num = Number(v);
    if (!v || !Number.isFinite(num) || (prop.type === "integer" && !Number.isInteger(num))) return { error: prop.type === "integer" ? "a whole number" : "a number" };
    if (prop.minimum != null && num < prop.minimum) return { error: `at least ${prop.minimum}` };
    if (prop.maximum != null && num > prop.maximum) return { error: `at most ${prop.maximum}` };
    return { value: num };
  }
  if (prop.minLength != null && v.length < prop.minLength) return { error: `at least ${prop.minLength} characters` };
  if (prop.maxLength != null && v.length > prop.maxLength) return { error: `at most ${prop.maxLength} characters` };
  if (prop.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return { error: "an email address" };
  return { value: v };
}

export function makeMcpClientHandlers(ctx, { chat = chatStream, log = console.log } = {}) {
  const alwaysSample = new Set();

  async function sample(server, params = {}) {
    const msgs = Array.isArray(params.messages) ? params.messages : [];
    if (!msgs.length) throw new Error("sampling request has no messages");
    const model = ctx.model;
    if (!model) throw new Error("no model is selected in this session");
    if (!alwaysSample.has(server)) {
      log("");
      log(c.bold(`  MCP server ${server} asks your model (${model.key}) to answer:`));
      if (params.systemPrompt) log(c.dim(`    system: ${clip(params.systemPrompt, 300)}`));
      for (const m of msgs.slice(-4)) log(`    ${m.role === "assistant" ? "assistant" : "user"}: ${clip(textOf(m.content), 400)}`);
      log(c.dim("    (it gets only this, not your conversation; the answer goes back to the server)"));
      const answer = String((await ctx.confirmToolUse(`mcp sampling for ${server}`, `up to ${params.maxTokens || model.maxTokens} tokens`)) || "").trim().toLowerCase();
      if (answer === "a" || answer === "always") alwaysSample.add(server);
      else if (answer !== "y" && answer !== "yes") throw new Error("the user declined this sampling request");
    }
    const maxTokens = Math.max(16, Math.min(Number(params.maxTokens) || model.maxTokens || 1024, model.maxTokens || 8192));
    const messages = [
      ...(params.systemPrompt ? [{ role: "system", content: String(params.systemPrompt) }] : []),
      ...msgs.map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: textOf(m.content) })),
    ];
    const out = await chat({ model: { ...model, maxTokens }, messages, tools: null, onToken: () => {} });
    const text = stripThink(String(out?.message?.content || "")).trim();
    infoLine(`answered ${server}'s sampling request (${text.length} characters)`);
    return { role: "assistant", content: { type: "text", text }, model: model.key, stopReason: "endTurn" };
  }

  async function elicit(server, params = {}) {
    const schema = params.requestedSchema || { type: "object", properties: {} };
    const props = schema.properties || {};
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    log("");
    log(c.bold(`  MCP server ${server} asks you:`));
    log(`    ${clip(params.message || "(no message)", 500)}`);
    const sensitive = sensitiveFields(schema);
    if (sensitive.length) {
      warnLine(`declined: the form asks for ${sensitive.join(", ")}. Omni doesn't collect passwords, keys or card numbers through MCP forms; enter those in the service itself.`);
      return { action: "decline" };
    }
    const fields = Object.entries(props);
    if (fields.length) log(c.dim(`    fields: ${fields.map(([k, p]) => `${p.title || k}${required.has(k) ? "" : " (optional)"}`).join(", ")}`));
    const go = String((await ctx.askLine(c.yellow("  answer it? [y/N, c = cancel] "))) || "").trim().toLowerCase();
    if (go === "c" || go === "cancel") return { action: "cancel" };
    if (go !== "y" && go !== "yes") return { action: "decline" };
    const content = {};
    for (const [key, prop] of fields) {
      const label = prop.title || key;
      const hint = Array.isArray(prop.enum)
        ? ` (${prop.enum.map((x, i) => `${i + 1}=${x}`).join(", ")})`
        : prop.type === "boolean" ? " (y/n)" : prop.type === "number" || prop.type === "integer" ? ` (${prop.type})` : "";
      const opt = required.has(key) ? "" : ", Enter to skip";
      let done = false;
      for (let tries = 0; tries < 3 && !done; tries++) {
        const raw = await ctx.askLine(c.yellow(`  ${label}${hint}${prop.default !== undefined ? ` [${prop.default}]` : ""}${opt}: `));
        if (raw == null) return { action: "cancel" };
        if (!String(raw).trim()) {
          if (prop.default !== undefined) { content[key] = prop.default; done = true; break; }
          if (!required.has(key)) { done = true; break; }
          warnLine("this one is required");
          continue;
        }
        const r = coerceField(raw, prop);
        if (r.error) { warnLine(r.error); continue; }
        content[key] = r.value;
        done = true;
      }
      if (!done) return { action: "cancel" };
    }
    return { action: "accept", content };
  }

  return { sample, elicit };
}
