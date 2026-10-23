// Training data for the intent router from your own sessions.
//
// The router (router/) picks the "coding" or "assistant" persona for each
// prompt, trained on router/data/seed.jsonl. This labels the prompts you
// actually typed by what the agent then did:
//   coding     the turn edited files, ran commands, or worked through the code
//   assistant  the turn answered without touching the project
// and writes them to router/data/sessions.jsonl (gitignored: it holds your
// own prompts), which router/train.py and train_intent_model.py read on top
// of the seed. Nothing leaves the machine.

import fs from "node:fs";
import path from "node:path";
import { SESSIONS_DIR, projectSessionsDir, readSessionRecords, describeSession } from "./config.mjs";
import { effectiveRecords } from "./session-export.mjs";
import { INSTALL_ROOT } from "../paths.mjs";
import { atomicWriteFileSync } from "./atomic-write.mjs";

// Tools that mean the turn was working on code.
const CODING = /^(write_file|edit_file|edit_lines|apply_patch|find_replace|move_file|copy_file|delete_path|make_dir|run_shell|run_test|start_process|git_\w+|lsp|find_symbol|rename_symbol|project_inspect|deps|lint_check|test_coverage|security_scan|read_file|read_many_files|search|find_files|list_dir|rag_search|diff_files|spawn_agent|self_review)$/;

function typed(content) {
  return typeof content === "string" && content.trim().length >= 4 && !/^(\(btw|\[)/.test(content.trim());
}

// [{ text, label }] for one session's records: each prompt you typed,
// labelled by the tool calls that followed it up to the next prompt. A
// prompt the agent never answered is skipped.
export function labelTurns(records) {
  const out = [];
  let current = null;
  const flush = () => {
    if (current && current.answered) out.push({ text: current.text.slice(0, 500), label: current.coding ? "coding" : "assistant" });
    current = null;
  };
  for (const r of effectiveRecords(records)) {
    if (r.type === "user" && typed(r.content)) { flush(); current = { text: r.content.trim(), coding: false, answered: false }; continue; }
    if (!current) continue;
    if (r.type === "assistant") {
      current.answered = true;
      for (const c of r.message?.tool_calls || []) if (CODING.test(c.function?.name || "")) current.coding = true;
    }
  }
  flush();
  return out;
}

// Collect labelled prompts from this folder's sessions (or every folder's),
// deduplicated by text, and write them out. Returns { file, count, coding, assistant }.
export function exportRouterData({ cwd = process.cwd(), all = false, out = path.join(INSTALL_ROOT, "router", "data", "sessions.jsonl") } = {}) {
  const dirs = [];
  if (all) { try { for (const d of fs.readdirSync(SESSIONS_DIR)) dirs.push(path.join(SESSIONS_DIR, d)); } catch { /* no sessions */ } }
  else dirs.push(projectSessionsDir(cwd));
  const seen = new Map();
  for (const dir of dirs) {
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")); } catch { continue; }
    for (const f of files) {
      const file = path.join(dir, f);
      const records = readSessionRecords(file);
      if (describeSession(file, records).kind !== "main") continue;
      for (const row of labelTurns(records)) seen.set(row.text.toLowerCase(), row);
    }
  }
  const rows = [...seen.values()];
  fs.mkdirSync(path.dirname(out), { recursive: true });
  atomicWriteFileSync(out, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
  return {
    file: out,
    count: rows.length,
    coding: rows.filter((r) => r.label === "coding").length,
    assistant: rows.filter((r) => r.label === "assistant").length,
  };
}
