# Working on this repo

Instructions for any coding agent (Claude Code, Codex, Omni itself) making
changes here. `CLAUDE.md` points here, so there is one copy to keep current.

## Shipping is part of the change

Work does not count as delivered while it sits on a branch. Unless the user
says otherwise, finish every change by landing it on `main`:

1. Run the full suite, `npm test` (`node tests/run-all.mjs`). It must be green.
2. **Bump the version, every time, without being asked.** Every PR that merges
   into `main` gets the next patch version on the current line (3.5.5 → 3.5.6).
   Change it in `package.json` and in `package-lock.json` (the top-level field
   and `packages[""]`), and update the website fallback (below). Bump once per
   PR: if your branch already bumped and hasn't merged, don't bump again. If
   `main` moved past your version while you worked, re-bump to the next free
   number. Move to a new minor or major line (3.6.0, 4.0.0) only when the user
   asks.
3. **Add an entry to [CHANGELOG.md](CHANGELOG.md)** for that version in the
   same PR (see below). No change reaches `main` without one.
4. Commit and push to a branch.
5. Open a PR into `main` and **merge it**. Wait for the checks (GitGuardian,
   Sourcery) to finish first; do not merge over a failing one.

Pushing and merging on this repo (`tattooinmtl/omni`) is pre-authorized, so do
it without stopping to ask. Ask only when checks fail, the merge conflicts, or
the change is something the user did not request.

## The changelog is the record of what shipped

`CHANGELOG.md` is the single source of truth for every change that reached
`main`. Don't keep a separate push log or bug list; a bug report file (such as
`NEWBUGS_*.md`) is retired by moving its items into the changelog entry that
fixes them.

For every PR, before merging, add a `## <version> — <YYYY-MM-DD>` section at
the top (below the intro), matching the version you bumped to:

- It starts with a **Shipped** line:
  `PR · merge commit · branch · session`.
  - Session: your agent session id if your harness exposes one (for Claude
    Code, the id in the session's transcript path). Otherwise write `—`.
  - The merge commit doesn't exist until the PR merges. Write `this PR` for
    the PR and leave the commit out, then fill both in on your next
    changelog edit. Every entry must be traceable to a PR.
- Then list what changed in plain words: user-visible behaviour first, then
  the tests that pin it.

## The version number is public in two places

Both read `package.json` **from `main`**, which is why a bump that stays on a
branch changes nothing the user can see:

- `website/index.html` fetches
  `raw.githubusercontent.com/tattooinmtl/omni/main/package.json` on page load.
- The installer reads the same file to decide what to download.

`website/` is gitignored and deployed separately, so it only exists in the main
checkout (`~/.omni`), not in worktrees. Its hardcoded banner version
(`id="omni-version"`) is only the offline fallback. Update it alongside
`package.json` and tell the user to redeploy. `tests/website-version.test.mjs`
guards the two against drift, but it skips when `website/` is absent, so run
it from the main checkout after a bump.

## Tests

Suites live in `tests/*.test.mjs`, zero dependencies, run by
`tests/run-all.mjs`. A bug fix lands with a test that fails without it. Keep
tests hermetic: never assert against this repo's own working tree (a test that
read `package.json`'s diff passed only while the tree happened to be clean, and
a version bump sent it off to make a real model call).
