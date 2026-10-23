// Small shared CLI utilities — no state, no side effects beyond printing.

import { infoLine, warnLine } from "../ui.mjs";
import { providerKeyMissing, providerKeyEnvVars, SETTINGS_PATH, Session } from "../core/config.mjs";
import { rankChunks } from "../core/bm25.mjs";
import { effectiveRecords } from "../core/session-export.mjs";
import { recordSkillUse } from "../core/skill-learn.mjs";

// Split a SKILL.md body into heading-anchored chunks so lean mode can BM25-rank
// them against the user's current request. A chunk starts at every top-level
// markdown heading (^#{1,6} ). The preface text before the first heading (if
// any) becomes chunk 0 so nothing is lost. Small, dependency-free — the
// intent is to keep only the most relevant sections in the sticky system
// message instead of the full body on every turn.
function chunkSkillBody(body) {
  const lines = String(body || "").split(/\r?\n/);
  const chunks = [];
  let cur = [];
  for (const line of lines) {
    if (/^#{1,6}\s/.test(line) && cur.length) {
      chunks.push(cur.join("\n"));
      cur = [];
    }
    cur.push(line);
  }
  if (cur.length) chunks.push(cur.join("\n"));
  return chunks.filter((c) => c.trim().length);
}

// Sticky store of full skill bodies so `/expand-skill <name>` can restore
// them on demand without re-reading disk. Keyed by lowercased skill name.
const fullSkillBodies = new Map();
export function rememberSkillBody(skill) {
  if (!skill?.name) return;
  fullSkillBodies.set(String(skill.name).toLowerCase(), skill.body || "");
}
export function getFullSkillBody(name) {
  return fullSkillBodies.get(String(name || "").toLowerCase()) || null;
}

// Mask a secret for display: nvapi-1…WxYz
export function maskKey(k) {
  if (!k) return "(none)";
  if (k.length <= 10) return "****";
  return k.slice(0, 6) + "…" + k.slice(-4);
}

export function normalizeProviderKey(name) {
  return String(name || "").trim().toLowerCase();
}

export function modelKeyFor(providerName, id) {
  const safe = String(id).replace(/^models\//, "").replace(/[^a-zA-Z0-9._:-]+/g, "-");
  return `${providerName}/${safe}`;
}

export function trimHealthMessage(message) {
  return String(message || "").replace(/\s+/g, " ").trim().slice(0, 240);
}

// Tracks skill-body system messages that were pushed for the CURRENT turn.
// After runAgentTurns finishes, the REPL calls evictEphemeralSkillMessages()
// to remove them so the body isn't re-billed on every subsequent turn (the
// old behavior: a 26KB skill body × 30 tool iterations = 780K tokens billed
// for one /invoke). Uses a WeakSet so a message dropped from ctx.messages
// gets garbage-collected without extra bookkeeping.
const ephemeralSkillMessages = new WeakSet();

export function markEphemeralSkill(message) {
  if (message && typeof message === "object") ephemeralSkillMessages.add(message);
}

export function isEphemeralSkill(message) {
  return ephemeralSkillMessages.has(message);
}

// Called by the REPL after each user-initiated turn completes. Filters
// ctx.messages in place, removing any skill-body system messages that were
// marked ephemeral. Returns the count removed (0 when nothing to do).
export function evictEphemeralSkillMessages(messages) {
  if (!Array.isArray(messages)) return 0;
  let removed = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isEphemeralSkill(messages[i])) {
      messages.splice(i, 1);
      removed++;
    }
  }
  return removed;
}

// Inject a skill's instructions as a system message, then queue the user's args.
//
// The pushed system message is marked ephemeral: it lives for the turn(s)
// the skill triggers, then the REPL evicts it once the model returns a plain-
// text answer. This keeps a single-invoke skill from re-billing its 10–26KB
// body on every subsequent turn of the session.
//
// contextMode "classic" (default): push the full skill.body for THIS turn.
// contextMode "lean" (opt-in): chunk the body by markdown heading, BM25-rank
// the chunks against the most recent user message (the `arg` if present, or
// the last user message on the stack), keep the top ~3 chunks / ~1500 chars,
// and stash the full body so `/expand-skill <name>` can restore it.
// The user turn that accompanies a /<skill>. It says the instructions are
// already in context: "Run the rust-coding skill" used to send models off to
// invoke_skill("/rust-coding"), which failed because the command is /rust.
// With no arguments there is no task yet, so ask for one rather than leaving
// the model to guess (often a near-empty reply that looked like nothing ran).
export function skillInvocationPrompt(skill, arg) {
  const loaded = `The user typed ${skill.command} — the "${skill.name}" skill's instructions are already loaded above; do not call invoke_skill for it.`;
  return arg
    ? `${loaded} Follow them for this task: ${arg}`
    : `${loaded} No task was given with it, so reply briefly: say in a sentence or two what this skill helps with, then ask what the user wants to do with it.`;
}

export async function applySkill(skill, arg, msgs, sess, opts = {}) {
  rememberSkillBody(skill);
  if (skill.learned) { try { recordSkillUse(skill.name); } catch { /* usage is advisory */ } }
  const contextMode = opts.contextMode || "classic";
  let systemContent;
  if (contextMode === "lean" && skill.body && skill.body.length > 800) {
    const chunks = chunkSkillBody(skill.body);
    // Rank against the arg first, then fall back to whatever the latest
    // user turn was — an "invoke with no args" call still deserves the
    // most relevant sections, ranked against the standing conversation.
    let queryText = String(arg || "").trim();
    if (!queryText) {
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === "user" && typeof msgs[i].content === "string") {
          queryText = msgs[i].content;
          break;
        }
      }
    }
    const ranked = rankChunks(queryText, chunks);
    // Keep top 3 chunks OR the first 1500 chars, whichever hits first.
    const kept = [];
    let bytes = 0;
    for (const r of ranked) {
      if (kept.length >= 3 || bytes >= 1500) break;
      kept.push(r.text);
      bytes += r.text.length + 2;
    }
    // Preserve chunk order (roughly by original position) so the resulting
    // fragment reads coherently, not shuffled by score.
    kept.sort((a, b) => chunks.indexOf(a) - chunks.indexOf(b));
    systemContent =
      `# Skill: ${skill.name} (lean-distilled ${kept.length}/${chunks.length} sections)\n` +
      kept.join("\n\n") +
      `\n\n[Full skill available — reply "/expand-skill ${skill.name}" to load it in full.]`;
  } else {
    systemContent = `# Skill: ${skill.name}\n${skill.body}`;
  }
  const skillMsg = { role: "system", content: systemContent };
  markEphemeralSkill(skillMsg);
  msgs.push(skillMsg);
  const userMsg = skillInvocationPrompt(skill, arg);
  msgs.push({ role: "user", content: userMsg });
  await sess.append({ type: "skill", skill: skill.name, arg, contextMode });
}

// Rebuild the in-memory message list from a saved session's records.
// "skill" records are replayed as the equivalent user invocation message
// ("Run the X skill…") — the full body is intentionally NOT re-injected on
// resume (it was ephemeral in the original session and would defeat the
// purpose to reload 26KB per resume). The prior conversation carries what
// the skill actually produced; the invocation line preserves intent.
// /rewind cuts recorded in the log are applied first (effectiveRecords).
export function restoreSessionMessages(records, msgs) {
  for (const rec of effectiveRecords(records)) {
    if (rec.type === "user") {
      msgs.push({ role: "user", content: rec.content });
    } else if (rec.type === "assistant" && rec.message) {
      msgs.push(rec.message);
    } else if (rec.type === "tool" && rec.tool_call_id) {
      msgs.push({
        role: "tool",
        tool_call_id: rec.tool_call_id,
        content: typeof rec.result === "string" ? rec.result : JSON.stringify(rec.result),
      });
    } else if (rec.type === "skill" && rec.skill) {
      const invocation = rec.arg
        ? `Run the "${rec.skill}" skill. Arguments: ${rec.arg}`
        : `Run the "${rec.skill}" skill.`;
      msgs.push({ role: "user", content: `[resumed] ${invocation}` });
    }
  }
}

// Replace the live conversation with a saved one. The saved records are also
// copied into the session that is running now, so resuming this session
// later brings the whole history back, not just what came after the resume.
// Returns the number of messages restored.
export async function resumeSessionInto(ctx, file) {
  const saved = Session.load(file);
  if (!saved) throw new Error(`could not read ${file}`);
  ctx.messages.length = ctx.messages[0]?.role === "system" ? 1 : 0;
  restoreSessionMessages(saved.records, ctx.messages);
  await copyConversation(saved.records, ctx.session, { type: "resumed_from", file });
  ctx.session.setContextTokens?.(0);
  return ctx.messages.length - (ctx.messages[0]?.role === "system" ? 1 : 0);
}

// Make `session`'s log replay as exactly the conversation in `records`:
// a rewind to zero clears whatever the log held before, then the messages
// still in effect are copied in.
export async function copyConversation(records, session, marker) {
  await session.append({ type: "rewind", keep: 0 });
  if (marker) await session.append(marker);
  for (const rec of effectiveRecords(records)) {
    const { eventId, schemaVersion, ...rest } = rec;
    await session.append(rest);
  }
}

// Print setup guidance when the active model's provider has no API key.
// Returns true if a key is missing.
export function reportMissingKey(model) {
  if (!providerKeyMissing(model)) return false;
  const prov = model.providerName;
  warnLine(`No API key configured for provider "${prov}".`);
  infoLine("Set one of:");
  infoLine(`  • in the REPL:   /apikey ${prov} <your-key>`);
  const [canonicalEnv, ...aliasEnv] = providerKeyEnvVars(prov);
  infoLine(
    `  • env variable:  ${canonicalEnv}=<your-key>` +
      (aliasEnv.length ? ` (or ${aliasEnv.join(", ")})` : ""),
  );
  infoLine(`  • edit:          ${SETTINGS_PATH}`);
  if (prov === "nvidia") infoLine("Get a free NVIDIA NIM key at https://build.nvidia.com");
  return true;
}

// Plaintext http:// to a non-loopback host means the request AND the model's
// response travel unencrypted — an on-path attacker can't just read prompts,
// they can rewrite the response, which directly drives tool execution. Doesn't
// block the provider (some setups genuinely run this way), just makes the risk
// visible instead of silent.
export function reportInsecureEndpoint(model) {
  let url;
  try {
    url = new URL(model.provider.baseUrl);
  } catch {
    return false;
  }
  const isLoopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "http:" || isLoopback) return false;
  warnLine(`Provider "${model.providerName}" uses plaintext http:// to ${url.hostname} — requests and model responses are unencrypted and can be tampered with in transit.`);
  return true;
}

// Parse "100k" / "1.5m" / "250000" into a token count (null if unparseable).
export function parseTokenBudget(text) {
  const m = String(text || "").trim().match(/^(\d+(?:\.\d+)?)([km])?$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const mult = m[2] ? (m[2].toLowerCase() === "k" ? 1e3 : 1e6) : 1;
  return Math.round(n * mult);
}
