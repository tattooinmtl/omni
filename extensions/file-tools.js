// Omni extension: extra filesystem tools (move, copy, delete, mkdir).
// Loaded via omni.config.json -> extensions. Contract:
//   export default { name, tools: [...], impl: { toolName: fn } }

import fs from "node:fs";
import path from "node:path";

function resolve(p) {
  const root = path.resolve(process.cwd());
  const full = path.resolve(root, p);
  const rel = path.relative(root, full);
  if (rel !== "" && (rel.startsWith("..") || path.isAbsolute(rel))) {
    throw new Error(`path escapes workspace: ${rel || full}`);
  }

  // Lexical containment isn't enough — a symlink inside the workspace can
  // point outside it. Resolve realpaths (walking up past any path segment
  // that doesn't exist yet, e.g. a file about to be created) and check
  // containment again against the real, symlink-resolved locations.
  const realRoot = fs.realpathSync(root);
  let dir = full;
  let suffix = "";
  let realDir;
  for (;;) {
    try {
      realDir = fs.realpathSync(dir);
      break;
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      const parent = path.dirname(dir);
      if (parent === dir) throw e; // reached filesystem root without finding anything real
      suffix = suffix ? path.join(path.basename(dir), suffix) : path.basename(dir);
      dir = parent;
    }
  }
  const realFull = suffix ? path.join(realDir, suffix) : realDir;
  const realRel = path.relative(realRoot, realFull);
  if (realRel !== "" && (realRel.startsWith("..") || path.isAbsolute(realRel))) {
    throw new Error(`path escapes workspace via a symlink: ${rel || full}`);
  }
  return full;
}

export default {
  name: "file-tools",
  tools: [
    {
      type: "function",
      function: {
        name: "move_file",
        description: "Move or rename a file or directory.",
        parameters: {
          type: "object",
          properties: { from: { type: "string" }, to: { type: "string" } },
          required: ["from", "to"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "copy_file",
        description: "Copy a file or directory.",
        parameters: {
          type: "object",
          properties: { from: { type: "string" }, to: { type: "string" } },
          required: ["from", "to"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "delete_path",
        description: "Delete a file or directory (recursive).",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "make_dir",
        description: "Create a directory (and parents).",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    },
  ],
  impl: {
    move_file({ from, to }) {
      fs.mkdirSync(path.dirname(resolve(to)), { recursive: true });
      fs.renameSync(resolve(from), resolve(to));
      return `Moved ${from} -> ${to}`;
    },
    copy_file({ from, to }) {
      fs.mkdirSync(path.dirname(resolve(to)), { recursive: true });
      fs.cpSync(resolve(from), resolve(to), { recursive: true });
      return `Copied ${from} -> ${to}`;
    },
    delete_path({ path: p }) {
      fs.rmSync(resolve(p), { recursive: true, force: true });
      return `Deleted ${p}`;
    },
    make_dir({ path: p }) {
      fs.mkdirSync(resolve(p), { recursive: true });
      return `Created directory ${p}`;
    },
  },
};
