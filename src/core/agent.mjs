// The agent loop: send conversation to the model, execute any tool calls,
// feed results back, repeat until the model answers with plain text.

import { chatStream, completionStream } from "./provider.mjs";
import { rotateAccount, activateAccount, resolveModel } from "./config.mjs";
import { renderTemplate } from "../integrations/router.mjs";
import { tools, runTool, commandRisk } from "../tools/index.mjs";
import {
  parseTextToolCalls, buildParamRegistry, hasToolIntent,
  stripThink, stripToolCallText, textToolInstructions, recoveryMessage,
  createThinkSplitter, extractThink,
} from "./toolcalls.mjs";
import { syncOkfNavGuidance } from "./okfnav.mjs";
import { publishActivity } from "../local/activity-bus.mjs";
import { CHAT_MEMORY_ID, CODEGRAPH_ID, OKF_ROOT_ID } from "../local/graph-ids.mjs";
import { extractAtomsFromMessages, captureToolActivity } from "./memory-provider.mjs";

// Which /neuralview architecture node a tool call represents, per
// NewPlanConversion.md's "retrieval request -> Memory coordinator -> {Chat
// Memory, Skills, Wiki, CodeGraph}" diagram. Used to route the live pulse
// to the right subsystem instead of just a generic "something happened".
function routeForTool(name) {
  if (name.startsWith("memory_")) return CHAT_MEMORY_ID;
  if (name.startsWith("okf_")) return OKF_ROOT_ID;
  if (name === "find_symbol" || name === "rag_search" || name === "deps") return CODEGRAPH_ID;
  return null;
}
import {
  c, assistantPrefix, toolLine, toolResultLine, errorLine, warnLine,
  startStatus, stopStatus, startGenerationStatus, diffPreviewLine,
  streamWrite, streamNewline, mascotLine
} from "../ui.mjs";

// Most recent turn's full <think>…</think> reasoning text, regardless of
// whether it was shown live or collapsed. Read by the /thinking last command.
let lastThinking = "";
export function getLastThinking() {
  return lastThinking;
}

// Routes live provider tokens into "think" vs "answer" streams and renders
// each appropriately. Reasoning is collapsed by default (spinner + one-line
// summary once it ends); showThinking=true streams it inline, dimmed.
// Created fresh per streaming attempt so state never leaks across retries.
function createTurnStreamRouter(showThinking) {
  const splitter = createThinkSplitter();
  let thinkStarted = false;
  let answerStarted = false;
  let thinkReported = false;
  let fullThink = "";

  // Closes out the reasoning section: dimmed live mode just needs a blank
  // line; collapsed mode needs the one-line summary printed exactly once —
  // whether that's triggered by the answer starting or, for a pure-reasoning
  // turn with no answer at all, by finish().
  function reportThinkEnd() {
    if (thinkReported) return;
    thinkReported = true;
    if (showThinking) {
      process.stdout.write("\n\n");
    } else {
      const words = fullThink.trim().split(/\s+/).filter(Boolean).length;
      console.log(`  ${c.dim(`▸ Thinking (~${words} words) — /thinking last to view`)}`);
    }
  }

  function routeThink(text) {
    if (!text) return;
    fullThink += text;
    if (!thinkStarted) {
      thinkStarted = true;
      stopStatus();
      if (showThinking) console.log(`  ${c.dim("▾ Thinking")}`);
      else startStatus("reasoning");
    }
    if (showThinking) process.stdout.write(c.dim(text));
  }

  function routeAnswer(text) {
    if (!text) return;
    if (!answerStarted) {
      answerStarted = true;
      stopStatus();
      if (thinkStarted) reportThinkEnd();
      assistantPrefix();
    }
    streamWrite(text);
  }

  return {
    onToken(token) {
      const { think, answer } = splitter.feed(token);
      routeThink(think);
      routeAnswer(answer);
    },
    // Call once after the stream settles (success or error) to release any
    // buffered tail and report what actually happened this attempt.
    finish() {
      const { think, answer } = splitter.flush();
      routeThink(think);
      routeAnswer(answer);
      if (thinkStarted && !thinkReported) { stopStatus(); reportThinkEnd(); }
      lastThinking = fullThink;
      return { thinkStarted, answerStarted };
    },
  };
}

// Re-serialize past assistant tool calls in the EXACT format the protocol
// instructions demand, so the model's own history reinforces the right shape
// instead of teaching it a divergent one.
function serializeToolCall(call) {
  const fn = call.function || {};
  let argsObj = {};
  try { argsObj = JSON.parse(fn.arguments || "{}"); } catch { /* leave empty */ }
  const params = Object.entries(argsObj)
    .map(([k, v]) => `<parameter=${k}>${typeof v === "string" ? v : JSON.stringify(v)}</parameter>`)
    .join("\n");
  return `<tool_call>\n<function=${fn.name || ""}>\n${params}\n</function>\n</tool_call>`;
}

function messagesWithTextTools(messages) {
  const normalized = messages.map((m) => {
    if (m.role === "tool") {
      const name = m.name ? ` (${m.name})` : "";
      return { role: "user", content: `Tool result${name}:\n${m.content || ""}` };
    }
    if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const calls = m.tool_calls.map(serializeToolCall).join("\n");
      return { role: "assistant", content: [m.content, calls].filter(Boolean).join("\n") };
    }
    return m;
  });

  const instructions = textToolInstructions(tools);
  if (!normalized.length || normalized[0].role !== "system") {
    return [{ role: "system", content: instructions }, ...normalized];
  }
  return [
    { ...normalized[0], content: normalized[0].content + "\n" + instructions },
    ...normalized.slice(1),
  ];
}

// Transient provider errors that are worth retrying automatically.
const RETRYABLE = /429|50[234]|ResourceExhausted|workers are busy|Service Unavailable/i;
// The subset that means "this key is throttled" — worth failing over to
// another account of the same provider before waiting it out.
const RATE_LIMITED = /429|ResourceExhausted|too many requests|rate.?limit/i;
const MAX_RETRIES  = 5;
const BASE_DELAY   = 3000;  // 3s → 6s → 12s → 24s → 48s
const MAX_ROTATIONS = 4;    // account hops per request before plain backoff
const AGNES_FAILOVER_MODEL = "agnes/agnes-2.0-flash";
const OPENROUTER_FAILOVER_MODEL = "openrouter/llama-3-8b";

function applyResolvedModel(target, resolved) {
  target.key = resolved.key;
  target.id = resolved.id;
  target.maxTokens = resolved.maxTokens;
  target.contextWindow = resolved.contextWindow;
  target.contextWindowSource = resolved.contextWindowSource;
  target.provider = resolved.provider;
  target.providerName = resolved.providerName;
  target.providerLabel = resolved.providerLabel;
  target.chatTemplate = resolved.chatTemplate;
  target.reasoning = resolved.reasoning;
  target.nativeTools = resolved.nativeTools;
}

function hasUsableKey(provider, accountName = null) {
  if (!provider) return false;
  if (accountName) {
    return Boolean(String(provider.accounts?.[accountName] || "").trim());
  }
  return Boolean(String(provider.apiKey || "").trim());
}

function buildRateLimitChain(settings) {
  if (!settings) return [];
  const desired = [
    { providerName: "nvidia", account: "nvidia1", modelKey: "nvidia/glm-5.2" },
    { providerName: "agnes", account: "agnes1", modelKey: AGNES_FAILOVER_MODEL },
    { providerName: "nvidia", account: "nvidia2", modelKey: "nvidia/glm-5.2" },
    { providerName: "agnes", account: "agnes2", modelKey: AGNES_FAILOVER_MODEL },
    { providerName: "openrouter", account: null, modelKey: OPENROUTER_FAILOVER_MODEL },
  ];

  return desired.filter((hop) => {
    const provider = settings.providers?.[hop.providerName];
    if (!provider) return false;
    if (!settings.models?.[hop.modelKey]) return false;
    if (!hasUsableKey(provider, hop.account)) return false;
    return true;
  });
}

function hopMatchesModel(hop, model) {
  if (!hop || !model) return false;
  if (hop.providerName !== model.providerName) return false;
  if (hop.modelKey !== model.key) return false;
  if (!hop.account) return true;
  return (model.provider?.activeAccount || "") === hop.account;
}

function switchModelToHop(model, settings, hop) {
  const provider = settings.providers?.[hop.providerName];
  if (!provider) throw new Error(`provider "${hop.providerName}" is not configured`);
  if (hop.account && !activateAccount(provider, hop.account)) {
    throw new Error(`account "${hop.account}" is not configured on provider "${hop.providerName}"`);
  }
  const resolved = resolveModel(settings, hop.modelKey);
  applyResolvedModel(model, resolved);
}

function isRetryable(err) {
  return RETRYABLE.test(err.message || String(err));
}

function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); reject(new DOMException("aborted", "AbortError")); }, { once: true });
  });
}

// chatStream wrapper with exponential backoff. Retries up to MAX_RETRIES
// times on transient 429/503/ResourceExhausted errors, showing a countdown
// so the user knows why the agent paused. When the provider has multiple
// accounts (settings.providers.<name>.accounts), a rate-limit error first
// rotates to the next account and retries almost immediately — backoff only
// kicks in once every account has been tried.
async function chatStreamWithRetry({ model, settings, session, messages, tools, signal, onToken, _templatePrompt }) {
  let attempt = 0;
  let rotations = 0;
  const failoverChain = buildRateLimitChain(settings);
  let failoverIndex = failoverChain.findIndex((hop) => hopMatchesModel(hop, model));
  const failoverActive = failoverIndex >= 0;
  let checkpointOpened = false;

  while (true) {
    try {
      if (_templatePrompt != null) {
        const out = await completionStream({ model, prompt: _templatePrompt, signal, onToken });
        if (checkpointOpened && session) {
          await session.append({
            type: "interrupt_checkpoint",
            status: "resolved",
            reason: "429",
            provider: model.providerName,
            account: model.provider?.activeAccount || null,
            modelKey: model.key,
          });
        }
        return out;
      }
      const out = await chatStream({ model, messages, tools, signal, onToken });
      if (checkpointOpened && session) {
        await session.append({
          type: "interrupt_checkpoint",
          status: "resolved",
          reason: "429",
          provider: model.providerName,
          account: model.provider?.activeAccount || null,
          modelKey: model.key,
        });
      }
      return out;
    } catch (e) {
      // Aborted by user (Ctrl-C / Esc) — propagate immediately, no retry.
      if (e.name === "AbortError" || signal?.aborted) throw e;
      if (!isRetryable(e) || attempt >= MAX_RETRIES) throw e;
      const msg = e.message || String(e);

      if (RATE_LIMITED.test(msg) && failoverActive) {
        const nextHop = failoverChain[failoverIndex + 1] || null;
        if (nextHop) {
          failoverIndex++;
          checkpointOpened = true;
          warnLine(`rate-limited (${msg.split("\n")[0].slice(0, 60)})`);
          warnLine(`switching to ${nextHop.providerName}${nextHop.account ? `:${nextHop.account}` : ""} (${nextHop.modelKey}) and retrying…`);
          mascotLine("provider", false);
          if (session) {
            await session.append({
              type: "interrupt_checkpoint",
              status: "active",
              reason: "429",
              hop: failoverIndex + 1,
              totalHops: failoverChain.length,
              provider: nextHop.providerName,
              account: nextHop.account || null,
              modelKey: nextHop.modelKey,
              message: msg.split("\n")[0].slice(0, 200),
            });
          }
          switchModelToHop(model, settings, nextHop);
          await abortableSleep(1200, signal);
          continue;
        }

        const chainText = failoverChain
          .map((hop) => `${hop.providerName}${hop.account ? `:${hop.account}` : ""}`)
          .join(" -> ");
        if (session) {
          await session.append({
            type: "interrupt_checkpoint",
            status: "exhausted",
            reason: "429",
            provider: model.providerName,
            account: model.provider?.activeAccount || null,
            modelKey: model.key,
            chain: chainText,
            message: msg.split("\n")[0].slice(0, 200),
          });
        }
        throw new Error(
          `Provider 429 Too Many Requests: failover chain exhausted (${chainText}). Switch provider/account manually with /provider or /switch-provider, then retry.`
        );
      }

      if (RATE_LIMITED.test(msg) && rotations < MAX_ROTATIONS) {
        // model.provider is the live settings object, so the rotated key is
        // picked up by authHeaders on the very next request. Session-only —
        // the on-disk activeAccount changes via /switch-provider, not here.
        const next = rotateAccount(model.provider);
        if (next) {
          rotations++;
          warnLine(`rate-limited (${msg.split("\n")[0].slice(0, 60)})`);
          warnLine(`switching to account ${next} and retrying…`);
          mascotLine("provider", false);
          await abortableSleep(1200, signal);
          continue;
        }
      }
      attempt++;
      const delay = BASE_DELAY * Math.pow(2, attempt - 1);
      const secs  = Math.round(delay / 1000);
      warnLine(`provider unavailable (${msg.split("\n")[0].slice(0, 80)})`);
      warnLine(`retrying in ${secs}s… (attempt ${attempt}/${MAX_RETRIES})`);
      mascotLine("provider", false);
      await abortableSleep(delay, signal);
    }
  }
}

// Map a batch of tool calls to the animated status shown while they run.
// Priority: writing > searching > reading > generic running.
function statusForTools(calls) {
  const names = calls.map((c) => c.function?.name);
  if (names.some((n) => n === "edit_file" || n === "write_file" || n === "apply_patch")) return "coding";
  if (names.some((n) => n === "project_inspect" || n === "git_status" || n === "git_diff")) return "reading";
  if (names.some((n) => n === "search" || n === "find_files")) return "searching";
  if (names.some((n) => n === "read_file" || n === "read_many_files" || n === "list_dir")) return "reading";
  return "running";
}

export function systemPrompt() {
  return [
    "You are Omni Agent, a terminal-based coding agent.",
    "You help with software engineering tasks in the user's current working directory.",
    `Working directory: ${process.cwd()}`,
    `Platform: ${process.platform}`,
    "",
    "Use the provided tools to inspect projects, read files, patch code, manage project todos, inspect git, manage dev processes, run shell commands, and run tests.",
    "Prefer making concrete changes with tools over describing them.",
    "When you run shell commands, the shell is PowerShell on Windows.",
    "",
    "# Task workflow",
    "Work through every task in these steps, in order. Treat the user's entire message as one single request, however long or multi-line it is — never act on part of it before you've read all of it.",
    "1. UNDERSTAND — read the whole prompt as one piece, then silently categorize it: what kind of task is this (question / bug fix / new feature / refactor / investigation / config change / something else), what is it actually asking for, what parts of the codebase does it touch.",
    "2. EXPLORE — gather context BEFORE proposing anything: project_inspect for the stack, rag_search to locate relevant code by keyword, find_symbol for definition/reference lookup, lsp for semantic answers (definition/references/hover/diagnostics) when a language server is installed, deps for dependency info, read_file to see exact content. Read-only tools are always fine to use freely at this stage — this step is what makes step 3 accurate instead of a guess.",
    "3. PRESENT THE PLAN, then STOP and wait — this is a real checkpoint, not a formality. For any task beyond a one-line trivial fix or a simple factual question, your reply must be plain text ONLY (no write/change tool calls yet: no edit_file, apply_patch, write_file, run_shell that changes anything, git_commit, etc.) laying out: (a) how you categorized the request — what you understood it to mean, (b) the concrete plan — the steps you intend to take, and (c) if there is more than one reasonable way to do it (different libraries, quick fix vs. proper refactor, anything where the right call depends on a preference you don't know), the options with their tradeoffs. Then wait for the user's next message. If they correct your understanding (by re-explaining, rephrasing, or adjusting the request), re-read it and present a revised plan the same way — do not proceed on a plan you know was corrected. Only skip this checkpoint for something so small a plan would be pure noise (fix this typo, what does this function do, run this exact command).",
    "3b. IF BLOCKED ON MISSING INFORMATION — at any point, if something you need to proceed correctly is missing or unclear (a file that should exist doesn't, a requirement could mean two different things, you need a credential/URL/decision only the user has), STOP and ask the user directly instead of guessing on anything consequential. Only proceed on your own judgment for genuinely low-stakes, easily-reversible details.",
    "4. IMPLEMENT — once the user has approved the plan (or the task was small enough to skip step 3), execute it start to finish without stopping to ask again — you already have what you need. Make changes in small increments, one file at a time. Use apply_patch for multi-hunk/multi-file edits, edit_file for tiny exact replacements, write_file only for new files or full rewrites. Match the conventions of the surrounding code. For multi-step work, track it in project_todo (add each task, mark the active one in_progress) as you go rather than re-asking the user anything already settled by the approved plan.",
    "5. VERIFY — this step is not optional and is not a formality. Prove the change actually works: run the relevant tests, build, or linter (run_test / run_shell); check git_diff to confirm the change is exactly what you intended. If verification fails OR you didn't actually run it, you are NOT done — fix it and re-verify, looping back to step 4/5 as many times as it takes, on your own, without waiting for the user to tell you to. Never report a task as finished, or that something \"should work,\" without having actually run something that proves it.",
    "6. REPORT — close finished project_todo tasks, then summarize concisely: what changed (files), how it was verified, and anything left open.",
    "",
    "# Guidelines",
    "- Always read a file before editing it so you know the exact content.",
    "- You have tools for a reason — use them. Don't describe a change in prose when you could make it with edit_file/apply_patch; don't guess at file contents when read_file would tell you; don't guess at project structure when project_inspect/rag_search would tell you. A turn that ends without having used any tool, on a task that needed one, is an incomplete turn.",
    "- Check for and use relevant skills before improvising a workflow from scratch — a skill encodes a known-good procedure for exactly this kind of task.",
    "- Use rag_search to find relevant code across the workspace when you don't know where something lives; fall back to search for exact patterns.",
    "- Use git_status and git_diff before summarizing changes or committing.",
    "- Use git_commit only when the user explicitly asks you to commit.",
    "- Use start_process for long-running dev servers, process_status for logs, and stop_process when done.",
    "- File tools are workspace-scoped. Do not try to work outside the current directory unless the user changes cwd before launching Omni Agent.",
    "- Use run_shell with dry_run=true to inspect risk before uncertain commands.",
    "- run_shell blocks obviously destructive commands unless allow_unsafe=true; set that only when the user explicitly authorized the exact action.",
    "- When searching, prefer specific patterns over broad ones to reduce noise.",
    "- If a tool call fails, read the error carefully and retry with corrected parameters. If a tool is DENIED by permissions, do not retry it — use another approach or ask the user.",
    "- When a problem could be environmental (missing runtime, wrong version, PATH issue), diagnose with system_info, dev_env_report, and where_is before guessing.",
    "- Never end your reply right after requesting a tool — the tool result always comes back to you; keep working until the task is done, then summarize.",
    "- Keep prose concise. After finishing, briefly summarize what you did.",
  ].join("\n");
}

// ── Context-window management ────────────────────────────────────────────
// Keep the conversation inside the model's context window. When the last
// request's token usage crosses the threshold, older messages are collapsed
// into a deterministic digest (original request + tools used) and only a
// recent tail is kept verbatim.

// Rough token estimate when the provider hasn't reported usage yet (~4 chars/token).
export function estimateTokens(messages) {
  let chars = 0;
  for (const m of messages || []) {
    chars += (typeof m.content === "string" ? m.content.length : 0) + 20;
    for (const call of m.tool_calls || []) {
      chars += (call.function?.arguments?.length || 0) + (call.function?.name?.length || 0) + 30;
    }
  }
  return Math.ceil(chars / 4);
}

// Collapse everything between the system prompt and the last `keepTail`
// messages into one digest message. Mutates `messages` in place. Returns
// true when something was actually compacted.
export function compactMessages(messages, { keepTail = 8 } = {}) {
  if (!Array.isArray(messages) || messages.length < keepTail + 4) return false;
  const hasSystem = messages[0]?.role === "system";
  const first = hasSystem ? 1 : 0;

  let cut = messages.length - keepTail;
  // The tail must not open with tool results whose assistant tool_calls
  // message was dropped — the API rejects orphaned tool messages.
  while (cut < messages.length && messages[cut].role === "tool") cut++;
  if (cut - first < 3) return false;

  const dropped = messages.slice(first, cut);
  const firstUser = dropped.find((m) => m.role === "user" && typeof m.content === "string");
  const toolTrail = [];
  for (const m of dropped) {
    for (const call of m.tool_calls || []) {
      const fn = call.function || {};
      let hint = "";
      try {
        const args = JSON.parse(fn.arguments || "{}");
        hint = args.path || args.pattern || args.command || args.query || (Array.isArray(args.paths) ? args.paths.join(", ") : "");
      } catch { /* args stay opaque */ }
      toolTrail.push(`${fn.name || "?"}${hint ? ` (${String(hint).slice(0, 80)})` : ""}`);
    }
  }
  const digest = [
    "[CONTEXT COMPACTED] Earlier conversation was condensed to fit the model's context window. Continue the task from the recent messages below.",
    firstUser ? `Original request: ${firstUser.content.slice(0, 600)}` : "",
    toolTrail.length ? `Tools already used (${toolTrail.length}): ${toolTrail.slice(-40).join("; ")}` : "",
  ].filter(Boolean).join("\n");

  messages.splice(first, cut - first, { role: "user", content: digest });
  return true;
}

// Auto-compact when the live conversation nears the context window. The
// budget leaves room for the response (maxTokens) plus a safety margin.
function maybeAutoCompact({ model, messages, session }) {
  const window = model.contextWindow;
  if (!window) return false;
  const budget = Math.max(window - (model.maxTokens || 0), Math.floor(window * 0.5));
  const used = session.contextTokens || estimateTokens(messages);
  if (used < budget * 0.85) return false;
  const did = compactMessages(messages);
  if (did) {
    session.setContextTokens(estimateTokens(messages));
    warnLine(`context ${used} tokens near the ${window}-token window — auto-compacted older messages`);
  }
  return did;
}

// Tools the user answered "always allow" for this session (permission "ask").
const alwaysAllowed = new Set();

// Resolve a tool call against the user's permission settings.
// States: "allow" (silent), "deny" (blocked with an error message the model
// sees), "ask" (interactive confirmation via the REPL). "*" sets the default
// for unlisted tools; no entry at all means allow.
async function checkPermission(name, summary, permissions, confirmTool) {
  const state = (permissions && (permissions[name] ?? permissions["*"])) || "allow";
  if (state === "deny") {
    return { allowed: false, message: `DENIED: the user's permission settings block the "${name}" tool. Do not retry it; use another approach or ask the user.` };
  }
  if (state !== "ask" || alwaysAllowed.has(name)) return { allowed: true };
  if (!confirmTool) {
    return { allowed: false, message: `DENIED: "${name}" requires interactive confirmation (permission "ask") but this session is non-interactive.` };
  }
  const answer = String((await confirmTool(name, summary)) || "").trim().toLowerCase();
  if (answer === "a" || answer === "always") {
    alwaysAllowed.add(name);
    return { allowed: true };
  }
  if (answer === "y" || answer === "yes") return { allowed: true };
  return { allowed: false, message: `DENIED: the user declined the "${name}" tool call.` };
}

// Extra gate for run_shell/start_process commands matching a high-risk pattern
// (registry edits, persistence, firewall/boot changes, irreversible deletes —
// see commandRisk in tools/index.mjs). Independent of the tool's configured
// permission state: even "allow" doesn't skip this, and the model can't
// self-authorize past it by passing allow_unsafe — only a human answering the
// confirm prompt can. No confirmTool (non-interactive session) means no human
// to ask, so it's denied rather than silently allowed.
async function checkCommandRisk(name, args, confirmTool) {
  if (name !== "run_shell" && name !== "start_process") return null;
  const risk = commandRisk(args?.command);
  if (risk.level !== "blocked") return null;
  if (!confirmTool) {
    return { allowed: false, message: `DENIED: this command ${risk.reason}, which requires interactive confirmation, but this session is non-interactive.` };
  }
  const answer = String((await confirmTool(name, `⚠ HIGH RISK — ${risk.reason}`)) || "").trim().toLowerCase();
  if (answer === "y" || answer === "yes" || answer === "a" || answer === "always") {
    return { allowed: true, approvedUnsafe: true };
  }
  return { allowed: false, message: `DENIED: the user declined this high-risk command (${risk.reason}).` };
}

// Extra gate for create_tool: writing + hot-loading + persisting a new
// extension is the single most powerful tool in the registry — unlike a
// one-off shell command, it runs on every future launch until manually
// removed. Forced independent of the tool's configured permission, same
// shape as checkCommandRisk above, but unconditional: every call qualifies,
// there's no "safe" create_tool call the way there's a safe run_shell call.
async function checkCreateToolRisk(name, confirmTool) {
  if (name !== "create_tool") return null;
  if (!confirmTool) {
    return { allowed: false, message: `DENIED: create_tool installs a persistent extension and requires interactive confirmation, but this session is non-interactive.` };
  }
  const answer = String((await confirmTool(name, "installs a NEW extension that runs on every future launch until removed")) || "").trim().toLowerCase();
  if (answer === "y" || answer === "yes" || answer === "a" || answer === "always") return { allowed: true };
  return { allowed: false, message: `DENIED: the user declined to install this extension.` };
}

export async function runTurn({ model, settings = null, messages, session, maxIterations = 30, diffPreview = true, persona = null, signal = null, permissions = null, confirmTool = null, showThinking = false }) {
  // If a persona is active, swap the system message and iteration budget.
  // Falls back to the defaults above when persona is null (existing behaviour).
  if (persona) {
    maxIterations = persona.maxIterations ?? maxIterations;
    if (messages.length > 0 && messages[0].role === "system") {
      messages[0] = { role: "system", content: persona.systemPrompt() };
    }
  }
  // Local models get strict index-first OKF navigation rules; frontier
  // providers are left alone. Re-synced every turn so /model switches apply.
  syncOkfNavGuidance(messages, model, tools);
  // Template-aware path: render messages through Jinja2 then use /v1/completions.
  // Active when the resolved model's provider has a chatTemplate configured.
  const useTemplate = Boolean(model.chatTemplate);
  const useNativeTools = model.nativeTools !== false;
  const useTextTools = !useNativeTools;

  // Schema registry for the tolerant text-tool parser, and a budget of
  // corrective retries when the model emits a malformed/truncated tool call.
  const paramRegistry = buildParamRegistry(tools);
  const MAX_PARSE_RECOVERIES = 3;
  let parseRecoveries = 0;
  let wrapUpNudged = false;

  for (let i = 0; i < maxIterations; i++) {
    // Keep the conversation inside the model's context window.
    maybeAutoCompact({ model, messages, session });

    // Near the iteration budget, tell the model to land the work instead of
    // getting cut off mid-task.
    if (!wrapUpNudged && maxIterations - i === 3) {
      wrapUpNudged = true;
      messages.push({
        role: "user",
        content: "[system note] Only 3 tool iterations remain this turn. Finish the smallest complete unit of work, verify if possible, then summarize what is done and what remains.",
      });
    }

    let resp;
    let streamedContent = false;
    let routerResult = { thinkStarted: false, answerStarted: false };
    let tokenCount = 0;
    // Fresh per attempt: splits live tokens into think/answer streams and
    // renders each (collapsed reasoning by default; see showThinking above).
    const router = createTurnStreamRouter(showThinking);
    try {
      // While the model is producing its first token, show the framed token
      // meter (the yellow-bounded bottom panel). As soon as text arrives we
      // tear the panel down and stream the answer inline, token by token.
      startGenerationStatus(() => tokenCount, { contextWindow: model.contextWindow });

      if (useTemplate) {
        // Render the full message history through the provider's Jinja2 template,
        // then send as a raw prompt to /v1/completions.
        let prompt;
        try {
          prompt = await renderTemplate(model.chatTemplate, messages, tools);
        } catch (e) {
          stopStatus();
          errorLine(`Template render failed: ${e.message}`);
          return;
        }
        resp = await chatStreamWithRetry({
          model,
          settings,
          session,
          messages: null,   // not used in template path
          tools: null,
          signal,
          _templatePrompt: prompt,
          onToken(token) {
            tokenCount++;
            router.onToken(token);
          },
        });
      } else {
        const providerMessages = useTextTools ? messagesWithTextTools(messages) : messages;
        resp = await chatStreamWithRetry({
          model,
          settings,
          session,
          messages: providerMessages,
          tools: useNativeTools ? tools : null,
          signal,
          // Always count real deltas so the generation panel's token/TPS
          // readout is accurate. In text-tools mode we still skip routing
          // through the live think/answer splitter — that raw text contains
          // unparsed tool-call syntax the user shouldn't see streamed inline.
          onToken(token) {
            tokenCount++;
            if (!useTextTools) router.onToken(token);
          },
        });
      }

      routerResult = router.finish();
      streamedContent = routerResult.answerStarted;
      if (!streamedContent) stopStatus();
      else streamNewline();
    } catch (e) {
      routerResult = router.finish();
      streamedContent = routerResult.answerStarted;
      if (!streamedContent) stopStatus();
      else streamNewline();
      if (e.name === "AbortError" || signal?.aborted) {
        warnLine("interrupted");
        return;
      }
      errorLine(e.message || String(e));
      session.append({ type: "error", message: e.message || String(e) });
      return;
    }

    const msg = resp.message;

    // Strip <think> blocks from content on EVERY path — both what gets shown
    // below and what gets stored in history (and therefore re-sent to the
    // provider). The native-tools path emits think tags in content too.
    let rawContent = "";
    if (msg.content) {
      if (routerResult.thinkStarted || routerResult.answerStarted) {
        // Already routed live — think content, if any, was already
        // shown/collapsed and reported by the router above.
        rawContent = stripThink(msg.content);
      } else {
        // No live token stream reached the terminal this attempt (always true
        // for useTextTools). Extract and report now instead.
        const extracted = extractThink(msg.content);
        rawContent = extracted.rest;
        if (extracted.think) {
          lastThinking = extracted.think;
          if (showThinking) {
            console.log(`  ${c.dim("▾ Thinking")}`);
            console.log(c.dim(extracted.think.trim()));
            console.log("");
          } else {
            const words = extracted.think.trim().split(/\s+/).filter(Boolean).length;
            console.log(`  ${c.dim(`▸ Thinking (~${words} words) — /thinking last to view`)}`);
          }
        }
      }
    }

    // Template/text-tool paths: parse tool-call text (canonical XML, GLM
    // arg_key/arg_value, Qwen JSON, hybrid/unclosed forms) into OpenAI
    // tool_calls, then strip the tool syntax from content.
    if ((useTemplate || useTextTools) && msg.content) {
      const toolCalls = parseTextToolCalls(rawContent, paramRegistry);
      if (toolCalls.length) {
        msg.tool_calls = toolCalls;
        msg.content = stripToolCallText(rawContent).trim();
      } else {
        msg.content = rawContent.trim();
      }
    } else if (msg.content) {
      msg.content = rawContent.trim();
    }

    messages.push(msg);
    session.append({ type: "assistant", message: msg, usage: resp.usage });
    if (resp.usage) session.addCost(resp.usage);

    const calls = msg.tool_calls || [];

    // Content already streamed above; only print here if nothing was streamed
    // (e.g. a tool-only response that carried no content tokens).
    if (msg.content && msg.content.trim() && !streamedContent) {
      assistantPrefix();
      console.log(msg.content.trim());
    }

    if (calls.length === 0) {
      // The model tried to call a tool but the text couldn't be parsed, or the
      // response was cut off mid-call by the token limit. Don't end the turn —
      // tell the model what happened and let it re-emit the call.
      const truncated = resp.finishReason === "length";
      const attempted = (useTemplate || useTextTools) && hasToolIntent(rawContent);
      if ((attempted || (truncated && useTextTools)) && parseRecoveries < MAX_PARSE_RECOVERIES) {
        parseRecoveries++;
        warnLine(
          truncated
            ? `response truncated by token limit — asking the model to re-emit (${parseRecoveries}/${MAX_PARSE_RECOVERIES})`
            : `malformed tool call — asking the model to re-emit (${parseRecoveries}/${MAX_PARSE_RECOVERIES})`
        );
        messages.push({ role: "user", content: recoveryMessage() });
        continue;
      }
      if (truncated) warnLine("response was truncated by the max_tokens limit");
      // Runs on every completed turn, regardless of which memory provider is
      // active (see core/memory-provider.mjs) — atoms are a separate,
      // additive store, so this always keeps the indexer/graph current
      // instead of only firing on an explicit /compact or /exit.
      try { extractAtomsFromMessages(messages, { source: session?.file || "session" }); } catch { /* best-effort */ }
      return; // model is done
    }

    // Print each tool call (and any edit diff) up front, then animate a single
    // action status (reading / searching / coding / running) while the whole
    // batch executes in parallel, then print the results in call order.
    const parsed = calls.map((call) => {
      let args = {};
      try {
        args = JSON.parse(call.function?.arguments || "{}");
      } catch {
        /* leave empty */
      }
      const name = call.function?.name;
      // Preview rendering is cosmetic — a bad/incomplete tool call (missing
      // args, an unexpected shape) must never crash the whole turn over it.
      // Real validation of the args happens inside the tool itself.
      try {
        toolLine(name, argSummary(name, args));
        if (name === "edit_file" && diffPreview) {
          diffPreviewLine(args.path, args.old_string, args.new_string);
        }
      } catch (e) {
        warnLine(`preview render failed for ${name}: ${e.message}`);
      }
      return { call, name, args };
    });

    // Resolve permissions sequentially BEFORE parallel execution so "ask"
    // confirmations don't interleave on the terminal.
    for (const p of parsed) {
      p.permission = await checkPermission(p.name, argSummary(p.name, p.args), permissions, confirmTool);
      if (p.permission.allowed) {
        const riskGate = await checkCommandRisk(p.name, p.args, confirmTool);
        if (riskGate) {
          p.permission = riskGate;
          if (riskGate.approvedUnsafe) p.args.allow_unsafe = true;
        } else {
          const createGate = await checkCreateToolRisk(p.name, confirmTool);
          if (createGate) p.permission = createGate;
        }
      }
      if (!p.permission.allowed) warnLine(`${p.name}: ${p.permission.message.split(":")[0].toLowerCase()} by permissions`);
    }

    const toolCategory = statusForTools(calls);
    startStatus(toolCategory);
    const toolResults = await Promise.all(
      parsed.map(async ({ call, name, args, permission }) => {
        let result;
        const route = routeForTool(name);
        if (!permission.allowed) {
          result = permission.message;
        } else {
          publishActivity({ kind: "tool_call", tool: name, phase: "start", route });
          try {
            result = await runTool(name, args);
          } catch (e) {
            result = "ERROR: " + e.message;
          }
        }
        publishActivity({ kind: "tool_call", tool: name, phase: "done", route, ok: typeof result !== "string" || !result.startsWith("ERROR:") });
        // Zero-effort capture: a failed tool call or a test run is durable
        // signal worth remembering on its own, no cue phrase or okf_add
        // needed — see memory-provider.mjs's captureToolActivity.
        try { captureToolActivity({ tool: name, args, result }); } catch { /* best-effort */ }
        return { call, name, args, result };
      })
    );
    stopStatus();

    // Print results and push tool messages in original call order
    // (API requires matching tool_call_id order).
    for (const { call, name, args, result } of toolResults) {
      toolResultLine(result);
      session.append({ type: "tool", name, args, result, tool_call_id: call.id });
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: typeof result === "string" ? result : JSON.stringify(result),
      });
    }
    // Omi reacts to what it just did — cheer if every call in the batch
    // succeeded, grumble if any of them blew up.
    const anyFailed = toolResults.some(
      ({ result }) => typeof result === "string" &&
        (result.startsWith("ERROR:") || result.startsWith("DENIED:") || result.startsWith("BLOCKED"))
    );
    mascotLine(toolCategory, !anyFailed);
  }
  errorLine(`Stopped after ${maxIterations} tool iterations.`);
}

function argSummary(name, args) {
  switch (name) {
    case "read_file":
    case "read_many_files":
    case "write_file":
    case "edit_file":
    case "list_dir":
      return args.path || (Array.isArray(args.paths) ? `${args.paths.length} file(s)` : "");
    case "apply_patch":
      return "patch";
    case "find_files":
      return (args.pattern || ".") + (args.path ? ` in ${args.path}` : "");
    case "search":
      return c.dim(`/${args.pattern}/`) + (args.path ? ` in ${args.path}` : "") + (args.glob ? ` ${args.glob}` : "");
    case "run_shell":
      return args.command || "";
    case "run_test":
      return args.command || "npm test";
    case "jq_query":
      return c.dim(args.filter || "") + (args.path ? ` ${args.path}` : "");
    case "project_inspect":
      return args.path || ".";
    case "git_status":
      return "status";
    case "git_diff":
      return (args.staged ? "--staged " : "") + (args.stat ? "--stat " : "") + (args.path || "");
    case "git_commit":
      return args.message || "";
    case "project_todo":
      return [args.action, args.id, args.title].filter(Boolean).join(" ");
    case "start_process":
      return args.name || args.command || "";
    case "process_status":
    case "stop_process":
      return args.id || "";
    case "web_search":
      return args.query || "";
    case "web_fetch":
      return args.url || "";
    case "youtube_transcript":
      return args.url || "";
    case "rag_search":
      return args.query || "";
    case "rag_index":
      return "";
    case "find_symbol":
      return (args.references ? "refs " : "") + (args.name || "") + (args.path ? ` in ${args.path}` : "");
    case "deps":
      return [args.action || "detect", args.manager].filter(Boolean).join(" ");
    case "test_coverage":
      return args.command || (args.dry_run ? "dry run" : "auto");
    case "security_scan":
      return args.scope || "all";
    case "lsp":
      return `${args.action || "?"} ${args.path || ""}${args.line ? `:${args.line}` : ""}`;
    case "memory_save":
      return (args.text || "").slice(0, 60);
    case "memory_search":
      return args.query || "";
    case "memory_list":
      return "";
    case "memory_forget":
      return args.id || "";
    case "system_info":
      return "";
    case "dev_env_report":
      return Array.isArray(args.tools) && args.tools.length ? args.tools.join(", ") : "all toolchains";
    case "where_is":
      return args.name || "";
    case "create_markdown_report":
      return args.filename || "";
    case "move_file":
    case "copy_file":
      return args.from && args.to ? `${args.from} → ${args.to}` : "";
    case "delete_path":
    case "make_dir":
      return args.path || "";
    default:
      return "";
  }
}
