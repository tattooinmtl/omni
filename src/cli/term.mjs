// Terminal keyboard ownership.
//
// readline in terminal mode decodes AND echoes keystrokes itself, which only
// works while stdin is in raw mode — createInterface() switches it on for
// exactly that reason and close() switches it back off.
//
// Anything that borrows the keyboard mid-session (the generation interrupt
// watch in repl.mjs, the arrow-key pickers in models.mjs) used to hand it back
// with setRawMode(false), and rl.resume() does NOT undo that: the rest of the
// session then ran in cooked mode, where Node only sees whole lines. No
// per-keystroke "keypress" event means no live "/" command menu, no ↑/↓
// history, no tab completion — and doubled echo, because the terminal and
// readline both draw what you type. So the menu worked at the first prompt and
// was silently dead from the first turn (or the first /model) onward.
//
// Hand the keyboard back the way readline expects to find it instead.
export function restoreLineEditing(rl) {
  const stdin = process.stdin;
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") return;
  // `rl.closed` is true once the REPL has shut down; then raw mode must go
  // back off so the user's shell behaves normally after we exit.
  const alive = Boolean(rl) && rl.closed !== true;
  stdin.setRawMode(alive);
  if (alive) stdin.resume();
}
