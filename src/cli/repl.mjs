// Interactive REPL: readline loop, interrupt handling, tab completion for
// slash commands, the agent turn runner, and goal-mode auto-continuation.

import readline from "node:readline";
import {
  c, banner, infoLine, warnLine, shutdown,
  promptTop, promptBottom, statusBar, setPersonaIndicator,
} from "../ui.mjs";
import { runTurn } from "../core/agent.mjs";
import { Session } from "../core/config.mjs";
import { disconnectAll, setMcpConfirm } from "../integrations/mcp.mjs";
import { disconnectBridge } from "../integrations/bridge.mjs";
import { shutdownAll as shutdownLspServers } from "../integrations/lsp.mjs";
import { classifyIntent, killSidecar } from "../integrations/router.mjs";
import * as llama from "../local/llama.mjs";
import { detectContextWindow } from "../core/context.mjs";
import { applySkill, restoreSessionMessages, reportMissingKey, reportInsecureEndpoint } from "./helpers.mjs";
import { activeModelBlockedByHealth } from "./models.mjs";
import { dispatchCommand, commandNames, commandMenu } from "./commands.mjs";
import { nextGoalStep } from "./goal.mjs";

// How long a gap between consecutive plain (non-slash, non-continuation)
// readline "line" events is still considered "the same paste" rather than
// two separate deliberate submissions. This has to absorb real-world paste
// jitter, not just the ideal case: a pasted multi-line block usually arrives
// as one synchronous burst, but on some terminal/shell combinations (seen on
// Windows) the lines can land tens to a couple hundred ms apart. A window
// that's too tight silently splits ONE paste into N separate agent turns —
// each one a real model request, which can burn through a rate limit in
// seconds. A human manually typing two distinct one-line messages back to
// back essentially never does it within half a second of each other, so this
// stays well clear of that case while giving paste plenty of room.
export const BURST_PASTE_WINDOW_MS = 500;

export function shouldImmediateSubmit(rawInput, multiLineActive = false) {
  const trimmed = String(rawInput || "").trim();
  return trimmed.startsWith("/") || trimmed.endsWith("\\") || Boolean(multiLineActive);
}

// Pure helper used by tests to verify burst grouping behavior without
// requiring an interactive terminal.
export function coalesceBurstInputs(events, { windowMs = BURST_PASTE_WINDOW_MS } = {}) {
  const out = [];
  const burst = [];
  let lastAt = 0;

  function flushBurst() {
    if (!burst.length) return;
    out.push({ text: burst.join("\n"), fromPaste: true });
    burst.length = 0;
  }

  for (const ev of events || []) {
    const input = String(ev?.input || "");
    const at = Number.isFinite(ev?.at) ? ev.at : lastAt;
    const immediate = shouldImmediateSubmit(input, Boolean(ev?.multiLineActive));

    if (immediate) {
      flushBurst();
      out.push({ text: input, fromPaste: false });
      lastAt = at;
      continue;
    }

    if (burst.length && at - lastAt > windowMs) flushBurst();
    burst.push(input);
    lastAt = at;
  }

  flushBurst();
  return out;
}

export async function startRepl(ctx, { resumeMode = false } = {}) {
  const BRACKET_PASTE_ON = "\x1b[?2004h";
  const BRACKET_PASTE_OFF = "\x1b[?2004l";
  const BRACKET_PASTE_START = "\x1b[200~";
  const BRACKET_PASTE_END = "\x1b[201~";
  // (BURST_PASTE_WINDOW_MS is the module-level export above — one definition,
  // so the live behavior and the unit tests can never drift apart again.)

  banner(ctx.model.key);
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

  // Tab completion: slash commands + skill commands.
  const completions = () => [...commandNames(), ...ctx.skills.map((s) => s.command)];
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: c.cyan("› "),
    completer: (line) => {
      if (!line.startsWith("/")) return [[], line];
      const hits = completions().filter((x) => x.startsWith(line));
      return [hits.length ? hits : [], line];
    },
  });
  ctx.rl = rl;
  const canBracketPaste = process.stdin.isTTY && process.stdout.isTTY;
  if (canBracketPaste) process.stdout.write(BRACKET_PASTE_ON);

  // Ctrl-C interrupt: wired to BOTH process and rl (rl.pause() mutes rl's
  // SIGINT on Windows, so the process-level handler covers generation time).
  const handleInterrupt = () => {
    if (ctx.currentAbort) ctx.currentAbort.abort();
    else rl.close();
  };
  process.on("SIGINT", handleInterrupt);
  rl.on("SIGINT", handleInterrupt);

  // ESC detection via raw mode, only while readline is paused (during
  // generation) so echoing is never affected. Raw-mode Ctrl-C = 0x03.
  const canRaw = process.stdin.isTTY && typeof process.stdin.setRawMode === "function";
  ctx.canRaw = canRaw;
  if (canRaw) {
    readline.emitKeypressEvents(process.stdin);
    process.stdin.on("data", (chunk) => {
      if (ctx.currentAbort && (chunk[0] === 0x1b || chunk[0] === 0x03)) {
        ctx.currentAbort.abort();
      }
    });
  }
  const startInterruptWatch = () => { if (canRaw) { process.stdin.setRawMode(true); process.stdin.resume(); } };
  const stopInterruptWatch = () => { if (canRaw) { process.stdin.setRawMode(false); } };

  // Permission "ask" confirmation: hand the terminal back to readline
  // mid-turn, ask, then restore the generation interrupt watch.
  ctx.confirmToolUse = async function confirmToolUse(name, summary) {
    stopInterruptWatch();
    rl.resume();
    const q = c.yellow(`  allow ${name}${summary ? ` (${String(summary).slice(0, 80)})` : ""}? [y/N/a=always] `);
    const answer = await new Promise((resolve) => rl.question(q, resolve));
    rl.pause();
    startInterruptWatch();
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
    if (process.stdout.isTTY) {
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
  const MENU_MAX = 12;
  let menuLines = 0;      // rows the menu currently occupies below the input
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

  function renderMenu() {
    if (!process.stdout.isTTY || !promptActive || ctx.currentAbort) return;
    const line = rl.line || "";
    const rows = line.startsWith("/") ? buildMenuRows(line) : [];
    if (!rows.length && !menuLines) return;
    if (menuSelected >= rows.length) menuSelected = Math.max(0, rows.length - 1);
    if (menuSelected < 0) menuSelected = 0;

    const width = process.stdout.columns || 80;
    const usageCol = Math.min(34, Math.max(16, width - 30));
    // Scroll the visible window with the selection instead of always
    // showing rows[0..MENU_MAX) — otherwise Up/Down past the first page
    // moves menuSelected but the screen never shows it (same windowing
    // models.mjs's arrow pickers already use for /model, /provider).
    const half = Math.floor(MENU_MAX / 2);
    let start = Math.max(0, menuSelected - half);
    start = Math.min(start, Math.max(0, rows.length - MENU_MAX));
    const shown = rows.slice(start, start + MENU_MAX);
    const lines = shown.map((r, i) => {
      const rowIndex = start + i;
      const usage = r.usage.length > usageCol ? r.usage.slice(0, usageCol - 1) + "…" : r.usage.padEnd(usageCol);
      const summary = String(r.summary || "").slice(0, Math.max(0, width - usageCol - 4));
      const pointer = rowIndex === menuSelected ? c.cyan("›") : " ";
      const row = ` ${pointer} ${c.cyan(usage)} ${c.dim(summary)}`;
      return rowIndex === menuSelected ? c.bold(row) : row;
    });
    if (rows.length > MENU_MAX) lines.push(c.dim(`  ${menuSelected + 1}/${rows.length} — ↑/↓ select · Enter run · keep typing to filter`));
    else if (rows.length) lines.push(c.dim("  ↑/↓ select · Enter run · keep typing to filter"));

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
    if (!process.stdout.isTTY) return;
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
    process.stdout.write(c.cyan("› ") + text);
  }

  function clearMenuAfterSubmit() {
    // Called from the line handler: readline has already echoed the newline,
    // so the cursor sits on the menu's first row — erase down from here.
    if (menuLines > 0 && process.stdout.isTTY) {
      process.stdout.write("\r\x1b[0J");
      menuLines = 0;
    }
    menuSelected = 0;
  }

  process.stdin.on("keypress", (_str, key) => {
    if (!promptActive || ctx.currentAbort) return;
    if (key && (key.name === "return" || key.name === "enter")) return;

    if (key && (key.name === "up" || key.name === "down") && menuLastLine.startsWith("/")) {
      // Readline's own listener (registered before ours, at
      // readline.createInterface() time) already ran for this same keypress
      // and applied its default Up/Down history substitution to rl.line —
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

  // Set on rl "close"; a line handler that was still awaiting a turn when the
  // REPL closed (burst/piped input) must not touch the closed readline —
  // rl.prompt() after close throws ERR_USE_AFTER_CLOSE and kills the process.
  let replClosed = false;

  function showPrompt() {
    if (replClosed) return;
    clearPendingInput();
    statusBar(ctx.model, ctx.session);
    promptTop();
    promptActive = true;
    rl.prompt();
  }

  // Run one agent turn, then keep going while goal mode queues continuations.
  async function runAgentTurns() {
    if (!replClosed) rl.pause();
    startInterruptWatch();
    let keepGoing = true;
    while (keepGoing) {
      ctx.currentAbort = new AbortController();
      await runTurn({
        model: ctx.model,
        settings: ctx.settings,
        messages: ctx.messages,
        session: ctx.session,
        maxIterations: ctx.maxIterations,
        diffPreview: ctx.diffPreview,
        persona: ctx.activePersona,
        signal: ctx.currentAbort.signal,
        permissions: ctx.settings.permissions,
        confirmTool: ctx.confirmToolUse,
        showThinking: ctx.settings.showThinking,
      });
      const aborted = ctx.currentAbort.signal.aborted;
      ctx.currentAbort = null;

      keepGoing = false;
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
    stopInterruptWatch();
    console.log("");
    clearPendingInput();
    // The REPL may have closed while the turn ran (stdin EOF, /exit) —
    // resuming a closed readline throws ERR_USE_AFTER_CLOSE.
    if (!replClosed) rl.resume();
  }

  let multiLine = "";
  let pasteActive = false;
  let pasteLines = [];
  let burstLines = [];
  let burstTimer = null;
  let burstLastAt = 0;
  let submitChain = Promise.resolve();

  function stripBracketPasteMarkers(value) {
    return String(value || "")
      .replaceAll(BRACKET_PASTE_START, "")
      .replaceAll(BRACKET_PASTE_END, "");
  }

  async function handleSubmittedText(rawText, { fromPaste = false } = {}) {
    const line = fromPaste ? String(rawText || "") : String(rawText || "").trim();

    // Multi-line continuation
    if (!fromPaste && line.endsWith("\\") && !line.startsWith("/")) {
      multiLine += line.slice(0, -1) + "\n";
      process.stdout.write(c.dim("… "));
      return;
    }

    const fullLine = fromPaste ? line.replace(/\r/g, "") : multiLine + line;
    multiLine = "";
    if (!fullLine.trim()) return showPrompt();

    promptBottom();

    const commandLine = fullLine.trim();
    if (!fromPaste && commandLine.startsWith("/")) {
      const parts = commandLine.split(/\s+/);
      const cmdName = parts[0].slice(1);
      const arg = parts.slice(1).join(" ");

      // Skill commands (from skills/*/SKILL.md) run a turn with skill instructions.
      if (ctx.skillByCommand.has(parts[0])) {
        await applySkill(ctx.skillByCommand.get(parts[0]), arg, ctx.messages, ctx.session);
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
        if (!activeModelBlockedByHealth(ctx)) await runAgentTurns();
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
    if (activeModelBlockedByHealth(ctx)) {
      return showPrompt();
    }
    await runAgentTurns();
    showPrompt();
  }

  function queueSubmittedText(rawText, opts) {
    submitChain = submitChain
      .then(() => handleSubmittedText(rawText, opts))
      .catch((e) => {
        warnLine(e?.message || String(e));
      });
    return submitChain;
  }

  function clearBurstTimer() {
    if (burstTimer) {
      clearTimeout(burstTimer);
      burstTimer = null;
    }
  }

  function flushBurstBuffer() {
    clearBurstTimer();
    if (!burstLines.length) return Promise.resolve();
    const pasted = burstLines.join("\n");
    burstLines = [];
    return queueSubmittedText(pasted, { fromPaste: true });
  }

  rl.on("line", async (rawInput) => {
    let input = rawInput;
    promptActive = false;
    const hasPasteStart = input.includes(BRACKET_PASTE_START);
    const hasPasteEnd = input.includes(BRACKET_PASTE_END);
    // Enter runs whichever row is highlighted in the live "/" menu, not
    // necessarily the literal text typed (e.g. typed "/mod", arrowed to
    // "/model", Enter runs "/model" — or just the top match if you never
    // touched the arrows at all).
    if (menuLines > 0 && !pasteActive && !hasPasteStart && !hasPasteEnd) {
      const rows = buildMenuRows(input);
      if (rows.length && rows[menuSelected]) {
        input = rows[menuSelected].usage.split(/\s+/)[0];
      }
    }
    clearMenuAfterSubmit();
    if (pasteActive || hasPasteStart || hasPasteEnd) {
      if (hasPasteStart) pasteActive = true;
      pasteLines.push(stripBracketPasteMarkers(input));
      if (hasPasteEnd) {
        pasteActive = false;
        const pasted = pasteLines.join("\n");
        pasteLines = [];
        return handleSubmittedText(pasted, { fromPaste: true });
      }
      return;
    }

    const needsImmediate = shouldImmediateSubmit(input, Boolean(multiLine));

    if (needsImmediate) {
      await flushBurstBuffer();
      return queueSubmittedText(input);
    }

    const now = Date.now();
    if (burstLines.length && now - burstLastAt > BURST_PASTE_WINDOW_MS) {
      await flushBurstBuffer();
    }
    burstLastAt = now;
    burstLines.push(input);
    clearBurstTimer();
    burstTimer = setTimeout(() => {
      void flushBurstBuffer();
    }, BURST_PASTE_WINDOW_MS);
  });

  rl.on("close", async () => {
    replClosed = true;
    await flushBurstBuffer();
    if (canBracketPaste && process.stdout.isTTY) process.stdout.write(BRACKET_PASTE_OFF);
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
