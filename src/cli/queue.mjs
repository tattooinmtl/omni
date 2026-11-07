// The prompts waiting behind the running turn, and the editing of them.
//
// Enter while Omi works adds a prompt here; the REPL runs them in order once
// the turn ends. In the prompt box you can walk the list with ↑/↓ (the box
// shows the selected prompt so you can change it), send one right away with
// Enter, or click its ✎ / 🗑 in the footer. Pure: no terminal, no readline.
//
// Items run oldest first (index 0 runs next). ↑ from your draft selects the
// newest one, like shell history; ↓ past the newest gives the draft back.

import { expandPastes } from "./paste.mjs";

export class PromptQueue {
  constructor() {
    this.items = [];        // { text, display, pastes }
    this.editing = null;    // index of the item shown in the box, or null
    this.draft = "";        // what was in the box before ↑ took it over
  }

  get length() { return this.items.length; }

  add(item) {
    this.items.push({ text: String(item.text ?? ""), display: String(item.display ?? item.text ?? ""), pastes: item.pastes || null });
  }

  // Next prompt to run, or null. Nothing leaves while one is being edited,
  // so the order you see is the order they run in.
  next() {
    if (this.editing !== null || !this.items.length) return null;
    return this.items.shift();
  }

  // Start editing item `index`; `line` is the box's current text (kept as the
  // draft). Returns the text to show in the box.
  begin(index, line = "") {
    if (index < 0 || index >= this.items.length) return null;
    if (this.editing === null) this.draft = String(line ?? "");
    else {
      const from = this.editing;
      // An emptied item is dropped; the clicked one slides up if it was after it.
      if (this._save(line) && index > from) index--;
    }
    this.editing = Math.min(index, this.items.length - 1);
    if (this.editing < 0) { this.editing = null; return this.draft; }
    return this.items[this.editing].display;
  }

  // ↑ (-1) / ↓ (+1). Returns the box text afterwards, or null when the key
  // isn't ours (nothing queued and not editing).
  move(dir, line = "") {
    if (this.editing === null) {
      if (dir >= 0 || !this.items.length) return null;
      return this.begin(this.items.length - 1, line);
    }
    const from = this.editing;
    const removed = this._save(line);
    let to = from + (dir < 0 ? -1 : 1);
    if (removed && dir > 0) to = from;         // the next item slid into this slot
    if (to >= this.items.length) return this.stop();
    to = Math.max(0, to);
    if (!this.items.length) return this.stop();
    this.editing = to;
    return this.items[to].display;
  }

  // Leave editing, keeping the change. Returns the draft to put back.
  commit(line = "") {
    if (this.editing !== null) this._save(line);
    return this.stop();
  }

  // Leave editing, dropping the unsaved change to the current item.
  stop() {
    this.editing = null;
    const d = this.draft;
    this.draft = "";
    return d;
  }

  // Remove item `index` (🗑). Returns it, or null.
  remove(index) {
    if (index < 0 || index >= this.items.length) return null;
    const [item] = this.items.splice(index, 1);
    if (this.editing !== null) {
      if (index === this.editing) this.editing = null;
      else if (index < this.editing) this.editing--;
    }
    return item;
  }

  // Take the item being edited out of the queue with the box's text applied
  // (Enter = send it now). Returns { item, draft } or null.
  take(line = "") {
    if (this.editing === null) return null;
    const item = this.items[this.editing];
    this._apply(item, line);
    this.items.splice(this.editing, 1);
    const draft = this.stop();
    return { item, draft };
  }

  // Write the box text into the edited item; an emptied one is removed.
  // Returns true when it was removed.
  _save(line) {
    const item = this.items[this.editing];
    if (!item) return false;
    if (!String(line ?? "").trim()) { this.items.splice(this.editing, 1); return true; }
    this._apply(item, line);
    return false;
  }

  _apply(item, line) {
    const display = String(line ?? "");
    if (display === item.display) return;
    item.display = display;
    item.text = item.pastes ? expandPastes(display, item.pastes) : display;
  }
}

// SGR mouse reports (ESC[<b;x;yM / …m) in a raw stdin chunk. Returns the
// chunk with them removed, the left-button presses found, and `partial`: an
// unfinished report at the end of the chunk, to put in front of the next one.
const MOUSE_RE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
const MOUSE_TAIL_RE = /\x1b(?:\[(?:<[\d;]*)?)?$/;
export function extractMouse(chunk) {
  const clicks = [];
  let s = String(chunk ?? "");
  let partial = "";
  const tail = MOUSE_TAIL_RE.exec(s);
  // Only hold back what is clearly a report under way ("ESC[<…"); a lone
  // Esc or "ESC[" is a key, and those go through untouched.
  if (tail && tail[0].startsWith("\x1b[<")) { partial = tail[0]; s = s.slice(0, tail.index); }
  const rest = s.replace(MOUSE_RE, (_m, b, x, y, kind) => {
    const btn = Number(b);
    // Left button press only: no motion (32), no wheel (64+), no release.
    if (kind === "M" && (btn & 3) === 0 && !(btn & 32) && btn < 64) clicks.push({ x: Number(x), y: Number(y) });
    return "";
  });
  return { rest, clicks, partial };
}

export const MOUSE_ON = "\x1b[?1000h\x1b[?1006h";
export const MOUSE_OFF = "\x1b[?1000l\x1b[?1006l";
