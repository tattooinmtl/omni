// Prompt templates: a Markdown file becomes a slash command.
//
// Where they live (a project one wins over a personal one of the same name):
//   .omni/commands/*.md        in the project you launched in
//   <HOME>/commands/*.md       yours, in every project
// A file in a subfolder gets the folder as a prefix: .omni/commands/git/pr.md
// is /git:pr.
//
// The body is the prompt. In it:
//   $ARGUMENTS      everything typed after the command
//   $1 … $9         one argument each ("quoted words" count as one)
//   @path/to/file   replaced by that file's contents (inside the workspace,
//                   up to 50 KB each)
// When the body uses no $ placeholder, typed arguments are added at the end.
//
// Optional frontmatter: description (shown in the / menu and /templates) and
// argument-hint (shown as the usage, e.g. "<issue number>").
//
// Unlike a skill, a template is not a set of instructions loaded for a turn:
// it is simply what gets sent, as if you had typed it.

import fs from "node:fs";
import path from "node:path";
import { HOME } from "./config.mjs";
import { parseFrontmatter } from "./frontmatter.mjs";

const MAX_INCLUDE = 50 * 1024;
const NAME_RE = /^[a-z0-9][a-z0-9_.-]*$/i;

function walk(dir, prefix, out, depth = 0) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory() && depth < 3 && NAME_RE.test(e.name)) walk(full, prefix ? `${prefix}:${e.name}` : e.name, out, depth + 1);
    else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) {
      const base = e.name.slice(0, -3);
      if (NAME_RE.test(base)) out.push({ name: prefix ? `${prefix}:${base}` : base, file: full });
    }
  }
}

function readTemplate({ name, file }, scope) {
  let raw = "";
  try { raw = fs.readFileSync(file, "utf8").replace(/^﻿/, ""); } catch { return null; }
  const { meta, body: parsedBody } = parseFrontmatter(raw);
  const body = parsedBody.trim();
  if (!body) return null;
  const firstLine = body.split(/\r?\n/).find((l) => l.trim() && !l.startsWith("#")) || "";
  return {
    name,
    command: "/" + name.toLowerCase(),
    file,
    scope,
    body,
    description: String(meta.description || firstLine).trim().slice(0, 120),
    argumentHint: meta["argument-hint"] ? String(meta["argument-hint"]) : "",
  };
}

// Every template for `cwd`, keyed by "/command". Project beats personal.
export function loadTemplates({ cwd = process.cwd(), home = HOME } = {}) {
  const map = new Map();
  const add = (dir, scope) => {
    const found = [];
    walk(dir, "", found);
    for (const f of found) {
      const t = readTemplate(f, scope);
      if (t) map.set(t.command, t);
    }
  };
  if (home) add(path.join(home, "commands"), "personal");
  add(path.join(cwd, ".omni", "commands"), "project");
  return map;
}

// Split arguments on spaces, keeping "quoted words" together.
export function splitArgs(text) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(String(text || "")))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

// @path → the file's contents, when it is a real file inside the workspace.
// Anything else (an email address, a decorator, a missing file) is left as is.
function includeFiles(text, cwd) {
  const root = path.resolve(cwd);
  return text.replace(/(^|[\s(])@([\w./\\-]+[\w])/g, (whole, lead, rel) => {
    const full = path.resolve(root, rel);
    const inside = full.toLowerCase().startsWith(root.toLowerCase() + path.sep) || full.toLowerCase() === root.toLowerCase();
    let stat;
    try { stat = inside && fs.statSync(full); } catch { stat = null; }
    if (!stat || !stat.isFile()) return whole;
    let content;
    try { content = fs.readFileSync(full, "utf8"); } catch { return whole; }
    if (content.length > MAX_INCLUDE) content = content.slice(0, MAX_INCLUDE) + `\n…[truncated at ${MAX_INCLUDE} bytes]`;
    const fence = content.includes("```") ? "~~~" : "```";
    return `${lead}${rel.replace(/\\/g, "/")}\n\n${fence}\n${content.replace(/\s+$/, "")}\n${fence}\n`;
  });
}

// The prompt a template sends for `args`.
export function expandTemplate(template, args = "", { cwd = process.cwd() } = {}) {
  const argText = String(args || "").trim();
  const positional = splitArgs(argText);
  let usedPlaceholder = false;
  let text = template.body.replace(/\$(ARGUMENTS|[1-9])\b/g, (_, key) => {
    usedPlaceholder = true;
    return key === "ARGUMENTS" ? argText : (positional[Number(key) - 1] ?? "");
  });
  if (!usedPlaceholder && argText) text += `\n\nArguments: ${argText}`;
  return includeFiles(text, cwd).trim();
}
