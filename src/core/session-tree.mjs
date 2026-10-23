// /tree: how this folder's conversations branched.
//
// /fork writes {type:"forked_from", file} into the new log and /resume writes
// {type:"resumed_from", file}, so every log knows where it came from. This
// links them into a tree: each conversation under the one it was forked or
// resumed from, oldest first.

import path from "node:path";
import fs from "node:fs";
import { projectSessionsDir, readSessionRecords, describeSession } from "./config.mjs";

const key = (f) => path.resolve(f).toLowerCase();

// The conversation a log was last forked or resumed from: { file, how } or null.
export function sessionParent(records) {
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i];
    if ((r.type === "forked_from" || r.type === "resumed_from") && r.file) return { file: r.file, how: r.type === "forked_from" ? "fork" : "resume" };
  }
  return null;
}

// Roots of the tree for `cwd`: [{ info, how, children: [...] }], oldest
// first. Logs nothing was typed into, and sub-agent logs, are left out unless
// `include` (the running session) names them.
export function buildSessionTree({ cwd = process.cwd(), include = null } = {}) {
  let files = [];
  const dir = projectSessionsDir(cwd);
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort().map((f) => path.join(dir, f)); } catch { return []; }
  const nodes = new Map();
  for (const file of files) {
    const records = readSessionRecords(file);
    const info = describeSession(file, records);
    const keep = (info.kind === "main" && info.prompts > 0) || (include && key(include) === key(file));
    if (!keep) continue;
    nodes.set(key(file), { info, parent: sessionParent(records), how: null, children: [] });
  }
  const roots = [];
  for (const node of nodes.values()) {
    const parent = node.parent && nodes.get(key(node.parent.file));
    if (parent && parent !== node) {
      node.how = node.parent.how;
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

// Depth-first rows for display and picking: [{ node, depth, prefix }].
export function flattenTree(roots) {
  const rows = [];
  const walk = (list, depth, lead) => {
    list.forEach((node, i) => {
      const last = i === list.length - 1;
      rows.push({ node, depth, prefix: depth ? lead + (last ? "└─ " : "├─ ") : "" });
      walk(node.children, depth + 1, depth ? lead + (last ? "   " : "│  ") : "");
    });
  };
  walk(roots, 0, "");
  return rows;
}
