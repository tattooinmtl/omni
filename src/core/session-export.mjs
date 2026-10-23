// /export: write a conversation out as Markdown, a single self-contained HTML
// page (no fonts, scripts or images from anywhere else), or JSON.
//
// Built from the session log rather than the live messages: the log is what
// was really said (compaction only shortens what the model sees), and secrets
// were already redacted from it on the way to disk.

import fs from "node:fs";
import path from "node:path";
import { atomicWriteFileSync } from "./atomic-write.mjs";

const MAX_TOOL_RESULT = 4000;

// The records a conversation is made of, one per message.
export function isConversationRecord(r) {
  return r && (r.type === "user" || (r.type === "assistant" && r.message) || (r.type === "tool" && r.tool_call_id) || (r.type === "skill" && r.skill));
}

// The conversation records still in effect: a {type:"rewind", keep:n} record
// (written by /rewind, /resume and /fork) cuts the conversation back to its
// first n messages.
export function effectiveRecords(records) {
  const out = [];
  for (const r of records || []) {
    if (r?.type === "rewind" && Number.isInteger(r.keep)) out.length = Math.max(0, Math.min(out.length, r.keep));
    else if (isConversationRecord(r)) out.push(r);
  }
  return out;
}

// Turn log records into a list of entries in conversation order.
export function conversationFromRecords(records) {
  const out = [];
  for (const r of effectiveRecords(records)) {
    if (r.type === "user") out.push({ role: "user", text: textOf(r.content) });
    else if (r.type === "skill" && r.skill) out.push({ role: "user", text: `/${r.skill}${r.arg ? " " + r.arg : ""}` });
    else if (r.type === "assistant" && r.message) {
      const calls = (r.message.tool_calls || []).map((c) => ({ id: c.id, name: c.function?.name || "?", args: c.function?.arguments || "{}" }));
      out.push({ role: "assistant", text: textOf(r.message.content), calls });
    } else if (r.type === "tool") {
      out.push({ role: "tool", name: r.name || "tool", id: r.tool_call_id, text: typeof r.result === "string" ? r.result : JSON.stringify(r.result) });
    }
  }
  return out;
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === "string" ? p : p?.type === "text" ? p.text : p?.type === "image_url" ? "[image]" : "")).join(" ");
  return "";
}

function clip(s, n) {
  const t = String(s || "");
  return t.length > n ? t.slice(0, n) + `\n…[${t.length - n} more chars]` : t;
}

function prettyArgs(raw) {
  try { return JSON.stringify(JSON.parse(raw), null, 2); } catch { return String(raw); }
}

export function toMarkdown(entries, { title = "Omni session", code = "", started = "" } = {}) {
  const lines = [`# ${title}`, ""];
  if (code || started) lines.push(`${[started && `Started ${started}`, code && `Resume with \`omni --resume ${code}\``].filter(Boolean).join(" · ")}`, "");
  const fence = (s) => "```" + (s.includes("```") ? "~" : "");
  for (const e of entries) {
    if (e.role === "user") lines.push("## You", "", e.text, "");
    else if (e.role === "assistant") {
      lines.push("## Omni", "");
      if (e.text.trim()) lines.push(e.text.trim(), "");
      for (const c of e.calls || []) {
        const args = prettyArgs(c.args);
        lines.push(`**Tool call:** \`${c.name}\``, "", fence(args) + "json", args, fence(args), "");
      }
    } else if (e.role === "tool") {
      const body = clip(e.text, MAX_TOOL_RESULT);
      lines.push(`<details><summary>Result of ${e.name}</summary>`, "", fence(body), body, fence(body), "", "</details>", "");
    }
  }
  return lines.join("\n");
}

function esc(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function toHtml(entries, { title = "Omni session", code = "", started = "" } = {}) {
  const blocks = [];
  for (const e of entries) {
    if (e.role === "user") blocks.push(`<section class="msg you"><h2>You</h2><div class="text">${esc(e.text)}</div></section>`);
    else if (e.role === "assistant") {
      const calls = (e.calls || []).map((c) => `<div class="call"><span class="tag">tool call</span> <code>${esc(c.name)}</code><pre>${esc(prettyArgs(c.args))}</pre></div>`).join("");
      blocks.push(`<section class="msg omni"><h2>Omni</h2>${e.text.trim() ? `<div class="text">${esc(e.text.trim())}</div>` : ""}${calls}</section>`);
    } else if (e.role === "tool") {
      blocks.push(`<details class="result"><summary>Result of <code>${esc(e.name)}</code></summary><pre>${esc(clip(e.text, MAX_TOOL_RESULT))}</pre></details>`);
    }
  }
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
:root{--bg:#f6f5f9;--card:#fff;--ink:#1c1823;--muted:#5d5769;--line:#dcd8e4;--accent:#b86f00;--plum:#7d2aa8}
@media (prefers-color-scheme:dark){:root{--bg:#14111a;--card:#1d1925;--ink:#ece8f3;--muted:#a49db2;--line:#332d3f;--accent:#ffb000;--plum:#c47aee}}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 "Segoe UI",system-ui,sans-serif;padding:32px max(16px,4vw)}
main{max-width:860px;margin:0 auto;display:grid;gap:14px}
header h1{margin:0;font-size:24px}header p{margin:4px 0 0;color:var(--muted)}
.msg{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px 16px}
.msg h2{margin:0 0 6px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.you h2{color:var(--plum)}.omni h2{color:var(--accent)}
.text{white-space:pre-wrap;overflow-wrap:anywhere}
pre{background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:8px;overflow-x:auto;font:12.5px/1.45 Consolas,"Cascadia Mono",monospace;white-space:pre}
.call{margin-top:8px}.tag{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
details.result{margin:-6px 0 0 16px;color:var(--muted)}summary{cursor:pointer}
code{font-family:Consolas,"Cascadia Mono",monospace}
</style></head><body><main>
<header><h1>${esc(title)}</h1><p>${[started && `Started ${esc(started)}`, code && `Resume with <code>omni --resume ${esc(code)}</code>`].filter(Boolean).join(" · ")}</p></header>
${blocks.join("\n")}
</main></body></html>
`;
}

// Write the export and return its absolute path.
export function exportSession(records, { format = "md", file, title, code, started, cwd = process.cwd() } = {}) {
  const fmt = String(format || "md").toLowerCase().replace(/^\./, "");
  if (!["md", "html", "json"].includes(fmt)) throw new Error(`unknown format "${format}" (md, html or json)`);
  const entries = conversationFromRecords(records);
  if (!entries.length) throw new Error("nothing to export yet: this conversation is empty");
  const meta = { title: title || "Omni session", code: code || "", started: started || "" };
  const body = fmt === "json"
    ? JSON.stringify({ ...meta, exportedAt: new Date().toISOString(), entries }, null, 2) + "\n"
    : fmt === "html" ? toHtml(entries, meta) : toMarkdown(entries, meta);
  const target = path.resolve(cwd, file || `${code || "omni-session"}.${fmt}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  atomicWriteFileSync(target, body);
  return target;
}
