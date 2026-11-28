// Interactive REPL: readline loop, interrupt handling, tab completion for
// slash commands, the agent turn runner, and goal-mode auto-continuation.
//
// Input path (interactive terminal):
//
//   stdin (raw) ──► PasteFilter ──► rlInput ──► readline ──► "line"
//                    │                           (keys, history, editing)
//                    └─ pastes become text/chips, never Enter
//
// readline only ever sees typed keys; pastes are recognised on the raw chunks
// first (see paste.mjs). In box mode readline draws nothing — its output is a
// no-op sink and the pinned footer (footer.mjs) renders rl.line inside the
// input box, which stays on screen while the agent works.

import { syntheticUser, recordFor, promptMessage } from "../core/synthetic.mjs";
import readline from "node:readline";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import {
  c, banner, infoLine, warnLine, shutdown,
  promptTop, promptBottom, statusBar, statusBarText, setPersonaIndicator, setStatusSink,
} from "../ui.mjs";
import { runTurn, steeringMessage, steeringText } from "../core/agent.mjs";
import { Session, turnMaxIterations, resolveSessionCode, describeSession } from "../core/config.mjs";
import { disconnectAll, setMcpConfirm } from "../integrations/mcp.mjs";
import { disconnectBridge } from "../integrations/bridge.mjs";
import { shutdownAll as shutdownLspServers } from "../integrations/lsp.mjs";
import { classifyIntent, killSidecar } from "../integrations/router.mjs";
import * as llama from "../local/llama.mjs";
import { detectContextWindow } from "../core/context.mjs";
import { applySkill, applySkills, resumeSessionInto, reportMissingKey, reportInsecureEndpoint, evictEphemeralSkillMessages } from "./helpers.mjs";
import { activeModelBlockedByHealth } from "./models.mjs";
import { dispatchCommand, slashKind, parseSlashLine, recognizedSlashRanges, skillLoadedLine, slashTokenAt, slashMenuRows, acceptSlashRow } from "./commands.mjs";
import { nextGoalStep } from "./goal.mjs";
import { submitPromptHooks } from "../core/hooks.mjs";
import { expandTemplate } from "../core/templates.mjs";
import { shouldOfferLearning, learnPrompt } from "../core/skill-learn.mjs";
import { unreadCount } from "../core/scheduler.mjs";
import { getPermissionMode, cyclePermissionMode, modeLabel } from "../core/permission-mode.mjs";
import { Checkpointer } from "../core/checkpoints.mjs";
import { updateNotice, refreshUpdateCacheInBackground } from "../integrations/update-check.mjs";
import { PasteFilter, pasteInsertion, expandPastes, PASTE_START, PASTE_END } from "./paste.mjs";
import { createFooter, stripAnsi } from "./footer.mjs";
import { PromptQueue, extractMouse, MOUSE_ON, MOUSE_OFF } from "./queue.mjs";
import { stopAllLoops } from "./loop-cmd.mjs";
import { stopAllBackground } from "./bg-cmd.mjs";

// Rows of the live "/" menu visible at once (plus one hint line below them).
export const MENU_MAX = 12;

// The input prompt, shared by readline and the plain-mode redraw.
const PROMPT = "› ";

// A second Ctrl-C within this long of the first (with nothing running and an
// empty prompt) exits. One stray Ctrl-C — e.g. trying to copy — no longer does.
export const EXIT_CONFIRM_MS = 1500;

// Format the visible slice of the "/" command menu. Pure and exported so the
// geometry that keeps the list on screen is testable without a terminal.
//
// The width rule matters more than it looks: renderMenu() draws the rows BELOW
// the input line and then hops back up with "\x1b[<lines>A", so every row has
// to occupy exactly one screen row. A row printed to the terminal's very last
// column wraps immediately on Windows consoles (they wrap eagerly instead of
// deferring the wrap to the next printed character), which makes each row eat
// two screen rows — the hop back up then lands in the middle of the menu and
// the following keystroke erases the list from there. That's what made the
// whole command list look like it had been removed. Leave a spare column.
export function formatMenuRows(rows, { width = 80, selected = 0, max = MENU_MAX } = {}) {
  if (!rows?.length) return [];
  const sel = Math.min(Math.max(0, selected), rows.length - 1);
  const rowWidth = Math.max(24, width - 1);
  const usageCol = Math.min(34, Math.max(16, rowWidth - 30));

  // Scroll the visible window with the selection instead of always showing
  // rows[0..max) — otherwise ↑/↓ past the first page moves the selection but
  // the screen never shows it (same windowing models.mjs's arrow pickers
  // already use for /model, /provider).
  const half = Math.floor(max / 2);
  let start = Math.max(0, sel - half);
  start = Math.min(start, Math.max(0, rows.length - max));
  const shown = rows.slice(start, start + max);

  const lines = shown.map((r, i) => {
    const rowIndex = start + i;
    const raw = String(r.usage || "");
    const usage = raw.length > usageCol ? raw.slice(0, usageCol - 1) + "…" : raw.padEnd(usageCol);
    const summary = String(r.summary || "").slice(0, Math.max(0, rowWidth - usageCol - 4));
    const pointer = rowIndex === sel ? c.cyan("›") : " ";
    const row = ` ${pointer} ${c.cyan(usage)} ${c.dim(summary)}`;
    return rowIndex === sel ? c.bold(row) : row;
  });

  const hint = rows.length > max
    ? `  ${sel + 1}/${rows.length} — ↑/↓ select · Tab pick · Enter run · keep typing to filter`
    : "  ↑/↓ select · Tab pick · Enter run · keep typing to filter";
  lines.push(c.dim(hint.slice(0, rowWidth)));
  return lines;
}

// Which prompt to use. The pinned box needs a real terminal with room for it
// and VT escape support; OMNI_SIMPLE_PROMPT=1 forces the plain prompt.
export function chooseBoxMode({ tty, rows, env = process.env } = {}) {
  if (!tty) return false;
  if (env.OMNI_SIMPLE_PROMPT === "1" || env.TERM === "dumb") return false;
  return (rows || 0) >= 12;
}

// Bracketed paste is on by default everywhere now (Windows Terminal and
// Windows 11 conhost support it); OMNI_BRACKET_PASTE=0 turns it off.
export function wantBracketedPaste({ tty, env = process.env } = {}) {
  return Boolean(tty) && env.OMNI_BRACKET_PASTE !== "0";
}

// Commands that are safe to run right away while the agent is working: they
// only read state (or, for /btw, hand the running turn a note). Everything
// else waits in the queue until the turn ends, since e.g. /model or /clear
// mid-turn would pull the conversation out from under it.
export const INSTANT_WHILE_BUSY = new Set(["btw", "help", "status", "cost", "usage", "limits", "quota", "version", "about", "bg", "loop"]);

// Pull the note out of a "/btw …" line, or null when it isn't one.
export function parseBtw(line) {
  const m = /^\/btw(?:\s+([\s\S]*))?$/.exec(String(line || "").trim());
  return m ? (m[1] || "").trim() : null;
}

// What ↑ + Enter on a queued prompt does while Omi is working. Pure, so the
// routing is testable without a terminal:
//   btw      "/btw note"                      → a course correction
//   message  text, or skills with text         → the running turn reads it as
//            the user's latest message; skills ride along and are loaded
//            with invoke_skill (they used to wait for the turn to end)
//   instant  a read-only command (/status…)    → runs right away
//   wait     other /commands, templates, typos → first in line for the next turn
export function planSendNow(ctx, text) {
  const t = String(text || "").trim();
  const btw = parseBtw(t);
  if (btw !== null) return btw ? { kind: "btw", note: btw } : { kind: "empty" };
  if (!t) return { kind: "empty" };
  const multi = parseSlashLine(ctx, t);
  if (multi) {
    if (multi.commands.length) return { kind: "wait", why: "that prompt runs commands - it runs next, when the turn ends" };
    return { kind: "message", text: multi.text, skills: multi.skills.map((s) => s.command) };
  }
  if (!t.startsWith("/")) return { kind: "message", text: t, skills: [] };
  const head = t.split(/\s+/)[0];
  const kind = slashKind(ctx, head);
  if (kind === "skill") return { kind: "message", text: t.slice(head.length).trim(), skills: [ctx.skillByCommand.get(head)?.command || head] };
  const cmdName = head.slice(1).toLowerCase();
  if (kind === "command" && INSTANT_WHILE_BUSY.has(cmdName)) return { kind: "instant", cmdName };
  return { kind: "wait", why: `${head} waits for the turn to end - it runs next` };
}

// Only a lone Esc (or two, from a key-repeat) interrupts a running turn —
// arrow keys, Home/End and pastes also start with ESC and used to kill it.
export function isInterruptKey(chunk) {
  return chunk === "\x1b" || chunk === "\x1b\x1b";
}

export async function startRepl(ctx, { resumeMode = false } = {}) {
  banner(ctx.model.key);
  // Cache-only, instant — never delays startup. Refreshes in the background
  // for next time (see integrations/update-check.mjs) if the cache is stale.
  const notice = updateNotice();
  if (notice) warnLine(notice);
  refreshUpdateCacheInBackground();
  // Scheduled runs that finished while you were away.
  try {
    const unread = unreadCount();
    if (unread) infoLine(`${unread} scheduled run(s) finished since you last looked: /inbox`);
  } catch { /* the inbox is advisory */ }
  if (ctx.loadedExtensions.length || ctx.skills.length || ctx.mcpInfo.servers) {
    const mcpNames = ctx.mcpInfo.names || [];
    const untrustedSet = new Set(ctx.mcpInfo.untrusted || []);
    const mcpList = mcpNames.length
      ? ` (${mcpNames.map((n) => (untrustedSet.has(n) ? `${n} [project, untrusted]` : n)).join(", ")})`
      : "";
    infoLine(
      `loaded ${ctx.loadedExtensions.length} extension(s), ${ctx.skills.length} skill(s), ${ctx.mcpInfo.servers} MCP server(s)${mcpList}` +
        (ctx.skills.length ? " — " + ctx.skills.map((s) => s.command).join(" ") : "")
    );
    console.log("");
  }

  // First-run onboarding: guide the user to configure a key if none is set.
  if (reportMissingKey(ctx.model)) console.log("");
  reportInsecureEndpoint(ctx.model);

  // Refresh the model's context window from provider metadata in the
  // background; the sync ladder value (user/table) is already in place.
  detectContextWindow(ctx).catch(() => {});

  // --resume: rebuild the conversation from the last session before prompting.
  // The session just created for this launch is the newest log in the folder,
  // so it is excluded; otherwise --resume would restore itself (nothing).
  // `--resume <code>` picks that exact conversation, from any folder.
  if (resumeMode) {
    let target = null;
    if (typeof resumeMode === "string") {
      const file = resolveSessionCode(resumeMode);
      if (!file) warnLine(`--resume: no session with the code ${resumeMode}`);
      else target = describeSession(file);
    } else {
      [target] = Session.list({ exclude: ctx.session.file, limit: 1 });
      if (!target) warnLine("--resume: no previous session found for this directory");
    }
    if (target) {
      const n = await resumeSessionInto(ctx, target.file);
      infoLine(`resumed "${target.title || target.id}": ${n} message(s) · ${target.code}`);
      if (target.cwd && path.resolve(target.cwd).toLowerCase() !== process.cwd().toLowerCase()) {
        warnLine(`that conversation happened in ${target.cwd}; you are in ${process.cwd()}`);
      }
      console.log("");
    }
  }

  const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY && typeof process.stdin.setRawMode === "function");
  const boxMode = chooseBoxMode({ tty, rows: process.stdout.rows });
  ctx.canRaw = tty;
  // /btw notes waiting for the running turn's next step (see runAgentTurns).
  ctx.steerQueue = [];

  // readline reads from rlInput, which only ever receives what the paste
  // filter lets through. Piped stdin (tests, scripts) goes straight in.
  let rlInput = process.stdin;
  if (tty) {
    rlInput = new PassThrough();
    rlInput.isTTY = true;
    rlInput.setRawMode = (mode) => process.stdin.setRawMode(mode);
  }
  // Box mode: readline keeps the keys, the footer does the drawing.
  const rlOutput = boxMode
    ? Object.assign(new Writable({ write(_chunk, _enc, cb) { cb(); } }), { isTTY: true })
    : process.stdout;

  // Tab completes the "/word" at the caret, wherever it is in the line: the
  // highlighted menu row (the top one unless you moved), then a space, so you
  // can go straight on typing or name the next skill. readline passes the
  // line up to the caret.
  const rl = readline.createInterface({
    input: rlInput,
    output: rlOutput,
    prompt: c.cyan(PROMPT),
    terminal: tty || undefined,
    completer: (line) => {
      const tok = slashTokenAt(line, line.length);
      if (!tok) return [[], line];
      const rows = slashMenuRows(ctx, line, line.length);
      const row = rows[Math.min(menuSelected, rows.length - 1)];
      if (!row) return [[], line];
      menuSelected = 0;
      return [[row.usage.split(/\s+/)[0] + " "], tok.word];
    },
  });
  ctx.rl = rl;

  // Set on rl "close"; a line handler that was still awaiting a turn when the
  // REPL closed must not touch the closed readline — rl.prompt() after close
  // throws ERR_USE_AFTER_CLOSE and kills the process.
  let replClosed = false;

  // ── Footer (box mode) ────────────────────────────────────────────────────
  let activityText = null;   // Omi's line while a status animates
  let footerNote = "";       // transient hint on the box border
  let footerNoteTimer = null;
  const queue = new PromptQueue();   // prompts waiting behind the running turn
  let runningTag = null;     // the tag of the queued item now running (/loop)
  let mouseOn = false;       // click reporting, on only while prompts are queued
  let mouseCarry = "";       // a mouse report split across stdin chunks
  let multiLine = "";
  let multiLineDisplay = "";
  let menuShown = [];        // rows the footer menu is showing right now

  function modeTag() {
    const m = getPermissionMode();
    if (m === "default") return "";
    const label = modeLabel(m);
    return "  " + (m === "plan" ? c.cyan(`⏸ ${label}`) : m === "auto" ? c.red(`⏵⏵ ${label}`) : c.yellow(`⏵ ${label}`)) + c.dim(" (shift+tab)");
  }

  function idleActivity() {
    if (ctx.currentAbort) {
      return "  " + c.cyan("(•‿•)⌨") + "  " + c.magenta("Omi: on it…") + modeTag() +
        c.dim("   esc to interrupt · enter queues a message · /btw <note> steers now");
    }
    return "  " + c.cyan("(•‿•)ᕗ") + "  " + c.dim("Omi ready · / for commands") + modeTag() + c.dim(" · shift+tab for plan mode");
  }

  // Say which mode is on now. Leaving plan mode re-arms the brainstorming
  // offer for the next time it's entered.
  function announceMode(m) {
    if (m !== "plan") ctx.brainstormOffered = false;
    const text = {
      default: "default mode: your permission settings apply",
      "accept-edits": "accept edits: file edits run without asking",
      plan: "plan mode: read-only until you approve a plan",
      auto: "auto: nothing asks except high-risk shell commands",
    }[m] || m;
    if (footer) flashNote(text);
    else { process.stdout.write("\n"); infoLine(text); if (promptActive) rl.prompt(true); }
  }
  ctx.announceMode = announceMode;

  const footer = boxMode ? createFooter({
    out: process.stdout,
    getState: () => {
      const cols = process.stdout.columns || 80;
      const line = rl.line || "";
      menuShown = !multiLine && queue.editing === null ? slashMenuRows(ctx, line, rl.cursor ?? line.length) : [];
      if (menuSelected >= menuShown.length) menuSelected = Math.max(0, menuShown.length - 1);
      const note = footerNote;
      return {
        activity: activityText || idleActivity(),
        prompt: multiLine ? "… " : stripAnsi(rl.getPrompt()),
        line,
        cursor: rl.cursor ?? line.length,
        highlight: multiLine ? [] : recognizedSlashRanges(ctx, line),
        statusText: statusBarText(ctx.model, ctx.session, cols - 1),
        menuLines: formatMenuRows(menuShown, { width: cols, selected: menuSelected, max: MENU_MAX }),
        note,
        queue: queue.items.map((q) => q.display),
        queueSelected: queue.editing ?? -1,
      };
    },
  }) : null;

  // Mouse reporting makes the ✎ / 🗑 next to queued prompts clickable. It
  // also takes the wheel and plain drag-select from the terminal, so it is on
  // only while something is queued (Shift+drag still selects text).
  // OMNI_MOUSE=0 turns it off for good.
  function syncMouse() {
    const want = Boolean(footer) && tty && !replClosed && !rl.paused && queue.length > 0 && process.env.OMNI_MOUSE !== "0";
    if (want === mouseOn) return;
    mouseOn = want;
    process.stdout.write(want ? MOUSE_ON : MOUSE_OFF);
  }

  let renderQueued = false;
  function renderFooter() {
    syncMouse();
    if (!footer || replClosed || rl.paused) return;
    if (renderQueued) return;
    renderQueued = true;
    setImmediate(() => {
      renderQueued = false;
      if (!replClosed && !rl.paused) footer.render();
    });
  }

  function flashNote(text) {
    footerNote = text;
    if (footerNoteTimer) clearTimeout(footerNoteTimer);
    footerNoteTimer = setTimeout(() => { footerNote = ""; renderFooter(); }, EXIT_CONFIRM_MS);
    footerNoteTimer.unref?.();
    renderFooter();
  }

  if (footer) {
    setStatusSink((text) => { activityText = text; renderFooter(); });
    // Pickers (/model, /provider, …) pause readline and take the whole screen;
    // get out of their way and come back when they hand the keyboard back.
    rl.on("pause", () => { footer.suspend(); syncMouse(); });
    rl.on("resume", () => renderFooter());
    process.stdout.on("resize", () => { if (!rl.paused && !replClosed) footer.onResize(); });
    // Never leave the shell with a scroll region or a hidden cursor.
    process.on("exit", () => { footer.disable(); if (mouseOn) process.stdout.write(MOUSE_OFF); });
  }

  // ── Raw stdin → paste filter → readline ──────────────────────────────────
  const bracketPaste = wantBracketedPaste({ tty });
  const pastes = new Map();
  let pasteSeq = 0;
  let onStdinData = null;
  if (tty) {
    // Keypress events on stdin itself are what the arrow pickers listen to.
    readline.emitKeypressEvents(process.stdin);
    const forward = (s) => { if (!replClosed && !rl.paused && s) rlInput.write(s); };
    const filter = new PasteFilter({
      onData: forward,
      onPaste: (text) => {
        const { inline, stored } = pasteInsertion(text, pasteSeq + 1);
        if (stored != null) pastes.set(++pasteSeq, stored);
        forward(inline);
      },
    });
    const decoder = new StringDecoder("utf8");
    onStdinData = (chunk) => {
      let s = typeof chunk === "string" ? chunk : decoder.write(chunk);
      if (mouseCarry || s.includes("\x1b[<")) {
        const { rest, clicks, partial } = extractMouse(mouseCarry + s);
        mouseCarry = partial;
        for (const { x, y } of clicks) onQueueClick(x, y);
        if (!rest) return;
        s = rest;
      }
      // Esc while a queued prompt is in the box stops editing it; it doesn't
      // interrupt the turn.
      if (queue.editing !== null && isInterruptKey(s)) { setBoxLine(queue.stop()); pump(); renderFooter(); return; }
      if (ctx.currentAbort && isInterruptKey(s)) { ctx.currentAbort.abort(); return; }
      // Shift+Tab cycles the permission mode, idle or mid-turn. Caught here,
      // before readline, which would also treat it as Tab and complete.
      if (s === "\x1b[Z") { announceMode(cyclePermissionMode()); return; }
      // Tab on a "/word" (anywhere in the line) takes the highlighted name.
      // Done here rather than in readline's completer, which pauses readline
      // and would blink the whole box away.
      if (s === "\t" && footer && !multiLine && queue.editing === null && !rl.paused && completeMenuWord()) { renderFooter(); return; }
      // readline raises Ctrl-C itself while it has the keyboard; when it's
      // paused (plain-mode generation) nobody would see it.
      if (rl.paused && ctx.currentAbort && s.includes("\x03")) { ctx.currentAbort.abort(); return; }
      filter.push(s);
    };
    process.stdin.on("data", onStdinData);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    if (bracketPaste) process.stdout.write("\x1b[?2004h");
  }

  // Ctrl-C: interrupt a running turn; otherwise clear the prompt; otherwise
  // exit on a second press within EXIT_CONFIRM_MS.
  let lastSigint = 0;
  const handleInterrupt = () => {
    if (ctx.currentAbort) { ctx.currentAbort.abort(); return; }
    if (!tty) { rl.close(); return; }
    if (rl.line) {
      rl.write(null, { ctrl: true, name: "e" });
      rl.write(null, { ctrl: true, name: "u" });
      renderFooter();
      return;
    }
    const now = Date.now();
    if (now - lastSigint < EXIT_CONFIRM_MS) { rl.close(); return; }
    lastSigint = now;
    if (footer) flashNote("press Ctrl-C again to exit");
    else {
      process.stdout.write("\n");
      infoLine("press Ctrl-C again to exit");
      rl.prompt(true);
    }
  };
  process.on("SIGINT", handleInterrupt);
  rl.on("SIGINT", handleInterrupt);

  // Permission "ask" confirmation, asked in the prompt itself mid-turn.
  ctx.confirmToolUse = async function confirmToolUse(name, summary) {
    return ctx.askLine(c.yellow(`  allow ${name}${summary ? ` (${String(summary).slice(0, 80)})` : ""}? [y/N/a=always] `));
  };

  // The agent's ask_user (and exit_plan_mode's approval) land here. Options
  // are numbered; typing a number picks one, anything else is a free answer.
  ctx.askUser = async function askUser({ question, options = [] }) {
    console.log("");
    console.log(c.bold("  " + String(question).trim().split("\n").join("\n  ")));
    options.forEach((o, i) => console.log(`    ${c.cyan(String(i + 1))}. ${o}`));
    const answer = String(await ctx.askLine(c.yellow(options.length ? `  your answer (1-${options.length}, or type one): ` : "  your answer: ")) || "").trim();
    const n = /^\d+$/.test(answer) ? Number(answer) : 0;
    return n >= 1 && n <= options.length ? options[n - 1] : answer;
  };

  // One line of input asked in the prompt box, keeping any half-typed draft.
  // /loop puts its prompt in the same queue as typed ones; a tag lets it see
  // whether its last run is still waiting or running.
  ctx.enqueuePrompt = (text, { tag = null, display = text } = {}) => {
    queue.add({ text, display, tag });
    pump();
    renderFooter();
  };
  ctx.isQueuedOrRunning = (tag) => runningTag === tag || queue.items.some((i) => i.tag === tag);
  ctx.renderFooter = () => renderFooter();

  ctx.askLine = async function askLine(q) {
    // readline's question() would glue a half-typed draft onto the answer.
    const draft = { line: rl.line || "", cursor: rl.cursor || 0 };
    rl.line = "";
    rl.cursor = 0;
    const wasPaused = Boolean(rl.paused);
    const answer = await new Promise((resolve) => {
      rl.question(footer ? stripAnsi(q).trim() + " " : q, resolve);
      renderFooter();
    });
    if (footer) {
      rl.line = draft.line;
      rl.cursor = draft.cursor;
      renderFooter();
    }
    if (wasPaused) rl.pause();
    return answer;
  };

  // Let mcp.mjs ask before ever connecting to a server sourced from this
  // project's .mcp.json (see loadMcpConfig) — reuses the same y/N/a prompt.
  // Trust is cached per-project per-definition (mcp.mjs), so this fires once
  // per server per machine, not on every connect.
  setMcpConfirm(async (name, target) => {
    const answer = await ctx.confirmToolUse(
      `mcp:${name}`,
      `NEW MCP server from this project's .mcp.json, not your own config — ${target}`
    );
    return /^(y|yes|a|always)$/i.test(String(answer || "").trim());
  });

  function clearPendingInput() {
    if (typeof rl.line === "string") rl.line = "";
    if (typeof rl.cursor === "number") rl.cursor = 0;
    if (process.stdout.isTTY && !footer) {
      readline.clearLine(process.stdout, 0);
      readline.cursorTo(process.stdout, 0);
    }
    // Otherwise a stale "/..." from the PREVIOUS prompt would make the very
    // next Up/Down on this fresh, empty prompt think the menu is still
    // active and hijack normal history navigation.
    menuLastLine = "";
    menuLastCursor = 0;
    menuSelected = 0;
    menuMoved = false;
  }

  // ── Live "/" command menu ────────────────────────────────────────────────
  // While the word at the caret starts with "/" (first word or any later one,
  // see slashTokenAt), a filtered list renders and narrows as you type ("/m"
  // shows every name starting with m; an empty "/" shows all of them).
  // Up/Down move the highlight; Tab puts the highlighted name in place of the
  // word and adds a space, so you can name another skill or keep typing;
  // Enter does the same and sends. Only that word changes, never the rest of
  // the prompt.
  let menuLines = 0;      // plain mode: rows the menu occupies below the input
  let menuSelected = 0;   // index into the current menu rows, highlighted row
  let menuLastLine = "";  // rl.line as of the last non-arrow keystroke — see
                           // the keypress handler: readline applies its own
                           // history substitution to rl.line for Up/Down
                           // BEFORE our listener runs, so this is what lets
                           // us restore the real filter text afterward.
  let promptActive = false;

  let menuLastCursor = 0; // rl.cursor at that same moment
  let menuMoved = false;  // the highlight was moved with the arrows

  const buildMenuRows = (line, cursor) => slashMenuRows(ctx, line, cursor);

  // The name Enter / Tab should use for the "/word" at the caret: the
  // highlighted row, or the word itself when it is already a full name and
  // you never moved the highlight (so "/python" stays /python even when
  // "/python-coding" sorts first).
  function pickedMenuName(line, cursor) {
    const tok = slashTokenAt(line, cursor);
    const rows = tok ? buildMenuRows(line, cursor) : [];
    const row = rows[Math.min(menuSelected, rows.length - 1)];
    if (!tok || !row) return null;
    const exact = rows.some((r) => r.usage.split(/\s+/)[0].toLowerCase() === tok.word.toLowerCase());
    return { tok, name: !menuMoved && exact ? tok.word : row.usage.split(/\s+/)[0] };
  }

  // Tab with the menu open: put the picked name in the line, caret after it.
  function completeMenuWord() {
    const line = rl.line || "";
    const pick = pickedMenuName(line, rl.cursor ?? line.length);
    if (!pick) return false;
    const next = acceptSlashRow(line, pick.tok, pick.name);
    rl.line = next.line;
    rl.cursor = next.cursor;
    menuLastLine = next.line;
    menuLastCursor = next.cursor;
    menuSelected = 0;
    menuMoved = false;
    return true;
  }

  // Plain mode: draw the menu under the input line.
  function renderMenu() {
    if (footer) { renderFooter(); return; }
    if (!process.stdout.isTTY || !promptActive || ctx.currentAbort) return;
    const line = rl.line || "";
    const rows = buildMenuRows(line, rl.cursor ?? line.length);
    if (!rows.length && !menuLines) return;
    if (menuSelected >= rows.length) menuSelected = Math.max(0, rows.length - 1);
    if (menuSelected < 0) menuSelected = 0;

    const lines = formatMenuRows(rows, {
      width: process.stdout.columns || 80,
      selected: menuSelected,
      max: MENU_MAX,
    });

    let cols = 2 + (rl.cursor ?? line.length); // fallback: "› " + cursor offset
    try { cols = rl.getCursorPos().cols; } catch { /* older readline */ }

    const out = ["\x1b[?25l"];
    // Erase the previous menu without touching the input row: hop one row
    // down (safe — the old menu occupies rows below), clear to screen end,
    // hop back up.
    if (menuLines > 0) out.push("\x1b[1B\r\x1b[0J\x1b[1A");
    if (lines.length) {
      out.push("\n" + lines.join("\n"));   // draw below the input line
      out.push(`\x1b[${lines.length}A`);   // and return to the input row
    }
    out.push("\r");
    if (cols > 0) out.push(`\x1b[${cols}C`);
    out.push("\x1b[?25h");
    process.stdout.write(out.join(""));
    menuLines = lines.length;
  }

  // Redraw the input row itself (prompt + text) — used after we restore
  // rl.line following a readline history-substitution we're overriding.
  function redrawInputLine(text) {
    if (footer) { renderFooter(); return; }
    if (!process.stdout.isTTY) return;
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
    process.stdout.write(c.cyan(PROMPT) + text);
  }

  function clearMenuAfterSubmit() {
    // Called from the line handler: readline has already echoed the newline,
    // so the cursor sits on the menu's first row — erase down from here.
    if (!footer && menuLines > 0 && process.stdout.isTTY) {
      process.stdout.write("\r\x1b[0J");
    }
    menuLines = 0;
    menuSelected = 0;
    menuMoved = false;
  }

  // Registered after readline's own listener on the same stream, so it runs
  // after readline has applied the key.
  if (tty) {
    rlInput.on("keypress", (_str, key) => {
      if (footer) {
        // Up on an empty box walks the queued prompts (newest first); while
        // one is shown, up/down move between them and down past the newest
        // gives the draft back. Readline has already swapped in a history
        // entry for this key, so put our text over it.
        const arrow = key && (key.name === "up" || key.name === "down") ? (key.name === "up" ? -1 : 1) : 0;
        if (arrow && !multiLine && (queue.editing !== null || (arrow < 0 && menuLastLine === "" && queue.length))) {
          absorbPastes();
          const text = queue.move(arrow, menuLastLine);
          if (text !== null) {
            setBoxLine(text);
            if (queue.editing === null) pump();
            renderFooter();
            return;
          }
        }
        // The box shows the draft even while a turn runs.
        if (arrow && !multiLine) {
          const rows = buildMenuRows(menuLastLine, menuLastCursor);
          if (rows.length) {
            rl.line = menuLastLine;
            rl.cursor = menuLastCursor;
            menuSelected = ((menuSelected + (key.name === "down" ? 1 : -1)) % rows.length + rows.length) % rows.length;
            menuMoved = true;
            renderFooter();
            return;
          }
        }
        if (!(key && (key.name === "return" || key.name === "enter"))) {
          menuLastLine = rl.line || "";
          menuLastCursor = rl.cursor ?? menuLastLine.length;
          menuSelected = 0;
          menuMoved = false;
        }
        renderFooter();
        return;
      }

      if (!promptActive || ctx.currentAbort) return;
      if (key && (key.name === "return" || key.name === "enter")) return;

      if (key && (key.name === "up" || key.name === "down") && buildMenuRows(menuLastLine, menuLastCursor).length) {
        // Readline's own listener already ran for this same keypress and
        // applied its default Up/Down history substitution to rl.line —
        // override that: restore the real filter text and move the menu
        // selection instead of recalling a previous command.
        const rows = buildMenuRows(menuLastLine, menuLastCursor);
        rl.line = menuLastLine;
        rl.cursor = menuLastCursor;
        menuSelected = ((menuSelected + (key.name === "down" ? 1 : -1)) % rows.length + rows.length) % rows.length;
        menuMoved = true;
        redrawInputLine(menuLastLine);
        renderMenu();
        return;
      }

      menuLastLine = rl.line || "";
      menuLastCursor = rl.cursor ?? menuLastLine.length;
      menuSelected = 0;
      menuMoved = false;
      setImmediate(renderMenu);
    });
  }

  function showPrompt() {
    if (replClosed) return;
    promptActive = true;
    if (footer) {
      // Keep whatever was typed into the box while the turn ran.
      rl.prompt(true);
      renderFooter();
      return;
    }
    clearPendingInput();
    statusBar(ctx.model, ctx.session);
    promptTop();
    rl.prompt();
  }

  // Echo a submitted message into the output (box mode: the box itself is
  // cleared on submit, so this is the transcript's copy of what you sent).
  function echoSubmitted(display) {
    if (!footer) return;
    const lines = String(display).split("\n");
    console.log("");
    lines.forEach((l, i) => {
      // Each recognised /command or /skill shows in blue, like in the box.
      const spans = i === 0 ? recognizedSlashRanges(ctx, l) : [];
      let text = "", at = 0;
      for (const [a, b] of spans) { text += c.bold(l.slice(at, a)) + c.blue(c.bold(l.slice(a, b))); at = b; }
      text += c.bold(l.slice(at));
      console.log((i === 0 ? c.cyan(PROMPT) : "  ") + text);
    });
  }

  // Snapshot the workspace before a turn first changes something (/rewind).
  // Off with settings.checkpoints:false; after one failure (no git, a huge
  // folder) it stays off for the session and says so once.
  ctx.checkpointer = ctx.settings.checkpoints === false ? null : new Checkpointer();
  function takeCheckpoint(turnStart) {
    const cp = ctx.checkpointer;
    if (!cp || cp.disabled) return;
    try {
      cp.snapshot({ ...turnStart, session: ctx.session.file });
    } catch (e) {
      warnLine(`checkpoints off for this session: ${e.message}`);
    }
  }

  // Run one agent turn, then keep going while goal mode queues continuations.
  async function runAgentTurns() {
    // Plain mode: readline would echo keystrokes into the streaming output, so
    // it sits the turn out. Box mode keeps it live — typing goes to the box.
    if (!footer && !replClosed) rl.pause();
    const runStart = ctx.messages.length;
    let goalJustCompleted = false;
    let endedAborted = false;
    let keepGoing = true;
    while (keepGoing) {
      ctx.currentAbort = new AbortController();
      renderFooter();
      // Where this turn starts, for /rewind: the prompt that triggered it is
      // the last message (and the last conversation record in the log).
      let promptAt = ctx.messages.length - 1;
      while (promptAt > 0 && ctx.messages[promptAt].role !== "user") promptAt--;
      const turnStart = {
        messageIndex: promptAt,
        recordCount: Math.max(0, ctx.session.conversationLength - 1),
        label: typeof ctx.messages[promptAt]?.content === "string" ? ctx.messages[promptAt].content : "(prompt)",
      };
      await runTurn({
        model: ctx.model,
        settings: ctx.settings,
        messages: ctx.messages,
        session: ctx.session,
        maxIterations: turnMaxIterations(ctx.model, ctx.settings),
        diffPreview: ctx.diffPreview,
        persona: ctx.activePersona,
        signal: ctx.currentAbort.signal,
        permissions: ctx.settings.permissions,
        confirmTool: ctx.confirmToolUse,
        showThinking: ctx.settings.showThinking,
        contextMode: ctx.contextMode,
        takeSteering: () => ctx.steerQueue.splice(0),
        beforeMutation: () => takeCheckpoint(turnStart),
      });
      const aborted = ctx.currentAbort.signal.aborted;
      endedAborted = aborted;
      ctx.currentAbort = null;

      keepGoing = false;
      // A /btw that arrived after the agent's last step (while it was
      // writing its final answer) would otherwise sit unread — answer it now.
      if (!aborted && ctx.steerQueue.length) {
        for (const note of ctx.steerQueue.splice(0)) {
          const msg = syntheticUser(steeringMessage(note), { userText: steeringText(note) });
          ctx.messages.push(msg);
          await ctx.session.append(recordFor(msg));
        }
        keepGoing = true;
        continue;
      }
      if (!aborted) {
        const continuation = nextGoalStep(ctx);
        if (continuation) {
          infoLine(`goal iteration ${ctx.goal.iterations} — continuing (Esc/Ctrl-C to interrupt, /goal pause to stop)`);
          const msg = syntheticUser(continuation);
          ctx.messages.push(msg);
          await ctx.session.append(recordFor(msg));
          keepGoing = true;
        } else if (ctx.goal?.status === "complete" && !ctx.goal.announced) {
          ctx.goal.announced = true;
          goalJustCompleted = true;
          infoLine(`🏁 goal complete after ${ctx.goal.iterations} iteration(s)`);
        }
      }
    }
    activityText = null;
    // Turn-scoped skill bodies (see applySkill / markEphemeralSkill in
    // helpers.mjs) live only for the turn(s) triggered by /<skill>. Once the
    // model returns a plain-text answer, drop them so a 10–26KB SKILL.md
    // isn't re-billed on every subsequent turn of the session.
    evictEphemeralSkillMessages(ctx.messages);
    console.log("");
    if (!footer) clearPendingInput();
    // The REPL may have closed while the turn ran (stdin EOF, /exit) —
    // resuming a closed readline throws ERR_USE_AFTER_CLOSE.
    if (!replClosed) rl.resume();
    renderFooter();

    // A long run that passed self_review (or finished a goal) is worth
    // remembering: offer to save how it was done as a learned skill.
    if (!endedAborted && !replClosed && !ctx.learningSkill && ctx.askLine) {
      const { offer, calls } = shouldOfferLearning(ctx.messages.slice(runStart), { goalCompleted: goalJustCompleted });
      if (offer) {
        const yes = /^y(es)?$/i.test(String(await ctx.askLine(c.cyan(`  that took ${calls} steps and passed review. Save how it was done as a reusable skill? [y/N] `)) || "").trim());
        if (yes) {
          const msg = syntheticUser(learnPrompt());
          ctx.messages.push(msg);
          await ctx.session.append(recordFor(msg));
          ctx.learningSkill = true;
          try { await runAgentTurns(); } finally { ctx.learningSkill = false; }
        }
      }
    }
  }

  async function handleSubmittedText(rawText, { display = rawText } = {}) {
    const line = String(rawText || "").replace(/\r/g, "").trim();
    const shown = String(display || "").trim();

    // Multi-line continuation
    if (line.endsWith("\\") && !line.startsWith("/")) {
      multiLine += line.slice(0, -1) + "\n";
      multiLineDisplay += shown.slice(0, -1) + "\n";
      if (footer) {
        renderFooter();
      } else {
        process.stdout.write(c.dim("… "));
        // We're prompting again (just without the full frame), so the menu and
        // the rest of the keypress handling stay live for the continuation line.
        promptActive = true;
      }
      return;
    }

    const fullLine = multiLine + line;
    const fullDisplay = multiLineDisplay + shown;
    multiLine = "";
    multiLineDisplay = "";
    pastes.clear();
    if (!fullLine.trim()) return showPrompt();

    if (!footer) promptBottom();
    echoSubmitted(fullDisplay);

    const commandLine = fullLine.trim();

    // Several /commands and /skills in one prompt: the commands run in order,
    // then every skill named is loaded for one turn on the remaining text.
    const multi = parseSlashLine(ctx, commandLine);
    if (multi) {
      for (const cmd of multi.commands) {
        infoLine(`▸ /${cmd.name}${cmd.arg ? " " + cmd.arg : ""}`);
        const result = await dispatchCommand(ctx, cmd.name, cmd.arg, cmd.parts);
        if (result?.closed || replClosed) return;
        if (result?.startTurn) {
          if (result.prompt) {
            ctx.messages.push({ role: "user", content: result.prompt });
            await ctx.session.append({ type: "user", content: result.prompt });
          }
          if (!reportMissingKey(ctx.model) && !activeModelBlockedByHealth(ctx)) await runAgentTurns();
        }
      }
      if (multi.skills.length) {
        for (const skill of multi.skills) infoLine(skillLoadedLine(skill));
        await applySkills(multi.skills, multi.text, ctx.messages, ctx.session, { contextMode: ctx.contextMode });
        if (!reportMissingKey(ctx.model) && !activeModelBlockedByHealth(ctx)) await runAgentTurns();
      }
      return showPrompt();
    }
    // A prompt template expands into the text it stands for and then goes to
    // the agent exactly like something you typed (hooks, plan mode, router).
    let agentText = fullLine;
    const kind = commandLine.startsWith("/") ? slashKind(ctx, commandLine) : "text";
    if (kind === "template") {
      const head = commandLine.split(/\s+/)[0];
      const template = ctx.templates.get(head.toLowerCase());
      agentText = expandTemplate(template, commandLine.slice(head.length));
      infoLine(`▸ template ${template.command} (${template.scope})`);
    } else if (commandLine.startsWith("/")) {
      const parts = commandLine.split(/\s+/);
      const cmdName = parts[0].slice(1);
      const arg = parts.slice(1).join(" ");

      // Skills run a turn with their instructions. A built-in of the same name
      // wins (slashKind), so /omnibots hits the launcher, not the model.
      if (slashKind(ctx, commandLine) === "skill") {
        const skill = ctx.skillByCommand.get(parts[0]);
        infoLine(skillLoadedLine(skill));
        await applySkill(skill, arg, ctx.messages, ctx.session, { contextMode: ctx.contextMode });
        await runAgentTurns();
        return showPrompt();
      }

      const result = await dispatchCommand(ctx, cmdName, arg, parts);
      if (result?.closed) return;
      if (result?.startTurn) {
        if (result.prompt) {
          ctx.messages.push({ role: "user", content: result.prompt });
          await ctx.session.append({ type: "user", content: result.prompt });
        }
        if (!reportMissingKey(ctx.model) && !activeModelBlockedByHealth(ctx)) await runAgentTurns();
      }
      return showPrompt();
    }

    // Plain input → the agent, after any UserPromptSubmit hooks have had a say.
    const hooked = await submitPromptHooks(agentText);
    for (const err of hooked.errors) warnLine(`hook ${err}`);
    if (hooked.denied) {
      warnLine(`prompt blocked by hook ${hooked.by}: ${hooked.reason}`);
      return showPrompt();
    }
    // The first prompt in plan mode: offer to explore it with the
    // brainstorming skill before the agent starts planning.
    if (getPermissionMode() === "plan" && !ctx.brainstormOffered) {
      ctx.brainstormOffered = true;
      const brainstorm = ctx.skillByCommand?.get("/brainstorming");
      if (brainstorm) {
        const yes = /^y(es)?$/i.test(String(await ctx.askLine(c.cyan("  plan mode: load the brainstorming skill to explore this first? [y/N] ")) || "").trim());
        if (yes) {
          infoLine(skillLoadedLine(brainstorm));
          await applySkill(brainstorm, hooked.content, ctx.messages, ctx.session, { contextMode: ctx.contextMode });
          if (!reportMissingKey(ctx.model) && !activeModelBlockedByHealth(ctx)) await runAgentTurns();
          return showPrompt();
        }
      }
    }
    const userMsg = promptMessage(agentText, hooked.content);
    ctx.messages.push(userMsg);
    await ctx.session.append(recordFor(userMsg));
    if (ctx.routerCfg.enabled && ctx.routeMode === "auto" && !ctx.routePinned) {
      ctx.activePersona = await classifyIntent({ message: agentText, settings: ctx.settings });
      setPersonaIndicator(ctx.activePersona);
    }
    // A keyless provider can only answer with a 401 — say so up front instead
    // of round-tripping to get the provider's own version of "unauthorized".
    if (reportMissingKey(ctx.model) || activeModelBlockedByHealth(ctx)) {
      return showPrompt();
    }
    await runAgentTurns();
    showPrompt();
  }

  // Submissions run one at a time; anything sent while a turn runs waits in
  // `queue`, where it can be edited, sent early or deleted (see queue.mjs).
  function queueSubmittedText(rawText, { display = rawText } = {}) {
    queue.add({ text: rawText, display, pastes: new Map(pastes) });
    pump();
    renderFooter();
  }

  let pumping = false;
  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      let item;
      while (!replClosed && (item = queue.next())) {
        renderFooter();
        try {
          runningTag = item.tag || null;
          await handleSubmittedText(item.text, { display: item.display });
        } catch (e) {
          warnLine(e?.message || String(e));
        } finally {
          runningTag = null;
        }
      }
    } finally {
      pumping = false;
      renderFooter();
    }
  }

  // Put `text` in the box with the caret at its end.
  function setBoxLine(text) {
    const t = String(text ?? "");
    rl.line = t;
    rl.cursor = t.length;
    menuLastLine = t;
    menuLastCursor = t.length;
    menuSelected = 0;
    menuMoved = false;
  }

  // A paste made while editing a queued prompt belongs to that prompt.
  function absorbPastes() {
    const item = queue.editing !== null ? queue.items[queue.editing] : null;
    if (!item) return;
    if (!item.pastes) item.pastes = new Map();
    for (const [k, v] of pastes) item.pastes.set(k, v);
  }

  // A click on a queued prompt: its pencil (or its text) puts it in the box,
  // its bin removes it.
  function onQueueClick(x, y) {
    const hit = footer?.hitTest(x, y);
    if (!hit) return;
    absorbPastes();
    if (hit.action === "delete") {
      const wasEditing = queue.editing === hit.index;
      queue.remove(hit.index);
      if (wasEditing) setBoxLine(queue.stop());
      flashNote(`removed queued prompt #${hit.index + 1}`);
      pump();
    } else {
      setBoxLine(queue.begin(hit.index, rl.line || ""));
    }
    // Redraw now, not on the next tick: a second click in the same chunk must
    // be matched against the rows as they are after this one.
    syncMouse();
    if (footer && !rl.paused && !replClosed) footer.render();
  }

  // Enter on a queued prompt in the box: send it now. Mid-turn, text goes to
  // the running turn the way /btw does; a command that can't run mid-turn
  // moves to the front of the queue instead. Idle, it simply runs.
  async function sendQueuedNow(input) {
    absorbPastes();
    if (!input.trim()) {
      queue.remove(queue.editing);
      setBoxLine(queue.stop());
      flashNote("removed the emptied queued prompt");
      pump();
      return;
    }
    const { item, draft } = queue.take(input);
    setBoxLine(draft);
    const text = String(item.text || "").trim();
    if (!ctx.currentAbort) {
      queue.items.unshift(item);
      pump();
      return;
    }
    const plan = planSendNow(ctx, text);
    if (plan.kind === "empty") { renderFooter(); return; }
    if (plan.kind === "instant") {
      const parts = text.split(/\s+/);
      console.log(c.cyan(PROMPT) + c.bold(item.display.trim()));
      Promise.resolve(dispatchCommand(ctx, plan.cmdName, parts.slice(1).join(" "), parts))
        .catch((e) => warnLine(e?.message || String(e)))
        .finally(renderFooter);
      return;
    }
    if (plan.kind === "wait") {
      queue.items.unshift(item);
      flashNote(plan.why);
      return;
    }
    let note = plan.kind === "btw" ? plan.note : { text: plan.text, skills: plan.skills };
    // Same UserPromptSubmit hooks as any prompt you send.
    if (plan.kind === "message" && plan.text) {
      const hooked = await submitPromptHooks(plan.text);
      for (const err of hooked.errors) warnLine(`hook ${err}`);
      if (hooked.denied) { warnLine(`prompt blocked by hook ${hooked.by}: ${hooked.reason}`); renderFooter(); return; }
      note = { text: hooked.content, skills: plan.skills };
    }
    ctx.steerQueue.push(note);
    console.log(c.cyan(PROMPT) + c.bold(item.display.trim()));
    infoLine(plan.skills?.length
      ? `↳ sent with ${plan.skills.join(" ")} — Omi loads ${plan.skills.length > 1 ? "them" : "it"} at its next step`
      : "↳ sent — Omi will read this at its next step");
    renderFooter();
  }

  rl.on("line", (rawInput) => {
    let input = String(rawInput || "").replaceAll(PASTE_START, "").replaceAll(PASTE_END, "");
    if (queue.editing !== null && !multiLine) {
      menuShown = [];
      sendQueuedNow(input).catch((e) => warnLine(e?.message || String(e)));
      // readline clears the box on Enter; give the draft back.
      const draft = menuLastLine;
      setImmediate(() => { if (!replClosed) { rl.line = draft; rl.cursor = draft.length; renderFooter(); } });
      return;
    }
    promptActive = false;
    // Enter takes whichever row is highlighted in the live "/" menu for the
    // "/word" at the caret, not necessarily the literal text typed (typed
    // "/mod", arrowed to "/model", Enter runs "/model"; untouched, the top
    // match, or the word itself when it is already a full name). Only that
    // word is swapped, wherever it is; the rest of the prompt stays. Worked
    // out from the line itself, not from what was last drawn: keys that
    // arrive in one chunk reach Enter before the menu is ever rendered.
    if (!multiLine && input === menuLastLine) {
      const pick = pickedMenuName(input, menuLastCursor);
      if (pick) input = acceptSlashRow(input, pick.tok, pick.name, { space: false }).line;
    }
    clearMenuAfterSubmit();
    menuLastLine = "";
    menuLastCursor = 0;
    menuShown = [];
    const text = expandPastes(input, pastes);

    // While the agent works: /btw goes straight into the running turn, and a
    // few read-only commands run right away instead of waiting their turn.
    if (ctx.currentAbort && !multiLine) {
      const trimmed = text.trim();
      const note = parseBtw(trimmed);
      if (note !== null) {
        pastes.clear();
        if (!note) { warnLine("usage: /btw <note> — e.g. /btw keep this backwards compatible"); renderFooter(); return; }
        ctx.steerQueue.push(note);
        console.log(c.cyan(PROMPT) + c.bold(input.trim()));
        infoLine("↳ noted — Omi will read this at its next step");
        renderFooter();
        return;
      }
      const cmdName = trimmed.startsWith("/") ? trimmed.slice(1).split(/\s+/)[0].toLowerCase() : "";
      if (cmdName && INSTANT_WHILE_BUSY.has(cmdName)) {
        pastes.clear();
        const parts = trimmed.split(/\s+/);
        console.log(c.cyan(PROMPT) + c.bold(trimmed));
        Promise.resolve(dispatchCommand(ctx, cmdName, parts.slice(1).join(" "), parts))
          .catch((e) => warnLine(e?.message || String(e)))
          .finally(renderFooter);
        return;
      }
    }
    queueSubmittedText(text, { display: input });
  });

  rl.on("close", async () => {
    replClosed = true;
    syncMouse();
    if (onStdinData) process.stdin.off("data", onStdinData);
    if (footer) { footer.disable(); setStatusSink(null); }
    // Only worth saying when there is something to come back to.
    if (ctx.session?.conversationLength > 0 && ctx.session.code) {
      console.log(c.dim(`\n  come back to this conversation: omni --resume ${ctx.session.code}`));
    }
    if (tty) {
      if (bracketPaste) process.stdout.write("\x1b[?2004l");
      try { process.stdin.setRawMode(false); } catch { /* already closed */ }
      process.stdin.pause();
    }
    // Each step on its own: one failing teardown used to skip everything
    // after it — including shutdown() — and leave a half-closed Omi running.
    const steps = [
      () => stopAllLoops(ctx),
      () => { const n = stopAllBackground(ctx); if (n) infoLine(`stopped ${n} background run(s)`); },
      disconnectAll,
      disconnectBridge,
      killSidecar,
      shutdownLspServers,
      () => {
        if (llama.status().running) {
          llama.stopServer();
          infoLine("stopped local llama server");
        }
      },
    ];
    for (const step of steps) {
      try { step(); } catch { /* best effort — keep closing */ }
    }
    console.log(c.dim("\n  bye 👋"));
    await shutdown(0);
  });

  showPrompt();
}
