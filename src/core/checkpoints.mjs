// Checkpoints for /rewind.
//
// Before the first call in a turn that changes anything, the whole workspace
// is snapshotted into a shadow git repository under
// <HOME>/checkpoints/<project>/shadow.git. It is separate from the project's
// own .git (which it never touches), works in folders that aren't repos, and
// catches changes made by shell commands, not only by the edit tools. The
// project's .gitignore files are honoured, plus a default exclude list.
//
// /rewind restores the files to a checkpoint (and, optionally, cuts the
// conversation back to the prompt that started that turn). It snapshots the
// current state first, so a rewind can itself be rewound.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { HOME } from "./config.mjs";
import { atomicWriteFileSync } from "./atomic-write.mjs";

const DEFAULT_EXCLUDES = [
  ".git/", "node_modules/", "vendor/", "dist/", "build/", "out/", "target/", ".next/", ".nuxt/",
  "__pycache__/", ".venv/", "venv/", ".cache/", "coverage/", "*.log", "*.tmp",
];
const GIT_TIMEOUT_MS = 30000;

function slug(cwd) {
  return "--" + path.resolve(cwd).replace(/[:\\/]+/g, "-").replace(/^-+|-+$/g, "") + "--";
}

export class Checkpointer {
  constructor({ cwd = process.cwd(), home = HOME } = {}) {
    this.cwd = path.resolve(cwd);
    this.dir = path.join(home, "checkpoints", slug(this.cwd));
    this.gitDir = path.join(this.dir, "shadow.git");
    this.manifest = path.join(this.dir, "checkpoints.jsonl");
    this.disabled = null; // reason string once checkpoints are off for this session
  }

  git(args, { input, timeout = GIT_TIMEOUT_MS } = {}) {
    const r = spawnSync("git", [
      "-c", "core.autocrlf=false", "-c", "core.quotepath=false", "-c", "core.safecrlf=false",
      "-c", "user.name=Omni", "-c", "user.email=omni@localhost",
      `--git-dir=${this.gitDir}`, `--work-tree=${this.cwd}`, ...args,
    ], { cwd: this.cwd, encoding: "utf8", input, timeout, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
    if (r.error) {
      if (r.error.code === "ENOENT") throw new Error("git is not installed, so checkpoints are off");
      if (r.error.code === "ETIMEDOUT") throw new Error(`git took over ${Math.round(timeout / 1000)}s (is this folder very large?), so checkpoints are off`);
      throw r.error;
    }
    if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${(r.stderr || r.stdout || "").trim().split(/\r?\n/)[0]}`);
    return r.stdout;
  }

  ensureRepo() {
    if (fs.existsSync(path.join(this.gitDir, "HEAD"))) return;
    fs.mkdirSync(this.dir, { recursive: true });
    const r = spawnSync("git", ["init", "--bare", "--quiet", this.gitDir], { encoding: "utf8", windowsHide: true });
    if (r.error?.code === "ENOENT") throw new Error("git is not installed, so checkpoints are off");
    if (r.status !== 0) throw new Error(`could not create the checkpoint store: ${(r.stderr || "").trim()}`);
    fs.mkdirSync(path.join(this.gitDir, "info"), { recursive: true });
    atomicWriteFileSync(path.join(this.gitDir, "info", "exclude"), DEFAULT_EXCLUDES.join("\n") + "\n");
  }

  // Stage the whole work tree and return its tree id.
  writeTree() {
    this.git(["add", "-A", "--ignore-errors", "."]);
    return this.git(["write-tree"]).trim();
  }

  // Record a checkpoint. Returns the manifest entry. messageIndex is where the
  // turn's prompt sits in the live messages, recordCount how many
  // conversation records the log held before it (what a rewind keeps).
  snapshot({ label = "", messageIndex = null, recordCount = null, session = null, kind = "turn" } = {}) {
    if (this.disabled) throw new Error(this.disabled);
    try {
      this.ensureRepo();
      const tree = this.writeTree();
      const last = this.list({ limit: 1 })[0];
      let commit;
      if (last && last.tree === tree) commit = last.commit; // nothing changed since: reuse it
      else {
        const parent = last ? ["-p", last.commit] : [];
        commit = this.git(["commit-tree", tree, ...parent, "-m", String(label || kind).slice(0, 200)]).trim();
        this.git(["update-ref", "refs/omni/last", commit]);
      }
      const entries = this.list();
      const entry = {
        id: (entries[0]?.id || 0) + 1, commit, tree, time: new Date().toISOString(),
        label: String(label || "").split(/\r?\n/)[0].slice(0, 120), messageIndex, recordCount, session, kind,
      };
      fs.appendFileSync(this.manifest, JSON.stringify(entry) + "\n");
      return entry;
    } catch (e) {
      // One failure (no git, a huge folder) turns them off for the session
      // instead of slowing every turn down with the same error.
      this.disabled = e.message;
      throw e;
    }
  }

  // Checkpoints, newest first. `session` limits them to one session's.
  list({ session = null, limit = Infinity } = {}) {
    let lines = [];
    try { lines = fs.readFileSync(this.manifest, "utf8").split(/\r?\n/).filter(Boolean); } catch { return []; }
    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      let e;
      try { e = JSON.parse(lines[i]); } catch { continue; }
      if (session && e.session && path.resolve(e.session).toLowerCase() !== path.resolve(session).toLowerCase()) continue;
      out.push(e);
    }
    return out;
  }

  // Files that differ between a checkpoint and the work tree right now:
  // [{ status: "A"|"M"|"D", path }] where A = created since the checkpoint.
  changesSince(entry) {
    this.ensureRepo();
    const now = this.writeTree();
    return this.diffTrees(entry.tree, now);
  }

  diffTrees(from, to) {
    if (from === to) return [];
    const raw = this.git(["diff-tree", "-r", "-z", "--no-renames", "--name-status", from, to]);
    const parts = raw.split("\0").filter(Boolean);
    const out = [];
    for (let i = 0; i + 1 < parts.length; i += 2) out.push({ status: parts[i][0], path: parts[i + 1] });
    return out;
  }

  // Put the files back the way they were at `entry`. Returns
  // { undo, restored, removed } where undo is the checkpoint taken just before.
  restore(entry, { session = null, messageIndex = null } = {}) {
    if (this.disabled) throw new Error(this.disabled);
    const undo = this.snapshot({ label: `before /rewind to #${entry.id}`, session, messageIndex, kind: "undo" });
    const changes = this.diffTrees(entry.tree, undo.tree);
    const removed = [];
    const toCheckout = [];
    for (const c of changes) {
      if (c.status === "A") {
        try { fs.rmSync(path.join(this.cwd, c.path), { force: true }); removed.push(c.path); } catch { /* already gone */ }
      } else {
        toCheckout.push(c.path);
      }
    }
    if (toCheckout.length) {
      this.git(["checkout", entry.commit, "--pathspec-from-file=-", "--pathspec-file-nul"], { input: toCheckout.join("\0") });
    }
    // Leave the shadow index matching what is on disk now.
    this.writeTree();
    return { undo, restored: toCheckout, removed };
  }
}
