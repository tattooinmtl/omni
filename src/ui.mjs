// Minimal ANSI color + output helpers (no dependencies).

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;

function wrap(code) {
  return (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
}

export const c = {
  dim: wrap("2"),
  bold: wrap("1"),
  red: wrap("31"),
  green: wrap("32"),
  yellow: wrap("33"),
  blue: wrap("34"),
  magenta: wrap("35"),
  cyan: wrap("36"),
  gray: wrap("90"),
};

// OMNI-AGENT banner — wide side-by-side block-letter wordmark (no frame),
// styled after the website logo: neon cyan -> violet -> magenta -> orange
// gradient, one color per row.
const LOGO_OMNI = [
  " ██████╗ ███╗   ███╗███╗   ██╗██╗",
  "██╔═══██╗████╗ ████║████╗  ██║██║",
  "██║   ██║██╔████╔██║██╔██╗ ██║██║",
  "██║   ██║██║╚██╔╝██║██║╚██╗██║██║",
  "╚██████╔╝██║ ╚═╝ ██║██║ ╚████║██║",
  " ╚═════╝ ╚═╝     ╚═╝╚═╝  ╚═══╝╚═╝",
];
const LOGO_SEP = ["     ", "     ", "████╗", "╚═══╝", "     ", "     "];
const LOGO_AGENT = [
  " █████╗  ██████╗ ███████╗███╗   ██╗████████╗",
  "██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝",
  "███████║██║  ███╗█████╗  ██╔██╗ ██║   ██║",
  "██╔══██║██║   ██║██╔══╝  ██║╚██╗██║   ██║",
  "██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║",
  "╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝",
];
const LOGO_SUBTITLE = "Omni-present harness for agents";

const LOGO_COLORS = [
  [80, 236, 240],
  [107, 202, 247],
  [136, 150, 255],
  [168, 96, 240],
  [206, 86, 218],
  [238, 129, 176],
  [255, 145, 92],
];

function tc(rgb, s) {
  if (!useColor) return s;
  const [r, g, b] = rgb;
  return `\x1b[38;2;${r};${g};${b}m${s}\x1b[0m`;
}

function gradientText(text, stops) {
  if (!useColor || !text) return String(text || "");
  if (!Array.isArray(stops) || stops.length === 0) return String(text);
  if (text.length === 1 || stops.length === 1) return tc(stops[0], text);

  const span = stops.length - 1;
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const t = i / (text.length - 1);
    const scaled = t * span;
    const a = Math.floor(scaled);
    const b = Math.min(a + 1, span);
    const localT = scaled - a;
    const r = Math.round(stops[a][0] + (stops[b][0] - stops[a][0]) * localT);
    const g = Math.round(stops[a][1] + (stops[b][1] - stops[a][1]) * localT);
    const blue = Math.round(stops[a][2] + (stops[b][2] - stops[a][2]) * localT);
    out += `\x1b[38;2;${r};${g};${blue}m${text[i]}`;
  }
  return out + "\x1b[0m";
}

export function banner(model) {
  console.log("");
  for (let i = 0; i < LOGO_OMNI.length; i++) {
    const row = LOGO_OMNI[i] + LOGO_SEP[i] + LOGO_AGENT[i];
    console.log("  " + tc(LOGO_COLORS[i], row));
  }
  console.log("  " + gradientText(LOGO_SUBTITLE, LOGO_COLORS));
  console.log("");
  console.log(`  ${c.dim("terminal coding agent")}   ${c.dim("model:")} ${c.cyan(model)}`);
  console.log(`  ${c.dim("type /help for commands, /exit to quit")}`);
  console.log("");
}

export function assistantPrefix() {
  process.stdout.write(`${c.magenta("●")} `);
}

// Streaming helpers: write tokens as they arrive, flush a trailing newline.
let _streamHadOutput = false;

export function streamWrite(token) {
  process.stdout.write(token);
  _streamHadOutput = true;
}

export function streamNewline() {
  if (_streamHadOutput) {
    process.stdout.write("\n");
    _streamHadOutput = false;
  }
}

export function toolLine(name, detail) {
  console.log(`  ${c.green("⚙")} ${c.bold(name)} ${c.dim(detail || "")}`.trimEnd());
}

export function toolResultLine(text) {
  const first = String(text).split("\n")[0].slice(0, 200);
  console.log(`    ${c.gray(first)}`);
}

// Show a mini diff preview for edit_file operations
export function diffPreviewLine(filePath, oldStr, newStr) {
  const oldLines = oldStr.split("\n");
  const newLines = newStr.split("\n");
  const maxShow = 5;
  console.log(`    ${c.red("─ removed")}`);
  for (let i = 0; i < Math.min(oldLines.length, maxShow); i++) {
    console.log(`    ${c.red("- " + oldLines[i])}`);
  }
  if (oldLines.length > maxShow) console.log(`    ${c.dim(`  … (${oldLines.length - maxShow} more)`)}`);
  console.log(`    ${c.green("─ added")}`);
  for (let i = 0; i < Math.min(newLines.length, maxShow); i++) {
    console.log(`    ${c.green("+ " + newLines[i])}`);
  }
  if (newLines.length > maxShow) console.log(`    ${c.dim(`  … (${newLines.length - maxShow} more)`)}`);
}

// ── Animated status line ─────────────────────────────────────────────────────
// One shared spinner drives every "what is the agent doing right now" state.
// Only a single state animates at a time. Each state carries its own ANSI color
// and a set of Unicode frames. The original braille "Thinking" frames are kept
// as the `thinking` state so existing behavior is unchanged.
const THINKING_FRAMES = [
  "⠋ Thinking",
  "⠙ Thinking.",
  "⠹ Thinking..",
  "⠸ Thinking...",
  "⠼ Thinking",
  "⠴ Thinking.",
  "⠦ Thinking..",
  "⠧ Thinking...",
  "⠇ Thinking",
  "⠏ Thinking.",
];

// color: one of the `c.*` helpers (respects NO_COLOR / non-TTY).
const STATES = {
  thinking:  { color: c.magenta, frames: THINKING_FRAMES },
  reasoning: { color: c.gray,    frames: ["▸ Reasoning", "▸ Reasoning.", "▸ Reasoning..", "▸ Reasoning..."] },
  searching: { color: c.cyan,    frames: ["⌕ Searching", "⌕ Searching.", "⌕ Searching..", "⌕ Searching..."] },
  coding:    { color: c.green,   frames: ["</> Writing code", "</> Writing code.", "</> Writing code..", "</> Writing code..."] },
  reading:   { color: c.blue,    frames: ["▤ Reading files", "▥ Reading files.", "▦ Reading files..", "▦ Reading files..."] },
  running:   { color: c.yellow,  frames: ["⚒ Running", "⚒ Running.", "⚒ Running..", "⚒ Running..."] },
  tokens:    { color: c.magenta, frames: ["▌ Generating", "█▌ Generating", "██▌ Generating", "███▌ Generating", "████▌ Generating"] },
  timer:     { color: c.gray,    frames: ["◷ Elapsed", "◶ Elapsed", "◵ Elapsed", "◴ Elapsed"] },
  ready:     { color: c.yellow,  frames: ["▰ OMNI-AGENT ready", "▱ OMNI-AGENT ready.", "▰ OMNI-AGENT ready..", "▱ OMNI-AGENT ready..."] },
};

// ── Codex-bot mascot ──────────────────────────────────────────────────────
// A tiny kaomoji-style robot that reacts to what the agent is doing right
// now — a terminal-friendly stand-in for the 11-pose sprite sheet (idle,
// walk-left, walk-right, salute, happy, furious, wondering, working,
// perplexed, look-down-right, look-down-left). Two frames per state give a
// subtle blink/bob animation without needing real image support in a shell.
const ROBOT = {
  idle:          ["(•‿•)", "(-‿-)"],
  walkLeft:      ["<(•‿•)", "<(-‿-)"],
  walkRight:     ["(•‿•)>", "(-‿-)>"],
  salute:        ["(•‿•)ᕗ", "(-‿-)ᕗ"],
  happy:         ["(^‿^)", "(^▽^)"],
  furious:       ["(>_<)", "(ò_ó)"],
  wondering:     ["(o_O)?", "(?_?) "],
  working:       ["(•‿•)⌨", "(-‿-)⌨"],
  perplexed:     ["(@_@)", "(•_•)"],
  lookDownRight: ["(•‿•)↘", "(-‿-)↘"],
  lookDownLeft:  ["(•‿•)↙", "(-‿-)↙"],
};

// Which mascot pose plays for each named agent status.
const STATE_ROBOT = {
  thinking: "wondering",
  reasoning: "wondering",
  searching: "lookDownRight",
  coding: "working",
  reading: "perplexed",
  running: "walkRight",
  ready: "salute",
};

function robotFrame(state, i = 0) {
  const frames = ROBOT[state] || ROBOT.idle;
  return frames[i % frames.length];
}

// Funny status verbs shown next to the mascot while the model "cooks" —
// same idea as Claude's rotating status word. A mix of real words and
// invented nonsense, all ending in "-ising" on purpose.
const FUNNY_WORDS = [
  "Tenderising", "Summarising", "Synthesising", "Optimising", "Philosophising",
  "Fantasising", "Improvising", "Advertising", "Surmising", "Revising",
  "Supervising", "Categorising", "Prioritising", "Visualising", "Energising",
  "Mesmerising", "Philanthropising", "Bamboozlising", "Frobnicising", "Pixelising",
  "Noodleising", "Confabulising", "Wobblising", "Sarcasmising", "Marinising",
  "Percolising", "Spelunkising", "Doodleising", "Snacklising", "Ponderising",
];

function pickFunnyWord() {
  return FUNNY_WORDS[Math.floor(Math.random() * FUNNY_WORDS.length)];
}

// ── Mascot personality ────────────────────────────────────────────────────
// Omi is chipper, a little sarcastic, and gets visibly impatient the longer
// it has to wait. Reactions are scoped to the action that just happened
// (coding, reading, searching, running a command, thinking, or a provider
// hiccup) so the quip actually matches what Omi was doing, not a generic
// "yay/oops". Picked randomly from a small pool so it doesn't repeat itself
// every turn.
const MASCOT_NAME = "Omi";

const ACTION_LINES = {
  coding: {
    cheer: ["patch applied clean.", "shipped it.", "diff looks good from here.", "code's in — fingers crossed."],
    grumble: ["that edit didn't take.", "patch rejected. rude.", "well, that write failed spectacularly.", "code and I are not speaking right now."],
  },
  reading: {
    cheer: ["skimmed the whole thing.", "found what we needed.", "read receipts: confirmed.", "nothing gets past me."],
    grumble: ["couldn't make sense of that file.", "the filesystem is hiding things again.", "that read bounced.", "page not found, so to speak."],
  },
  searching: {
    cheer: ["found it — barely broke a sweat.", "needle located in haystack.", "search complete, ego intact.", "nailed the query."],
    grumble: ["the internet is hiding something.", "zero results. shocking, I know.", "that search went nowhere.", "even I can't find that."],
  },
  running: {
    cheer: ["command executed, ego intact.", "ran clean, no drama.", "process behaved itself.", "exit code 0, as it should be."],
    grumble: ["that exit code was NOT a vibe.", "the shell and I disagree.", "command bailed on me.", "well, THAT crashed."],
  },
  thinking: {
    cheer: ["brain dump complete.", "thought that one through.", "reasoning: solid. mostly.", "and... done."],
    grumble: ["lost my train of thought.", "that reasoning went in circles.", "brain fog — send coffee.", "still not sure what happened there."],
  },
  provider: {
    grumble: ["rate limited. typical.", "the API said no.", "network's having a moment.", "getting throttled again, great."],
  },
};

// Omi's patience wears thin the longer a generation takes with no tokens yet.
const IMPATIENT = [
  "still thinking... unlike me, apparently.",
  "any day now.",
  "I've seen glaciers move faster.",
  "is it the wifi? it's the wifi, isn't it.",
  "taking notes for my memoir: 'The Great Wait'.",
  "beep. boop. still waiting.",
];

function pickLine(list) {
  return list[Math.floor(Math.random() * list.length)];
}

// One small, dim "<bot> Omi: <quip>" line reacting to what just happened.
// stateName matches the STATES/STATE_ROBOT keys (coding, reading, searching,
// running, thinking, provider); ok picks the cheer or grumble pool.
export function mascotLine(stateName, ok = true) {
  const pool = ACTION_LINES[stateName];
  if (!pool) return;
  const lines = ok ? pool.cheer : pool.grumble;
  if (!lines || !lines.length) return;
  const bot = ok ? c.green(robotFrame("happy", 0)) : c.red(robotFrame("furious", 0));
  console.log(`    ${bot} ${c.dim(`${MASCOT_NAME}: ${pickLine(lines)}`)}`);
}

let statusTimer = null;
// How many terminal lines the current status occupies. A simple one-line
// spinner is 0/1; the framed generation panel is 3 (top rule, content, bottom
// rule). stopStatus() uses this to erase the whole panel cleanly.
let statusFrameLines = 0;

// Full-width horizontal rule. Defaults to the yellow separator used to frame
// the bottom panel (user input when idle, token meter while generating).
export function hr(color = c.yellow, ch = "─") {
  const width = process.stdout.columns || 80;
  console.log(color(ch.repeat(width)));
}

// The two separator lines that sandwich the user-input area. Dim while idle;
// yellow is reserved for the active token-generation panel and alerts.
export function promptTop() { if (process.stdout.isTTY) hr(c.gray); }
export function promptBottom() { if (process.stdout.isTTY) hr(c.gray); }

// Bottom status bar: context usage on the left, provider/model on the right,
// right-justified to the terminal width. Rendered as part of the prompt frame.
// Persona indicator shown in the status bar when the router is active.
// Pass persona object (from PERSONAS) or null.
let _activePersona = null;
export function setPersonaIndicator(persona) { _activePersona = persona; }

function fmtK(n) {
  return n >= 1000 ? (n / 1000).toFixed(n % 1000 === 0 ? 0 : 1) + "k" : String(n);
}

export function statusBar(model, session) {
  if (!process.stdout.isTTY) return;
  const width = process.stdout.columns || 80;

  // Context usage: size of the live conversation (last request's prompt +
  // completion) against the model's context WINDOW — not the output cap.
  const used = (session && (session.contextTokens || 0)) || 0;
  const cap = (model && (model.contextWindow || model.maxTokens)) || 0;
  const pct = cap ? Math.min(100, Math.round((used / cap) * 100)) : 0;

  // Persona tag: "[coding]" or "[assistant]" when router is active.
  const personaTag = _activePersona
    ? c.yellow(`[${_activePersona.label}] `)
    : "";

  const left = `ctx ${fmtK(used)}/${fmtK(cap)} (${pct}%)`;
  const provider = model?.providerLabel || model?.providerName || "?";
  let id = model?.id || model?.key || "?";
  let right = `(${provider}) ${id}`;

  // Truncate the model id if the bar would overflow the terminal width.
  const personaLen = _activePersona ? _activePersona.label.length + 3 : 0;
  let gap = width - left.length - right.length - personaLen;
  if (gap < 1) {
    const over = 1 - gap + 1;
    if (id.length > over) {
      id = id.slice(0, id.length - over) + "…";
      right = `(${provider}) ${id}`;
    }
    gap = Math.max(1, width - left.length - right.length - personaLen);
  }

  process.stdout.write(
    c.gray(left) + " ".repeat(gap) + personaTag + c.dim(`(${provider}) `) + c.gray(id) + "\n"
  );
}

// Start (or switch to) an animated status. Names: see STATES above.
export function startStatus(name = "thinking", interval = 120) {
  if (!process.stdout.isTTY) return;
  if (statusTimer) stopStatus();
  const state = STATES[name] || STATES.thinking;
  const robotState = STATE_ROBOT[name] || "idle";
  const hint = c.dim("  [ESC / Ctrl-C to stop]");
  let i = 0;
  statusTimer = setInterval(() => {
    const frame = state.frames[i % state.frames.length];
    const bot = c.cyan(robotFrame(robotState, i));
    process.stdout.write("\r\x1b[2K  " + bot + "  " + state.color(frame) + hint);
    i++;
  }, interval);
  // Don't let the spinner keep the event loop alive on exit.
  if (statusTimer.unref) statusTimer.unref();
}

export function stopStatus() {
  if (statusTimer) {
    clearInterval(statusTimer);
    statusTimer = null;
  }
  if (!process.stdout.isTTY) return;
  if (statusFrameLines > 0) {
    // Cursor sits on the bottom rule. Erase it and every line above the panel,
    // leaving the cursor at the start of the (now empty) top line.
    for (let k = 0; k < statusFrameLines; k++) {
      process.stdout.write("\r\x1b[2K");
      if (k < statusFrameLines - 1) process.stdout.write("\x1b[1A");
    }
    statusFrameLines = 0;
  } else {
    process.stdout.write("\r\x1b[2K");
  }
}

// Live token-generation panel: the token info + animated icons housed inside a
// bottom box bounded by two yellow lines — the same frame that brackets the
// user's input. The middle line (token bar + elapsed timer) animates in place;
// the yellow rules above and below stay put. `getTokenCount` is read each tick.
export function startGenerationStatus(getTokenCount, { interval = 120, contextWindow = 0 } = {}) {
  if (!process.stdout.isTTY) return;
  if (statusTimer) stopStatus();
  const width = process.stdout.columns || 80;
  const rule = c.yellow("─".repeat(width));
  const bar = STATES.tokens.frames;     // ▌ █▌ ██▌ ███▌ ████▌
  const clock = STATES.timer.frames;    // ◷ ◶ ◵ ◴
  const funnyWord = pickFunnyWord();    // one word for the whole wait, not per-tick
  const impatientLine = pickLine(IMPATIENT); // in reserve, in case Omi's patience runs out
  const IMPATIENCE_MS = 12000; // no tokens after this long and the mask slips
  const contextLabel = contextWindow ? `  ·  context: ${fmtK(contextWindow)}` : "";
  const start = Date.now();
  let i = 0;

  // Lay down the frame once: top rule, blank content line, bottom rule. The
  // cursor ends on the bottom rule; each tick we hop up to the content line.
  process.stdout.write(rule + "\n\n" + rule);
  statusFrameLines = 3;

  statusTimer = setInterval(() => {
    const elapsedMs = Date.now() - start;
    const elapsed = (elapsedMs / 1000).toFixed(1);
    const tokens = typeof getTokenCount === "function" ? getTokenCount() : 0;
    const tps = elapsedMs > 300 ? (tokens / (elapsedMs / 1000)).toFixed(1) : "0.0";
    const icon = bar[i % bar.length];
    const spin = clock[i % clock.length].slice(0, 1);
    const impatient = tokens === 0 && elapsedMs > IMPATIENCE_MS;
    const bot = c.cyan(robotFrame(impatient ? "perplexed" : (tokens > 0 ? "working" : "wondering"), i));
    const label = impatient
      ? c.yellow(`${MASCOT_NAME}: ${impatientLine}`)
      : c.magenta(`${funnyWord}…`);
    const content =
      "  " + bot +
      "  " + label +
      "   " + c.magenta(`${icon} ${tokens} tokens (${tps} tok/s)`) +
      "   " + c.gray(`${spin} ${elapsed}s${contextLabel}`);
    // Save cursor → up to the content line → clear → write → restore.
    process.stdout.write("\x1b[s\x1b[1A\r\x1b[2K" + content + "\x1b[u");
    i++;
  }, interval);
  if (statusTimer.unref) statusTimer.unref();
}

// Final-state lines (not animated): success / failure.
export function statusDone(msg = "done") {
  stopStatus();
  console.log(`  ${c.green("✓")} ${msg}`);
}

// Backward-compatible aliases used throughout the codebase.
export function startThinking() { startStatus("thinking"); }
export function stopThinking() { stopStatus(); }

// Quick visual demo of every state. Run with:  node -e "import('./src/ui.mjs').then(m=>m.demoStatuses())"
export async function demoStatuses() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (const name of ["thinking", "searching", "coding", "reading", "running", "ready"]) {
    startStatus(name);
    await sleep(1400);
  }
  stopStatus();
  let n = 0;
  const feed = setInterval(() => { n += 7; }, 60);
  startGenerationStatus(() => n);
  await sleep(2600);
  clearInterval(feed);
  statusDone(`generated ${n} tokens`);
}

// Clean shutdown. We avoid a hard process.exit() because on Windows that can
// race with handles still closing and trigger a libuv assertion
// (UV_HANDLE_CLOSING in async.c). Instead we clear our own timers, set the exit
// code, and let the event loop drain naturally. A short *unref'd* fallback timer
// forces exit only if something else (e.g. a pooled socket) keeps the loop alive,
// and it won't itself keep an otherwise-idle process running.
export async function shutdown(code = 0) {
  stopStatus();
  process.exitCode = code;
  const fallback = setTimeout(() => process.exit(code), 250);
  if (fallback.unref) fallback.unref();
}

export function errorLine(msg) {
  stopStatus();
  console.log(`  ${c.red("✗")} ${msg}`);
}

export function warnLine(msg) {
  console.log(`  ${c.yellow("⚠")} ${msg}`);
}

export function infoLine(msg) {
  console.log(`  ${c.dim(msg)}`);
}

export function costLine(session) {
  const cost = session.cost;
  if (!cost || cost.totalTokens === 0) {
    infoLine("no token usage recorded");
    return;
  }
  const fmt = (n) => n.toLocaleString();
  infoLine(
    `tokens: ${fmt(cost.totalTokens)} total ` +
    `(prompt: ${fmt(cost.promptTokens)}, completion: ${fmt(cost.completionTokens)})`
  );
}
