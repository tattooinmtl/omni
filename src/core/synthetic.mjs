// Where a user-role message came from: typed by the user, or written by Omni.
//
// Omni writes user-role messages of its own: /btw wrappers, iteration and
// hook nudges, image labels, compaction digests, goal continuations, skill
// invocations, the learned-skill request, and prompts a UserPromptSubmit hook
// added context to. Memory extraction (memory-provider.mjs) must keep only
// the user's own words, so every message says which it is.
//
// The mark lives here, off the message, because providers receive message
// objects as they are and a strict one refuses fields it doesn't know. The
// session log carries the same mark (recordFor), and restoring a session
// puts it back (markFromRecord), so a resumed conversation knows too. Only a
// log written before the marks existed leaves a message unmarked.
//
// A leaf module: no imports, so anything can use it without a cycle.

const notes = new WeakMap();

// Mark `msg` as written by Omni. `userText` is the part that is the user's
// own words (a /btw note, a skill's arguments, a prompt before a hook's
// additions); "" when none of it is.
export function markSynthetic(msg, { userText = "" } = {}) {
  if (msg && typeof msg === "object") notes.set(msg, { kind: "omni", userText: String(userText || "") });
  return msg;
}

// Mark `msg` as typed by the user, word for word.
export function markTyped(msg) {
  if (msg && typeof msg === "object") notes.set(msg, { kind: "typed" });
  return msg;
}

// A user message written by Omni.
export function syntheticUser(content, opts = {}) {
  return markSynthetic({ role: "user", content }, opts);
}

// The message for a typed prompt. When a UserPromptSubmit hook added context,
// `content` differs from what was typed: the message is then Omni's, with the
// typed part as the user's words.
export function promptMessage(typed, content) {
  const msg = { role: "user", content };
  return content === typed ? markTyped(msg) : markSynthetic(msg, { userText: typed });
}

// { userText } for a message Omni wrote, or null.
export function syntheticInfo(msg) {
  const n = msg && typeof msg === "object" ? notes.get(msg) : null;
  return n?.kind === "omni" ? { userText: n.userText } : null;
}

// True for a message the user typed.
export function isTyped(msg) {
  return Boolean(msg && typeof msg === "object" && notes.get(msg)?.kind === "typed");
}

// The session record for a user message, carrying its mark.
export function recordFor(msg) {
  const n = notes.get(msg);
  const mark = n?.kind === "omni" ? { synthetic: true, ...(n.userText ? { userText: n.userText } : {}) }
    : n?.kind === "typed" ? { typed: true }
    : {};
  return { type: "user", content: msg.content, ...mark };
}

// Put a record's mark back on the message rebuilt from it.
export function markFromRecord(msg, rec) {
  if (rec?.synthetic) return markSynthetic(msg, { userText: rec.userText });
  if (rec?.typed) return markTyped(msg);
  return msg;
}
