// The pinned bottom area of the interactive REPL: Omi's activity line, the
// framed input box, the status bar, and (while typing "/…") the command menu.
//
//   (•‿•)⌨  Omi: Percolising…  ███▌ 312 tokens (41.2 tok/s)   ◷ 7.6s
//   ╭─────────────────────────────────────────────────────── 1 queued ─╮
//   │ › also check the tests folder [Pasted text #1 +14 lines]         │
//   ╰──────────────────────────────────────────────────────────────────╯
//   ctx 12.4k/200k (6%)                       (anthropic) claude-sonnet-5
//
// It stays on screen while the agent works. Everything else the program prints
// scrolls ABOVE it: a DECSTBM scroll region covers the top of the screen, so
// the existing console.log / stream writers need no changes at all. The footer
// is drawn with save-cursor → absolute moves → restore-cursor, so the output
// cursor never moves.
//
// Rows are at most columns-1 wide: Windows consoles wrap eagerly at the last
// column (see formatMenuRows in repl.mjs), which would make each row eat two.

import { c } from "../ui.mjs";

export const BOX_MAX_ROWS = 8;
// Queued prompts listed above the box at once (the rest scroll with ↑/↓).
export const QUEUE_MAX_ROWS = 5;

export const ICON_EDIT = "✎";
export const ICON_DELETE = "🗑";

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;

export function stripAnsi(s) {
  return String(s ?? "").replace(ANSI_RE, "");
}

export function visibleLength(s) {
  return Array.from(stripAnsi(s)).length;
}

// Cut an (optionally colored) string down to `max` visible characters.
export function fitVisible(s, max) {
  if (visibleLength(s) <= max) return String(s ?? "");
  return Array.from(stripAnsi(s)).slice(0, Math.max(0, max - 1)).join("") + "…";
}

// The queued-prompt rows: a hint line, then one row per prompt ending in
// ✎ and 🗑. `hits` says where those are (0-based row in the returned lines,
// 1-based screen columns) so a mouse click can be matched to them.
//
// Rows are kept two columns short of `width`: 🗑 draws two columns wide in
// most terminals but counts as one here, and the last column must stay free
// (see the eager-wrap note above).
export function formatQueueRows(items = [], { width = 79, selected = -1, max = QUEUE_MAX_ROWS } = {}) {
  if (!items.length) return { lines: [], hits: [] };
  const budget = Math.max(20, width - 1);
  const textWidth = budget - 7;              // then "  ✎  🗑"
  let start = 0;
  if (items.length > max) {
    const focus = selected >= 0 ? selected : items.length - 1;
    start = Math.min(Math.max(0, focus - Math.floor(max / 2)), items.length - max);
  }
  const shown = items.slice(start, start + max);
  const more = items.length > max ? ` · ${start + 1}-${start + shown.length} of ${items.length}` : "";
  const hint = selected >= 0
    ? `  editing #${selected + 1} · enter sends it now · ↑/↓ next · esc stops editing${more}`
    : `  ${items.length} queued · ↑ to edit · click ${ICON_EDIT} edit · ${ICON_DELETE} delete${more}`;
  const lines = [c.dim(fitVisible(hint, budget))];
  const hits = [];
  shown.forEach((raw, k) => {
    const index = start + k;
    const one = String(raw ?? "").replace(/\s*\n\s*/g, " ⏎ ");
    const isSel = index === selected;
    const label = `${isSel ? "›" : " "} ${index + 1}. ${one}`;
    const cut = fitVisible(" " + label, textWidth);
    const pad = " ".repeat(Math.max(0, textWidth - visibleLength(cut)));
    const left = isSel ? c.bold(c.cyan(cut)) : cut;
    lines.push(left + pad + "  " + c.cyan(ICON_EDIT) + "  " + c.red(ICON_DELETE));
    const pencil = textWidth + 3;            // 1-based column of ✎
    const trash = pencil + 3;                // and of 🗑 (two columns wide)
    hits.push({ row: lines.length - 1, index, text: [1, textWidth], edit: [pencil - 1, pencil + 1], delete: [trash - 1, trash + 2] });
  });
  return { lines, hits };
}

// Pure: every row of the footer plus nothing else. The controller below only
// decides where on screen these go.
export function layoutFooter({
  cols = 80,
  activity = "",
  prompt = "› ",
  line = "",
  cursor = 0,
  statusText = "",
  menuLines = [],
  note = "",
  highlight = 0,                         // leading chars of `line` to draw blue (a recognised /command)
  maxRows = BOX_MAX_ROWS,
  queue = [],                            // queued prompts (display text), oldest first
  queueSelected = -1,                    // the one being edited, or -1
} = {}) {
  const width = Math.max(20, cols - 1);
  const inner = width - 4;               // "│ " + text + " │"

  const promptChars = Array.from(stripAnsi(prompt));
  const lineChars = Array.from(String(line));
  const chars = [...promptChars, ...lineChars];
  const caret = promptChars.length + Array.from(String(line).slice(0, Math.max(0, cursor))).length;

  // Hard-wrap into rows of `inner` characters; make room for a caret sitting
  // just past a full last row.
  const rows = [];
  for (let i = 0; i < chars.length; i += inner) rows.push(chars.slice(i, i + inner));
  if (!rows.length || caret >= rows.length * inner) rows.push([]);
  const caretRow = Math.floor(caret / inner);
  const caretCol = caret % inner;

  // Show the rows around the caret when the input outgrows the box.
  let first = 0;
  if (rows.length > maxRows) first = Math.min(Math.max(0, caretRow - maxRows + 1), rows.length - maxRows);
  const shown = rows.slice(first, first + maxRows);

  const bodyRows = shown.map((rowChars, k) => {
    const r = first + k;
    let text = "";
    for (let j = 0; j < inner; j++) {
      const idx = r * inner + j;
      const ch = rowChars[j] ?? " ";
      const isCaret = r === caretRow && j === caretCol;
      if (isCaret) text += `\x1b[7m${ch}\x1b[27m`;
      else if (idx < promptChars.length) text += c.cyan(ch);
      else if (idx < promptChars.length + highlight) text += c.blue(c.bold(ch));
      else text += ch;
    }
    return c.gray("│") + " " + text + " " + c.gray("│");
  });

  const noteText = note ? ` ${stripAnsi(note)} ` : "";
  const dashes = Math.max(0, width - 2 - noteText.length - (noteText ? 1 : 0));
  const top = c.gray("╭" + "─".repeat(dashes)) + (noteText ? c.yellow(noteText) + c.gray("─") : "") + c.gray("╮");
  const bottom = c.gray("╰" + "─".repeat(width - 2) + "╯");

  const q = formatQueueRows(queue, { width, selected: queueSelected });
  const lines = [
    fitVisible(activity, width),
    ...q.lines,
    top,
    ...bodyRows,
    bottom,
    fitVisible(statusText, width),
    ...menuLines.map((l) => fitVisible(l, width)),
  ];
  // q.lines sit right under the activity line.
  const hits = q.hits.map((h) => ({ ...h, row: h.row + 1 }));
  return { lines, caretRow: caretRow - first, caretCol, hits };
}

// Which queued prompt a click at screen column x, footer row `row` (0-based
// from the footer's first line) landed on: { index, action } or null.
export function hitQueue(hits = [], row, x) {
  const h = hits.find((t) => t.row === row);
  if (!h) return null;
  const inside = ([a, b]) => x >= a && x <= b;
  if (inside(h.delete)) return { index: h.index, action: "delete" };
  if (inside(h.edit) || inside(h.text)) return { index: h.index, action: "edit" };
  return null;
}

// Screen controller. `getState()` returns layoutFooter's input minus `cols`.
export function createFooter({ out = process.stdout, getState } = {}) {
  let height = 0;        // rows currently reserved at the bottom (0 = none)
  let active = false;    // reserved + drawn
  let disabled = false;
  let hits = [];         // queue click targets from the last render

  const rowsTotal = () => out.rows || 24;
  const write = (s) => { if (s) out.write(s); };

  // Change the reserved area to `newH` rows, keeping the output cursor where
  // it is relative to the text above.
  function reserve(newH) {
    const H = rowsTotal();
    if (newH === height) return;
    if (height === 0) {
      // Scroll the screen up enough to free the bottom rows, then fence them off.
      write("\n".repeat(newH) + `\x1b[${newH}A` + "\x1b7" + `\x1b[1;${H - newH}r` + "\x1b8");
    } else if (newH > height) {
      // Push the scroll region's content up by d rows to make space.
      const d = newH - height;
      write(
        "\x1b7" + `\x1b[${H - height};1H` + "\n".repeat(d) + "\x1b8" + `\x1b[${d}A` +
        "\x1b7" + `\x1b[1;${H - newH}r` + "\x1b8"
      );
    } else {
      // Give rows back to the region; wipe the old footer rows first.
      let s = "\x1b7";
      for (let r = H - height + 1; r <= H - newH; r++) s += `\x1b[${r};1H\x1b[2K`;
      s += `\x1b[1;${H - newH}r` + "\x1b8";
      write(s);
    }
    height = newH;
  }

  function render() {
    if (disabled) return;
    const H = rowsTotal();
    const st = getState ? getState() : {};
    const laid = layoutFooter({ ...st, cols: out.columns || 80 });
    // Never take more than the screen minus a few rows of output.
    const lines = laid.lines.slice(0, Math.max(5, H - 3));
    hits = laid.hits.filter((h) => h.row < lines.length);
    reserve(lines.length);
    active = true;
    const top = H - height + 1;
    let s = "\x1b7\x1b[?25l";
    for (let i = 0; i < lines.length; i++) s += `\x1b[${top + i};1H\x1b[2K` + lines[i];
    s += "\x1b8";
    write(s);
  }

  // Remove the footer and the scroll region (pickers, exit). Output keeps its place.
  function suspend() {
    if (!active && height === 0) return;
    const H = rowsTotal();
    let s = "\x1b7";
    for (let r = H - height + 1; r <= H; r++) s += `\x1b[${r};1H\x1b[2K`;
    s += "\x1b[r\x1b8\x1b[?25h";
    write(s);
    height = 0;
    active = false;
    hits = [];
  }

  function resume() {
    if (disabled) return;
    render();
  }

  function onResize() {
    if (disabled || !active) return;
    // Positions are unreliable after a reflow: drop the region and set it up
    // fresh from wherever the cursor landed.
    write("\x1b7\x1b[r\x1b8\x1b[J");
    height = 0;
    render();
  }

  function disable() {
    suspend();
    disabled = true;
  }

  // A click at 1-based screen (x, y) on a queued prompt's row.
  function hitTest(x, y) {
    if (!active) return null;
    return hitQueue(hits, y - (rowsTotal() - height + 1), x);
  }

  return {
    render, suspend, resume, onResize, disable, hitTest,
    get active() { return active; },
    get height() { return height; },
  };
}
