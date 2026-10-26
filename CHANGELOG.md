# Changelog

The single record of every change that reached `main`: what changed, in which
version, and how it got there (PR, merge commit, branch, agent session).
Newest first. The rules for keeping it up to date are in [AGENTS.md](AGENTS.md).

Each entry's **Shipped** line reads:
`PR · merge commit · branch · session`. A `—` means it wasn't recorded (older
entries were rebuilt from git history).

## 3.5.34 — 2026-10-26

- **Shipped:** this PR · — · TattooAI/security-audit · session `d270c228-682c-48d9-a9bf-4dc8347bc185`
- A security audit against SQL injection, XSS, path traversal, auth bypass,
  insecure deserialization, command injection, weak cryptography, input
  validation and exposed secrets. Four real problems, all fixed here:
- **`git_clone` could run a command.** Its URL check threw inside a `try`
  whose `catch` swallowed everything, so any string reached `git clone`,
  including `--upload-pack=<command>`, which git runs. Now only https, ssh,
  git and `user@host:path` URLs are accepted, anything starting with `-` is
  refused, and `--` goes before the URL.
- **Command tools ignored your shell setting.** `run_test`, `start_process` and
  `test_coverage` run commands the model writes, but each had its own
  permission, so `/perm run_shell ask` left them running anything silently.
  They now follow `run_shell` unless you set them yourself.
- **API keys reached the model in tool results.** A `.env` the agent read, or a
  page that printed a key, went to the model as-is, where a prompt injection
  could tell it to send the key somewhere. Tool results are now redacted
  first: the known key formats, and the exact keys you have configured
  (provider keys, account keys, `OMNI_*_KEY` variables), so formats no pattern
  knows are caught too.
- **The neural view had an XSS.** The tooltip put a node's folder, card type,
  atom type and status into the page unescaped, and memory atoms can come
  from web pages the agent read. They are escaped now, and the page is served
  with a Content-Security-Policy that lets it talk only to its own server, so
  nothing that slipped through could send your memories elsewhere.
- Already covered, no change: no SQL anywhere (data is JSON files), the HTML
  export escapes everything, every file tool resolves paths inside the
  workspace with a symlink check, `where_is`/`lint_check` validate what reaches a
  shell, the web tools refuse private addresses on every redirect hop,
  downloads are SHA-256 checked, and the router's `pickle` model is only ever
  written by Omni itself.
- Tests: `security-audit` covers the git_clone URLs, the command tools'
  permissions, key redaction (pattern, configured key, env key, ordinary text
  untouched), the escaped tooltip and the CSP header.

## 3.5.33 — 2026-10-26

- **Shipped:** [#45](https://github.com/tattooinmtl/omni/pull/45) · `858120d` · TattooAI/readme-refresh · session `d270c228-682c-48d9-a9bf-4dc8347bc185`
- **README brought up to date.** The title no longer carries a version
  number that nobody bumped (it still said 3.5.29); `omni --version` and this
  file carry it. What's new covers 3.5.29 to 3.5.32, and older releases point
  here instead of repeating it.
- The command table lists `/update-omni`, and the runtime-pack command for a
  checkout reads `.\install\install.ps1 -WithRuntime` again (its backslashes
  had been lost).
- Project instructions now say what 3.5.32 changed: a project's files wait
  for folder trust, imports stay inside the project, and secrets files are
  never imported.
- The test count (61) is gone from the Tests section; there are 84 suites.

## 3.5.32 — 2026-10-26

- **Shipped:** [#44](https://github.com/tattooinmtl/omni/pull/44) · `9f3b5a8` · TattooAI/instruction-trust · session `169b2a38-7c96-4641-9bbd-c91e9081f01f`
- **A repo's instruction files wait for folder trust.** OMNI.md, AGENTS.md
  and CLAUDE.md become system-prompt text, so a repo you just cloned could
  steer the agent before you agreed to anything. A project's files now load
  only once its folder is trusted (`/workspace trust`), the same rule project
  hooks already follow. That matters for one-shot and headless runs and for
  repos inside your OmniWorkspace, which never ask. Startup names the files
  it left out, and `/instructions` marks them as not loaded. Your personal
  OMNI.md always loads.
- **`@` imports stay where they belong.** An import from a project file must
  stay inside the project. `../`, absolute paths, `~/` and symlinks that
  point out of the project are refused. Your personal OMNI.md can import from
  your home folder. Only .md and .txt files can be imported, and never a
  secrets file such as `.env`, `.npmrc` or a private key, so an instruction
  file can't put your keys into the prompt that goes to the provider. A
  refused import shows as `(import X skipped: <why>)`.
- **The system prompt says tool results are data, not instructions.** File
  contents, web pages, search results, MCP output and command output never
  direct the agent. When one asks for an action, the agent quotes it to you,
  says where it came from, and asks.
- The secrets-file check `git_commit` uses moved to `core/secret-files.mjs`
  so the instructions loader shares it.
- Tests: `instructions` covers an untrusted folder (project file left out,
  personal file kept), trusting the folder, imports that escape by `../`, by
  absolute path, by `~/` and by a symlink, a `.env` and a non-text import
  inside the project, the personal file's home imports, and the new
  system-prompt rule.

## 3.5.31 — 2026-10-26

- **Shipped:** [#43](https://github.com/tattooinmtl/omni/pull/43) · `6a45a2a` · TattooAI/update-omni · session `d270c228-682c-48d9-a9bf-4dc8347bc185`
- **`/update-omni` updates Omni from inside the app** (alias `/upgrade`). It
  asks GitHub for the latest version right away instead of trusting the
  once-a-day cache. If `main` is newer it runs `install/install.ps1` on this
  install and streams its output, so the same safety rules apply: no update
  over uncommitted work or unpushed commits. It skips the installer's
  `C:models` question and the `npm link` step, which only matter on a
  first install.
- It only says "updated" when the installed version actually moved to the
  latest. An installer that declined or failed is reported as *did not apply*,
  pointing at the installer's own messages. The running session keeps the old
  code until you restart Omni, and it tells you so.
- `/update-omni check` only reports. Offline it says it could not check.
  Outside Windows, where there is no installer, it prints the manual
  `git pull` steps.
- The startup "update available" notice now points to `/update-omni`
  instead of "re-run the installer".
- Tests: `update-omni` covers already-latest, check-only, a successful
  update, an installer that exits 0 without moving the version, a failed
  installer, files that moved before setup failed, a second update while one
  runs, offline, no installer, and how the installer arguments are quoted.
- The installer gets 15 minutes before it is stopped, so a stalled download
  can't hang the app.

## 3.5.30 — 2026-10-26

- **Shipped:** [#37](https://github.com/tattooinmtl/omni/pull/37) · `897ec9a` · TattooAI/reflection-reasoning-echo · session `mvs_7f08f91d50584929a32315c1e41e4870`
- **Reasoning is now sent back to providers that require it.** Reflection's
  Beam models reject a request whose earlier assistant messages lost their
  reasoning — *"Missing required parameter: 'messages[2].reasoning_content'.
  This model needs the reasoning of every earlier assistant message"* — so
  every turn after the first failed with a 400. The harness folded the
  reasoning into `<think>` tags for display and then threw it away; the raw
  text is now kept on the message and echoed back on the wire.
- The echo is **opt-in per provider** (`echoReasoning: true`), because
  `reasoning_content` is not part of the OpenAI chat spec and a strict
  provider validator can reject an unknown field. Every other provider has it
  stripped before the request leaves, and the strip happens at the wire
  rather than in history, so switching providers mid-session keeps the
  reasoning available.
- Compaction is unaffected: it replaces the dropped middle with a *user*
  digest message, and the kept tail keeps the reasoning it already had.
- A conversation started before this change has no stored reasoning to send
  back, and an empty `reasoning_content` does not satisfy the requirement
  either — so such a request now fails with a plain explanation and the way
  out (`/clear`) instead of the provider's bare 400.
- The two text-tools rebuilds of an assistant tool-call message (provider
  `flattenToolMessages`, agent `messagesWithTextTools`) now carry the
  reasoning through too, so a `nativeTools: false` setup doesn't lose it on
  every tool turn and trip the refusal above.
- Tests: `reasoning-stream` pins the raw reasoning on the message, the echo
  for a provider that asks for it, and the strip for every provider that
  does not.

## 3.5.29 — 2026-10-23

- **Shipped:** [#42](https://github.com/tattooinmtl/omni/pull/42) · `b8bae81` · TattooAI/learning-reach · session `e67d2934-ff4d-4b06-a966-28bfb85e2987`
- Phase 4 of the harness parity plan (learning and reach) and the `/tree`
  view left from phase 3.
- **Learned skills.** After a run of 8+ tool calls that passed `self_review`
  (or a `/goal` that completed), the REPL offers to save how it was done.
  - The agent drafts the skill with the new `skill_create` tool, and you
    approve, decline or reply with changes.
  - Skills are stored in `<HOME>/skills/learned/<name>/SKILL.md` and load as
    slash commands at startup. A bundled skill wins a name clash, and a learned
    skill can never take a built-in command, template or bundled skill name.
  - Uses are counted (a `/command` or `invoke_skill`), and weight halves
    every 30 days without use, with a 14-day grace period. A faded skill
    leaves the prompt, `find_skill` and the `/` menu but still runs by name.
  - `find_skill` tags them `[learned, used N×]`. `/learned [forget <name>]`.
- **Local scheduler.** `/schedule add <daily HH:MM|weekdays HH:MM|weekly
  <day> HH:MM|hourly|every Nm|Nh> [--mode m] [--model m] [--agent a] <prompt>`,
  plus `/schedule`, `remove <id>` and `run <id>`.
  - Jobs live in `<HOME>/schedule.json`. On Windows each is registered with
    Task Scheduler as `\Omni\<id>` running `omni schedule run <id>`;
    elsewhere Omni prints the crontab line.
  - A run is a headless Omni in the job's folder. Results go to
    `<HOME>/inbox/` with a Windows notification (WinRT toast through
    PowerShell, no module), and a failed run still leaves an entry.
  - `/inbox [clear]` shows them, and the REPL mentions unread results at
    startup. `omni schedule list|run <id>|run-due` for other runners;
    `OMNI_SCHEDULER=none` and `OMNI_NO_TOAST=1` turn the system parts off.
- **RPC mode.** `omni --rpc`: one JSON object per line each way, with the
  terminal UI on stderr.
  - Methods: `prompt` (queued, replies with `{stop, result, session}`),
    `steer`, `abort`, `command`, `status`, `set_mode`, `set_model`, `confirm`,
    `answer`, `exit`.
  - Events: `ready`; the stream-json session events; `confirm` for tool
    approvals; `question` for `ask_user`.
  - Checkpoints work as in the REPL. The model chosen isn't saved as the
    next session's.
- **`/tree`** links this folder's logs by their `forked_from` /
  `resumed_from` records into a tree, marks where you are, lets you pick one
  to continue, and draws the branches as edges in the neural view.
- **Extension API.** Extensions can export `commands` (a returned string
  goes to the agent as a prompt) and `statusItems` (short text in the status
  bar).
  - Built-ins always win a name clash, and a bad entry is reported and
    skipped. A hot reload replaces what the extension added.
  - `/help` lists them under Extensions. Documented in `docs/EXTENDING.md`.
- **Router training data.** `/route learn [--all]` labels each prompt you
  typed `coding` or `assistant` by what the agent did next. Rewound turns,
  notes and sub-agent logs are skipped, and duplicates are dropped.
  - It writes `router/data/sessions.jsonl` (gitignored), which
    `router/train.py` and `router/train_intent_model.py` now read on top of
    the seed.
- Tests: `skill-learn` (8), `scheduler` (10, including a real `omni schedule
  run` through a child Omni against a mock provider), `session-tree` (5),
  `ext-api` (6), `rpc` (9, driving `omni --rpc`: events, a tool approval
  accepted and refused, an `ask_user` answer, commands, errors, exit) and
  `router-data` (4).

## 3.5.28 — 2026-10-23

- **Shipped:** [#41](https://github.com/tattooinmtl/omni/pull/41) · `118c390` · TattooAI/agents-worktrees · session `e67d2934-ff4d-4b06-a966-28bfb85e2987`
- **Named sub-agents.** Markdown definitions in `agents/` (shipped),
  `<HOME>/agents/` (personal) and `.omni/agents/` (project; replaces a shipped
  one of the same name) with frontmatter `description`, `tools`, `readonly`,
  `model` and `isolation`; the body is the agent's role.
  - Ships `explorer` (read-only, maps code), `reviewer` (read-only, ends with a
    VERDICT line) and `tester` (writes and runs tests, on its own branch).
  - `spawn_agent` takes `agent:"<name>"`. The agent is offered only its tools
    (`runTurn` gained `allowedTools`), and its permissions are the parent's
    narrowed: a parent `deny` stays a deny and an `ask` stays an ask.
    Read-only agents get the plan-mode read set minus `spawn_agent`.
  - `spawn_agent`'s description lists the available agents. `/agents
    [reload]` shows them and the sub-agents running now.
  - `omni -p --agent <name>` runs one headless (an agent run is never routed
    to a persona, which would replace its role).
- **Worktree isolation.** `spawn_agent` with `isolation:"worktree"` (or an
  agent defined that way) creates a git worktree on a new `omni/agent-…`
  branch under `<HOME>/worktrees/<project>/` and runs the agent there as a
  headless Omni (`--mode accept-edits`, or plan if you are in plan mode). Its
  log is marked as a sub-agent's. When it finishes, its changes are committed
  on the branch and `agent_status` lists the files.
  - Omni's file tools resolve paths against the one process's working folder,
    which is why a worktree agent runs as its own process.
  - New `merge_agent({id})`: `self_review` checks the branch diff against the
    task the agent was given. The branch merges (`--no-ff`) only on
    `VERDICT: CLEAN` or `MINOR`; otherwise the findings come back and nothing
    changes (`force:true` merges anyway). A merge conflict is aborted cleanly.
    `action:"discard"` drops the branch. Either way the worktree and branch are
    removed.
  - It needs a git repo with a commit, and starts from your last commit
    (`spawn_agent` says so when you have uncommitted changes).
  - `self_review` can now review a given diff instead of taking one from git.
- Tests: `agents` (12: loading and precedence, read-only and narrowed
  permissions, role prompt, catalog, a read-only agent offered only read tools
  against a mock provider, unknown agent, the worktree requires a repo, a real
  worktree run through a child Omni with the branch checked, merge on CLEAN
  with worktree and branch removed, refusal on BLOCKERS then discard, no merge
  for shared agents). `headless` covers `--agent` parsing.

## 3.5.27 — 2026-10-23

- **Shipped:** [#40](https://github.com/tattooinmtl/omni/pull/40) · `1a88abe` · TattooAI/headless-templates · session `e67d2934-ff4d-4b06-a966-28bfb85e2987`
- **Headless mode.** `omni -p "…"` (or `--print`) with `--output text|json|stream-json`
  (`--output-format` works too) and `--max-turns N`.
  - With `json` or `stream-json`, stdout holds only JSON: every line the
    terminal UI prints is sent to stderr instead.
  - `json` prints one result object: `ok`, `stop`, `result`, `error`, `session`
    code, `model`, `mode`, `turns`, `toolCalls`, `usage`, `durationMs`.
  - `stream-json` prints an `init` event, then `user`, `assistant` (with parsed
    `toolCalls`), `tool_result` and `error` events as the session log is
    written, then the same result.
  - With `-p` and no prompt, the prompt is read from stdin.
  - Exit codes: 0 done, 1 error (no API key, provider failure, a hook blocked
    the prompt, unhealthy model, no prompt), 3 hit `--max-turns`. One-shot runs
    used to exit 0 on every failure.
  - Headless runs never stop for the folder-trust prompt. Skills and prompt
    templates work as the prompt.
  - `runTurn` now returns `{ stop: "done" | "error" | "aborted" | "max_turns" }`,
    and takes a `turnLimit` that wins over a routed persona's own iteration
    budget, so `--max-turns` is exact even when the router picks a persona.
  - stream-json events go out in order and only once their record is in the
    session log, so the stream never reports anything `--resume` won't have.
    If the log can't be written, the run ends as an error (exit 1) saying
    how many records were lost.
  - `/omnibots` in json mode ends with a result object like any other run.
- **Prompt templates.** Markdown files in `.omni/commands/` (project) and
  `<HOME>/commands/` (personal) become slash commands; a subfolder gives a
  `folder:name` prefix.
  - The body is the prompt, with `$ARGUMENTS`, `$1`…`$9` (quotes keep words
    together) and `@path` (the file's contents, only inside the workspace, up
    to 50 KB, and only that much is read from disk). Without a placeholder,
    arguments are appended.
  - Frontmatter `description` and `argument-hint` show in the `/` menu.
  - Precedence: project over personal; built-in commands over templates over
    skills. A template goes through hooks, plan mode and the router like typed
    text.
  - `/templates [reload]` lists them and flags one hidden by a built-in.
- **Fixed:** a one-shot run saved its model as the "last good" model on exit,
  so `omni --model x "…"` (even with a provider that has no key) changed
  which model the next interactive session started on.
- Tests: `headless` (14, spawning the real CLI against a mock provider: json,
  stream-json event order, stdin prompt, `--max-turns` exit 3, missing key exit
  1 and the last-model regression, no prompt, bad flag, a template run,
  `--max-turns` over a persona budget, `/omnibots` result, stream ordering and
  failed writes) and
  `templates` (8: loading and precedence, placeholders, an 8 MB `@file` cut
  at 50 KB, `@file` limited to the
  workspace, routing, `/templates`).

## 3.5.26 — 2026-10-22

- **Shipped:** [#39](https://github.com/tattooinmtl/omni/pull/39) · `7d825a2` · TattooAI/safety-controls · session `e67d2934-ff4d-4b06-a966-28bfb85e2987`
- Phase 2 of the harness parity plan: safety and controls, plus sessions.
- **Permission modes.** `default`, `accept-edits`, `plan` and `auto`, cycled
  with Shift+Tab (caught before readline, so it doesn't also tab-complete) or
  set with `/mode`, `/plan [prompt]`, `--mode`, or `settings.permissionMode`.
  The prompt box shows the mode, and a note in the system prompt tells the
  model. No mode overrides a `deny`; `auto` still asks for high-risk shell
  commands and `create_tool`, and `/mode auto` confirms first. The mode is
  process-wide, so sub-agents spawned in plan mode are read-only too.
- **Plan mode.** Only reads, searches and single read-only shell commands run
  (no chaining or redirection); edits, writes, other commands, unknown
  extension tools and `mcp` are refused with a message telling the model to
  plan instead. The new `exit_plan_mode` tool shows the plan and asks you:
  implement, implement with accept-edits, keep planning, or type changes. An
  approved plan's steps are added to `project_todo`. The first prompt sent in
  plan mode offers to load the brainstorming skill.
- **Checkpoints and `/rewind`.** Before a turn first changes something, the
  workspace is snapshotted into a shadow git store in
  `agent/checkpoints/<project>/` (never the project's own `.git`; works in
  folders that aren't repos; `.gitignore` and `node_modules/` etc. skipped;
  catches shell-made changes too). `/rewind` restores files, the conversation
  (and puts the prompt back in the box), or both; a rewind snapshots first so
  it can be undone. One failure (no git, a folder too large for 30 s) turns
  checkpoints off for the session with one warning. `"checkpoints": false`
  turns them off.
- **Session codes.** Every conversation has a code
  (`omni-session-<time>-<folder>`), derived from its log name so old sessions
  have one too. `omni --resume <code>` and `/resume <code>` work from any
  folder. `/status` shows the code and Omni prints it on exit. Search hits
  and the `/resume` list show codes.
- **`/fork`** continues in a copy and leaves the original log untouched.
  **`/export [md|html|json] [file]`** writes the conversation, with the HTML
  a single page with no external fonts, scripts or links, escaped, and in
  light and dark. **`/clear`** now starts a new log, so the cleared
  conversation stays resumable whole.
- The log now records rewinds (`{type:"rewind", keep}`). Resume, fork and
  export apply them, and resume/fork copy only the messages still in effect,
  so a log always replays to what you saw.
- **Fixed: `ask_user` never reached the user.** The tool looked for
  `ctx.askUser`, which the REPL never set, so every question got "no
  interactive user". The REPL now asks in the prompt box, with numbered
  options.
- **Fixed:** two sessions started in the same millisecond (parallel
  sub-agents) shared one log file.
- Tests: `permission-mode` (17, including plan-mode refusal and
  `beforeMutation` inside a real `runTurn`), `checkpoints` (10, a real shadow
  store: edits, deletions, new files, CRLF byte-for-byte, undo, `/rewind`
  both/code-only) and `session-tools` (11: codes across folders, fork,
  resume into a used session, md/html/json export, `/clear`).
  `session-picker` now expects codes in search hits.

## 3.5.25 — 2026-10-22

- **Shipped:** [#38](https://github.com/tattooinmtl/omni/pull/38) · `df48c25` · TattooAI/claw-code-harness-audit-74f6c1 · session `e67d2934-ff4d-4b06-a966-28bfb85e2987`
- Phase 1 of the harness parity plan (Claude Code, Hermes Agent, Pi).
- **Project instructions.** Omni now follows `OMNI.md`, or an existing
  `AGENTS.md` / `CLAUDE.md`, from the repo root down to the cwd, plus
  `~/.omni/agent/OMNI.md` for personal rules. One file per folder, deeper
  wins, `@path` lines import other files, 40 KB cap in total. The rules sit in
  the session-context block so the per-turn persona swap keeps them, and
  sub-agents get them too. New: `/init` (the agent writes an OMNI.md),
  `/instructions [reload|add <rule>]`. Each file shows up as a node in
  `/neuralview`.
- **Hooks now run.** `hooks/scan-now.json` was declared in `omni.config.json`
  but nothing executed it. `src/core/hooks.mjs` runs hooks at SessionStart,
  UserPromptSubmit, PreToolUse, PostToolUse, PreCompact, Stop and
  SubagentStop, from settings, hook files, a trusted project's
  `.omni/hooks.json`, and extensions (`hooks` export). Command hooks use the
  Claude Code contract (JSON on stdin, exit 2 blocks, JSON or text on
  stdout). A Stop hook can send the agent back to work up to 3 times a turn.
  PreToolUse runs after the permission gates, so it can only tighten them.
  New: `/hooks`, `OMNI_NO_HOOKS=1`. Documented in `docs/EXTENDING.md`.
- **Forge digest compaction.** Auto-compaction and `/compact` used to keep only
  the first request and a tool list, losing every decision. A model now writes
  a summary under fixed headings (goal, decisions, files, done, open, errors),
  optionally on a cheaper model (`settings.compaction.model`). It falls back to
  the old digest on local models (unless configured), on errors, or on an
  empty reply. Memory atoms are extracted from the dropped turns first, a
  PreCompact hook can cancel or add focus, and `/compact` takes a focus text.
- **Fixed `/resume` and `--resume`.** Both restored the newest log in the
  folder, which is the session Omni creates at startup (or a sub-agent /
  self_review log), so they brought back almost nothing. Sessions now record
  their kind, the running session is excluded, `/resume` opens a picker (or
  takes a number, an id, or `latest`), replaces the conversation instead of
  appending to it, and copies it into the running log so a later resume gets
  the whole history.
- **Session search.** New `session_search` tool and `/history <words> [--all]`:
  BM25 over past prompts and answers in this project or all projects, at most
  two hits per session, with a `/resume` id for each.
- README header now shows the current version (it still said 3.5.5).
- Tests: `instructions` (14), `hooks` (16, including PreToolUse deny/rewrite,
  PostToolUse notes and the Stop loop inside a real `runTurn`), `compaction`
  (9, including a summary over the wire on the configured cheap model) and
  `session-picker` (12, including the `--resume` regression). The shared
  `tests/_mock-provider.mjs` lets fetch's keep-alive sockets close before a
  suite exits, because Node 24 on Windows aborts otherwise
  (`UV_HANDLE_CLOSING`).

## 3.5.23 — 2026-10-20

- **Shipped:** [#36](https://github.com/tattooinmtl/omni/pull/36) · `65f4115` · TattooAI/reflection-provider · session `mvs_7f08f91d50584929a32315c1e41e4870`
- **Reflection AI** ships as a first-class provider. `Beam-1.0-501B-A23B` is a
  1M-context model that reasons on every request, so Omni keeps the standard
  `reasoning_effort` parameter against `https://api.reflection.ai/openai/v1`
  instead of skipping it. Set the key with `/apikey reflection <key>`,
  `OMNI_REFLECTION_KEY`, or Reflection's own `REFLECTION_API_KEY`; switch with
  `/provider reflection`. The model ships with the context window Reflection
  documents (1,048,576) and its own default output cap (32,768), well under
  the provider's 131,072 ceiling.
- Tests: `provider-keys` pins the provider's endpoint, model id, context window,
  output cap, and the `REFLECTION_API_KEY` alias — live at runtime, never
  written to `settings.json`.
- One thing to know: Reflection reasons on every request, and `/effort off`
  only omits the parameter — so the server applies its own default of `max`,
  the most expensive tier. Use `/effort low` to actually scale it down.

## 3.5.22 — 2026-10-19

- **Shipped:** this PR · — · TattooAI/installer-ignore-untracked · session `e47ed03a-177f-4114-b238-4d94d0d7923a`
- The installer no longer refuses to update because of an untracked folder
  in the install directory. Its local-changes check used
  `git status --porcelain`, which lists untracked files too, so one side
  folder printed "1 uncommitted change(s) - NOT updating" and left the
  install at 3.5.19 while main was at 3.5.21. Only changes to tracked files
  block the update now; the fast-forward itself still refuses to overwrite
  an untracked file.
- `rea-main/` (the next-gen Omni, developed in the install directory) is
  gitignored.
- Tests: `website-version` checks the installer's local-changes test
  ignores untracked files.

## 3.5.21 — 2026-10-19

- **Shipped:** [#34](https://github.com/tattooinmtl/omni/pull/34) · `17b1bb7` · TattooAI/minimax-flash-preview-default · session `e47ed03a-177f-4114-b238-4d94d0d7923a`
- minimax.io now offers exactly two models: `minimax.io/m3` (MiniMax-M3)
  and `minimax.io/m3.1-flash` (MiniMax-M3.1-Flash). MiniMax-M3.1-Flash-Preview
  is removed: the released M3.1 Flash replaces it. A saved Preview entry is
  pruned on load, and a default or last-used model that pointed at it
  moves to `minimax.io/m3.1-flash`.
- Tests: `minimax` pins the shipped minimax.io list to those two ids,
  checks that the live list (still carrying M2.x) filters down to them,
  and covers the Preview's migration.

## 3.5.20 — 2026-10-19

- **Shipped:** [#33](https://github.com/tattooinmtl/omni/pull/33) · `b855379` · TattooAI/minimax-m3-1-flash-f1cbda · session `e47ed03a-177f-4114-b238-4d94d0d7923a`
- **MiniMax-M3.1-Flash** ships as `minimax.io/m3.1-flash`, the MiniMax
  default (1M context, 128000 output cap, image input, 200 tool iterations).
  Checked live against api.minimax.io before adding: it is listed by
  `/v1/models`, chats, makes tool calls, reads images, and 400s above the
  same 524288 output ceiling as M3.
- **Models before M3 are gone.** MiniMax is discontinuing M2, M2.1, M2.5,
  M2.7 and their `-highspeed` variants. `/getmodel minimax` no longer lists
  them, and saved entries are removed on load; a default model that pointed
  at one moves to `minimax.io/m3.1-flash`. M3 and M3.1-Flash-Preview stay.
- `/getmodel` no longer saves a second entry for a model that is already
  configured under another key (`minimax.io/MiniMax-M3` beside the shipped
  `minimax.io/m3`). Existing duplicates of a shipped MiniMax model fold
  back into the shipped key on load, keeping its health status. The
  last-used model follows a folded or retired key instead of being cleared.
- Reasoning that a provider streams in `reasoning_content` (M3.1 Flash,
  DeepSeek-style APIs) was dropped: nothing showed while the model
  thought, and `/thinking last` was empty. It now goes through the same
  `<think>` handling as M3's inline reasoning: collapsed or shown live,
  kept for `/thinking last`, and stripped from history.
- Tests: `minimax` covers the new model, the pre-M3 cut-off, pruning,
  default re-pointing and duplicate folding; new `reasoning-stream` covers
  `reasoning_content` before an answer, before a tool call, and alone.

## 3.5.19 — 2026-10-13

- **Shipped:** [#32](https://github.com/tattooinmtl/omni/pull/32) · `2372395` · TattooAI/omni-local-skill-index · session `fc4bcfdc-fdbf-4797-a8a9-2b8f33610bd4`
- A personal skill index (an add-on such as brain-skills) can now be set in
  your own `agent/settings.json` as `"skillIndex": "<path>"`, which wins
  over the shipped default in `omni.config.json`. Before, the only place
  was `omni.config.json` itself, and editing it left the install folder
  with a local change, so the installer refused to update it.
- The runtime pack treats rg / fd / jq that an older Omni left in `vendor/`
  as already available: `/runtime` shows "already in vendor/ (from an
  older Omni)" and `/runtime install` skips them, instead of warning that
  it won't overwrite a file it didn't install. Naming the part explicitly
  still refuses, with the same "move it out first" message.
- Tests: `skill-index` covers the settings override and that a missing or
  blank value leaves the shipped one alone; `runtime-pack` covers files
  already in `vendor/`.

## 3.5.18 — 2026-10-13

- **Shipped:** [#31](https://github.com/tattooinmtl/omni/pull/31) · `2c00a97` · TattooAI/omni-runtime-installer-guard · session `fc4bcfdc-fdbf-4797-a8a9-2b8f33610bd4`
- Fixed: installing with the runtime option on an Omni that didn't update
  sent `runtime install` to the model as a chat prompt. The installer
  always comes fresh from GitHub, but local changes in the install folder
  stop the update, and Omni before 3.5.17 has no `runtime` command, so
  `omni runtime install` ran as a one-shot prompt. The installer now skips
  the pack on such an install and says to update first, then run
  `omni runtime install`.
- Fixed: the installer's runtime messages read `<install>endor` — a `\v`
  in the path had become a control character.
- Tests: `installer-runtime` runs the real `Install-RuntimePack` from
  `install.ps1` against a fake pre-3.5.17 install (skipped, nothing run) and
  a current one (runs `omni runtime install`), and checks shipped text
  files for stray control characters.

## 3.5.17 — 2026-10-13

- **Shipped:** [#30](https://github.com/tattooinmtl/omni/pull/30) · `fdc082a` · TattooAI/omni-runtime-pack · session `fc4bcfdc-fdbf-4797-a8a9-2b8f33610bd4`
- New optional runtime pack: portable tools Omni's features use, installed
  into Omni's own `vendor/` folder with no admin rights and nothing
  system-wide. ffmpeg + ffprobe 9.0.2 (video understanding), ripgrep 15.2.0
  (fast search / replace / security scan), fd 10.5.0 (`find_files`), jq 1.8.2,
  and on request language servers (TypeScript 7 + Pyright, for `lsp` and
  `rename_symbol`). Each download is pinned to a release and checked against
  the SHA-256 GitHub publishes for it before anything is unpacked; a
  mismatch installs nothing.
- `/runtime` shows each part, what it unlocks and whether it is installed
  (in the pack or already on the PC); `/runtime install` adds ffmpeg,
  ripgrep, fd and jq, skipping any the PC already has; `/runtime install
  lsp|all|<names>` and `/runtime remove <name>`. Same as `omni runtime …`
  outside the REPL. Other platforms get their package-manager command.
- The installer takes `-WithRuntime`, or `$env:OMNI_RUNTIME = "1"` before the
  one-liner; a failed download warns without failing the install. The
  website's install section has an "Include the optional runtime pack"
  checkbox that switches the command.
- Safety: a download is capped at its catalog size (a response that keeps
  streaming is cut off before it can fill the disk); the pack never
  overwrites a file in `vendor/` it didn't install; `/runtime remove` only
  deletes that part's own files inside `vendor/`, whatever `runtime.json`
  says; npm parts install with `--ignore-scripts`. `OMNI_VENDOR_DIR` is
  shell-only like `OMNI_HOME`, and the rg / fd / jq lookups honour it.
  `omni runtime …` waits for the hardware rescan before exiting.
- Omni puts `vendor/` first on PATH at startup, so every tool and child
  process finds the pack. When ffmpeg is missing, the agent's machine notes
  and `/hardware` point to `/runtime install ffmpeg`.
- Tests: `runtime-pack` checks every catalog entry is pinned (GitHub release
  URL, SHA-256, size; exact npm versions), id resolution, PATH wiring, and
  the install path end to end with injected downloads: checksum mismatch
  and HTTP errors install nothing, an exe and a zip (file found at any
  depth) install and are recorded, removal, and missing files reading as not
  installed, plus the size cap, never overwriting a user's file, and a
  tampered manifest that can't delete outside `vendor/`. `all-commands`
  dispatches `/runtime`.

## 3.5.16 — 2026-10-13

- **Shipped:** [#29](https://github.com/tattooinmtl/omni/pull/29) · `254f9f2` · TattooAI/omni-web-browser-6536fd · session `fc4bcfdc-fdbf-4797-a8a9-2b8f33610bd4`
- Omni now fits itself to the PC it is installed on. The first launch on a
  new machine (and the first after a hardware change or this upgrade) scans
  it: CPU name, RAM, free disk, every GPU and whether it is a graphics card,
  a built-in iGPU, or software-only (VMs, remote desktop), display resolution
  and refresh rate, battery and power plan, and which of python, git, ffmpeg,
  ollama, docker and a Chromium browser are installed. Nothing is tuned to
  one machine; each install reads its own.
- The agent gets a short "This machine" block in its system prompt every
  session, with only the warnings that apply: integrated GPU, browser FPS
  capped by the display, running on battery, under 8 GB RAM, which tools are
  missing, what size of local model fits. Before, it had to guess.
- Settings are chosen from the scan. The headless browser now uses the GPU
  when the PC has a real one (it always ran with `--disable-gpu`, so WebGL
  and canvas pages rendered in software), and only together with Chromium's
  sandbox: pages the agent opens are untrusted, so if the sandbox can't
  start the browser falls back to the old no-sandbox software mode.
  `browser_status` reports `sandbox` and `gpu`. VMs and software adapters
  keep software rendering. `/hardware` lists each choice and why, and
  `/hardware set <browserGpu|localBackend> <value|auto>` overrides one
  (saved in `settings.hardware`; a `localBackend` override counts as
  `--force` for `/llama-start`). An `OMNI_BROWSER_GPU` set in the shell or
  `.env` always wins.
- Fixed: the browser tools stopped working with current Edge. Edge's
  launcher process now exits (code 0) right after handing off to the real
  browser, and Omni took that as the browser dying, so every `browser_*`
  call failed with "browser session is not running". It also attached to
  Edge's own first-run tab (`edge://sync-confirmation-dialog/`) instead of
  its `about:blank`. The session now lives as long as its devtools
  connection, attaches to its own tab, and closes the real browser with
  `Browser.close` (plus its pid on Ctrl+C or a crash). Before, closing killed
  only the exited launcher and leaked a headless Edge every session.
- On hybrid laptops the GPU name and VRAM now come from the best adapter
  (the graphics card), not whichever one Windows lists first; `dxdiag` VRAM
  is read from that card's block. Linux names GPUs from `lspci`, macOS from
  `system_profiler` (plus display), and `nvidia-smi` VRAM works off Windows.
  `/snap/bin/chromium` is found.
- A cached profile older than a day is rescanned in the background for the
  next session, since a new monitor, GPU or installed tool doesn't change
  the cheap fingerprint. Battery state is reported as of the scan. A failed
  or timed-out first scan prints a warning instead of starting silently
  without machine info. `/llama-start` only trusts a fresh profile.
- The scan is ~3x faster (12 s → ~4 s here): `dxdiag` only runs when
  Windows' 32-bit `AdapterRAM` sits at its 4 GB ceiling.
- Tests: `hardware-profile` covers GPU classification for real adapter
  names (Arc B-series, Radeon iGPUs), best-adapter and per-card dxdiag
  picks on hybrid laptops, the Windows / lspci / system_profiler parsers,
  settings and prompt summaries for a gaming desktop, a low-RAM laptop on
  battery and a VM, overrides, `.env` precedence, stale caches and a failed
  scan. New `browser-session` (skips without a browser) pins the Edge
  launcher hand-off, attaching to our own tab, and that `close()` really
  shuts the browser down.

## 3.5.15 — 2026-10-12

- **Shipped:** [#28](https://github.com/tattooinmtl/omni/pull/28) · `4c1a127` · TattooAI/omni-endpoints-file-eab6e8 · session `cd6afbc1-d61b-4bd2-b852-006fc4d9caa2`
- Typing a skill now visibly works. A recognised `/command` or `/skill` turns
  blue in the input box (and in the echoed line), and running a skill prints
  `▸ skill /rust loaded — rust-coding`. Before, `/rust` ran with no sign it
  had been picked up.
- The model is now told the skill's instructions are already loaded, so it no
  longer calls `invoke_skill` for it. The old wording ("Run the rust-coding
  skill") sent models to `invoke_skill("/rust-coding")`, which failed because
  the command is `/rust`; one test run spent 88k tokens recovering, now 21k.
  With no task after the skill, the model says what the skill does and asks
  what you want, instead of replying with next to nothing.
- `invoke_skill` also accepts a skill's name when it differs from its command.
- The skill index set in `omni.config.json` (`skillIndex`, the brain-skills
  `skills.json`) actually loads. It lists `skills` with paths relative to
  `source`, but Omni only read the scan-now `entries` shape, so it loaded zero
  skills. Its 232 skills are now reachable by `find_skill` and, new, typeable
  as commands with the `/` menu and Tab: `/gauntlet-loop`, `/superpowers` and
  the rest. They stay out of the system prompt, and a bundled skill still wins
  a name clash.
- Tests: `slash-skills` covers which input is highlighted, the confirmation
  line, the new skill prompt, and that highlighting leaves the box layout
  unchanged. `skill-index` covers the brain-skills index shape (with and
  without `source`) and `invoke_skill` by name.

## 3.5.14 — 2026-10-11

- **Shipped:** [#27](https://github.com/tattooinmtl/omni/pull/27) · `bdbf3ce` · TattooAI/add-m3-flash-preview-model-02aa5b · session `5fefff97-2c15-4efa-bb4b-b7680cfef07e`
- `MiniMax-M3.1-Flash-Preview` (`minimax.io/m3.1-flash-preview`, shipped in
  3.5.7) now shows in the `/model` picker and in `/models minimax.io`.
  MiniMax's `/v1/models` doesn't list the preview, and the picker showed only
  that live list. It now adds every configured model on the provider that the
  live list leaves out, under its configured key, so no duplicate entry is
  saved. The fix applies to every provider, not just MiniMax.
- Tests: `minimax` checks that the picker rows include the preview under
  `minimax.io/m3.1-flash-preview` when the live list omits it, without
  doubling `MiniMax-M3`.

## 3.5.13 — 2026-09-29

- **Shipped:** [#26](https://github.com/tattooinmtl/omni/pull/26) · 0df3e01 · TattooAI/omnibots-config-doctor-289fb1 · session `75b72e75-5bf5-4682-9787-9950350d4ea8`
- `instructions_omnibots.md` catches up with OmniBots (tattooinmtl/Omnibots#21):
  - The only folders either app keeps config, keys or data in: `~\.omni`,
    `~\.omnibots`, `%LOCALAPPDATA%\OmniBots` (Qt's cache only) and the
    projects folder.
  - Providers and keys: one shared list in Omni's `settings.json`. OmniBots'
    Settings → Providers edits only its provider entries. Without Omni,
    OmniBots uses its own Omni-format copy in `~\.omnibots\config`, with the
    keys DPAPI-encrypted in its database, never in a text file. A wrong
    `[omni] install_root` is reported, not silently replaced.
  - The OmniBots doctor: its reference file (`layout.json`), the ways to run
    it (every start, Settings → Doctor, asking Omi, the CLI, the installer),
    what its messages mean, and what it never does (delete, write to
    `~\.omni`, show a key).
  - "Rules to keep" no longer says OmniBots only reads Omni's config.
- Omni's code is unchanged. The offline banner fallback is v3.5.13.
- The 3.5.11 and 3.5.12 entries now name their PRs and merge commits.

## 3.5.12 — 2026-09-29

- **Shipped:** [#25](https://github.com/tattooinmtl/omni/pull/25) · d884d17 · website-omnibots-notice · session `01a0eda3-bc15-7ca1-aba3-6ba8cc04d497`
- Omni's local website (`website/index.html`, not in git) now has the matching
  notice: header and footer **OmniBots ↗**, a **Works with OmniBots** section,
  the OmniBots PowerShell install line with its own Copy button, and a link to
  omnibots.globalwarningnetworks.com. Install Omni first, then OmniBots. The
  two folders are `~\.omni` and `~\.omnibots`.
- `instructions_omnibots.md` records that notice as done. Publishing the page
  is still a FastComet upload; a push does not deploy `website/`.
- The offline banner fallback is v3.5.12. `.playwright-mcp/` and `*.bak-*`
  stay ignored so those local files do not block the installer's next update.

## 3.5.11 — 2026-09-29

- **Shipped:** [#24](https://github.com/tattooinmtl/omni/pull/24) · 94ff286 · omnibots-instructions · session `b7a22d57-e356-429c-a191-a55340019974`
- New `instructions_omnibots.md`: everything `/omnibots` needs to work. It
  covers OmniBots installed in `%USERPROFILE%\.omnibots` next to `~\.omni`,
  the launcher, the config line, the command and the skill, how the OmniBots
  folder and its Python are found, a quick test, what each launcher message
  means and what to do about it, and the rules between the two projects.
- It also holds a to-do for Omni's website: the same "works together, install
  Omni first" notice that the OmniBots site now has, linking to
  omnibots.globalwarningnetworks.com.
- `.gitignore` publishes that one file (`!/instructions_omnibots.md`); other
  loose markdown stays local as before.
- The website's offline version fallback was back at v2.1.4 (the `website/`
  folder had been reset to the deployed copy); it's v3.5.11 again, so
  `website-version` passes. The live site needs a redeploy to show it.

## 3.5.10 — 2026-09-29

- **Shipped:** [#23](https://github.com/tattooinmtl/omni/pull/23) · 31415da · omnibots-command · session `01a0ed1e-344f-7173-9a50-70c5930b585f`
- `/omnibots` is now in the command list (`/help`, the `/` menu, tab
  completion, and the README), beside `/browser`. `/omnibots` and
  `/omnibots start` start the tray app or bring its window forward.
  `/omnibots status` checks it. `/omnibots stop` (also `close` and `quit`)
  closes it. Those run the launcher directly, so they do not spend a model
  turn, and `omni /omnibots status` works with no provider key.
- The skill of the same name stays for a plain-language ask ("start
  omnibots"). A typed `/omnibots` hits the command, and `/help` lists it once.
- The launcher still talks to OmniBots with `python -m omnibots`,
  `python -m omnibots --send status`, and `python -m omnibots --send stop`.
- Tests: `omnibots-launcher` — the command is on the menu; start, status,
  stop, open, close, and quit call the matching tool; an unknown subcommand
  prints the usage line; a same-named skill does not take the slash or show
  twice in `/help`; a missing launcher is named.

## 3.5.9 — 2026-09-29

- **Shipped:** [#22](https://github.com/tattooinmtl/omni/pull/22) · c8b618e · omnibots-home-default · session `b7a22d57-e356-429c-a191-a55340019974`
- `/omnibots` now looks for OmniBots in `~/.omnibots` first, where the
  OmniBots installer puts it (next to `~/.omni`), then `C:\omnibots`, then
  `%LOCALAPPDATA%\OmniBots`. `OMNIBOTS_DIR` still wins when set, and a
  folder without OmniBots is named in the error.
- Tests: `omnibots-launcher` picks `~/.omnibots` without `OMNIBOTS_DIR`, and
  a set `OMNIBOTS_DIR` without OmniBots is refused.

## 3.5.8 — 2026-09-28

- **Shipped:** [#21](https://github.com/tattooinmtl/omni/pull/21) · f98efd1 · omnibots-launcher · session `b7a22d57-e356-429c-a191-a55340019974`
- New `/omnibots` command starts the OmniBots desktop app (Omi and its bot
  team, in the system tray), or brings it to the front when it's already
  running. `/omnibots status` and `/omnibots stop` check or close it.
- The Python for OmniBots is found automatically: the checkout's `.venv`,
  then the OmniBots installer's venv, then any `python` on PATH that can
  import OmniBots' dependencies. The choice is remembered per OmniBots folder
  (`extensions/omnibots-launcher.json`, git-ignored). When none works, it
  makes `<OmniBots folder>.venv` and installs OmniBots into it.
- The OmniBots folder is `OMNIBOTS_DIR`, else `C:omnibots`; without one
  the command says so and starts nothing. Status is a short summary (version,
  bots, jobs), never provider details.
- Files: `extensions/omnibots-launcher.js` (registered in
  `omni.config.json`), `skills/omnibots/SKILL.md`.
- Tests: `omnibots-launcher` (the three tools load; a missing OmniBots folder
  is named and nothing starts; with no usable Python, status says so and
  builds nothing).

## 3.5.7 — 2026-09-28

- **Shipped:** [#20](https://github.com/tattooinmtl/omni/pull/20) · 82d79c3 · minimax-m3.1-flash-preview · session `01a0ea7f-d30c-7033-a39f-f9b4d2d9c8ab`
- MiniMax (`minimax.io`) now ships `MiniMax-M3.1-Flash-Preview` as
  `minimax.io/m3.1-flash-preview`. That is the published API id (1,000,000
  token context, image input). The output cap is 128000, the same verified
  ceiling as M3, which stays under the API's 524288 max_tokens limit.
- Tests: `minimax` asserts the shipped id, context, vision flag, and output
  cap. `context-probe` pins the 1M family window for this id.

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
