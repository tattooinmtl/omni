// Paste handling for the interactive prompt.
//
// readline treats every "\r"/"\n" it reads as Enter, so feeding it pasted text
// as-is submits the paste line by line — the "my paste got sent before I was
// done typing" bug. It also can't help us detect a paste: emitKeypressEvents
// decodes the bracketed-paste markers (ESC[200~ / ESC[201~) into keys named
// "paste-start"/"paste-end" and readline drops them, so they never show up in
// a submitted line.
//
// So paste is recognised here, on the RAW stdin chunks, before readline sees
// anything. A recognised paste is never forwarded with its newlines: a one-line
// paste is inserted as plain text, a multi-line one as a short chip
// ("[Pasted text #1 +14 lines]") whose full text is swapped back in on submit.
// Only a real Enter keypress ever submits.

export const PASTE_START = "\x1b[200~";
export const PASTE_END = "\x1b[201~";

// A large unbracketed paste can arrive split over several stdin chunks; ones
// landing this close together belong to the same paste.
export const PASTE_CONTINUE_MS = 30;

// A single chunk this long with no control characters is a paste too — typing
// delivers a key or two per chunk, never dozens.
export const LONG_CHUNK = 32;

const CHIP_RE = /\[Pasted text #(\d+) \+\d+ lines\]/g;

// Heuristic for terminals without bracketed paste: printable text and a
// newline in the same chunk can't come from a person typing.
export function looksLikePaste(chunk) {
  const s = String(chunk || "");
  if (!s || s.includes("\x1b")) return false; // arrows, function keys, …
  const printable = s.replace(/[\x00-\x1f\x7f]/g, "");
  if (!printable) return false;
  if (/[\r\n]/.test(s)) return true;
  return printable.length >= LONG_CHUNK && printable.length === s.length;
}

// Normalise pasted text: CRLF/CR → LF, drop control characters other than
// newline and tab, and trim trailing blank lines (copying a line from a
// terminal usually brings its line break along).
export function normalizePaste(text) {
  return String(text || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
    .replace(/\n+$/, "");
}

// What to put on the prompt line for a paste. `inline` never contains a
// newline or a tab (tab would trigger completion); `stored` is the full text
// behind a chip, or null when the paste fits on one line.
export function pasteInsertion(text, id) {
  const norm = normalizePaste(text);
  if (!norm.includes("\n")) return { inline: norm.replace(/\t/g, "    "), stored: null };
  const lines = norm.split("\n").length;
  return { inline: `[Pasted text #${id} +${lines} lines]`, stored: norm };
}

// Swap chips back for the text they stand for. Unknown ids are left alone.
export function expandPastes(line, store) {
  return String(line || "").replace(CHIP_RE, (m, id) => {
    const v = store?.get(Number(id));
    return v == null ? m : v;
  });
}

// Longest suffix of `s` that is a proper prefix of `marker` — a marker split
// across two chunks. Only 3+ chars are held back so a lone Esc keypress is
// never delayed.
function heldPrefix(s, marker) {
  for (let n = Math.min(marker.length - 1, s.length); n >= 3; n--) {
    if (marker.startsWith(s.slice(-n))) return n;
  }
  return 0;
}

// Splits raw stdin text into "typed" data (forwarded to readline untouched)
// and whole pastes. Timers are injectable so tests can drive it synchronously.
export class PasteFilter {
  constructor({
    onData,
    onPaste,
    continueMs = PASTE_CONTINUE_MS,
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (t) => clearTimeout(t),
  } = {}) {
    this.onData = onData || (() => {});
    this.onPaste = onPaste || (() => {});
    this.continueMs = continueMs;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.bracketed = false;   // inside ESC[200~ … ESC[201~
    this.buf = "";            // bracketed paste body so far
    this.pending = null;      // unbracketed paste still collecting chunks
    this.partial = "";        // a marker split across chunks
    this.timer = null;
  }

  push(chunk) {
    let s = this.partial + String(chunk || "");
    this.partial = "";
    this._cancelTimer();
    while (s) {
      if (this.bracketed) {
        const end = s.indexOf(PASTE_END);
        if (end < 0) {
          const hold = heldPrefix(s, PASTE_END);
          this.buf += s.slice(0, s.length - hold);
          this.partial = s.slice(s.length - hold);
          return;
        }
        this.buf += s.slice(0, end);
        this.bracketed = false;
        const text = this.buf;
        this.buf = "";
        this.onPaste(text);
        s = s.slice(end + PASTE_END.length);
        continue;
      }
      const start = s.indexOf(PASTE_START);
      if (start >= 0) {
        this._typed(s.slice(0, start));
        this.flush();                 // an unbracketed paste can't continue past a real one
        this.bracketed = true;
        s = s.slice(start + PASTE_START.length);
        continue;
      }
      const hold = heldPrefix(s, PASTE_START);
      this._typed(s.slice(0, s.length - hold));
      if (hold) {
        this.partial = s.slice(s.length - hold);
        this._armTimer();             // release it if nothing follows
      }
      return;
    }
    if (this.pending !== null) this._armTimer();
  }

  // Emit whatever unbracketed paste / held marker is buffered right now.
  flush() {
    this._cancelTimer();
    if (this.pending !== null) {
      const text = this.pending;
      this.pending = null;
      this.onPaste(text);
    }
    if (this.partial && !this.bracketed) {
      const p = this.partial;
      this.partial = "";
      this.onData(p);
    }
  }

  _typed(s) {
    if (!s) return;
    if (this.pending !== null) { this.pending += s; this._armTimer(); return; }
    if (looksLikePaste(s)) { this.pending = s; this._armTimer(); return; }
    this.onData(s);
  }

  _armTimer() {
    this._cancelTimer();
    this.timer = this.setTimer(() => { this.timer = null; this.flush(); }, this.continueMs);
  }

  _cancelTimer() {
    if (this.timer) { this.clearTimer(this.timer); this.timer = null; }
  }
}
