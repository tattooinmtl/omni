// Builds the graph the /neuralview galaxy visualizer renders.
//
// The shape follows NewPlanConversion.md's own architecture diagram — the
// Memory Coordinator is the true center, fanning out into L0 (session log),
// Chat Memory (L1 atoms — a SEPARATE namespace from the coding taxonomy,
// per that doc's explicit design rule), Skills (OKF howto/pattern cards),
// Wiki (OKF reference/decision/snippet/gotcha cards), CodeGraph (Phase 7 —
// not built yet, rendered dim as a labeled placeholder so the map stays
// honest about what's real), and Feedback (confidence/outcome adjustments —
// what a supersede/deprecate actually is). The OKF taxonomy itself (see
// resume.md, which first sketched "one vertex per folder") still renders in
// full underneath Skills/Wiki — every canonical folder is a node whether or
// not it has cards yet, so the map looks like the whole knowledge base, not
// just whatever happens to be populated today.
//
// Read-only — never touches packages/okf/server.mjs (that file is a stdio
// MCP server that starts listening on import; the card format and the
// canonical taxonomy are duplicated here, read-only, instead).
//
// Kept dependency-free and local-only per project convention: no network
// calls, no external services, nothing leaves the machine.

import fs from "node:fs";
import path from "node:path";
import { HOME } from "../core/config.mjs";
import { currentAtoms, providers as memoryProviders } from "../core/memory-provider.mjs";
import { liveGraph } from "./activity-bus.mjs";
import {
  COORDINATOR_ID, L0_ID, CHAT_MEMORY_ID, SKILLS_ID, WIKI_ID, CODEGRAPH_ID, FEEDBACK_ID, OKF_ROOT_ID,
  SESSIONS_HUB_ID, TOOLS_HUB_ID, FILES_HUB_ID,
} from "./graph-ids.mjs";

const OKF_DIR = process.env.OKF_DIR || path.join(HOME, "knowledge");

const MAX_NODES = 3000; // keep the client-side layout responsive
const MAX_TAG_EDGES = 800;
const COMMON_TAG_CEILING = 8; // tags shared by more nodes than this are too generic to draw

// Mirrors packages/okf/server.mjs's CANONICAL taxonomy — the fixed skeleton
// that exists whether or not any cards have been filed yet.
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

// Skills = "howto"/"pattern" cards (procedures); Wiki = everything else
// (reference/decision/snippet/gotcha) — the plan's asset mapping.
const SKILL_CARD_TYPES = new Set(["howto", "pattern"]);

// ---- OKF card parsing (mirrors packages/okf/server.mjs's parse(), read-only) ---

function parseCard(raw, fallbackId) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  const card = { id: fallbackId, title: fallbackId, type: "reference", tags: [], links: [], body: raw };
  if (!m) return card;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([a-z]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const [, key, value] = kv;
    if (key === "tags" || key === "links") card[key] = value.split(",").map((s) => s.trim()).filter(Boolean);
    else if (key !== "okf") card[key] = value.trim();
  }
  card.body = m[2].trim();
  return card;
}

function truncate(s, n) {
  s = String(s || "");
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function addTagEdges(nodesByTag, edges, seen) {
  let added = 0;
  for (const [tag, ids] of nodesByTag) {
    if (ids.length < 2 || ids.length > COMMON_TAG_CEILING) continue;
    for (let i = 0; i < ids.length && added < MAX_TAG_EDGES; i++) {
      for (let j = i + 1; j < ids.length && added < MAX_TAG_EDGES; j++) {
        const key = ids[i] < ids[j] ? `${ids[i]}|${ids[j]}` : `${ids[j]}|${ids[i]}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({ source: ids[i], target: ids[j], kind: "tag", label: tag });
        added++;
      }
    }
  }
}

export function buildGraph() {
  const nodes = [];
  const edges = [];
  const knownIds = new Set();

  const addNode = (n) => { nodes.push(n); knownIds.add(n.id); };
  const addEdge = (source, target, kind) => edges.push({ source, target, kind });

  // ---- fixed architecture core (NewPlanConversion.md's own diagram) ---------
  addNode({ id: COORDINATOR_ID, kind: "system", label: "Memory Coordinator", detail: "Routes every retrieval request and every captured event to the right subsystem below.", tags: [], degree: 0 });
  addNode({ id: L0_ID, kind: "system", label: "L0 · Conversation Log", detail: "Immutable session record — every message, tool call, and correction, stamped with a stable event id (core/config.mjs Session.append).", tags: [], degree: 0 });
  addNode({ id: CHAT_MEMORY_ID, kind: "system", label: "Chat Memory · L1 Facts", detail: "Preferences, facts, decisions, and corrections — a separate namespace from the coding taxonomy, weighted and auto-placed by the indexer (core/memory-provider.mjs).", tags: [], degree: 0 });
  addNode({ id: SKILLS_ID, kind: "system", label: "Skills", detail: "OKF howto/pattern cards — reusable procedures.", tags: [], degree: 0 });
  addNode({ id: WIKI_ID, kind: "system", label: "Wiki", detail: "OKF reference/decision/snippet/gotcha cards — documentary knowledge.", tags: [], degree: 0 });
  addNode({ id: CODEGRAPH_ID, kind: "system-inactive", label: "CodeGraph", detail: "Not built yet (NewPlanConversion.md Phase 7) — would index files, symbols, and callers as a derived, discardable cache.", tags: [], degree: 0 });
  addNode({ id: FEEDBACK_ID, kind: "system", label: "Feedback · Confidence & Outcomes", detail: "Where weight comparisons and contradiction resolution happen — a supersede or deprecate is this loop acting.", tags: [], degree: 0 });
  addNode({ id: SESSIONS_HUB_ID, kind: "system", label: "Sessions", detail: "One live child per omni launch. Each session node fans out to the tool calls, skills, and files it touched — trace a session end-to-end.", tags: [], degree: 0 });
  addNode({ id: TOOLS_HUB_ID, kind: "system", label: "Tools", detail: "Live parent of every tool call the agent makes this session (list_dir, read_file, run_command…). Every invocation appears as a transient child node.", tags: [], degree: 0 });
  addNode({ id: FILES_HUB_ID, kind: "system", label: "Files", detail: "Live parent of every file the agent touches (read, wrote, edited) this session. New file → new node here, linked back to the tool call that created it.", tags: [], degree: 0 });
  for (const id of [L0_ID, CHAT_MEMORY_ID, SKILLS_ID, WIKI_ID, CODEGRAPH_ID, FEEDBACK_ID, SESSIONS_HUB_ID, TOOLS_HUB_ID, FILES_HUB_ID]) addEdge(COORDINATOR_ID, id, "system");

  // ---- OKF taxonomy skeleton: root -> categories -> subcategories ----------
  const folderMeta = new Map(); // relPath -> { parent, label }
  const ensureFolder = (id, parent, label) => {
    if (!folderMeta.has(id)) folderMeta.set(id, { parent, label });
  };
  // Registers every ancestor of a real on-disk path too, so a folder outside
  // the seeded canonical set (force:true categories, depth-3 subfolders)
  // still chains back to the OKF root instead of floating disconnected.
  const ensurePath = (rel) => {
    if (!rel) return OKF_ROOT_ID;
    if (folderMeta.has(rel)) return rel;
    const segs = rel.split("/");
    let parent = OKF_ROOT_ID, acc = "";
    for (const seg of segs) {
      acc = acc ? `${acc}/${seg}` : seg;
      if (!folderMeta.has(acc)) ensureFolder(acc, parent, seg);
      parent = acc;
    }
    return rel;
  };
  for (const [top, subs] of Object.entries(CANONICAL)) {
    ensureFolder(top, OKF_ROOT_ID, top);
    for (const sub of subs) ensureFolder(`${top}/${sub}`, top, sub);
  }

  // ---- walk the real knowledge dir for cards + any extra real folders -------
  const cards = [];
  const dirCardCount = new Map();
  const walk = (rel) => {
    ensurePath(rel);
    let entries;
    try {
      entries = fs.readdirSync(path.join(OKF_DIR, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "index.okf") continue;
      if (e.isDirectory()) walk(rel ? `${rel}/${e.name}` : e.name);
      else if (e.isFile() && e.name.endsWith(".md")) {
        try {
          const card = parseCard(fs.readFileSync(path.join(OKF_DIR, rel, e.name), "utf8"), e.name.slice(0, -3));
          card.folder = rel;
          cards.push(card);
          dirCardCount.set(rel, (dirCardCount.get(rel) || 0) + 1);
        } catch { /* unreadable — skip */ }
      }
    }
  };
  walk("");

  const subdirCount = new Map();
  for (const meta of folderMeta.values()) subdirCount.set(meta.parent, (subdirCount.get(meta.parent) || 0) + 1);

  addNode({
    id: OKF_ROOT_ID,
    kind: "hub",
    label: "OKF Index",
    detail: `Root of the OKF taxonomy: ${Object.keys(CANONICAL).length} top-level categories, ${folderMeta.size} folders total, ${cards.length} card(s) filed. Reached from Skills and Wiki above.`,
    tags: [],
    degree: 0,
  });
  addEdge(SKILLS_ID, OKF_ROOT_ID, "system");
  addEdge(WIKI_ID, OKF_ROOT_ID, "system");

  for (const [id, meta] of folderMeta) {
    addNode({
      id,
      kind: "folder",
      label: meta.label,
      folder: id,
      detail: `${dirCardCount.get(id) || 0} card(s), ${subdirCount.get(id) || 0} subfolder(s)`,
      tags: [],
      degree: 0,
    });
    addEdge(meta.parent, id, "hierarchy");
  }

  const cardTagIndex = new Map();
  for (const card of cards) {
    if (nodes.length >= MAX_NODES) break;
    addNode({
      id: card.id,
      kind: "card",
      label: truncate(card.title, 80),
      detail: truncate(card.body, 600),
      cardType: card.type,
      folder: card.folder || "",
      tags: card.tags || [],
      degree: 0,
    });
    addEdge(ensurePath(card.folder || ""), card.id, "hierarchy");
    addEdge(SKILL_CARD_TYPES.has(card.type) ? SKILLS_ID : WIKI_ID, card.id, "system");
    for (const t of card.tags || []) {
      if (!cardTagIndex.has(t)) cardTagIndex.set(t, []);
      cardTagIndex.get(t).push(card.id);
    }
  }
  for (const card of cards) {
    for (const link of card.links || []) {
      if (knownIds.has(link)) addEdge(card.id, link, "link");
    }
  }

  // ---- Chat Memory: L1 atoms + legacy memories — always here, never routed
  // into the OKF taxonomy (NewPlanConversion.md is explicit that chat memory
  // needs its own namespace, separate from the coding knowledge base). -----
  const atoms = currentAtoms();
  const atomTagIndex = new Map();
  for (const atom of atoms) {
    if (nodes.length >= MAX_NODES) break;
    addNode({
      id: atom.id,
      kind: "atom",
      label: truncate(atom.text, 80),
      detail: truncate(atom.text, 600),
      atomType: atom.type,
      status: atom.status,
      confidence: atom.confidence,
      tags: atom.tags || [],
      sources: atom.sources || [],
      degree: 0,
    });
    addEdge(CHAT_MEMORY_ID, atom.id, "system");
    for (const t of atom.tags || []) {
      if (!atomTagIndex.has(t)) atomTagIndex.set(t, []);
      atomTagIndex.get(t).push(atom.id);
    }
  }
  for (const atom of atoms) {
    for (const c of atom.contradicts || []) if (knownIds.has(c)) addEdge(atom.id, c, "contradicts");
    for (const s of atom.supersedes || []) if (knownIds.has(s)) addEdge(atom.id, s, "supersedes");
  }

  // Legacy flat memories (only meaningful when that provider actually has
  // data — always shown so switching providers doesn't hide history).
  const legacyMemories = memoryProviders["legacy-jsonl"].search("", {}, { limit: 5000 });
  for (const m of legacyMemories) {
    if (nodes.length >= MAX_NODES) break;
    addNode({
      id: m.id,
      kind: "memory",
      label: truncate(m.text, 80),
      detail: truncate(m.text, 600),
      tags: m.tags || [],
      degree: 0,
    });
    addEdge(CHAT_MEMORY_ID, m.id, "system");
  }

  const seen = new Set();
  addTagEdges(cardTagIndex, edges, seen);
  addTagEdges(atomTagIndex, edges, seen);

  // Live-layer nodes/edges published by agent.mjs and Session ctor at runtime
  // (session, project, tool-call, file). Merged here so /api/graph responses
  // — and therefore a fresh browser refresh — include everything the session
  // has spawned, instead of the client losing them on reload.
  const live = liveGraph();
  for (const ln of live.nodes) {
    if (nodes.length >= MAX_NODES) break;
    if (knownIds.has(ln.id)) continue;
    addNode({
      id: ln.id, kind: ln.nodeKind || "live",
      label: truncate(ln.label || ln.id, 80),
      detail: truncate(ln.detail || "", 600),
      tags: [], degree: 0, meta: ln.meta || {},
    });
    if (ln.parent && knownIds.has(ln.parent)) addEdge(ln.parent, ln.id, "live");
  }
  for (const le of live.edges) {
    if (knownIds.has(le.source) && knownIds.has(le.target)) addEdge(le.source, le.target, le.kind || "live");
  }

  const degree = new Map();
  for (const e of edges) {
    degree.set(e.source, (degree.get(e.source) || 0) + 1);
    degree.set(e.target, (degree.get(e.target) || 0) + 1);
  }
  for (const n of nodes) n.degree = degree.get(n.id) || 0;

  return {
    generatedAt: new Date().toISOString(),
    okfDir: OKF_DIR,
    coordinatorId: COORDINATOR_ID,
    counts: {
      cards: cards.length,
      folders: folderMeta.size,
      atoms: atoms.length,
      activeAtoms: atoms.filter((a) => a.status === "active").length,
      memories: legacyMemories.length,
      nodes: nodes.length,
      edges: edges.length,
      truncated: cards.length + atoms.length + legacyMemories.length > MAX_NODES,
    },
    nodes,
    edges,
  };
}
