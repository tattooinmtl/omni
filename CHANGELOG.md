# Changelog

The single record of every change that reached `main`: what changed, in which
version, and how it got there (PR, merge commit, branch, agent session).
Newest first. The rules for keeping it up to date are in [AGENTS.md](AGENTS.md).

Each entry's **Shipped** line reads:
`PR · merge commit · branch · session`. A `—` means it wasn't recorded (older
entries were rebuilt from git history).

## 3.5.6 — 2026-09-25

- **Shipped:** [#19](https://github.com/tattooinmtl/omni/pull/19) · merge commit in the PR · chore/changelog · session `cb62e1a3-538e-4079-8cc4-aa7114a888a0`
- Added this `CHANGELOG.md`, backfilled from the git and PR history.
- `AGENTS.md` and `CLAUDE.md` are now tracked, so every clone and worktree
  sees the instructions (they were git-ignored and existed in one checkout
  only).
- `AGENTS.md` now requires, for every PR that merges: an automatic patch
  version bump (no need to ask) and a changelog entry for that version.

## 3.5.5 — 2026-09-25

- **Shipped:** [#18](https://github.com/tattooinmtl/omni/pull/18) · `4fc3eac` · TattooAI/newbugs-omni-verification-dda657 · session `cb62e1a3-538e-4079-8cc4-aa7114a888a0`

Six bugs found while building OmniBots (reported in a local
`NEWBUGS_OMNI.md`, now retired in favour of this file):

1. **High — keys for multi-account providers lost on restart.**
   `/provider apikey|login|edit|logout` and the `/addprovider` and `/connect`
   key prompts assigned `provider.apiKey` directly. For `nvidia` and `agnes`
   the next load mirrored the old account key back over it, so a new key
   reverted on restart and logout brought the old key back. All six sites now
   use `setProviderKey`. Test: `provider-key-accounts`.
2. **`OMNI_HOME` in `.env` split state across two folders.** Settings stayed
   in `<install>/agent` while `last-provider.json` followed the `.env` value.
   `OMNI_HOME` is now shell-only (`loadDotEnv` skips it). Test:
   `omni-home-dotenv`.
3. **`.env.example` stated the wrong precedence.** It said `.env` overrides
   `settings.json`; the code does the opposite. Comment corrected.
4. **`/browser` missing from `/help`.** Its "Tools" category was never
   rendered. `printHelp` now renders every category a command declares. Test
   in `all-commands`.
5. **Shipped `omni.config.json` failed its own schema.** `hooks` was not
   declared. Test in `shipped-config` checks every config key against the
   schema.
6. **`docs/EXTENDING.md` was git-ignored** though the README, the system
   prompt and `/extend` point to it. It is now tracked, and `.gitattributes`
   uses `docs/**` so the installer's zip includes it.

Also: the README was rewritten to cover every current feature, command and
tool.

## 3.5.4 — 2026-09-25

- **Shipped:** [#17](https://github.com/tattooinmtl/omni/pull/17) · `abc1fd1` · fix/neuralview-lifecycle · —
- The neural view stops with Omi on every exit path, tells open tabs "Omi
  closed", and reloads them when Omi comes back. `/neuralview
  open|restart|stop|status`.

## 3.5.3 — 2026-09-24

- **Shipped:** [#16](https://github.com/tattooinmtl/omni/pull/16) · `ae47212` · fix/invoke-skill-wire-order · —
- Fixed provider 400s (MiniMax 2013) when a skill loads mid-turn: tool results
  stay next to their calls, and system messages are merged to the top.
- `run_shell` no longer freezes Omi; Esc and timeouts kill the whole process
  tree; the real exit code is reported (no false failures from stderr).
- `/btw` reaches a turn that is already running.

## 3.5.2 — 2026-09-24

- **Shipped:** [#15](https://github.com/tattooinmtl/omni/pull/15) · `37a6c69` · TattooAI/omni-agent-audit-82e98e · —
- Prompt box pinned to the bottom of the terminal, usable while the agent
  works; Enter queues.
- Pastes never auto-send; multi-line pastes show as a `[Pasted text]` chip.

## 3.5.1 — 2026-09-22

- **Shipped:** [#14](https://github.com/tattooinmtl/omni/pull/14) · `0e99195` · fix/installer-git-stderr · —
- The installer no longer dies on git's stderr under Windows PowerShell 5.1.

## 3.5.0 — 2026-09-21

- **Shipped:** [#10](https://github.com/tattooinmtl/omni/pull/10) · `a3cc1cf` · audit/full-sweep · —
- `edit_file`, `apply_patch` and `edit_lines` work on CRLF files and keep each
  file's line endings.
- Clear errors for missing tool arguments; `/providers` registered once; paths
  with spaces fixed for last-provider; OneDrive path detection fixed.

Also landed under 3.5.0, without a bump:
- [#11](https://github.com/tattooinmtl/omni/pull/11) · `68e068c` · TattooAI/v3-5-final-audit-cbd218 — MCP lifecycle, the Python
  router bridge, memory/OKF atom ids, neural view security, atomic writes
  everywhere.
- [#12](https://github.com/tattooinmtl/omni/pull/12) · `571138f` · fix/installer-never-updates — the installer can run from
  disk and updates by default, without moving dirty or diverged checkouts.
- [#13](https://github.com/tattooinmtl/omni/pull/13) · `3cbc419` · feature/atria-on-main — Atria ASI provider.

## 3.4.1 — 2026-09-21

- **Shipped:** [#9](https://github.com/tattooinmtl/omni/pull/9) · `fb4dd91` · fix/audit-followups · —
- Account env var names, quoted skill descriptions, and repair of existing
  `maxTokens >= contextWindow` settings.

## 3.4.0 — 2026-09-20

- **Shipped:** [#8](https://github.com/tattooinmtl/omni/pull/8) · `9f003ab` · audit/hidden-bugs · —
- Skill discovery fixed on Windows (CRLF frontmatter); env-supplied keys no
  longer leak into `settings.json`; scanner gaps closed.

## 3.3.1 — 2026-09-20

- **Shipped:** [#7](https://github.com/tattooinmtl/omni/pull/7) · `fe0ec51` · fix/four-failing-suites · —
- Fixed the four failing test suites.

## 3.3.0 — 2026-09-20

- **Shipped:** [#6](https://github.com/tattooinmtl/omni/pull/6) · `7c75442` · TattooAI/minimax-io-setup-fetch-6a379b · —
- The duplicate `minimax` provider folded into `minimax.io`; M3 fixed;
  `/getmodel` added.

## 3.2.0 — 2026-09-14

- **Shipped:** [#3](https://github.com/tattooinmtl/omni/pull/3) · `f93d1d6` · feature/xkiro-qwen3.8-max-default · —
- xKiro set as the shipped default provider.
- Also [#4](https://github.com/tattooinmtl/omni/pull/4) · `f8eab6a` · fix/xkiro-default-and-secret-redaction — redact `nvapi-`/`gsk_`
  keys; correct xKiro model limits.

## 3.1.5 — 2026-09-14

- **Shipped:** [#2](https://github.com/tattooinmtl/omni/pull/2) · `2349104` · fix/session-context-and-screenshot-vision · —
- The live `/` command menu is back; `edit_lines` can append.

## 3.1.4 — 2026-09-14

- **Shipped:** [#1](https://github.com/tattooinmtl/omni/pull/1) · `18d2c37` · fix/session-context-and-screenshot-vision · —
- Session context no longer discarded every turn; screenshot vision fixed;
  `self_review` critic; per-model vision; settings recovery; xKiro provider;
  external skill index.

## Before pull requests (pushed straight to main)

| Version | Date | Commit | Change |
|---|---|---|---|
| 3.1.3 | 2026-09-07 | `de61dfc` | `settings.json` wins over `.env`; NVIDIA 4-account rotation |
| 3.1.2 | 2026-09-07 | `7fe42ea` | Installer path to `.omni`; `/disconnect`; minimax.io key validation |
| 3.1.1 | 2026-09-02 | `96c7e04` | Audit fixes: `invoke_skill`, `edit_lines` lock, tool-name strip |
| 3.1.0 | 2026-09-02 | `807bc78` | Skills master, containment hardening, tolerant tag parser, new tools |
| 3.0.1 | 2026-08-27 | `fb5d36d` | `/connect` unified provider + model picker |
| 3.0.0 | 2026-08-26 | `1b8ae6a` | Local llama backend picker, hardware profile, video frames |
| 2.5.0 | 2026-08-26 | `c03a23a` | git-ops extension, tool reference, core fixes |
| 2.4.0 | 2026-08-25 | `44a1181` | Vision: `read_media_file`, `/image` |
| 2.3.1 | 2026-08-20 | `ad4fcf7` | Kimi models, minimax alias, settings tools |
| 2.3.0 | 2026-08-19 | `eb3f4d9` | Lean context mode, live neural view |
| 2.2.4 | 2026-08-19 | `0127d00` | Marker bump, no code change |
| 2.2.3 | 2026-08-18 | `88e647a` | Save the last-good provider on close |
| 2.2.2 | 2026-08-18 | `afe2510` | Per-provider max tool iterations |
| 2.2.1 | 2026-08-18 | `af270dd` | Bump so the update notice fires for the MiniMax fix |
| 2.2.0 | 2026-08-18 | `9955ae3` | Skill dispatcher, per-model max tool iterations |
| 2.1.4 | 2026-08-08 | `fc71f13` | Stop stripping `.md` files from the release archive |
| 2.1.3 | 2026-08-08 | `ef4f7e6` | Language-coding skills |
| 2.1.2 | 2026-08-08 | `d2905d6` | `omni --version` |
| 2.1.1 | 2026-08-08 | `21d222e` | Release |
| 2.1.0 | 2026-07-09 | `527fe47` | Restructure: command registry, goal mode, effort tiers |
