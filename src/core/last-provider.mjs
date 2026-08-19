// Persist the user's "last good provider" so a fresh session can reload
// the model they were last successfully using — without making them
// re-pick via /model every launch.
//
// Three write paths feed this file (best-effort; never throws):
//   1. /model <key> command — user explicitly chose, save immediately
//   2. runTurn — at the end of any turn that completes without an error
//   3. Graceful shutdown (SIGINT, beforeExit) — last-chance save
//
// One read path (cli/main.mjs at startup): if a saved modelKey still
// resolves to a configured model in settings.models, use it as the
// default. If the saved model is no longer configured (e.g. the user
// removed the provider, renamed the model, or wiped settings), the
// file is treated as stale and cleared so we don't keep retrying.
//
// The file lives at $HOME/last-provider.json (under agent/ which is
// already gitignored by .gitignore, so this never gets committed).
//
// "Best effort" matters: this code runs in shutdown paths, after the
// tool loop has already returned, etc. — we MUST NOT throw and re-raise
// a fatal that masks the real exit code. Every write is wrapped.

import fs from "node:fs";
import path from "node:path";

// Read HOME dynamically (per call) so tests that change process.env.OMNI_HOME
// between cases still work, and so an `omni --home <path>` style flag (if
// added later) takes effect without re-importing this module.
function filePath() {
  const home = process.env.OMNI_HOME || path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1")), "..", "..", "agent");
  return path.join(home, "last-provider.json");
}

export function getLastProvider() {
  try {
    const raw = fs.readFileSync(filePath(), "utf8");
    const data = JSON.parse(raw);
    if (data && typeof data.modelKey === "string" && data.modelKey) {
      return { modelKey: data.modelKey, savedAt: data.savedAt || null };
    }
  } catch { /* missing or corrupt — first run / never saved */ }
  return null;
}

export function setLastProvider(modelKey, reason = "manual") {
  if (!modelKey || typeof modelKey !== "string") return;
  try {
    const file = filePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ modelKey, savedAt: new Date().toISOString(), reason }, null, 2) + "\n",
      "utf8"
    );
  } catch {
    /* best effort — never throw from a save path */
  }
}

export function clearLastProvider() {
  try { fs.unlinkSync(filePath()); } catch { /* missing is fine */ }
}

// Validate a saved entry against the live settings — returns the modelKey
// if still usable, null otherwise. The caller decides whether to fall back
// to settings.defaultModel or surface an error to the user.
export function resolveLastProvider(settings) {
  const last = getLastProvider();
  if (!last) return null;
  if (settings?.models && Object.prototype.hasOwnProperty.call(settings.models, last.modelKey)) {
    return last.modelKey;
  }
  // Stale — the saved model no longer exists in settings. Clear so we
  // don't keep failing this check on every launch.
  clearLastProvider();
  return null;
}
