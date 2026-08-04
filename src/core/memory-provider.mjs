// Memory provider interface — NewPlanConversion.md, Phases 1-4.
//
// Phase 1: a MemoryProvider boundary with two implementations selected by a
//   config flag (settings.memory.provider), so the new layered system can be
//   rolled back to the original flat behavior at any time.
//     - legacy-jsonl : the original flat <HOME>/memory.jsonl store (same file
//                       src/tools/index.mjs's memory_save/search/list/forget
//                       already use). Unchanged behavior — this IS the
//                       rollback path.
//     - layered-okf  : L1 "atoms" (preference/fact/constraint/decision/…)
//                       with provenance, a confidence WEIGHT, and a lifecycle.
//
// Phase 2 (L0 immutable evidence — stable event ids + redaction) lives in
//   core/config.mjs's Session.append(), not here; atoms just cite session
//   file + event id as their `sources`.
//
// Phase 3: async L1 extraction. extractAtomsFromMessages() is a dependency-
//   free heuristic extractor (cue-phrase matching, no model call). There is
//   NO manual review gate: every atom — extracted or manually saved — is
//   weighted (confidence) and placed straight into the index as "active".
//   The indexer decides where it goes purely from that weight, never from a
//   human approval step.
//
// Phase 4: contradiction + lifecycle handling. The atom store
//   (<HOME>/memory-atoms.jsonl) is APPEND-ONLY — an atom is never rewritten
//   in place. Its "current" state is the last event on disk with that id, so
//   the full history stays inspectable via explainAtom(). When a new atom's
//   weight is >= an existing atom it contradicts, the old one is
//   auto-superseded (a new event is appended for the OLD id — it is never
//   mutated or deleted). When the new atom is weaker, both stay active and
//   ranking (by weight, then recency) is what surfaces the stronger one.

import fs from "node:fs";
import path from "node:path";
import { HOME, SETTINGS_PATH } from "./config.mjs";
import { publishActivity } from "../local/activity-bus.mjs";

export const ATOM_TYPES = [
  "preference", "fact", "constraint", "decision", "event",
  "correction", "project_state", "successful_technique", "failed_technique",
];

export const STATUSES = ["active", "superseded", "deprecated"];
export const EXTRACTOR_VERSION = "heuristic-v1";

function atomsFile() {
  return path.join(HOME, "memory-atoms.jsonl");
}

function legacyMemoryFile() {
  return path.join(HOME, "memory.jsonl");
}

function readJsonl(file) {
  try {
    return fs.readFileSync(file, "utf8")
      .split(/\r?\n/).filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function appendJsonl(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(record) + "\n");
  return record;
}

function newId(prefix) {
  return prefix + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
}

function tokenSet(text) {
  return new Set(String(text || "").toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1));
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

// ---------------------------------------------------------------------------
// Atom store — append-only event log, collapsed to "current state" on read.
// ---------------------------------------------------------------------------

function readAtomEvents() {
  return readJsonl(atomsFile());
}

// Every event in insertion order, grouped by id — used by explainAtom() to
// show the full lifecycle.
function historyFor(id) {
  return readAtomEvents().filter((e) => e.id === id);
}

// Current state: last event per id wins. Nothing is ever deleted or edited —
// "current" is just "most recent".
export function currentAtoms() {
  const byId = new Map();
  for (const ev of readAtomEvents()) if (ev.id) byId.set(ev.id, ev);
  return [...byId.values()];
}

// Ranking used everywhere atoms are listed/retrieved: heavier weight first,
// most-recent as the tiebreaker. This IS the "indexer weighs them to see
// where they go" behavior — there's no separate approval step to sort by.
function byWeightThenRecency(a, b) {
  const dw = (b.confidence ?? 0) - (a.confidence ?? 0);
  if (dw) return dw;
  return String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt));
}

export function activeAtoms({ limit = 10 } = {}) {
  return currentAtoms()
    .filter((a) => a.status === "active")
    .sort(byWeightThenRecency)
    .slice(0, limit);
}

// ---- Phase 4: contradiction detection --------------------------------------
// Heuristic: same atom type, enough shared subject (tags or topic words), but
// not saying near-enough the same thing => plausibly a conflicting claim.
export function findContradictions(candidate, pool = currentAtoms()) {
  const cText = tokenSet(candidate.text);
  const cTags = new Set((candidate.tags || []).map((t) => String(t).toLowerCase()));
  return pool.filter((a) => {
    if (a.id === candidate.id) return false;
    if (a.type !== candidate.type) return false;
    if (a.status !== "active") return false;
    const aTags = new Set((a.tags || []).map((t) => String(t).toLowerCase()));
    const tagOverlap = jaccard(cTags, aTags);
    const textSim = jaccard(cText, tokenSet(a.text));
    return (tagOverlap >= 0.34 || textSim >= 0.25) && textSim < 0.8;
  });
}

function supersede(oldId, newId, reason) {
  const cur = currentAtoms().find((a) => a.id === oldId);
  if (!cur || cur.status === "superseded" || cur.status === "deprecated") return null;
  const rec = appendJsonl(atomsFile(), {
    ...cur,
    status: "superseded",
    supersededBy: newId,
    supersedeReason: reason,
    updatedAt: new Date().toISOString(),
  });
  publishActivity({ kind: "memory_atom", action: "superseded", id: oldId, by: newId, atomType: rec.type, text: rec.text.slice(0, 100) });
  return rec;
}

// ---------------------------------------------------------------------------
// layered-okf provider
// ---------------------------------------------------------------------------

export const layeredProvider = {
  name: "layered-okf",

  // Generic capture — used by the extractor for a raw observation it isn't
  // confident enough to type more specifically; always lands as "event".
  capture(event) {
    return this.propose({
      type: "event",
      text: String(event.text || event.summary || "").trim(),
      tags: event.tags || [],
      confidence: event.confidence ?? 0.4,
      sources: event.sources || [],
    });
  },

  // Weighs and places an atom — no review step. `confidence` is the weight
  // the indexer uses to decide what wins on conflict and what ranks first;
  // callers set it (a direct memory_save is more confident than a heuristic
  // cue-phrase match). Every atom lands "active" immediately.
  propose({ type, text, tags = [], confidence = 0.5, sources = [], scope = {} }) {
    text = String(text || "").trim();
    if (!text) throw new Error("text is required");
    if (!ATOM_TYPES.includes(type)) throw new Error(`type must be one of: ${ATOM_TYPES.join(", ")}`);
    const now = new Date().toISOString();
    const weight = Math.max(0, Math.min(1, Number(confidence) || 0));
    const atom = {
      id: newId("a"),
      type,
      text,
      tags: [...new Set(tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean))],
      confidence: weight,
      sources,
      scope,
      status: "active",
      contradicts: [],
      supersedes: [],
      extractorVersion: EXTRACTOR_VERSION,
      createdAt: now,
      observedAt: now,
      updatedAt: now,
    };
    const conflicts = findContradictions(atom);
    if (conflicts.length) {
      atom.contradicts = conflicts.map((c) => c.id);
      // Heavier-or-equal weight wins and supersedes the older claim; a
      // lighter new atom stays active too (both are on record) but ranks
      // below the stronger one — no human has to referee this.
      const outweighed = conflicts.filter((c) => weight >= (c.confidence ?? 0));
      if (outweighed.length) {
        for (const c of outweighed) supersede(c.id, atom.id, `superseded by a heavier atom (${weight} >= ${c.confidence ?? 0})`);
        atom.supersedes = outweighed.map((c) => c.id);
      }
    }
    appendJsonl(atomsFile(), atom);
    publishActivity({ kind: "memory_atom", action: "created", id: atom.id, atomType: atom.type, weight: atom.confidence, text: atom.text.slice(0, 100) });
    return atom;
  },

  update(id, fields = {}) {
    const cur = currentAtoms().find((a) => a.id === id);
    if (!cur) throw new Error(`no atom with id "${id}"`);
    if (fields.status && !STATUSES.includes(fields.status)) throw new Error(`status must be one of: ${STATUSES.join(", ")}`);
    return appendJsonl(atomsFile(), { ...cur, ...fields, id, updatedAt: new Date().toISOString() });
  },

  deprecate(id, reason = "") {
    const cur = currentAtoms().find((a) => a.id === id);
    if (!cur) throw new Error(`no atom with id "${id}"`);
    const rec = appendJsonl(atomsFile(), { ...cur, status: "deprecated", deprecateReason: reason, updatedAt: new Date().toISOString() });
    publishActivity({ kind: "memory_atom", action: "deprecated", id, atomType: rec.type, text: rec.text.slice(0, 100) });
    return rec;
  },

  get(id) {
    return currentAtoms().find((a) => a.id === id) || null;
  },

  search(query, context = {}, budget = {}) {
    const terms = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
    const pool = currentAtoms().filter((a) => budget.includeInactive || a.status === "active");
    if (!terms.length) {
      return pool.sort(byWeightThenRecency).slice(0, budget.limit || 10);
    }
    return pool
      .map((a) => {
        const hay = (a.text + " " + (a.tags || []).join(" ")).toLowerCase();
        const matchScore = terms.reduce((n, t) => n + (hay.includes(t) ? 1 : 0), 0);
        // Weight nudges ranking among equally-matching atoms — the "where it
        // goes" the indexer decides, not just raw keyword overlap.
        return { a, matchScore, score: matchScore + (a.confidence ?? 0) * 0.25 };
      })
      .filter((x) => x.matchScore > 0)
      .sort((x, y) => y.score - x.score)
      .slice(0, budget.limit || 10)
      .map((x) => x.a);
  },

  // Full lifecycle + relationships for one atom — the "explain recall" view
  // Phase 10 calls the single most important control surface.
  explain(id) {
    const events = historyFor(id);
    if (!events.length) throw new Error(`no atom with id "${id}"`);
    const cur = events[events.length - 1];
    const all = currentAtoms();
    const contradictedBy = all.filter((a) => (a.contradicts || []).includes(id));
    const supersededBy = all.find((a) => a.id === cur.supersededBy) || null;
    return {
      id,
      current: cur,
      history: events,
      contradicts: (cur.contradicts || []).map((cid) => all.find((a) => a.id === cid)).filter(Boolean),
      contradictedBy,
      supersededBy,
      supersedes: (cur.supersedes || []).map((sid) => all.find((a) => a.id === sid)).filter(Boolean),
    };
  },
};

// ---------------------------------------------------------------------------
// legacy-jsonl provider — thin wrapper around the original flat memory.jsonl
// so behavior matches src/tools/index.mjs's memory_* tools exactly. This is
// the default and the rollback path.
// ---------------------------------------------------------------------------

const legacyProvider = {
  name: "legacy-jsonl",

  capture(event) {
    return this.propose({ text: event.text || event.summary || "", tags: event.tags || [] });
  },

  propose({ text, tags = [] }) {
    text = String(text || "").trim();
    if (!text) throw new Error("text is required");
    const rec = { id: newId("m"), text, tags: tags.map(String), createdAt: new Date().toISOString() };
    appendJsonl(legacyMemoryFile(), rec);
    publishActivity({ kind: "legacy_memory", action: "created", id: rec.id, text: rec.text.slice(0, 100) });
    return rec;
  },

  update() {
    throw new Error("legacy-jsonl has no update — /memory forget <id> and re-save instead, or switch to layered-okf.");
  },

  deprecate(id) {
    const all = readJsonl(legacyMemoryFile());
    const kept = all.filter((m) => m.id !== id);
    if (kept.length === all.length) throw new Error(`memory not found: ${id}`);
    fs.writeFileSync(legacyMemoryFile(), kept.map((m) => JSON.stringify(m)).join("\n") + (kept.length ? "\n" : ""));
    publishActivity({ kind: "legacy_memory", action: "deleted", id });
    return { id, status: "deleted" };
  },

  get(id) {
    return readJsonl(legacyMemoryFile()).find((m) => m.id === id) || null;
  },

  search(query, context = {}, budget = {}) {
    const terms = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
    const all = readJsonl(legacyMemoryFile());
    if (!terms.length) return all.slice(-(budget.limit || 10)).reverse();
    return all
      .map((m) => {
        const hay = (m.text + " " + (m.tags || []).join(" ")).toLowerCase();
        const score = terms.reduce((n, t) => n + (hay.includes(t) ? 1 : 0), 0);
        return { m, score };
      })
      .filter((x) => x.score > 0)
      .sort((x, y) => y.score - x.score)
      .slice(0, budget.limit || 10)
      .map((x) => x.m);
  },

  explain(id) {
    const rec = this.get(id);
    if (!rec) throw new Error(`no memory with id "${id}"`);
    return { id, current: rec, history: [rec], contradicts: [], contradictedBy: [], supersededBy: null, supersedes: [] };
  },
};

export const providers = {
  "legacy-jsonl": legacyProvider,
  "layered-okf": layeredProvider,
};

export function resolveProviderName(settings) {
  const name = settings?.memory?.provider;
  return providers[name] ? name : "legacy-jsonl";
}

export function activeProvider(settings) {
  return providers[resolveProviderName(settings)];
}

// Lightweight settings read for call sites (tool implementations) that don't
// have `ctx.settings` in hand — just the one flag, not the full merged
// settings pipeline in loadSettings().
function readRawSettings() {
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, "utf8").replace(/^\s*\/\/.*$/gm, "");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function activeProviderFromDisk() {
  return activeProvider(readRawSettings());
}

// ---------------------------------------------------------------------------
// Phase 3: heuristic L1 extraction (no model call — dependency-free, so it
// can run on every /compact or /exit without cost or latency surprises).
// ---------------------------------------------------------------------------

// Per-cue base weight: how much the indexer trusts a heuristic match of this
// kind before any contradiction/recency adjustment. Explicit corrections and
// hard constraints are stronger signal than a loosely-phrased preference.
const CUES = [
  { type: "constraint", re: /\b(never|don'?t|do not|must not)\b/i, weight: 0.6 },
  { type: "correction", re: /\b(no,? that'?s (?:wrong|not right|not it)|actually,|instead of that)\b/i, weight: 0.65 },
  { type: "preference", re: /\bi (?:prefer|like|want|always want|generally want)\b/i, weight: 0.5 },
  { type: "decision", re: /\b(let'?s (?:use|go with)|we(?:'ll| will) use|we decided to|decided to use)\b/i, weight: 0.55 },
  { type: "successful_technique", re: /\b(that worked|that fixed it|good,? that works|works now)\b/i, weight: 0.45 },
  { type: "failed_technique", re: /\b(that didn'?t work|that failed|still broken|doesn'?t work)\b/i, weight: 0.45 },
];

function sentencesOf(text) {
  return String(text || "").split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
}

function messageText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === "string" ? p : p?.text || "")).join(" ");
  return "";
}

// Scans user-authored messages for cue phrases and weighs+places a matching
// sentence straight into the index (see layeredProvider.propose — no review
// step). Deduplicates against existing atoms with identical normalized text
// so repeated runs (e.g. every /compact) don't spam.
export function extractAtomsFromMessages(messages, { source = "session" } = {}) {
  const existingText = new Set(currentAtoms().map((a) => a.text.toLowerCase().trim()));
  const created = [];
  for (const msg of messages || []) {
    if (msg.role !== "user") continue;
    const text = messageText(msg.content);
    for (const sentence of sentencesOf(text)) {
      if (sentence.length < 8 || sentence.length > 300) continue;
      const cue = CUES.find((c) => c.re.test(sentence));
      if (!cue) continue;
      const norm = sentence.toLowerCase().trim();
      if (existingText.has(norm)) continue;
      existingText.add(norm);
      const atom = layeredProvider.propose({
        type: cue.type,
        text: sentence,
        confidence: cue.weight,
        sources: [{ source, snippet: sentence.slice(0, 160) }],
      });
      created.push(atom);
    }
  }
  return created;
}

// ---------------------------------------------------------------------------
// Shared formatting — one record shape from either provider, one line.
// ---------------------------------------------------------------------------

export function formatMemoryRecord(m) {
  const date = String(m.createdAt || "").slice(0, 10);
  const tags = m.tags?.length ? ` [${m.tags.join(", ")}]` : "";
  if (m.type) {
    // layered-okf atom
    return `- (${m.id}, ${date}) <${m.type}/${m.status}>${tags} ${m.text}`;
  }
  return `- (${m.id}, ${date})${tags} ${m.text}`;
}

export function explainAtomText(id) {
  const info = layeredProvider.explain(id);
  const lines = [
    `Atom ${info.id} — currently ${info.current.status} (${info.current.type}, confidence ${info.current.confidence})`,
    info.current.text,
    "",
    `History (${info.history.length} event(s)):`,
    ...info.history.map((e, i) => `  ${i + 1}. ${e.status} @ ${e.updatedAt || e.createdAt}${e.supersedeReason ? ` — ${e.supersedeReason}` : ""}${e.deprecateReason ? ` — ${e.deprecateReason}` : ""}`),
  ];
  if (info.current.sources?.length) lines.push("", `Sources: ${JSON.stringify(info.current.sources)}`);
  if (info.contradicts.length) lines.push("", `Contradicts: ${info.contradicts.map((a) => `${a.id} (${a.text})`).join("; ")}`);
  if (info.contradictedBy.length) lines.push("", `Contradicted by: ${info.contradictedBy.map((a) => `${a.id} (${a.text})`).join("; ")}`);
  if (info.supersededBy) lines.push("", `Superseded by: ${info.supersededBy.id} (${info.supersededBy.text})`);
  if (info.supersedes.length) lines.push("", `Supersedes: ${info.supersedes.map((a) => `${a.id} (${a.text})`).join("; ")}`);
  return lines.join("\n");
}
