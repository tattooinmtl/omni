// The last omni.brains page/link snapshot, for the /neuralview galaxy.
//
// Zero-dependency on purpose (like graph-ids.mjs): integrations/omnibrains.mjs
// WRITES it after fetching pages and links over MCP, and local/galaxy-graph.mjs
// READS it while building the graph synchronously, so the galaxy never imports
// the MCP client or waits on the brain.
//
// Snapshot shape:
//   { pages: [{ slug, title, type, sourceId, updatedAt }],
//     links: [{ from, to, type }],          // page ids ("<source>:<slug>")
//     fetchedAt: ISO string, truncated: boolean, totalPages: number|null }

let snapshot = null;

export function setBrainGraph(next) {
  snapshot = next || null;
}

export function brainGraph() {
  return snapshot;
}

export function brainPageId(sourceId, slug) {
  return `brain:${sourceId || "default"}:${slug}`;
}
