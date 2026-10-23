// Worktree isolation for sub-agents.
//
// A sub-agent spawned with isolation "worktree" gets its own git worktree
// (a second checkout of the repo) on a new branch, under
// <HOME>/worktrees/<project>/<agent id>. It works there, so it can never
// collide with your files or with another agent's, and nothing lands in your
// checkout until merge_agent merges the branch, after self_review has looked
// at the diff.
//
// Omni's file tools resolve paths against the process's working folder, so
// an in-process sub-agent can't work in a different checkout. A worktree
// agent therefore runs as a separate headless Omni (`omni -p --output json`)
// started inside the worktree, and its JSON result comes back here.
//
// The branch starts from your last commit: uncommitted changes in your
// checkout are not in it.

import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { HOME } from "./config.mjs";
import { INSTALL_ROOT } from "../paths.mjs";
import { findProjectRoot } from "./instructions.mjs";

function git(cwd, args, { input, allowFail = false, identity = false } = {}) {
  const pre = ["-c", "core.quotepath=false"];
  // Commits need an identity; fall back to Omni's only when the repo has none.
  if (identity && !hasIdentity(cwd)) pre.push("-c", "user.name=Omni", "-c", "user.email=omni@localhost");
  const r = spawnSync("git", [...pre, ...args], { cwd, encoding: "utf8", input, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new Error(r.error.code === "ENOENT" ? "git is not installed" : r.error.message);
  if (r.status !== 0 && !allowFail) throw new Error(`git ${args[0]} failed: ${(r.stderr || r.stdout || "").trim().split(/\r?\n/).slice(0, 3).join(" ")}`);
  return { ok: r.status === 0, out: r.stdout || "", err: r.stderr || "" };
}

function hasIdentity(cwd) {
  const r = spawnSync("git", ["config", "user.email"], { cwd, encoding: "utf8", windowsHide: true });
  return r.status === 0 && Boolean((r.stdout || "").trim());
}

function slug(p) {
  return "--" + path.resolve(p).replace(/[:\\/]+/g, "-").replace(/^-+|-+$/g, "") + "--";
}

// Make the worktree. Returns { root, path, branch, cwd } where cwd is the
// folder inside the worktree matching where you are in the repo.
export function createAgentWorktree({ id, cwd = process.cwd(), home = HOME } = {}) {
  const root = findProjectRoot(cwd);
  if (!root) throw new Error("worktree isolation needs a git repository, and this folder is not in one; spawn without isolation instead");
  if (!git(root, ["rev-parse", "--verify", "HEAD"], { allowFail: true }).ok) {
    throw new Error("worktree isolation needs at least one commit to branch from");
  }
  const dir = path.join(home, "worktrees", slug(root), String(id).toLowerCase());
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  const branch = `omni/agent-${String(id).toLowerCase()}-${Date.now().toString(36)}`;
  git(root, ["worktree", "add", "-b", branch, dir, "HEAD"]);
  const rel = path.relative(root, path.resolve(cwd));
  const dirty = git(root, ["status", "--porcelain", "--untracked-files=no"], { allowFail: true }).out.trim().length > 0;
  return { root, path: dir, branch, cwd: rel && !rel.startsWith("..") ? path.join(dir, rel) : dir, dirty };
}

// Run a headless Omni in `cwd` with `prompt` on stdin. Resolves with
// { code, result } where result is the parsed JSON result (or null).
export function runHeadlessAgent({ cwd, prompt, model = null, agent = null, mode = "accept-edits", maxTurns = null, signal = null, env = {} } = {}) {
  return new Promise((resolve) => {
    const args = [path.join(INSTALL_ROOT, "bin", "omni.mjs"), "-p", "--output", "json", "--mode", mode];
    if (model) args.push("--model", model);
    if (agent) args.push("--agent", agent);
    if (maxTurns) args.push("--max-turns", String(maxTurns));
    const child = spawn(process.execPath, args, {
      cwd,
      env: { ...process.env, OMNI_SESSION_KIND: "subagent", ...env },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { if (stderr.length < 200000) stderr += d; });
    child.stdin.on("error", () => {});
    child.stdin.end(String(prompt));
    const onAbort = () => {
      try {
        if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
        else child.kill("SIGKILL");
      } catch { /* already gone */ }
    };
    signal?.addEventListener?.("abort", onAbort, { once: true });
    child.on("error", (e) => resolve({ code: null, result: null, stderr: e.message }));
    child.on("close", (code) => {
      signal?.removeEventListener?.("abort", onAbort);
      let result = null;
      const last = stdout.trim().split(/\r?\n/).filter(Boolean).pop();
      try { result = last ? JSON.parse(last) : null; } catch { /* not JSON */ }
      resolve({ code, result, stderr });
    });
  });
}

// Commit whatever the agent left in its worktree. Returns
// { changes: [{ status, path }], commit } (commit null when nothing changed).
export function commitAgentWork({ path: dir, message }) {
  git(dir, ["add", "-A"]);
  const raw = git(dir, ["diff", "--cached", "--name-status", "--no-renames"]).out.trim();
  const changes = raw ? raw.split(/\r?\n/).map((l) => { const [status, ...p] = l.split("\t"); return { status: status[0], path: p.join("\t") }; }) : [];
  if (!changes.length) return { changes, commit: null };
  git(dir, ["commit", "-q", "-m", message], { identity: true });
  return { changes, commit: git(dir, ["rev-parse", "HEAD"]).out.trim() };
}

// What merging the branch would bring in: changes since the branch point.
export function branchDiff({ root, branch }) {
  return git(root, ["diff", `HEAD...${branch}`]).out;
}

// Merge the agent's branch into whatever is checked out at `root`. On a
// conflict the merge is aborted and nothing changes.
export function mergeAgentBranch({ root, branch, message }) {
  const r = git(root, ["merge", "--no-ff", "-m", message, branch], { allowFail: true, identity: true });
  if (!r.ok) {
    git(root, ["merge", "--abort"], { allowFail: true });
    throw new Error(`the merge did not apply cleanly and was undone: ${(r.err || r.out).trim().split(/\r?\n/).slice(0, 4).join(" ")}`);
  }
  return git(root, ["rev-parse", "HEAD"]).out.trim();
}

// Remove the worktree folder and (unless keepBranch) its branch.
export function removeAgentWorktree({ root, path: dir, branch, keepBranch = false }) {
  git(root, ["worktree", "remove", "--force", dir], { allowFail: true });
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  git(root, ["worktree", "prune"], { allowFail: true });
  if (!keepBranch) git(root, ["branch", "-D", branch], { allowFail: true });
}
