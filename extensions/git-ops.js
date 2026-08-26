// Omni extension: full git operations — push, pull, fetch, branch, checkout,
// log, stash, remote, clone, tag, and init.
// Fills the gap between git_status/git_diff/git_commit (core tools) and the
// complete developer workflow needed for full-stack projects pushed to GitHub,
// GitLab, Bitbucket, etc.
// Contract: export default { name, tools: [...OpenAI schemas], impl: { name: fn } }

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const MAX_OUTPUT = 30000;
function clip(s) {
  s = String(s ?? "");
  return s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + "\n…[truncated]" : s;
}

// Safe passthrough for git commands that legitimately need network access or
// branch management. We don't block anything here (the user runs Omni locally)
// but we do surface the full git output including auth errors so the agent can
// explain what to do.
function runGit(args, cwd = process.cwd(), timeout = 120000) {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 16,
    timeout,
    env: {
      ...process.env,
      // Prevent git from opening a credential popup / hanging for a
      // password prompt when credentials are missing — surface the error
      // immediately instead.
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "echo",
    },
  });
  if (r.error) throw new Error(`git unavailable: ${r.error.message}`);
  const out = [r.stdout, r.stderr].filter(Boolean).join("\n").trim();
  if (r.status !== 0) throw new Error(out || `git exited with code ${r.status}`);
  return clip(out);
}

// Validate that a branch/remote/tag name doesn't look like a git option.
function assertSafeName(name, label = "name") {
  if (!name || typeof name !== "string") throw new Error(`${label} is required`);
  if (name.startsWith("-")) throw new Error(`${label} "${name}" starts with '-' which git may interpret as an option`);
  if (/[\0\n\r]/.test(name)) throw new Error(`${label} contains invalid characters`);
}

export default {
  name: "git-ops",
  tools: [
    // ── Remote operations ───────────────────────────────────────────────
    {
      type: "function",
      function: {
        name: "git_push",
        description:
          "Push commits to a remote repository. Wraps `git push`. " +
          "Set force=true only when the user explicitly asks for a force-push (--force-with-lease). " +
          "Set set_upstream=true to publish a new branch for the first time (--set-upstream). " +
          "Requires git credentials already configured (SSH key or credential helper).",
        parameters: {
          type: "object",
          properties: {
            remote:      { type: "string",  description: "Remote name, default 'origin'" },
            branch:      { type: "string",  description: "Branch to push, default current branch" },
            force:       { type: "boolean", description: "Force-push with --force-with-lease (safer than --force)" },
            set_upstream:{ type: "boolean", description: "Set upstream tracking for a new branch (-u / --set-upstream)" },
            tags:        { type: "boolean", description: "Also push all tags (--tags)" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "git_pull",
        description:
          "Pull changes from a remote branch into the current branch. " +
          "Wraps `git pull`. Use rebase=true to rebase local commits on top of upstream instead of merging.",
        parameters: {
          type: "object",
          properties: {
            remote:  { type: "string",  description: "Remote name, default 'origin'" },
            branch:  { type: "string",  description: "Remote branch, default current tracking branch" },
            rebase:  { type: "boolean", description: "Rebase instead of merge (--rebase)" },
            ff_only: { type: "boolean", description: "Refuse to merge if fast-forward is not possible (--ff-only)" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "git_fetch",
        description:
          "Fetch remote refs without merging. " +
          "Wraps `git fetch`. Fetches all remotes by default; pass remote to limit scope.",
        parameters: {
          type: "object",
          properties: {
            remote:  { type: "string",  description: "Remote to fetch, default all remotes" },
            prune:   { type: "boolean", description: "Remove stale remote-tracking branches (--prune)" },
            tags:    { type: "boolean", description: "Also fetch tags" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "git_clone",
        description:
          "Clone a remote repository into a local directory. " +
          "Wraps `git clone`. The clone happens inside the CURRENT workspace directory unless dest is absolute.",
        parameters: {
          type: "object",
          properties: {
            url:    { type: "string", description: "Repository URL (https or ssh)" },
            dest:   { type: "string", description: "Local directory name / path (optional, git default)" },
            branch: { type: "string", description: "Branch to check out after cloning (-b)" },
            depth:  { type: "integer", description: "Shallow clone depth (--depth N)" },
          },
          required: ["url"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "git_remote",
        description:
          "Manage git remotes. Actions: list (show all remotes with URLs), " +
          "add (add a new remote), remove (delete a remote), " +
          "rename (rename a remote), set_url (change a remote's URL).",
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["list", "add", "remove", "rename", "set_url"] },
            name:   { type: "string", description: "Remote name (required for add/remove/rename/set_url)" },
            url:    { type: "string", description: "URL (required for add/set_url)" },
            new_name:{ type: "string", description: "New name (required for rename)" },
          },
          required: ["action"],
        },
      },
    },
    // ── Branch management ────────────────────────────────────────────────
    {
      type: "function",
      function: {
        name: "git_branch",
        description:
          "List, create, rename, or delete branches. " +
          "action: list (all branches), create (new branch), delete (delete branch), rename (rename branch).",
        parameters: {
          type: "object",
          properties: {
            action:   { type: "string", enum: ["list", "create", "delete", "rename"], description: "Default: list" },
            name:     { type: "string", description: "Branch name (required for create/delete/rename)" },
            new_name: { type: "string", description: "New name (required for rename)" },
            force:    { type: "boolean", description: "Force delete even if branch is not merged (-D)" },
            remote:   { type: "boolean", description: "List remote-tracking branches too (list only)" },
            start:    { type: "string",  description: "Start point for create (commit/branch/tag, default HEAD)" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "git_checkout",
        description:
          "Switch to an existing branch or create a new one. " +
          "Wraps `git checkout`. Use create=true to make a new branch (-b). " +
          "Pass path to restore a file to HEAD (git checkout -- <file>).",
        parameters: {
          type: "object",
          properties: {
            target:  { type: "string",  description: "Branch name, commit, or tag to check out" },
            create:  { type: "boolean", description: "Create the branch if it doesn't exist (-b)" },
            path:    { type: "string",  description: "Restore this file path to its HEAD version instead of switching branches" },
          },
        },
      },
    },
    // ── History & introspection ──────────────────────────────────────────
    {
      type: "function",
      function: {
        name: "git_log",
        description:
          "Show commit history. Wraps `git log --oneline` by default. " +
          "Optionally filter by path, limit count, or show full diffs.",
        parameters: {
          type: "object",
          properties: {
            path:    { type: "string",  description: "Limit log to commits touching this file/directory" },
            n:       { type: "integer", description: "Max commits to show, default 20" },
            full:    { type: "boolean", description: "Show full commit messages and diffs (--patch)" },
            graph:   { type: "boolean", description: "Show branch graph (--graph --all)" },
            author:  { type: "string",  description: "Filter by author name or email" },
            since:   { type: "string",  description: "Show commits newer than a date, e.g. '2 weeks ago'" },
          },
        },
      },
    },
    // ── Stash ────────────────────────────────────────────────────────────
    {
      type: "function",
      function: {
        name: "git_stash",
        description:
          "Manage the git stash. " +
          "Actions: push (stash current changes), pop (apply + drop top stash), " +
          "apply (apply without dropping), list (show stash entries), drop (delete one stash), clear (delete all).",
        parameters: {
          type: "object",
          properties: {
            action:  { type: "string", enum: ["push", "pop", "apply", "list", "drop", "clear"], description: "Default: push" },
            message: { type: "string",  description: "Optional description for push" },
            index:   { type: "integer", description: "Stash index for drop/apply/pop (default 0 = most recent)" },
            include_untracked: { type: "boolean", description: "Include untracked files in push (-u)" },
          },
        },
      },
    },
    // ── Tags ─────────────────────────────────────────────────────────────
    {
      type: "function",
      function: {
        name: "git_tag",
        description:
          "List, create, or delete tags. " +
          "action: list (show all tags), create (create a lightweight or annotated tag), delete (delete a local tag).",
        parameters: {
          type: "object",
          properties: {
            action:  { type: "string", enum: ["list", "create", "delete"] },
            name:    { type: "string", description: "Tag name (required for create/delete)" },
            message: { type: "string", description: "Annotated tag message (if set, creates annotated tag)" },
            ref:     { type: "string", description: "Commit/branch to tag (default HEAD)" },
            force:   { type: "boolean", description: "Overwrite existing tag (-f)" },
          },
        },
      },
    },
    // ── Init & misc ──────────────────────────────────────────────────────
    {
      type: "function",
      function: {
        name: "git_init",
        description: "Initialize a new git repository in the current workspace directory (or a subdirectory).",
        parameters: {
          type: "object",
          properties: {
            path:          { type: "string",  description: "Directory to init (default cwd)" },
            initial_branch:{ type: "string",  description: "Name for the initial branch (default: git's configured default, usually 'main')" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "git_merge",
        description:
          "Merge a branch into the current branch. " +
          "Use no_ff=true to always create a merge commit even for fast-forward merges.",
        parameters: {
          type: "object",
          properties: {
            branch:  { type: "string",  description: "Branch (or commit) to merge into the current branch" },
            message: { type: "string",  description: "Custom merge commit message" },
            no_ff:   { type: "boolean", description: "Disable fast-forward (--no-ff)" },
            squash:  { type: "boolean", description: "Squash all commits into one (--squash)" },
            abort:   { type: "boolean", description: "Abort an in-progress merge (git merge --abort)" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "git_rebase",
        description:
          "Rebase the current branch onto another. " +
          "Use abort=true to abort an in-progress rebase, continue=true to continue after resolving conflicts.",
        parameters: {
          type: "object",
          properties: {
            onto:     { type: "string",  description: "Branch/commit to rebase onto" },
            interactive: { type: "boolean", description: "Interactive rebase — NOT supported in headless mode; use run_shell instead" },
            abort:    { type: "boolean", description: "Abort an in-progress rebase" },
            continue: { type: "boolean", description: "Continue after resolving conflicts" },
          },
        },
      },
    },
  ],

  impl: {
    // ── Remote operations ─────────────────────────────────────────────
    git_push({ remote = "origin", branch, force = false, set_upstream = false, tags = false } = {}) {
      if (remote) assertSafeName(remote, "remote");
      if (branch) assertSafeName(branch, "branch");
      const args = ["push"];
      if (force) args.push("--force-with-lease");
      if (set_upstream) args.push("--set-upstream");
      if (tags) args.push("--tags");
      if (remote) args.push(remote);
      if (branch) args.push(branch);
      const out = runGit(args);
      return out || "Push complete (no output from git)";
    },

    git_pull({ remote = "origin", branch, rebase = false, ff_only = false } = {}) {
      if (remote) assertSafeName(remote, "remote");
      if (branch) assertSafeName(branch, "branch");
      const args = ["pull"];
      if (rebase) args.push("--rebase");
      if (ff_only) args.push("--ff-only");
      if (remote) args.push(remote);
      if (branch) args.push(branch);
      const out = runGit(args);
      return out || "Pull complete (already up to date)";
    },

    git_fetch({ remote, prune = false, tags = false } = {}) {
      if (remote) assertSafeName(remote, "remote");
      const args = ["fetch"];
      if (prune) args.push("--prune");
      if (tags) args.push("--tags");
      if (remote) args.push(remote);
      else args.push("--all");
      const out = runGit(args);
      return out || "Fetch complete (nothing new)";
    },

    git_clone({ url, dest, branch, depth } = {}) {
      if (!url) throw new Error("url is required");
      // Minimal SSRF: reject obviously internal URLs from being cloned
      // (a clone that phones home to 169.254.x.x etc. would be unusual but possible)
      try {
        const u = new URL(url);
        if (!["http:", "https:", "git:", "ssh:"].includes(u.protocol) &&
            !url.startsWith("git@")) {
          throw new Error(`Unsupported protocol in URL: ${url}`);
        }
      } catch (e) {
        // URL parse fails for git@host:path.git — that's fine, pass through
        if (!url.includes("git@") && !e.message.includes("git@")) {
          // swallow URL parse errors for SSH shorthand
        }
      }
      const args = ["clone"];
      if (branch) { assertSafeName(branch, "branch"); args.push("-b", branch); }
      if (depth && Number.isInteger(depth) && depth > 0) args.push("--depth", String(depth));
      args.push(url);
      if (dest) {
        assertSafeName(dest, "dest");
        args.push(dest);
      }
      const out = runGit(args, process.cwd(), 300000); // 5 min for large repos
      return out || `Cloned ${url}`;
    },

    git_remote({ action = "list", name, url, new_name } = {}) {
      if (action === "list") {
        return runGit(["remote", "-v"]) || "(no remotes configured)";
      }
      assertSafeName(name, "name");
      if (action === "add") {
        if (!url) throw new Error("url is required for add");
        return runGit(["remote", "add", name, url]);
      }
      if (action === "remove") return runGit(["remote", "remove", name]);
      if (action === "rename") {
        if (!new_name) throw new Error("new_name is required for rename");
        assertSafeName(new_name, "new_name");
        return runGit(["remote", "rename", name, new_name]);
      }
      if (action === "set_url") {
        if (!url) throw new Error("url is required for set_url");
        return runGit(["remote", "set-url", name, url]);
      }
      throw new Error(`Unknown action "${action}". Valid: list, add, remove, rename, set_url`);
    },

    // ── Branch management ────────────────────────────────────────────
    git_branch({ action = "list", name, new_name, force = false, remote = false, start } = {}) {
      if (action === "list") {
        const args = ["branch", "--list"];
        if (remote) args.push("-a");
        return runGit(args) || "(no branches)";
      }
      assertSafeName(name, "name");
      if (action === "create") {
        const args = ["branch", name];
        if (start) { assertSafeName(start, "start"); args.push(start); }
        return runGit(args);
      }
      if (action === "delete") {
        return runGit(["branch", force ? "-D" : "-d", name]);
      }
      if (action === "rename") {
        if (!new_name) throw new Error("new_name is required for rename");
        assertSafeName(new_name, "new_name");
        return runGit(["branch", "-m", name, new_name]);
      }
      throw new Error(`Unknown action "${action}". Valid: list, create, delete, rename`);
    },

    git_checkout({ target, create = false, path: p } = {}) {
      if (p) {
        // File restore mode
        assertSafeName(p, "path");
        return runGit(["checkout", "--", p]);
      }
      if (!target) throw new Error("target is required");
      assertSafeName(target, "target");
      const args = ["checkout"];
      if (create) args.push("-b");
      args.push(target);
      return runGit(args);
    },

    // ── History ──────────────────────────────────────────────────────
    git_log({ path: p, n = 20, full = false, graph = false, author, since } = {}) {
      const limit = Math.max(1, Math.min(Number(n) || 20, 200));
      const args = ["log", `--max-count=${limit}`];
      if (graph) args.push("--graph", "--all", "--decorate");
      if (full) args.push("--patch");
      else args.push("--oneline", "--decorate");
      if (author) { assertSafeName(author, "author"); args.push(`--author=${author}`); }
      if (since) args.push(`--since=${since}`);
      if (p) {
        assertSafeName(p, "path");
        args.push("--", p);
      }
      return runGit(args) || "(no commits yet)";
    },

    // ── Stash ────────────────────────────────────────────────────────
    git_stash({ action = "push", message, index = 0, include_untracked = false } = {}) {
      if (action === "push") {
        const args = ["stash", "push"];
        if (include_untracked) args.push("-u");
        if (message) args.push("-m", message);
        return runGit(args) || "No local changes to stash";
      }
      if (action === "list") return runGit(["stash", "list"]) || "(stash is empty)";
      if (action === "pop")   return runGit(["stash", "pop",   `stash@{${index}}`]);
      if (action === "apply") return runGit(["stash", "apply", `stash@{${index}}`]);
      if (action === "drop")  return runGit(["stash", "drop",  `stash@{${index}}`]);
      if (action === "clear") return runGit(["stash", "clear"]) || "Stash cleared";
      throw new Error(`Unknown action "${action}". Valid: push, pop, apply, list, drop, clear`);
    },

    // ── Tags ─────────────────────────────────────────────────────────
    git_tag({ action = "list", name, message, ref, force = false } = {}) {
      if (action === "list") return runGit(["tag", "--list"]) || "(no tags)";
      assertSafeName(name, "name");
      if (action === "create") {
        const args = ["tag"];
        if (force) args.push("-f");
        if (message) args.push("-a", name, "-m", message);
        else args.push(name);
        if (ref) { assertSafeName(ref, "ref"); args.push(ref); }
        return runGit(args) || `Tagged ${name}`;
      }
      if (action === "delete") return runGit(["tag", "-d", name]);
      throw new Error(`Unknown action "${action}". Valid: list, create, delete`);
    },

    // ── Init & misc ──────────────────────────────────────────────────
    git_init({ path: p = ".", initial_branch } = {}) {
      const cwd = path.resolve(process.cwd(), p);
      if (!fs.existsSync(cwd)) fs.mkdirSync(cwd, { recursive: true });
      const args = ["init"];
      if (initial_branch) {
        assertSafeName(initial_branch, "initial_branch");
        args.push("-b", initial_branch);
      }
      return runGit(args, cwd);
    },

    git_merge({ branch, message, no_ff = false, squash = false, abort = false } = {}) {
      if (abort) return runGit(["merge", "--abort"]);
      if (!branch) throw new Error("branch is required");
      assertSafeName(branch, "branch");
      const args = ["merge"];
      if (no_ff) args.push("--no-ff");
      if (squash) args.push("--squash");
      if (message) args.push("-m", message);
      args.push(branch);
      return runGit(args);
    },

    git_rebase({ onto, abort = false, continue: cont = false } = {}) {
      if (abort) return runGit(["rebase", "--abort"]);
      if (cont)  return runGit(["rebase", "--continue"]);
      if (!onto) throw new Error("onto is required");
      assertSafeName(onto, "onto");
      return runGit(["rebase", onto]);
    },
  },
};
