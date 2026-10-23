// Search past conversations — the session_search tool and /history.
//
// Every prompt you typed and every answer the agent gave in this project's
// session logs (or every project's, with scope "all") is one BM25 chunk,
// ranked with the same scorer lean mode and rag_search use. Tool output is
// left out: it is mostly file contents, which rag_search already covers and
// which would drown the conversation itself.

import fs from "node:fs";
import path from "node:path";
import { SESSIONS_DIR, projectSessionsDir, readSessionRecords, describeSession } from "./config.mjs";
import { rankChunks, tokenize } from "./bm25.mjs";

const MAX_FILES = 300;
const MAX_CHUNK = 1500;

function sessionFiles(scope, cwd) {
  const dirs = [];
  if (scope === "all") {
    try {
      for (const d of fs.readdirSync(SESSIONS_DIR)) dirs.push(path.join(SESSIONS_DIR, d));
    } catch { /* no sessions yet */ }
  } else {
    dirs.push(projectSessionsDir(cwd));
  }
  const files = [];
  for (const dir of dirs) {
    try {
      for (const f of fs.readdirSync(dir)) if (f.endsWith(".jsonl")) files.push(path.join(dir, f));
    } catch { /* missing dir */ }
  }
  // Newest first by name (names are ISO timestamps), capped.
  return files.sort((a, b) => path.basename(b).localeCompare(path.basename(a))).slice(0, MAX_FILES);
}

function recordText(r) {
  if (r.type === "user" && typeof r.content === "string") return { role: "you", text: r.content };
  if (r.type === "skill" && r.skill) return { role: "you", text: `/${r.skill} ${r.arg || ""}` };
  if (r.type === "assistant" && typeof r.message?.content === "string" && r.message.content.trim()) {
    return { role: "agent", text: r.message.content };
  }
  return null;
}

// A window of `text` around the first query term it contains.
function snippet(text, query, width = 180) {
  const flat = String(text).replace(/\s+/g, " ").trim();
  const lower = flat.toLowerCase();
  let at = -1;
  for (const t of tokenize(query)) {
    at = lower.indexOf(t);
    if (at !== -1) break;
  }
  if (at === -1 || flat.length <= width) return flat.slice(0, width) + (flat.length > width ? "…" : "");
  const start = Math.max(0, at - Math.floor(width / 3));
  return (start > 0 ? "…" : "") + flat.slice(start, start + width) + (start + width < flat.length ? "…" : "");
}

// Returns [{ session: describeSession(...), role, snippet, score }], best
// first, at most `perSession` hits from any one session.
export function searchSessions(query, { scope = "project", cwd = process.cwd(), limit = 8, exclude = null, perSession = 2 } = {}) {
  const q = String(query || "").trim();
  if (!q) throw new Error("query is required");
  const skip = exclude ? path.resolve(exclude).toLowerCase() : null;
  const chunks = [];
  const meta = [];
  const sessions = new Map();
  for (const file of sessionFiles(scope, cwd)) {
    if (skip && path.resolve(file).toLowerCase() === skip) continue;
    const records = readSessionRecords(file);
    const info = describeSession(file, records);
    if (info.kind !== "main" || !info.prompts) continue;
    sessions.set(file, info);
    for (const r of records) {
      const t = recordText(r);
      if (!t) continue;
      chunks.push(t.text.slice(0, MAX_CHUNK));
      meta.push({ file, role: t.role, text: t.text });
    }
  }
  const ranked = rankChunks(q, chunks).filter((h) => h.score > 0);
  const perFile = new Map();
  const hits = [];
  for (const h of ranked) {
    const m = meta[h.index];
    const n = perFile.get(m.file) || 0;
    if (n >= perSession) continue;
    perFile.set(m.file, n + 1);
    hits.push({ session: sessions.get(m.file), role: m.role, snippet: snippet(m.text, q), score: Number(h.score.toFixed(2)) });
    if (hits.length >= limit) break;
  }
  return hits;
}

export function formatWhen(iso) {
  if (!iso) return "unknown time";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "unknown time";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Plain-text rendering shared by the tool and /history.
export function formatHits(hits, { scope = "project", cwd = process.cwd() } = {}) {
  if (!hits.length) return "(no past conversations match)";
  const here = path.resolve(cwd).toLowerCase();
  const lines = [];
  for (const h of hits) {
    const s = h.session;
    const elsewhere = s.cwd && path.resolve(s.cwd).toLowerCase() !== here;
    lines.push(`${formatWhen(s.started || s.updated)} · "${s.title || "(untitled)"}"${elsewhere ? ` · in ${s.cwd}` : ""}`);
    lines.push(`  ${h.role}: ${h.snippet}`);
    lines.push(`  resume: /resume ${s.code}${elsewhere ? "  (from another folder)" : ""}`);
  }
  if (scope !== "all") lines.push("", "(searched this project only; scope \"all\" searches every project)");
  return lines.join("\n");
}
