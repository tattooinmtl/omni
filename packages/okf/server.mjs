// OKF — Open Knowledge Format MCP server v2 (stdio transport, zero dependencies).
//
// Stores "knowledge cards" as plain markdown files with a small frontmatter
// block, so the knowledge base is portable: readable in any editor, greppable,
// diffable, and usable by any MCP client (NimAgent, Claude Code, etc.).
//
// v2 adds a HIERARCHICAL INDEX on top of the flat card store:
//   - cards live in a folder taxonomy (languages/go, patterns/testing, …)
//   - every folder gets a generated index.okf — a human-readable table of
//     contents rebuilt DETERMINISTICALLY from card frontmatter on every
//     mutation. No model ever writes an index, so indexes cannot hallucinate
//     and cannot go stale.
//   - okf_browse walks the tree top-down (computed live from disk, never from
//     a cache), so navigation output is always ground truth.
//
// Guardrails for small local models (the primary consumers of navigation):
//   - top-level folders are restricted to the canonical taxonomy; unknown
//     categories are rejected with the valid list (force:true overrides)
//   - card ids and links must reference cards that actually exist; unknown
//     ids fail with "did you mean" suggestions instead of silently creating
//     or fabricating knowledge
//   - near-duplicate titles are rejected with the existing card's id, steering
//     the model to okf_update instead of duplicate spam (force:true overrides)
//   - every error message states the valid options, so a wrong call is
//     self-correcting on the next attempt
//
// Storage directory precedence:
//   OKF_DIR env > <OMNI_HOME>/knowledge > <repo>/agent/knowledge
//
// Card layout (one file per card, <folder>/<id>.md — folder comes from the
// file's location on disk, the single source of truth, never from frontmatter):
//   ---
//   okf: 1
//   id: goroutine-ticker-leak-3f9a
//   title: time.Ticker goroutines leak unless stopped
//   type: pattern | snippet | gotcha | decision | howto | reference
//   tags: comma, separated
//   language: go
//   source: optional URL or file path
//   created: 2026-07-14T00:00:00.000Z
//   updated: 2026-07-14T00:00:00.000Z
//   links: comma, separated, card, ids
//   ---
//   Markdown body: the actual knowledge.
//
// Transport: newline-delimited JSON-RPC 2.0 on stdin/stdout per the MCP spec.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INSTALL_ROOT = path.resolve(__dirname, "..", "..");
const OKF_DIR =
  process.env.OKF_DIR ||
  path.join(process.env.OMNI_HOME || path.join(INSTALL_ROOT, "agent"), "knowledge");

const TYPES = ["pattern", "snippet", "gotcha", "decision", "howto", "reference"];
const SERVER_INFO = { name: "okf", version: "2.0.0" };

const INDEX_FILE = "index.okf";
const MAX_DEPTH = 3;
const MAX_TITLE = 200;
const MAX_BODY = 64000;

// Canonical taxonomy. Top-level categories are CLOSED (force:true to extend);
// second-level entries are seeded on disk but the level itself is open — new
// languages/frameworks/etc. can be added freely as valid slugs.
const CANONICAL = {
  languages: [
    "go", "python", "javascript", "typescript", "c", "cpp", "csharp", "rust",
    "java", "php", "ruby", "swift", "kotlin", "dart", "lua", "powershell",
    "bash", "sql", "html", "css",
  ],
  frameworks: [
    "react", "vue", "svelte", "htmx", "express", "fastapi", "django", "flask",
    "laravel", "aspnet", "spring", "electron",
  ],
  databases: ["sqlite", "postgresql", "mysql", "redis", "mongodb", "supabase"],
  tools: ["git", "docker", "cmake", "npm", "pnpm", "cargo", "go-cli", "dotnet-cli", "powershell"],
  patterns: ["architecture", "testing", "security", "concurrency", "networking", "error-handling"],
};

// ---- filesystem helpers -------------------------------------------------------

function ensureDir() {
  fs.mkdirSync(OKF_DIR, { recursive: true });
}

// Create the canonical two-level taxonomy on disk so browse shows the map even
// before any cards exist. Idempotent and cheap; called before every operation.
function ensureScaffold() {
  ensureDir();
  for (const [top, subs] of Object.entries(CANONICAL)) {
    for (const sub of subs) fs.mkdirSync(path.join(OKF_DIR, top, sub), { recursive: true });
  }
}

// A relative folder path that is safe to join under OKF_DIR. "" means root.
function absDir(rel) {
  const full = path.resolve(OKF_DIR, rel || ".");
  const root = path.resolve(OKF_DIR);
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw new Error(`invalid folder path: ${rel}`);
  }
  return full;
}

function slugify(text) {
  return (
    String(text)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "card"
  );
}

function validId(id) {
  return /^[a-z0-9][a-z0-9-]*$/.test(String(id || ""));
}

function newId(title, taken) {
  for (let i = 0; i < 20; i++) {
    const id = `${slugify(title)}-${crypto.randomBytes(2).toString("hex")}`;
    if (!taken || !taken.has(id)) return id;
  }
  return `${slugify(title)}-${crypto.randomBytes(4).toString("hex")}`;
}

// ---- folder validation --------------------------------------------------------

// Normalize a model-supplied folder into a canonical relative path, or throw a
// self-correcting error. This is the main taxonomy guardrail.
function resolveFolder(folder, { force = false } = {}) {
  if (folder === undefined || folder === null || folder === "") return "";
  const norm = String(folder)
    .replace(/\\/g, "/")
    .toLowerCase()
    .split("/")
    .map((s) => s.trim().replace(/\s+/g, "-"))
    .filter(Boolean)
    .join("/");
  if (!norm) return "";
  const segs = norm.split("/");
  if (segs.length > MAX_DEPTH) {
    throw new Error(`folder "${norm}" is ${segs.length} levels deep — maximum is ${MAX_DEPTH} (e.g. languages/go/examples)`);
  }
  for (const seg of segs) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(seg) || seg === "index.okf") {
      throw new Error(`invalid folder segment "${seg}" — use lowercase letters, digits and hyphens (e.g. error-handling)`);
    }
  }
  const top = segs[0];
  const topExists = fs.existsSync(path.join(OKF_DIR, top));
  if (!Object.hasOwn(CANONICAL, top) && !topExists && !force) {
    throw new Error(
      `unknown top-level category "${top}". Valid categories: ${Object.keys(CANONICAL).join(", ")}. ` +
      `File the card under one of those (e.g. languages/${segs[1] || "go"}), or pass force:true to deliberately create a new category.`
    );
  }
  return norm;
}

// ---- card storage -------------------------------------------------------------

function serialize(card) {
  const fm = [
    "---",
    "okf: 1",
    `id: ${card.id}`,
    `title: ${card.title}`,
    `type: ${card.type}`,
    `tags: ${(card.tags || []).join(", ")}`,
    `language: ${card.language || ""}`,
    `source: ${card.source || ""}`,
    `created: ${card.created}`,
    `updated: ${card.updated}`,
    `links: ${(card.links || []).join(", ")}`,
    "---",
    "",
  ].join("\n");
  return fm + (card.body || "").trim() + "\n";
}

function parse(raw, fallbackId) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  const card = { id: fallbackId, title: fallbackId, type: "reference", tags: [], links: [], body: raw };
  if (!m) return card;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([a-z]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const [, key, value] = kv;
    if (key === "tags" || key === "links") {
      card[key] = value.split(",").map((s) => s.trim()).filter(Boolean);
    } else if (key !== "okf") {
      card[key] = value.trim();
    }
  }
  card.body = m[2].trim();
  return card;
}

// Recursively collect every card under OKF_DIR. Each card carries .folder
// (relative dir, "" for root) derived from its on-disk location.
function allCards() {
  ensureDir();
  const out = [];
  const walk = (rel) => {
    const dir = absDir(rel);
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      if (e.isDirectory()) {
        walk(rel ? `${rel}/${e.name}` : e.name);
      } else if (e.isFile() && e.name.endsWith(".md")) {
        try {
          const card = parse(fs.readFileSync(path.join(dir, e.name), "utf8"), e.name.slice(0, -3));
          card.folder = rel;
          out.push(card);
        } catch {
          /* unreadable file — skip */
        }
      }
    }
  };
  walk("");
  return out;
}

function cardFile(folder, id) {
  if (!validId(id)) throw new Error(`invalid card id: ${id}`);
  return path.join(absDir(folder), `${id}.md`);
}

// Locate a card by id anywhere in the tree. Ids are globally unique.
function findCard(id) {
  if (!validId(id)) return null;
  for (const card of allCards()) {
    if (card.id === id) return card;
  }
  return null;
}

function writeCard(card) {
  const file = cardFile(card.folder || "", card.id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, serialize(card), "utf8");
}

// ---- similarity + "did you mean" guards ----------------------------------------

function tokenSet(text) {
  return new Set(String(text).toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1));
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

// Closest existing ids to a wrong one — turns a hallucinated id into a
// correctable error instead of a dead end.
function closestIds(wrongId, cards, n = 3) {
  const target = tokenSet(wrongId);
  return cards
    .map((c) => ({ id: c.id, s: jaccard(target, tokenSet(c.id)) + jaccard(target, tokenSet(c.title)) }))
    .filter((h) => h.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, n)
    .map((h) => h.id);
}

function unknownIdError(id, cards) {
  const near = closestIds(id, cards);
  const hint = near.length
    ? ` Did you mean: ${near.join(", ")}?`
    : " Use okf_browse or okf_search to find real card ids.";
  return new Error(`no card with id "${id}". Only use ids that appeared in a previous okf tool result.${hint}`);
}

// Cards whose titles are near-duplicates of the given one. Jaccard catches
// same-length overlap; containment (shared / smaller set) catches a rephrased
// or extended version of an existing title.
function similarTitleCards(title, cards) {
  const target = tokenSet(title);
  return cards.filter((c) => {
    const other = tokenSet(c.title);
    if (!target.size || !other.size) return false;
    let inter = 0;
    for (const t of target) if (other.has(t)) inter++;
    const containment = inter / Math.min(target.size, other.size);
    return jaccard(target, other) >= 0.7 || containment >= 0.8;
  });
}

// Validate that every link points at a real card — hallucinated graph edges
// are rejected at the door.
function validateLinks(links, cards, selfId) {
  const known = new Set(cards.map((c) => c.id));
  const clean = [...new Set((links || []).map((l) => String(l).trim()).filter(Boolean).filter((l) => l !== selfId))];
  const bad = clean.filter((l) => !known.has(l));
  if (bad.length) {
    const hints = bad.map((b) => {
      const near = closestIds(b, cards, 2);
      return near.length ? `${b} (did you mean ${near.join(" or ")}?)` : b;
    });
    throw new Error(`links must reference existing cards — unknown id(s): ${hints.join("; ")}`);
  }
  return clean;
}

function normalizeTags(tags) {
  return [...new Set((tags || []).map((t) => String(t).trim().toLowerCase()).filter(Boolean))].slice(0, 10);
}

function checkLimits({ title, body }) {
  if (title !== undefined && String(title).length > MAX_TITLE) {
    throw new Error(`title too long (${String(title).length} chars, max ${MAX_TITLE}) — keep titles to one line`);
  }
  if (body !== undefined && String(body).length > MAX_BODY) {
    throw new Error(`body too long (${String(body).length} chars, max ${MAX_BODY}) — keep cards atomic; split into linked cards`);
  }
}

// ---- tree scan + generated indexes ----------------------------------------------

// One pass over the tree: every directory (rel path) -> { cards, subdirs }.
function scanTree() {
  ensureDir();
  const dirs = new Map();
  const walk = (rel) => {
    const node = { cards: [], subdirs: [] };
    dirs.set(rel, node);
    let entries;
    try {
      entries = fs.readdirSync(absDir(rel), { withFileTypes: true });
    } catch {
      return node;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith(".")) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        node.subdirs.push(childRel);
        walk(childRel);
      } else if (e.isFile() && e.name.endsWith(".md")) {
        try {
          const card = parse(fs.readFileSync(path.join(absDir(rel), e.name), "utf8"), e.name.slice(0, -3));
          card.folder = rel;
          node.cards.push(card);
        } catch {
          /* skip unreadable */
        }
      }
    }
    return node;
  };
  walk("");
  return dirs;
}

function countRecursive(dirs, rel) {
  const node = dirs.get(rel);
  if (!node) return 0;
  return node.cards.length + node.subdirs.reduce((n, s) => n + countRecursive(dirs, s), 0);
}

function topTags(dirs, rel, n = 4) {
  const counts = new Map();
  const visit = (r) => {
    const node = dirs.get(r);
    if (!node) return;
    for (const card of node.cards) for (const t of card.tags || []) counts.set(t, (counts.get(t) || 0) + 1);
    for (const s of node.subdirs) visit(s);
  };
  visit(rel);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([t]) => t);
}

function firstSentence(body) {
  const text = String(body || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const m = /^(.{1,140}?[.!?])(\s|$)/.exec(text);
  return (m ? m[1] : text.slice(0, 140)).trim();
}

function cardLine(card, { withFolder = false } = {}) {
  const tags = card.tags?.length ? ` [${card.tags.join(", ")}]` : "";
  const where = withFolder && card.folder ? `  (in ${card.folder})` : "";
  return `${card.id} (${card.type})${tags} — ${card.title}${where}`;
}

// Render one directory's table of contents from scanned data. Deterministic
// (no timestamps) so regenerating produces clean git diffs.
function renderIndex(dirs, rel) {
  const node = dirs.get(rel) || { cards: [], subdirs: [] };
  const lines = [
    `# OKF index — ${rel || "knowledge root"}`,
    "",
    "Auto-generated from card frontmatter by the OKF server — do not edit by hand.",
    "",
  ];
  if (rel === "") {
    lines.push(`Total cards: ${countRecursive(dirs, "")}`, "");
  }
  lines.push("## Folders");
  if (node.subdirs.length) {
    for (const sub of node.subdirs) {
      const count = countRecursive(dirs, sub);
      const tags = topTags(dirs, sub);
      lines.push(`- ${sub}/ — ${count} card${count === 1 ? "" : "s"}${tags.length ? ` [${tags.join(", ")}]` : ""}`);
    }
  } else {
    lines.push("(none)");
  }
  lines.push("", "## Cards here");
  if (node.cards.length) {
    for (const card of node.cards.sort((a, b) => a.id.localeCompare(b.id))) {
      const sent = firstSentence(card.body);
      lines.push(`- ${cardLine(card)}${sent ? ` — ${sent}` : ""}`);
    }
  } else {
    lines.push("(no cards yet)");
  }
  return lines.join("\n") + "\n";
}

// Rebuild every index.okf on disk. Returns stats for reporting.
function reindexAll() {
  ensureScaffold();
  const dirs = scanTree();
  let written = 0;
  for (const rel of dirs.keys()) {
    const file = path.join(absDir(rel), INDEX_FILE);
    const next = renderIndex(dirs, rel);
    let prev = null;
    try {
      prev = fs.readFileSync(file, "utf8");
    } catch {
      /* new index */
    }
    if (prev !== next) {
      fs.writeFileSync(file, next, "utf8");
      written++;
    }
  }
  return { folders: dirs.size, cards: countRecursive(dirs, ""), written };
}

// Is this folder part of the seeded taxonomy (never pruned even when empty)?
function isCanonicalDir(rel) {
  const segs = rel.split("/");
  if (segs.length === 1) return Object.hasOwn(CANONICAL, segs[0]);
  if (segs.length === 2) return (CANONICAL[segs[0]] || []).includes(segs[1]);
  return false;
}

// After a delete/move, drop now-empty non-canonical dirs (and their index.okf),
// walking up toward the root.
function pruneEmptyDirs(rel) {
  let current = rel;
  while (current) {
    if (isCanonicalDir(current)) break;
    const dir = absDir(current);
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      break;
    }
    const leftovers = entries.filter((e) => e !== INDEX_FILE);
    if (leftovers.length) break;
    try {
      fs.rmSync(path.join(dir, INDEX_FILE), { force: true });
      fs.rmdirSync(dir);
    } catch {
      break;
    }
    current = current.includes("/") ? current.slice(0, current.lastIndexOf("/")) : "";
  }
}

// ---- search ---------------------------------------------------------------------

function tokenize(text) {
  return String(text).toLowerCase().split(/[^a-z0-9.]+/).filter((t) => t.length > 1);
}

// Weighted token overlap: title > tags > folder > body. Cheap and
// dependency-free; the knowledge base is hundreds of cards, not millions.
function score(card, tokens) {
  const title = card.title.toLowerCase();
  const tags = (card.tags || []).join(" ").toLowerCase();
  const folder = (card.folder || "").toLowerCase();
  const body = (card.body || "").toLowerCase();
  let s = 0;
  for (const t of tokens) {
    if (title.includes(t)) s += 5;
    if (tags.includes(t)) s += 3;
    if (folder.includes(t)) s += 2;
    if (body.includes(t)) s += 1;
  }
  return s;
}

function snippet(body, tokens) {
  const lower = body.toLowerCase();
  let at = 0;
  for (const t of tokens) {
    const i = lower.indexOf(t);
    if (i >= 0) { at = i; break; }
  }
  const start = Math.max(0, at - 40);
  return (start > 0 ? "…" : "") + body.slice(start, start + 160).replace(/\s+/g, " ").trim() + (body.length > start + 160 ? "…" : "");
}

function inFolder(card, folder) {
  if (!folder) return true;
  return card.folder === folder || (card.folder || "").startsWith(folder + "/");
}

// ---- tool implementations ---------------------------------------------------------

const toolImpl = {
  okf_add({ title, body, type = "reference", tags = [], language = "", source = "", links = [], folder = "", force = false }) {
    if (!title || !body) throw new Error("okf_add requires `title` and `body`");
    if (!TYPES.includes(type)) throw new Error(`type must be one of: ${TYPES.join(", ")}`);
    checkLimits({ title, body });
    ensureScaffold();
    const rel = resolveFolder(folder, { force });
    const cards = allCards();
    if (!force) {
      const dupes = similarTitleCards(title, cards);
      if (dupes.length) {
        throw new Error(
          `a very similar card already exists: ${dupes.map((c) => cardLine(c, { withFolder: true })).join("; ")}. ` +
          `Extend it with okf_update({id, append}) instead of duplicating, or pass force:true if it is genuinely different.`
        );
      }
    }
    const cleanLinks = validateLinks(links, cards);
    const now = new Date().toISOString();
    const card = {
      id: newId(title, new Set(cards.map((c) => c.id))),
      title, type,
      tags: normalizeTags(tags),
      language, source,
      links: cleanLinks,
      created: now, updated: now,
      body,
      folder: rel,
    };
    writeCard(card);
    reindexAll();
    return `Saved card ${card.id} in ${rel || "knowledge root"}.`;
  },

  okf_get({ id }) {
    const card = findCard(id);
    if (!card) throw unknownIdError(id, allCards());
    return `Location: ${card.folder || "knowledge root"}\n\n${serialize(card)}`;
  },

  okf_browse({ path: rel = "" } = {}) {
    ensureScaffold();
    const dirs = scanTree();
    const norm = String(rel || "")
      .replace(/\\/g, "/")
      .toLowerCase()
      .split("/")
      .map((s) => s.trim())
      .filter(Boolean)
      .join("/");
    if (norm && !dirs.has(norm)) {
      // Self-correcting error: show the valid children of the deepest existing
      // ancestor so the model's next call can only be right.
      let parent = norm;
      while (parent && !dirs.has(parent)) {
        parent = parent.includes("/") ? parent.slice(0, parent.lastIndexOf("/")) : "";
      }
      const valid = (dirs.get(parent)?.subdirs || []).map((s) => `${s}/`);
      throw new Error(
        `no folder "${norm}". Folders under ${parent || "the root"}: ${valid.length ? valid.join(", ") : "(none)"}. ` +
        `Only browse paths that appeared in a previous okf_browse result.`
      );
    }
    const listing = renderIndex(dirs, norm).trimEnd();
    return (
      listing +
      `\n\nNavigate: okf_browse({path:"<folder shown above>"}) · read a card: okf_get({id:"<id shown above>"}) · keyword fallback: okf_search({query}).`
    );
  },

  okf_search({ query, tag = "", type = "", folder = "", limit = 8 }) {
    if (!query) throw new Error("okf_search requires `query`");
    const tokens = tokenize(query);
    const rel = folder ? resolveFolder(folder, { force: true }) : "";
    const hits = allCards()
      .filter((c) => (!tag || c.tags.includes(tag)) && (!type || c.type === type) && inFolder(c, rel))
      .map((c) => ({ c, s: score(c, tokens) }))
      .filter((h) => h.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, limit);
    if (!hits.length) return `No cards match "${query}". Try okf_browse to navigate the folder index, or okf_add to capture new knowledge.`;
    return hits.map((h) => `${cardLine(h.c, { withFolder: true })}\n    ${snippet(h.c.body, tokens)}`).join("\n");
  },

  okf_list({ tag = "", type = "", folder = "", limit = 50 }) {
    const rel = folder ? resolveFolder(folder, { force: true }) : "";
    const cards = allCards()
      .filter((c) => (!tag || c.tags.includes(tag)) && (!type || c.type === type) && inFolder(c, rel))
      .sort((a, b) => String(b.updated).localeCompare(String(a.updated)))
      .slice(0, limit);
    if (!cards.length) return "No cards match. The knowledge base may be empty here — okf_browse shows the folder map.";
    return cards.map((c) => cardLine(c, { withFolder: true })).join("\n");
  },

  okf_update({ id, title, body, append, type, tags, language, source, links }) {
    const cards = allCards();
    const card = cards.find((c) => c.id === id);
    if (!card) throw unknownIdError(id, cards);
    if (type !== undefined && !TYPES.includes(type)) throw new Error(`type must be one of: ${TYPES.join(", ")}`);
    checkLimits({ title, body });
    if (title !== undefined) card.title = title;
    if (body !== undefined) card.body = body;
    if (append) card.body = `${card.body}\n\n${append}`.trim();
    checkLimits({ body: card.body });
    if (type !== undefined) card.type = type;
    if (tags !== undefined) card.tags = normalizeTags(tags);
    if (language !== undefined) card.language = language;
    if (source !== undefined) card.source = source;
    if (links !== undefined) card.links = validateLinks(links, cards, card.id);
    card.updated = new Date().toISOString();
    writeCard(card);
    reindexAll();
    return `Updated card ${card.id} (in ${card.folder || "knowledge root"}).`;
  },

  okf_move({ id, folder = "", force = false }) {
    const cards = allCards();
    const card = cards.find((c) => c.id === id);
    if (!card) throw unknownIdError(id, cards);
    const rel = resolveFolder(folder, { force });
    if (rel === (card.folder || "")) return `Card ${id} is already in ${rel || "knowledge root"}.`;
    const from = cardFile(card.folder || "", id);
    const oldFolder = card.folder || "";
    card.folder = rel;
    card.updated = new Date().toISOString();
    writeCard(card);
    fs.rmSync(from, { force: true });
    pruneEmptyDirs(oldFolder);
    reindexAll();
    return `Moved card ${id} from ${oldFolder || "knowledge root"} to ${rel || "knowledge root"}.`;
  },

  okf_delete({ id }) {
    const cards = allCards();
    const card = cards.find((c) => c.id === id);
    if (!card) throw unknownIdError(id, cards);
    fs.rmSync(cardFile(card.folder || "", id), { force: true });
    pruneEmptyDirs(card.folder || "");
    reindexAll();
    const backrefs = cards.filter((c) => c.id !== id && (c.links || []).includes(id));
    const note = backrefs.length
      ? ` Note: ${backrefs.length} card(s) still link to it: ${backrefs.map((c) => c.id).join(", ")} — consider okf_update to fix their links.`
      : "";
    return `Deleted card ${id}.${note}`;
  },

  okf_reindex() {
    const stats = reindexAll();
    return `Reindexed: ${stats.cards} card(s) across ${stats.folders} folder(s); ${stats.written} index.okf file(s) rewritten.`;
  },
};

// ---- tool schemas -----------------------------------------------------------------

const str = { type: "string" };
const strArr = { type: "array", items: { type: "string" } };
const folderProp = {
  ...str,
  description:
    `Folder path in the taxonomy, max ${MAX_DEPTH} levels (e.g. "languages/go", "patterns/testing"). ` +
    `Top-level must be one of: ${Object.keys(CANONICAL).join(", ")}. Empty = knowledge root.`,
};
const TOOLS = [
  {
    name: "okf_browse",
    description:
      "Navigate the knowledge base like a table of contents. No arguments = root index (all categories); " +
      "pass path to descend (e.g. {path:'languages/go'}). Output is computed live from disk and is the ONLY " +
      "trustworthy source of folder paths and card ids — never invent either. Prefer browsing over searching " +
      "when you know the topic area.",
    inputSchema: {
      type: "object",
      properties: { path: { ...str, description: "Folder to list, from a previous browse result. Empty for the root." } },
    },
  },
  {
    name: "okf_add",
    description:
      "Save a knowledge card (Open Knowledge Format) — a reusable coding lesson: a pattern, snippet, gotcha, " +
      "decision, howto, or reference. File it in the right folder (see okf_browse). Near-duplicate titles are " +
      "rejected so knowledge concentrates in one card per lesson.",
    inputSchema: {
      type: "object",
      properties: {
        title: str,
        body: { ...str, description: "Markdown body: the knowledge itself, with code blocks as needed." },
        type: { ...str, enum: TYPES },
        tags: strArr,
        language: str,
        source: { ...str, description: "Optional URL or file path this knowledge came from." },
        links: { ...strArr, description: "Related card ids (must already exist)." },
        folder: folderProp,
        force: { type: "boolean", description: "Override the duplicate-title and new-category guards. Use only when certain." },
      },
      required: ["title", "body"],
    },
  },
  {
    name: "okf_search",
    description:
      "Keyword search across all cards — the fallback when okf_browse navigation doesn't reach the topic. " +
      "Returns ranked cards with snippets. Weighted match over title, tags, folder, and body.",
    inputSchema: {
      type: "object",
      properties: {
        query: str,
        tag: { ...str, description: "Only cards carrying this tag." },
        type: { ...str, enum: TYPES },
        folder: { ...str, description: "Restrict to this folder subtree (e.g. languages/go)." },
        limit: { type: "number" },
      },
      required: ["query"],
    },
  },
  {
    name: "okf_get",
    description: "Fetch a full knowledge card by id (returns the raw OKF markdown). Ids come from okf_browse/okf_search/okf_list output.",
    inputSchema: { type: "object", properties: { id: str }, required: ["id"] },
  },
  {
    name: "okf_list",
    description: "List knowledge cards, newest first, optionally filtered by tag, type, or folder subtree.",
    inputSchema: {
      type: "object",
      properties: {
        tag: str,
        type: { ...str, enum: TYPES },
        folder: { ...str, description: "Restrict to this folder subtree." },
        limit: { type: "number" },
      },
    },
  },
  {
    name: "okf_update",
    description: "Update an existing card: replace fields, or `append` extra markdown to the body. Links must reference existing cards.",
    inputSchema: {
      type: "object",
      properties: {
        id: str,
        title: str,
        body: str,
        append: { ...str, description: "Markdown appended to the existing body." },
        type: { ...str, enum: TYPES },
        tags: strArr,
        language: str,
        source: str,
        links: strArr,
      },
      required: ["id"],
    },
  },
  {
    name: "okf_move",
    description: "Move a card to a different folder in the taxonomy (id stays the same).",
    inputSchema: {
      type: "object",
      properties: {
        id: str,
        folder: folderProp,
        force: { type: "boolean", description: "Allow creating a new top-level category." },
      },
      required: ["id"],
    },
  },
  {
    name: "okf_delete",
    description: "Delete a knowledge card by id.",
    inputSchema: { type: "object", properties: { id: str }, required: ["id"] },
  },
  {
    name: "okf_reindex",
    description:
      "Rebuild every generated index.okf from the cards on disk (deterministic — no model involvement). " +
      "Run after editing cards outside the okf tools (manual edits, git pull, sync).",
    inputSchema: { type: "object", properties: {} },
  },
];

// ---- JSON-RPC over stdio ------------------------------------------------------------

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function handle(req) {
  const { id, method, params = {} } = req;
  const reply = (result) => id !== undefined && send({ jsonrpc: "2.0", id, result });
  const fail = (message, code = -32000) =>
    id !== undefined && send({ jsonrpc: "2.0", id, error: { code, message } });

  switch (method) {
    case "initialize":
      return reply({
        protocolVersion: params.protocolVersion || "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS });
    case "tools/call": {
      const fn = toolImpl[params.name];
      if (!fn) return fail(`unknown tool: ${params.name}`, -32602);
      try {
        const text = fn(params.arguments || {});
        return reply({ content: [{ type: "text", text }], isError: false });
      } catch (err) {
        return reply({ content: [{ type: "text", text: `ERROR: ${err.message}` }], isError: true });
      }
    }
    default:
      // Notifications (method starts with "notifications/") need no response;
      // unknown *requests* get a method-not-found error.
      if (id !== undefined) return fail(`method not found: ${method}`, -32601);
  }
}

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let req;
  try {
    req = JSON.parse(trimmed);
  } catch {
    return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
  }
  try {
    handle(req);
  } catch (err) {
    if (req.id !== undefined) send({ jsonrpc: "2.0", id: req.id, error: { code: -32000, message: err.message } });
  }
});
rl.on("close", () => process.exit(0));
