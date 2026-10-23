// Context compaction.
//
// The mechanical digest (kept as the fallback) collapses old turns into the
// first request plus a list of tool calls. It is free and never fails, but it
// throws away every decision, finding and dead end the agent reached, so a
// long session forgets why it did things.
//
// The forge digest asks a model to write a structured summary of the span
// being dropped instead, under fixed headings, and keeps the tool list under
// it. The summary can run on a cheaper second model (settings.compaction.model,
// e.g. a flash model on another provider) so it doesn't spend the main
// model's rate limit. A local model writes it only when configured to:
// summarizing 30K tokens on a laptop GPU would stall the turn for minutes.
//
// settings.compaction = { model?: "<provider/model>", mode?: "forge"|"mechanical" }

import { chatStream } from "./provider.mjs";
import { resolveModel } from "./config.mjs";
import { stripThink } from "./toolcalls.mjs";
import { isLocalModel } from "./okfnav.mjs";
import { runHooks } from "./hooks.mjs";
import { extractAtomsFromMessages } from "./memory-provider.mjs";

export const COMPACTED_MARKER = "[CONTEXT COMPACTED]";
const MAX_TRANSCRIPT_CHARS = 48000;
const SUMMARY_TIMEOUT_MS = 120000;

// Which messages a compaction would drop: everything between the system
// prompt and the last `keepTail`, never starting the tail on an orphaned tool
// result. null when the conversation is too short to bother.
export function planCompaction(messages, keepTail = 8) {
  if (!Array.isArray(messages) || messages.length < keepTail + 4) return null;
  const first = messages[0]?.role === "system" ? 1 : 0;
  let cut = messages.length - keepTail;
  // The API rejects a tool message whose assistant tool_calls were dropped.
  while (cut < messages.length && messages[cut].role === "tool") cut++;
  if (cut - first < 3) return null;
  return { first, cut, dropped: messages.slice(first, cut) };
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === "string" ? p : p?.type === "text" ? p.text : "")).join(" ");
  return "";
}

function callHint(call) {
  const fn = call.function || {};
  let hint = "";
  try {
    const args = JSON.parse(fn.arguments || "{}");
    hint = args.path || args.pattern || args.command || args.query || (Array.isArray(args.paths) ? args.paths.join(", ") : "");
  } catch { /* args stay opaque */ }
  return `${fn.name || "?"}${hint ? ` (${String(hint).slice(0, 80)})` : ""}`;
}

// One line per tool call in the dropped span, paired with the first line of
// what it returned.
export function toolTrail(dropped) {
  const resultById = new Map();
  for (const m of dropped) {
    if (m.role === "tool" && m.tool_call_id) resultById.set(m.tool_call_id, (textOf(m.content).split(/\r?\n/)[0] || "").slice(0, 80));
  }
  const trail = [];
  for (const m of dropped) {
    for (const call of m.tool_calls || []) {
      const summary = resultById.get(call.id);
      trail.push(callHint(call) + (summary ? ` -> ${summary}` : ""));
    }
  }
  return trail;
}

function firstRequest(dropped) {
  return dropped.find((m) => m.role === "user" && typeof m.content === "string" && !m.content.startsWith(COMPACTED_MARKER));
}

export function mechanicalDigest(dropped, { sessionGoal = null } = {}) {
  const firstUser = firstRequest(dropped);
  const trail = toolTrail(dropped);
  return [
    `${COMPACTED_MARKER} Earlier conversation was condensed to fit the model's context window. Continue the task from the recent messages below.`,
    sessionGoal ? `Session goal: ${String(sessionGoal).slice(0, 400)}` : "",
    firstUser ? `Original request: ${firstUser.content.slice(0, 600)}` : "",
    trail.length ? `Tools already used (${trail.length}):\n  - ${trail.slice(-40).join("\n  - ")}` : "",
  ].filter(Boolean).join("\n");
}

// The dropped span as plain text for the summarizer. Tool results are cut to
// their head; if the whole thing is still too long, the middle goes, since
// the opening request and the latest work matter most.
export function renderTranscript(dropped) {
  const parts = [];
  for (const m of dropped) {
    if (m.role === "user") parts.push(`USER: ${textOf(m.content).slice(0, 4000)}`);
    else if (m.role === "assistant") {
      const calls = (m.tool_calls || []).map(callHint);
      const text = stripThink(textOf(m.content)).trim();
      parts.push(`ASSISTANT: ${text.slice(0, 3000)}${calls.length ? `\n  [called ${calls.join("; ")}]` : ""}`);
    } else if (m.role === "tool") parts.push(`TOOL ${m.name || ""} RESULT: ${textOf(m.content).slice(0, 700)}`);
    else if (m.role === "system") parts.push(`SYSTEM NOTE: ${textOf(m.content).slice(0, 800)}`);
  }
  let text = parts.join("\n\n");
  if (text.length > MAX_TRANSCRIPT_CHARS) {
    const head = Math.floor(MAX_TRANSCRIPT_CHARS * 0.2);
    text = text.slice(0, head) + "\n\n[… middle of the history omitted …]\n\n" + text.slice(text.length - (MAX_TRANSCRIPT_CHARS - head));
  }
  return text;
}

export const SUMMARY_HEADINGS = ["Goal", "Decisions and constraints", "Files touched", "Done so far", "Still open", "Errors and gotchas"];

const SUMMARIZER_PROMPT = [
  "You compress the working history of an AI coding agent so it can carry on with the task after the history is deleted. Only your summary will remain.",
  `Write Markdown under exactly these headings, in this order: ${SUMMARY_HEADINGS.map((h) => `## ${h}`).join(", ")}.`,
  "Be concrete: file paths, function names, exact commands and their outcome, error messages, numbers, and anything the user asked for or ruled out. Keep the user's own words for requirements.",
  "Leave out pleasantries, reasoning that led nowhere unless it is a trap to avoid, and anything a later step superseded. Write 'none' under a heading with nothing to say.",
  "Stay under 450 words. Output only the summary.",
].join("\n");

// Ask `model` for the summary. `complete` is injectable for tests.
async function summarize({ model, transcript, sessionGoal, focus, signal, complete }) {
  const messages = [
    { role: "system", content: SUMMARIZER_PROMPT },
    {
      role: "user",
      content: [
        sessionGoal ? `Session goal: ${String(sessionGoal).slice(0, 600)}` : "",
        focus ? `Keep extra detail about: ${focus}` : "",
        "History to summarize:",
        transcript,
      ].filter(Boolean).join("\n\n"),
    },
  ];
  if (complete) return String(await complete({ model, messages, signal }) || "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SUMMARY_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener?.("abort", onAbort, { once: true });
  try {
    const resp = await chatStream({ model: { ...model, maxTokens: Math.min(model.maxTokens || 2048, 2048), reasoning: "" }, messages, tools: null, signal: controller.signal, onToken: () => {} });
    return stripThink(String(resp?.message?.content || ""));
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.("abort", onAbort);
  }
}

// Which model writes the summary, or null for the mechanical digest.
export function pickSummarizer(model, settings) {
  const cfg = settings?.compaction || {};
  if (cfg.mode === "mechanical") return null;
  if (cfg.model) {
    try { return resolveModel(settings, cfg.model); } catch { return null; }
  }
  return isLocalModel(model) ? null : model;
}

// Compact `messages` in place. Returns { done, mode, summarizer, dropped,
// reason, error } — done:false when there was nothing to compact or a
// PreCompact hook cancelled it.
export async function forgeCompact(messages, {
  model, settings = null, keepTail = 8, sessionGoal = null, focus = "", trigger = "manual",
  signal = null, complete = null, source = "session",
} = {}) {
  const plan = planCompaction(messages, keepTail);
  if (!plan) return { done: false, reason: "too short" };

  const hook = await runHooks("PreCompact", { trigger, focus, messageCount: messages.length, dropping: plan.cut - plan.first });
  if (hook.denied) return { done: false, reason: `cancelled by hook ${hook.by}: ${hook.reason}`, hookErrors: hook.errors };
  const fullFocus = [focus, hook.context].filter(Boolean).join("\n");

  // Durable facts in the dropped turns go to memory before they're gone.
  try { extractAtomsFromMessages(plan.dropped, { source }); } catch { /* best-effort */ }

  const summarizer = model ? pickSummarizer(model, settings) : null;
  let summary = "";
  let error = null;
  if (summarizer && !signal?.aborted) {
    try {
      summary = (await summarize({ model: summarizer, transcript: renderTranscript(plan.dropped), sessionGoal, focus: fullFocus, signal, complete })).trim();
    } catch (e) {
      error = e?.message || String(e);
    }
  }

  let digest;
  let mode;
  if (summary && summary.length >= 40) {
    const trail = toolTrail(plan.dropped);
    digest = [
      `${COMPACTED_MARKER} Earlier conversation was summarized by ${summarizer.key} to fit the context window (forge digest). Treat this as your own memory of the work and continue from the recent messages below.`,
      "",
      summary,
      trail.length ? `\nTool calls in the summarized part (last ${Math.min(trail.length, 20)} of ${trail.length}):\n  - ${trail.slice(-20).join("\n  - ")}` : "",
    ].join("\n");
    mode = "forge";
  } else {
    digest = mechanicalDigest(plan.dropped, { sessionGoal });
    mode = "mechanical";
    if (summarizer && !error) error = "the summary came back empty";
  }

  messages.splice(plan.first, plan.cut - plan.first, { role: "user", content: digest });
  return { done: true, mode, summarizer: mode === "forge" ? summarizer.key : null, dropped: plan.cut - plan.first, error, hookErrors: hook.errors };
}
