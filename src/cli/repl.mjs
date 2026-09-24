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

import readline from "node:readline";
import { PassThrough, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import {
  c, banner, infoLine, warnLine, shutdown,
  promptTop, promptBottom, statusBar, statusBarText, setPersonaIndicator, setStatusSink,
} from "../ui.mjs";
import { runTurn, steeringMessage } from "../core/agent.mjs";
import { Session, turnMaxIterations } from "../core/config.mjs";
import { disconnectAll, setMcpConfirm } from "../integrations/mcp.mjs";
import { disconnectBridge } from "../integrations/bridge.mjs";
import { shutdownAll as shutdownLspServers } from "../integrations/lsp.mjs";
import { classifyIntent, killSidecar } from "../integrations/router.mjs";
import * as llama from "../local/llama.mjs";
import { detectContextWindow } from "../core/context.mjs";
import { applySkill, restoreSessionMessages, reportMissingKey, reportInsecureEndpoint, evictEphemeralSkillMessages } from "./helpers.mjs";
import { activeModelBlockedByHealth } from "./models.mjs";
import { dispatchCommand, commandNames, commandMenu } from "./commands.mjs";
import { nextGoalStep } from "./goal.mjs";
import { updateNotice, refreshUpdateCacheInBackground } from "../integrations/update-check.mjs";
import { PasteFilter, pasteInsertion, expandPastes, PASTE_START, PASTE_END } from "./paste.mjs";
import { createFooter, stripAnsi } from "./footer.mjs";

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
    ? `  ${sel + 1}/${rows.length} — ↑/↓ select · Enter run · keep typing to filter`
    : "  ↑/↓ select · Enter run · keep typing to filter";
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
export const INSTANT_WHILE_BUSY = new Set(["btw", "help", "status", "cost", "version", "about"]);

// Pull the note out of a "/btw …" line, or null when it isn't one.
export function parseBtw(line) {
  const m = /^\/btw(?:\s+([\s\S]*))?$/.exec(String(line || "").trim());
  return m ? (m[1] || "").trim() : null;
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
  if (resumeMode) {
    const lastSession = await Session.findLast();
    if (!lastSession) {
      warnLine("--resume: no previous session found for this directory");
    } else {
      restoreSessionMessages(lastSession.records, ctx.messages);
      infoLine(`resumed ${ctx.messages.length} message(s) from ${lastSession.file}`);
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

  // Tab completion: slash commands + skill commands.
  const completions = () => [...commandNames(), ...ctx.skills.map((s) => s.command)];
  const rl = readline.createInterface({
    input: rlInput,
    output: rlOutput,
    prompt: c.cyan(PROMPT),
    terminal: tty || undefined,
    completer: (line) => {
      if (!line.startsWith("/")) return [[], line];
      const hits = completions().filter((x) => x.startsWith(line));
      return [hits.length ? hits : [], line];
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
  let pendingSubmits = 0;    // messages queued behind the running turn
  let multiLine = "";
  let multiLineDisplay = "";
  let menuShown = [];        // rows the footer menu is showing right now

  function idleActivity() {
    if (ctx.currentAbort) {
      return "  " + c.cyan("(•‿•)⌨") + "  " + c.magenta("Omi: on it…") +
        c.dim("   esc to interrupt · enter queues a message · /btw <note> steers now");
    }
    return "  " + c.cyan("(•‿•)ᕗ") + "  " + c.dim("Omi ready · / for commands · end a line with \\ for more lines");
  }

  const footer = boxMode ? createFooter({
    out: process.stdout,
    getState: () => {
      const cols = process.stdout.columns || 80;
      const line = rl.line || "";
      menuShown = !multiLine && line.startsWith("/") ? buildMenuRows(line) : [];
      if (menuSelected >= menuShown.length) menuSelected = Math.max(0, menuShown.length - 1);
      const note = footerNote || (pendingSubmits > 0 ? `${pendingSubmits} queued` : "");
      return {
        activity: activityText || idleActivity(),
        prompt: multiLine ? "… " : stripAnsi(rl.getPrompt()),
        line,
        cursor: rl.cursor ?? line.length,
        statusText: statusBarText(ctx.model, ctx.session, cols - 1),
        menuLines: formatMenuRows(menuShown, { width: cols, selected: menuSelected, max: MENU_MAX }),
        note,
      };
    },
  }) : null;

  let renderQueued = false;
  function renderFooter() {
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
    rl.on("pause", () => footer.suspend());
    rl.on("resume", () => renderFooter());
    process.stdout.on("resize", () => { if (!rl.paused && !replClosed) footer.onResize(); });
    // Never leave the shell with a scroll region or a hidden cursor.
    process.on("exit", () => footer.disable());
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
      const s = typeof chunk === "string" ? chunk : decoder.write(chunk);
      if (ctx.currentAbort && isInterruptKey(s)) { ctx.currentAbort.abort(); return; }
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
    const q = c.yellow(`  allow ${name}${summary ? ` (${String(summary).slice(0, 80)})` : ""}? [y/N/a=always] `);
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
    menuSelected = 0;
  }

  // ── Live "/" command menu ────────────────────────────────────────────────
  // While the input line starts with "/", a filtered command list renders
  // below the prompt and narrows as the user types (e.g. "/m" shows every
  // command starting with m — an empty "/" shows all of them). Up/Down move
  // a highlighted selection through it; Enter runs whichever row is
  // highlighted (not literally whatever text was typed — see the "line"
  // handler below, which substitutes the selected row's command). Cleared on
  // submit or when the "/" is deleted.
  let menuLines = 0;      // plain mode: rows the menu occupies below the input
  let menuSelected = 0;   // index into the current menu rows, highlighted row
  let menuLastLine = "";  // rl.line as of the last non-arrow keystroke — see
                           // the keypress handler: readline applies its own
                           // history substitution to rl.line for Up/Down
                           // BEFORE our listener runs, so this is what lets
                           // us restore the real filter text afterward.
  let promptActive = false;

  function buildMenuRows(line) {
    const body = line.slice(1);
    if (/\s/.test(body)) return []; // arguments started — hide the menu
    const prefix = body.toLowerCase();
    const cmds = commandMenu(prefix).map((r) => ({ usage: r.usage, summary: r.summary }));
    const skills = ctx.skills
      .filter((s) => s.command.slice(1).toLowerCase().startsWith(prefix))
      .map((s) => ({ usage: s.command, summary: s.description || "skill" }));
    return [...cmds, ...skills];
  }

  // Plain mode: draw the menu under the input line.
  function renderMenu() {
    if (footer) { renderFooter(); return; }
    if (!process.stdout.isTTY || !promptActive || ctx.currentAbort) return;
    const line = rl.line || "";
    const rows = line.startsWith("/") ? buildMenuRows(line) : [];
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
  }

  // Registered after readline's own listener on the same stream, so it runs
  // after readline has applied the key.
  if (tty) {
    rlInput.on("keypress", (_str, key) => {
      if (footer) {
        // The box shows the draft even while a turn runs.
        if (key && (key.name === "up" || key.name === "down") && menuLastLine.startsWith("/") && !multiLine) {
          const rows = buildMenuRows(menuLastLine);
          if (rows.length) {
            rl.line = menuLastLine;
            rl.cursor = menuLastLine.length;
            menuSelected = ((menuSelected + (key.name === "down" ? 1 : -1)) % rows.length + rows.length) % rows.length;
          }
          renderFooter();
          return;
        }
        if (!(key && (key.name === "return" || key.name === "enter"))) {
          menuLastLine = rl.line || "";
          menuSelected = 0;
        }
        renderFooter();
        return;
      }

      if (!promptActive || ctx.currentAbort) return;
      if (key && (key.name === "return" || key.name === "enter")) return;

      if (key && (key.name === "up" || key.name === "down") && menuLastLine.startsWith("/")) {
        // Readline's own listener already ran for this same keypress and
        // applied its default Up/Down history substitution to rl.line —
        // override that: restore the real filter text and move the menu
        // selection instead of recalling a previous command.
        const rows = buildMenuRows(menuLastLine);
        if (rows.length) {
          rl.line = menuLastLine;
          rl.cursor = menuLastLine.length;
          menuSelected = ((menuSelected + (key.name === "down" ? 1 : -1)) % rows.length + rows.length) % rows.length;
          redrawInputLine(menuLastLine);
          renderMenu();
        }
        return;
      }

      menuLastLine = rl.line || "";
      menuSelected = 0;
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
    lines.forEach((l, i) => console.log((i === 0 ? c.cyan(PROMPT) : "  ") + c.bold(l)));
  }

  // Run one agent turn, then keep going while goal mode queues continuations.
  async function runAgentTurns() {
    // Plain mode: readline would echo keystrokes into the streaming output, so
    // it sits the turn out. Box mode keeps it live — typing goes to the box.
    if (!footer && !replClosed) rl.pause();
    let keepGoing = true;
    while (keepGoing) {
      ctx.currentAbort = new AbortController();
      renderFooter();
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
      });
      const aborted = ctx.currentAbort.signal.aborted;
      ctx.currentAbort = null;

      keepGoing = false;
      // A /btw that arrived after the agent's last step (while it was
      // writing its final answer) would otherwise sit unread — answer it now.
      if (!aborted && ctx.steerQueue.length) {
        for (const note of ctx.steerQueue.splice(0)) {
          const content = steeringMessage(note);
          ctx.messages.push({ role: "user", content });
          await ctx.session.append({ type: "user", content });
        }
        keepGoing = true;
        continue;
      }
      if (!aborted) {
        const continuation = nextGoalStep(ctx);
        if (continuation) {
          infoLine(`goal iteration ${ctx.goal.iterations} — continuing (Esc/Ctrl-C to interrupt, /goal pause to stop)`);
          ctx.messages.push({ role: "user", content: continuation });
          await ctx.session.append({ type: "user", content: continuation });
          keepGoing = true;
        } else if (ctx.goal?.status === "complete" && !ctx.goal.announced) {
          ctx.goal.announced = true;
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
  }

  let submitChain = Promise.resolve();

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
    if (commandLine.startsWith("/")) {
      const parts = commandLine.split(/\s+/);
      const cmdName = parts[0].slice(1);
      const arg = parts.slice(1).join(" ");

      // Skill commands (from skills/*/SKILL.md) run a turn with skill instructions.
      if (ctx.skillByCommand.has(parts[0])) {
        await applySkill(ctx.skillByCommand.get(parts[0]), arg, ctx.messages, ctx.session, { contextMode: ctx.contextMode });
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

    // Plain input → the agent.
    ctx.messages.push({ role: "user", content: fullLine });
    await ctx.session.append({ type: "user", content: fullLine });
    if (ctx.routerCfg.enabled && ctx.routeMode === "auto" && !ctx.routePinned) {
      ctx.activePersona = await classifyIntent({ message: fullLine, settings: ctx.settings });
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

  // Submissions run one at a time; anything sent while a turn runs waits here.
  function queueSubmittedText(rawText, opts) {
    pendingSubmits++;
    renderFooter();
    submitChain = submitChain
      .then(() => {
        pendingSubmits--;
        return handleSubmittedText(rawText, opts);
      })
      .catch((e) => {
        warnLine(e?.message || String(e));
      });
    return submitChain;
  }

  rl.on("line", (rawInput) => {
    let input = String(rawInput || "").replaceAll(PASTE_START, "").replaceAll(PASTE_END, "");
    promptActive = false;
    // Enter runs whichever row is highlighted in the live "/" menu, not
    // necessarily the literal text typed (e.g. typed "/mod", arrowed to
    // "/model", Enter runs "/model" — or just the top match if you never
    // touched the arrows at all).
    const menuOpen = footer ? menuShown.length > 0 : menuLines > 0;
    if (menuOpen && !multiLine) {
      const rows = buildMenuRows(input);
      if (rows.length && rows[menuSelected]) {
        input = rows[menuSelected].usage.split(/\s+/)[0];
      }
    }
    clearMenuAfterSubmit();
    menuLastLine = "";
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
    if (onStdinData) process.stdin.off("data", onStdinData);
    if (footer) { footer.disable(); setStatusSink(null); }
    if (tty) {
      if (bracketPaste) process.stdout.write("\x1b[?2004l");
      try { process.stdin.setRawMode(false); } catch { /* already closed */ }
      process.stdin.pause();
    }
    disconnectAll();
    disconnectBridge();
    killSidecar();
    shutdownLspServers();
    if (llama.status().running) {
      llama.stopServer();
      infoLine("stopped local llama server");
    }
    console.log(c.dim("\n  bye 👋"));
    await shutdown(0);
  });

  showPrompt();
}
