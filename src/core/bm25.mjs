// Standalone BM25 scoring — extracted from integrations/rag.mjs so contextMode
// "lean" can rank arbitrary chunks (skill headings, tool-result summaries)
// against a query without dragging in the workspace-file walker or the
// on-disk index. rag.mjs re-exports `tokenize` from here so the two callers
// share one tokenizer and cannot drift.

// BM25 parameters (standard defaults; must match rag.mjs so ranking behaviour
// is consistent between skill-chunk distillation and workspace search).
export const K1 = 1.5;
export const B = 0.75;

// Split camelCase / snake_case / kebab-case identifiers into searchable words,
// keeping the original token too so exact identifier queries still rank high.
// Copy-of-record for the tokenizer — rag.mjs imports this one.
export function tokenize(text) {
  const out = [];
  const raw = String(text).split(/[^A-Za-z0-9_]+/);
  for (const tok of raw) {
    if (!tok) continue;
    const lower = tok.toLowerCase();
    if (lower.length >= 2) out.push(lower);
    const parts = tok
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .split(/[_\s]+/);
    if (parts.length > 1) {
      for (const p of parts) {
        const pl = p.toLowerCase();
        if (pl.length >= 2 && pl !== lower) out.push(pl);
      }
    }
  }
  return out;
}

// Rank `chunks` (array of strings) against `query`, returning `[{ index, score, text }]`
// sorted best-first. Used by the lean-mode skill distiller to pick the top
// heading-chunks of a SKILL.md to keep in the system message instead of
// pushing the full body every turn.
export function rankChunks(query, chunks) {
  const N = chunks.length;
  if (!N) return [];
  const terms = [...new Set(tokenize(query))];
  if (!terms.length) return chunks.map((t, i) => ({ index: i, score: 0, text: t }));

  const tokenLists = chunks.map(tokenize);
  const lens = tokenLists.map((t) => t.length);
  const avgLen = lens.reduce((a, b) => a + b, 0) / N || 1;

  // Inverted index over just this small pool of chunks.
  const postings = Object.create(null);
  for (let i = 0; i < N; i++) {
    const tf = new Map();
    for (const t of tokenLists[i]) tf.set(t, (tf.get(t) || 0) + 1);
    for (const [term, n] of tf) (postings[term] ||= []).push([i, n]);
  }

  const scores = new Array(N).fill(0);
  for (const term of terms) {
    const plist = Object.prototype.hasOwnProperty.call(postings, term) ? postings[term] : null;
    if (!Array.isArray(plist)) continue;
    const df = plist.length;
    const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
    for (const [id, tf] of plist) {
      const norm = tf * (K1 + 1) / (tf + K1 * (1 - B + B * (lens[id] / avgLen)));
      scores[id] += idf * norm;
    }
  }
  return scores
    .map((score, index) => ({ index, score, text: chunks[index] }))
    .sort((a, b) => b.score - a.score);
}
