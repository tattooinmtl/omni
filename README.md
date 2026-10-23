# OMNI-AGENT 3.5.28

Omni-present harness for agents

A from-scratch terminal coding agent for Windows. It talks to any
**OpenAI-compatible** provider (NVIDIA NIM, xKiro, MiniMax, Agnes, Atria,
Reflection, OpenRouter, local llama.cpp, Ollama, …) and runs a tool-calling agent loop with
per-tool permissions, sub-agents, self-review, layered memory, goal mode and a
live neural view. It has **zero npm dependencies**: pure Node ≥ 20 and the
built-in `fetch`.

```
 ██████╗ ███╗   ███╗███╗   ██╗██╗      █████╗  ██████╗ ███████╗███╗   ██╗████████╗
██╔═══██╗████╗ ████║████╗  ██║██║     ██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝
██║   ██║██╔████╔██║██╔██╗ ██║██║████╗███████║██║  ███╗█████╗  ██╔██╗ ██║   ██║
██║   ██║██║╚██╔╝██║██║╚██╗██║██║╚═══╝██╔══██║██║   ██║██╔══╝  ██║╚██╗██║   ██║
╚██████╔╝██║ ╚═╝ ██║██║ ╚████║██║     ██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║
 ╚═════╝ ╚═╝     ╚═╝╚═╝  ╚═══╝╚═╝     ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝
                        Omni-present harness for agents
```

**[omni.globalwarningnetworks.com](https://omni.globalwarningnetworks.com/)**

## What's new

**3.5.28**
- **Named sub-agents:** `explorer`, `reviewer` and `tester` ship with Omni;
  add your own in `.omni/agents/`. Each has a role, a tool list, read-only or
  not, and its own model. `/agents` lists them.
- **Sub-agents on their own git branch:** a worktree agent works in a separate
  checkout. `merge_agent` has the critic review its diff and merges only a
  clean one.

**3.5.27**
- **Headless mode:** `omni -p "…" --output json` (or `stream-json`) prints
  only JSON on stdout, reads the prompt from stdin, stops at `--max-turns`,
  and exits 0, 1 or 3 so scripts and CI can tell what happened.
- **Prompt templates:** Markdown files in `.omni/commands/` become slash
  commands, with `$ARGUMENTS`, `$1`…`$9` and `@file`. `/templates` lists them.
- **Fixed:** a one-shot run's `--model` was saved as your next session's
  model, even when it had no API key.

**3.5.26**
- **Plan mode and permission modes:** Shift+Tab cycles default, accept
  edits and plan. In plan mode the agent only reads, then shows you a plan to
  approve, and your first prompt offers the brainstorming skill.
- **Rewind:** Omni checkpoints the workspace before each turn changes
  anything. `/rewind` puts files and/or the conversation back.
- **Sessions:** every conversation has a code (`omni --resume <code>` from
  any folder). `/fork` branches it and `/export` saves it as Markdown, HTML
  or JSON.
- **Fixed:** the agent's `ask_user` questions never reached you; it was
  always told no one was there.

**3.5.25**
- **Project instructions:** Omni follows `OMNI.md` (or an existing
  `AGENTS.md` / `CLAUDE.md`) from the repo root down to the folder you're
  in, plus your own `~/.omni/agent/OMNI.md`. `/init` has the agent write
  one, `/instructions` shows what's loaded, `/instructions add <rule>`
  appends a rule.
- **Hooks:** your own commands run at session start, prompt submit, before
  and after each tool call, before compaction, and when the agent stops.
  They can block, rewrite or add context. `/hooks` lists them.
- **Compaction summaries:** when the context fills up, or on
  `/compact [focus]`, a model writes a structured summary of the older turns
  instead of only listing the tools used. Point it at a cheaper model with
  `"compaction": { "model": "<provider/model>" }` in settings.
- **Resume any conversation:** `/resume` opens a picker of this folder's
  past conversations, and `/history <words>` (or the agent's
  `session_search` tool) searches them. `/resume` and `--resume` used to
  restore the session Omni had just started, which held nothing.

**3.5.5**
- A key set with `/provider apikey`, `/provider login`, `/provider edit` or
  the `/addprovider` and `/connect` key prompts now survives a restart for
  providers with several accounts (`nvidia`, `agnes`). `/provider logout` now
  stays logged out.
- `OMNI_HOME` is only read from the real environment. Setting it in `.env`
  used to split settings and the last-used model across two folders.
- `/help` lists every command, including `/browser`.
- `docs/EXTENDING.md` now ships with the repo and the install.
- The shipped `omni.config.json` validates against its own schema.

**3.5.x**
- **Prompt box:** pinned to the bottom of the terminal like Claude Code. You
  can keep typing while the agent works, pastes never send by themselves, and
  `/btw` steers a turn that's already running.
- **Shell:** `run_shell` no longer freezes Omni. Long builds stream, Esc stops
  them, timeouts kill the whole process tree, and the real exit code is
  reported (no more false failures from `cargo` writing to stderr).
- **Neural view:** tied to Omi's lifetime, restartable, and it tells you when
  Omi has closed.
- **Skills:** fixed the provider 400 errors (MiniMax 2013) when loading a skill
  mid-turn.
- **Editing tools on Windows:** `edit_file`, `apply_patch` and `edit_lines`
  work on CRLF files and keep each file's own line endings.
- **Installer:** updates by default, never moves a dirty or diverged checkout,
  and tells you plainly when an update didn't apply.
- **Reliability sweep:** MCP servers start and stop cleanly, the Python
  router bridge works end to end, memory atom ids no longer collide, and every
  state file is written atomically.

**3.1–3.4**
- **Providers:** xKiro (12 free-tier models, the shipped default), Atria ASI,
  MiniMax folded into one `minimax.io` provider with `/getmodel`, and up to
  four rotating NVIDIA accounts.
- **`/connect` and `/disconnect`:** one picker for provider, key and model.
- **`self_review`:** an independent critic that only sees the task and the
  diff.
- **Per-model vision:** only models that can see are sent images.
- **External skill index:** skills found by an outside scanner are reachable
  through `find_skill` and `invoke_skill`.
- **Security:** keys are redacted from logs, env-supplied keys never land in
  `settings.json`, and `run_test` goes through the same risk gate as
  `run_shell`.

**3.0**
- Local llama.cpp with automatic CPU/Vulkan selection from a cached hardware
  profile, plus video understanding through `read_video_file`.

## Install

One line, straight from here. It checks the latest version, downloads it, and
wires up the `omni` command:

```powershell
irm https://omni.globalwarningnetworks.com/install.ps1 | iex
```

Or clone it yourself:

```powershell
# Requires Git and Node.js 20+
# Clone straight into ~/.omni so it matches the one-liner's default install dir
git clone https://github.com/tattooinmtl/omni.git $HOME\.omni
cd $HOME\.omni
.\install\install.ps1
omni
```

Both routes run the same script, [`install/install.ps1`](install/install.ps1).
The public URL serves a small shim that fetches that file from this repo, so the
installer is always whatever is on `main`. The install dir is `~/.omni`; pass
`-InstallDir <path>` for a development checkout. A git checkout updates with a
fast-forward, anything else resyncs from the branch zip. Re-running is always
safe: your `.env` and `agent/settings.json` are never overwritten.

```powershell
.\install\install.ps1              # update in place (the default)
.\install\install.ps1 -NoUpdate    # only report whether an update exists
.\install\install.ps1 -Force       # resync every file from GitHub
```

The installer refuses to move a checkout with uncommitted changes, or one with
commits that exist nowhere on the remote. It names them and stops rather than
losing work.

### Optional runtime pack

Portable tools Omni uses when they are there, installed into Omni's own
`vendor/` folder: no admin rights, nothing system-wide, and every download is
checked against the SHA-256 its GitHub release publishes before it is
unpacked. Omni puts `vendor/` first on PATH at startup.

| Part | Unlocks | Download |
|---|---|---|
| `ffmpeg` + `ffprobe` 9.0.2 | video understanding (`read_video_file`) | 115 MB |
| `ripgrep` 15.2.0 | fast `search`, `search_replace`, `security_scan` | 2 MB |
| `fd` 10.5.0 | fast `find_files` | 2 MB |
| `jq` 1.8.2 | the `jq` tool | 1 MB |
| `lsp`: TypeScript 7 + Pyright (npm) | `lsp` and `rename_symbol` for JS/TS/Python | ~60 MB |

```powershell
$env:OMNI_RUNTIME = "1"; irm https://omni.globalwarningnetworks.com/install.ps1 | iex   # with the install
.installinstall.ps1 -WithRuntime                                                       # from a checkout
```

Or later, from Omni: `/runtime` shows what is installed and what each part
unlocks, `/runtime install` adds the first four (skipping any the PC
already has), `/runtime install lsp` the language servers, `/runtime install
all` everything, `/runtime remove <name>` takes one out. Outside the REPL:
`omni runtime install`. Downloads are Windows x64; elsewhere `/runtime` prints
the package-manager command instead.

## API keys

Omni ships **with no API keys**; supply your own. The first run writes a clean
`settings.json` into `agent/` (git-ignored).

```powershell
node bin\omni.mjs --set-key nvidia nvapi-xxxxxxxx   # save a key, then exit
# …or inside the REPL:  /apikey nvidia nvapi-xxxxxxxx
# …or /connect for a guided provider + key + model picker
```

Keys can also come from environment variables or a `.env` file
(`OMNI_<PROVIDER>_KEY`, see [`.env.example`](.env.example)). **A non-empty key
in `settings.json` wins**; env keys only fill providers whose saved key is
empty. A real shell variable beats `.env`.

**Multiple accounts.** NVIDIA and Agnes support several accounts. When one key
gets rate-limited (429), Omni fails over to the next one instead of waiting:

```powershell
# .env (or in the REPL: /apikey nvidia1 <key>  /apikey nvidia2 <key>)
OMNI_NVIDIA1_KEY=nvapi-xxxxxxxx
OMNI_NVIDIA2_KEY=nvapi-yyyyyyyy
# switch manually any time:  /switch-provider nvidia2   (alias /swp)
```

**Secrets policy.** The repo contains no keys and no user data, only
[`settings.example.json`](settings.example.json) and
[`.env.example`](.env.example) with empty placeholders. `agent/`, `.env` and
`vendor/` are git-ignored. Env-supplied keys are stripped before
`settings.json` is written, and key-shaped strings are redacted from session
logs.

## Providers

Shipped presets: `xkiro` (default), `nvidia`, `minimax.io`, `agnes`, `atria`,
`reflection`, `openai`, `openrouter`, `groq`, `deepseek`, `google`, `xai`,
`grok`, `mistral`, `kimi`, `claude`, `cursor`, `together`, `fireworks`, `ollama`
and `local`.
Any other OpenAI-compatible endpoint works through `/addprovider`.

```text
/connect                      pick provider → add key if needed → pick model
/model                        arrow-key model picker
/getmodel minimax             fetch a provider's live model list and save it
/addprovider myhost https://api.example.com/v1 sk-xxxx
/addmodel mykey myhost some-model-id 32768
/doctor                       probe the active model and save its health
/probe-contexts               detect every model's real context window
/disconnect nvidia            clear a key so you can reconnect with another
```

The last model you used is restored on the next launch.

## Usage

```powershell
omni                                   # interactive REPL
omni --version                         # installed version + install path (also -V)
node bin\omni.mjs "fix the bug"        # one-shot mode
node bin\omni.mjs --model local/coder --resume
node bin\omni.mjs install <pkg>        # package manager (install|uninstall|list|search)
```

`omni --version` answers before any config is read, so it still works when
`settings.json` is broken. Inside the REPL, `/version` reports the same thing.
Omni checks for a newer version in the background (cached, never on the hot
path) and tells you when one exists.

### Headless (scripts and CI)

```powershell
omni -p "fix the failing test" --output json          # one JSON object on stdout
omni -p "review src/" --output stream-json            # one JSON event per line, live
"summarize the repo" | omni -p --output json          # the prompt from stdin
omni -p "plan the migration" --mode plan --max-turns 10
omni -p "/review src/app.js" --output json            # templates and skills work too
```

With `json` or `stream-json`, stdout holds only JSON; everything Omni would
print in the terminal goes to stderr, so `| ConvertFrom-Json` or `| jq` just
work. The result object has `ok`, `stop` (`done`, `error`, `max_turns`),
`result` (the final answer), `error`, `session` (the code to `--resume` it),
`model`, `mode`, `turns`, `toolCalls`, `usage` and `durationMs`. The stream
starts with an `init` event and then emits `user`, `assistant` (with its
`toolCalls`), `tool_result` and `error` events as they happen, ending with the
same `result`.

Exit codes: `0` the agent finished, `1` an error (no API key, provider failure,
a hook blocked the prompt), `3` it reached `--max-turns` first. Headless runs
never stop to ask: tools set to `ask` are refused, and a `--model` given to a
script doesn't become your next session's model.

## Commands

Tab completes `/commands`, typing `/` opens a live menu, and `/help` lists
everything with usage strings. Unknown commands get a nearest-match suggestion.

| Category | Commands |
|---|---|
| Session | `/help` `/image` `/status` `/clear` `/compact [now] [focus]` `/resume` `/history` `/fork` `/export` `/rewind` `/cost` `/cwd` `/config` `/version` `/exit` `/personality` `/compare-personality` `/expand-skill` `/expand` |
| Agent | `/goal` `/effort` `/thinking` `/route` `/btw` `/diff` `/mode` `/plan` `/instructions` `/init` `/templates` `/agents` `/hooks` `/memory` `/neuralview` `/rag` `/tools` `/perm` `/workspace` |
| Models & Providers | `/model` `/models` `/getmodel` `/context` `/probe-contexts` `/default` `/doctor` `/addmodel` `/providers` `/provider` `/switch-provider` `/apikey` `/connect` `/disconnect` `/addprovider` `/llama` `/llama-start` `/llama-stop` `/llama-restart` `/hardware` |
| Tools | `/browser` `/runtime` `/omnibots` |
| Packages & Integrations | `/packages` `/install` `/uninstall` `/mcp` `/bridge` |

Every installed skill is also a `/slash-command`.

### The prompt box

The input box is pinned to the bottom of the terminal, with Omi's status line
above it and the context/model bar below. Output scrolls above the box, and the
box stays usable while the agent works:

- **Enter while the agent works** queues your message (the border shows
  `1 queued`); it runs as soon as the current turn ends.
- **`/btw <note>` while the agent works** goes straight into the running turn.
  The agent reads it at its next step and adjusts without stopping. `/help`,
  `/status`, `/cost` and `/version` also run right away; other commands wait
  in the queue.
- **Esc** interrupts the turn, including a running shell command. Arrow keys
  don't interrupt; they edit and recall history.
- **Pasting never sends.** A one-line paste lands in the box as text. A
  multi-line paste shows as `[Pasted text #1 +14 lines]` and is sent in full
  when you press Enter.
- **Ctrl-C** clears the box; with the box empty, press it twice to exit.
- **Multi-line input:** end a line with `\`.

Set `OMNI_SIMPLE_PROMPT=1` for the plain one-line prompt instead. That's also
what you get when the terminal has fewer than 12 rows or isn't interactive.
`OMNI_BRACKET_PASTE=0` turns bracketed paste off.

### Goal mode

```
/goal migrate every fetch() call to the new client --tokens 200k
/goal pause | resume | edit <objective> | clear | status
```

Sets an objective the agent keeps working toward **across turns
automatically**. When a turn ends without the objective met, Omni queues a
continuation until the model calls `goal_complete` with a verified summary,
the iteration cap is hit, or the token budget runs out.

### Effort and thinking

```
/effort off|low|medium|high|xhigh     reasoning-effort tier (persisted)
/thinking on|off|last                 show live <think> reasoning, or reprint the last turn's
```

`xhigh` is sent as `high` to OpenAI-compatible APIs.

### Personas and context modes

- **`/route coding|assistant|auto`** pins a persona, or lets the router pick
  one per message.
- **`/personality classic|lean`** switches the context mode. Lean mode uses
  distilled skills, rolling compaction and shrunk tool results to save tokens.
  `/expand-skill` and `/expand <hash>` bring back a full body when needed, and
  `/compare-personality` shows the average token cost of each mode. An
  `omni.config.json` in the project folder can set the mode per project.
- **`/context 200k`** overrides a model's context window; `/context auto` goes
  back to the detected value.

### Project instructions (OMNI.md)

Omni reads one instruction file per folder, from the repo root (the nearest
parent with `.git`) down to the folder you launched in: `OMNI.md` if there is
one, otherwise `AGENTS.md`, otherwise `CLAUDE.md`. Your personal rules for
every project go in `~/.omni/agent/OMNI.md`, which is read first. A deeper
file wins where two disagree. A line holding only `@docs/style.md` pulls that
file in. Sub-agents follow the same rules.

```
/init                         have the agent study the project and write OMNI.md
/instructions                 which files are loaded, and their size
/instructions add <rule>      append a rule to ./OMNI.md
/instructions reload          re-read them after editing
```

### Compaction

When the conversation nears the model's context window (or on `/compact`),
the older turns are replaced by a summary a model writes under fixed
headings: goal, decisions, files touched, what's done, what's open, errors.
`/compact now` keeps only the last two messages; anything after it is a
focus, as in `/compact keep the API shapes`. Durable facts are saved to
memory first. In `agent/settings.json`:

```json
"compaction": { "model": "agnes/agnes-2.5-flash" }
```

runs the summary on a cheaper model so it doesn't spend the main one's rate
limit. Local models use the plain tool list unless you set a model here, and
`"mode": "mechanical"` always does.

### Hooks

Hooks run your own command at a point in the agent loop. Put them in
`agent/settings.json`:

```json
"hooks": [
  { "event": "PreToolUse", "matcher": "run_shell", "command": "node C:/tools/no-force-push.mjs" },
  { "event": "Stop", "command": "npm test --silent", "timeout_ms": 120000 }
]
```

Events: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`,
`PreCompact`, `Stop`, `SubagentStop`. The hook gets the event as JSON on
stdin. Exit 2 blocks (stderr is the reason; on `Stop` it sends the agent back
to work, up to 3 times a turn). Exit 0 with text adds that text as context.
A project can ship `.omni/hooks.json`, which only loads once you trust the
folder. `/hooks` lists what's loaded; `OMNI_NO_HOOKS=1` turns them off. The
full contract is in [docs/EXTENDING.md](docs/EXTENDING.md#hooks).

### Prompt templates

A Markdown file in `.omni/commands/` (this project) or
`~/.omni/agent/commands/` (every project) becomes a slash command:
`review.md` is `/review`, and `.omni/commands/git/pr.md` is `/git:pr`. Its
text is what gets sent, as if you had typed it.

```markdown
---
description: Review a file for bugs
argument-hint: <file>
---
Review @$1 for bugs and missing tests. Pay extra attention to: $ARGUMENTS
```

`$ARGUMENTS` is everything typed after the command, `$1`…`$9` one argument
each (`"quoted words"` count as one), and `@path` is replaced by that file's
contents (inside the workspace, up to 50 KB). With no placeholder in the text,
what you type is added at the end. A project template beats a personal one,
built-in commands beat templates, and templates beat skills of the same name.
`/templates` lists them; they show up in the `/` menu too.

### Sub-agents

The agent can hand a self-contained task to a sub-agent that runs in
parallel (`spawn_agent`), on another provider if you like, so the two don't
share a rate limit.

**Named agents** give a sub-agent a role and limits. Omni ships three:

| Agent | Does | Limits |
|---|---|---|
| `explorer` | finds where something lives and how it works | read-only |
| `reviewer` | reviews a change, ends with a VERDICT line | read-only |
| `tester` | writes and runs tests, never changes the code under test | its own git branch |

Add your own as `.omni/agents/<name>.md` (this project) or
`~/.omni/agent/agents/<name>.md` (every project). A project agent with a
shipped name replaces it.

```markdown
---
description: Updates the docs to match a code change
tools: read_file, search, edit_file, write_file
model: agnes/agnes-2.5-flash
isolation: worktree
---
You keep README.md and docs/ in step with the code. …
```

`tools` limits what it may use (only those are offered to the model),
`readonly: true` gives it read tools only, `model` runs it on its own
provider, and the body is its role. A sub-agent is never allowed more than
you are: your `deny` settings still apply, and anything you'd be asked about
still asks. `/agents` lists them and the sub-agents running now.

**Own git branch.** With `isolation: worktree` (or `spawn_agent` with
`isolation:"worktree"`), the sub-agent works in a separate checkout of your
repo on a new branch, under `~/.omni/agent/worktrees/`. It can't collide with
you or another agent, and nothing reaches your files until `merge_agent`:

1. an independent critic reviews the branch's diff against the task the
   agent was given;
2. on `VERDICT: CLEAN` or `MINOR` the branch is merged into what you have
   checked out; on `MAJOR`, `BLOCKERS` or no verdict it isn't, and you get
   the findings (`force:true` merges anyway);
3. the worktree and branch are removed. `action:"discard"` drops them
   without merging.

The branch starts from your last commit, so uncommitted changes are not in
it. It needs a git repo with at least one commit. Under the hood the agent is
a headless `omni -p --agent <name>` running in that checkout, so you can run
one yourself the same way.

### Sessions: resume, search, fork, export

Every conversation has a code such as `omni-session-mvkely37-ftzhe6i`.
`/status` shows it, and Omni prints it when you exit.

```
omni --resume <code>          come back to that conversation, from any folder
omni --resume                 the latest one in this folder
/resume                       pick from this folder's earlier conversations
/resume 2 | latest | <code>   skip the picker
/history <words> [--all]      search what was said (the agent has session_search)
/fork                         carry on in a copy; the original stays as it was
/export [md|html|json] [file] save it (html is one standalone page)
/clear                        start fresh; the old conversation stays resumable
```

### Rewind

Before a turn first changes anything (an edit, a write, a shell command that
isn't read-only), Omni snapshots the workspace into a private checkpoint
store under `~/.omni/agent/checkpoints/`. Your project's own `.git` is never
touched, folders that aren't repos work too, and `.gitignore` plus
`node_modules/`, `dist/`, `build/` and similar are skipped.

```
/rewind                       pick a checkpoint, then: files and conversation,
                              files only, or conversation only
/rewind 12 code               files only, back to checkpoint #12
```

Rewinding the conversation also puts that prompt back in the box so you can
edit and resend it. A rewind first snapshots the current state, so you can
rewind the rewind. Turn checkpoints off with `"checkpoints": false` in
`agent/settings.json`. Folders inside the workspace that are their own git
repos are recorded as a link only, so rewind does not restore their files.

### Permission modes and plan mode

Shift+Tab cycles the mode; the prompt box shows which one is on.

| Mode | What happens |
|---|---|
| `default` | your `/perm` settings, exactly as they are |
| `accept-edits` | file edits run without asking; shell commands still follow your settings |
| `plan` | read-only: the agent investigates, then shows you a plan to approve |
| `auto` | nothing asks, except high-risk shell commands (`/mode auto` confirms first) |

No mode overrides a `deny`. In plan mode, reads, searches and read-only shell
commands (`git status`, `ls`, `rg`, …) run; anything else is refused. When the
agent knows what to do it calls `exit_plan_mode`, and you answer with
1 (implement it), 2 (implement it and accept edits), 3 (keep planning), or by
typing what to change. An approved plan's steps go into `project_todo`. The
first prompt you send in plan mode offers to load the brainstorming skill
first.

```
/plan [prompt]                switch to plan mode (and send a prompt)
/mode [name]                  show or set the mode
omni --mode plan "…"          start in a mode; or "permissionMode" in settings
```

### Tool permissions

| State | Behavior |
|---|---|
| `allow` | Permits the action silently (default) |
| `deny` | Blocks the action with an error message the model sees |
| `ask` | Prompts you for confirmation (`y` / `N` / `a` = always this session) |

`/perm <tool|*> <allow|deny|ask>` is persisted in `settings.json`. In one-shot
mode `ask` behaves as `deny`. Destructive shell commands go through a separate
risk gate that asks you first, whichever tool runs them (and refuses them outright in one-shot mode).

### Workspace and folder trust

File tools are sandboxed to the workspace root (symlink-aware, so no `..` or
link escapes). Where that root lands depends on how you launch:

- **From nowhere in particular** (home, Documents, a drive root): Omni creates
  and enters the **workspace hub**, `Documents\OmniWorkspace`. If Documents is
  OneDrive-synced, the first run offers a local `C:\OmniWorkspace` instead. The
  choice persists in `settings.json`.
- **Inside a project folder:** a one-time *"trust this folder?"* prompt.
  Trusted folders are cached in `agent/folder-trust.json`; declining drops you
  into the hub.

`/workspace` shows root, trust and scope. `/workspace trust|untrust` manages
the cache, and `/workspace scope system` (extra confirmation) lifts the sandbox
machine-wide. `/workspace scope folder` puts the walls back up.

### Neural view

`/neuralview` opens a live map of the knowledge base and memory in your
browser. It pulses as the agent works. It runs only while Omi is open: when Omi
closes, the tab says so, and it reloads by itself the next time Omi starts. If
a tab is already open, `/neuralview` brings that tab forward instead of opening
another one.

| | |
|---|---|
| `/neuralview open` | open another tab |
| `/neuralview restart` | restart it on the same port (open tabs reconnect) |
| `/neuralview stop` | stop it for this session |
| `/neuralview status` | port, open tabs, graph size |

It uses port 5678, bound to localhost with a Host check. A second Omi window
uses the next free port, and `/neuralview` tells you which Omi holds 5678.

## Tools the agent can use

- **Files and code:** `read_file`, `read_many_files`, `write_file`,
  `edit_file`, `edit_lines`, `apply_patch`, `list_dir`, `find_files` (fd),
  `search` (ripgrep), `find_replace`, `diff_files`, `jq_query`
- **Code intelligence:** `lsp`, `find_symbol`, `rename_symbol` (semantic
  whole-workspace rename), `deps`, `test_coverage`, `lint_check`,
  `security_scan`, `rag_search` / `rag_index` (workspace retrieval, also
  `/rag`)
- **Shell and processes:** `run_shell` (PowerShell, async, Esc-interruptible),
  `run_test`, `start_process` / `process_status` / `process_input` /
  `stop_process`
- **Project and git:** `project_inspect`, `project_todo`, `git_status`,
  `git_diff`, `git_commit`, `create_markdown_report`, plus the git-ops
  extension (`git_push`, `git_pull`, `git_fetch`, `git_clone`, `git_branch`,
  `git_checkout`, `git_log`, `git_merge`, `git_rebase`, `git_stash`,
  `git_tag`, …)
- **Sub-agents:** `spawn_agent` runs a task in parallel, optionally on a
  different provider or model, as a named agent, or on its own git branch.
  `agent_status` and `stop_agent` manage it; `merge_agent` reviews and merges
  a branch agent's work.
- **Self-review:** `self_review` sends the task and the diff to an independent,
  read-only critic that can't be talked round by the author's reasoning.
- **Memory:** `memory_save`, `memory_search`, `memory_list`, `memory_forget`,
  `memory_deprecate`, `memory_explain`, `memory_atoms`. Memory is captured
  automatically as weighted, layered atoms; `/memory` inspects it.
  `session_search` finds what was said in earlier conversations.
- **Skills and self-extension:** `find_skill`, `invoke_skill`, `create_tool`
  (writes a new tool and hot-loads it into the running session),
  `settings_add_model`, `settings_set_apikey`
- **System diagnostics:** `system_info` (OS/CPU/RAM/GPU/disks),
  `dev_env_report` (about 85 toolchains probed in parallel, including
  broken-PATH detection), `where_is`
- **Web (no API keys):** `web_search` (DuckDuckGo), `web_fetch`,
  `youtube_transcript`, `http_request`
- **Browser:** `browser_navigate`, `browser_click`, `browser_type`,
  `browser_screenshot`, `browser_get_text`, `browser_extract`,
  `browser_evaluate`, … drive a headless Edge/Chrome for JS-rendered pages,
  with the GPU on when this PC has one.
  `/browser` gives manual control.
- **OmniBots:** `/omnibots` starts the tray app (or brings its window forward).
  `/omnibots status` and `/omnibots stop` check or close it.
- **Vision:** `read_media_file`, `read_video_file` (see below)
- **Files:** `move_file`, `copy_file`, `delete_path`, `make_dir`
- **Interaction and goals:** `ask_user`, `goal_complete`
- **MCP:** one `mcp` proxy tool reaches any configured MCP server lazily. The
  bundled OKF knowledge-base server is wired in by default.

`/tools` lists everything available in the current session.

### Robust tool calling on any provider

Providers without native OpenAI tool calling use a text protocol. The parser
(`src/core/toolcalls.mjs`) accepts the canonical format plus what models
actually emit: GLM `<arg_key>/<arg_value>`, Qwen JSON-in-`<tool_call>`, bare
`<function=…>`, unclosed envelopes and hybrids, with schema-aware argument
coercion. Unparseable or truncated tool calls trigger a corrective retry
instead of silently ending the turn. System messages are merged to the top of
each request, so providers that reject mid-conversation system messages
(MiniMax, many llama.cpp templates) work with skills and goal mode.

## Skills

About 220 skills ship in `skills/`, covering languages, frameworks, creative
work, research and agent orchestration. Each is a `/slash-command`, and the
agent can find and load them itself with `find_skill` / `invoke_skill`.
Skills are discovered from:

1. `skills/*/SKILL.md` under the install root (`autoDiscoverSkills`)
2. User skill folders (`~/.agents/skills/`, `~/.kimi-code/skills/`)
3. An external index written by a scanner. Point your own at it with
   `"skillIndex": "<path to skills.json>"` in `agent/settings.json`, which
   wins over the shipped default in `omni.config.json`. Don't edit
   `omni.config.json` for this: a changed install folder blocks the
   installer's updates.

## Local models (llama.cpp)

Omni ships two `llama-server` builds, CPU and Vulkan, in `server/`. The default
models directory is `C:\models`; the installer offers to create it.

```text
/llama list                       # numbered menu of what's on disk
/llama-start                      # start the default model, auto-pick backend
/llama-start 3                    # start model #3 from the list
/llama-start qwen3 vulkan         # explicit backend
/llama-start qwen3 vulkan --force # override the VRAM<6GB CPU fallback
/llama-stop
/llama-restart
/hardware                         # this PC + the settings Omni chose for it
/hardware set browserGpu off      # override one choice (auto puts it back)
```

**Fits each PC:** on first launch (and after a hardware change) Omni scans
the machine: CPU, RAM, every GPU and whether it is a graphics card, a
built-in iGPU or software-only, display and refresh rate, battery and power
plan, free disk, and which of python, git, ffmpeg, ollama, docker and a
browser are installed. It caches the result in `agent/hardware-profile.json`,
chooses settings from it (browser GPU on or off, local-model backend and
threads) and gives the agent a short summary of the machine every session,
so it stops guessing. `/hardware` shows each choice and why;
`/hardware set <browserGpu|localBackend> <value|auto>` overrides one.

**Backend choice:** With less than 6 GB of VRAM,
`/llama-start` picks `cpu`; 6 GB or more gets `vulkan`.

- Change the threshold: `settings.llama.gpuMinVramGB` (default 6).
- Always allow Vulkan: `settings.llama.allowLowVram: true`.
- One-off override: append `--force`.
- Re-scan after a GPU swap: `/hardware rescan`.

**Models directory:** set `llama.modelsDir` in `agent/settings.json` or the
`OMNI_MODELS_DIR` env var.

**Small-model rails:** when a local model is active (provider `local` or
`ollama`, or any loopback `baseUrl`), Omni appends short, strict instructions
so small GGUFs call real Omni tools instead of inventing them. Cloud providers
don't get them.

## Vision: images and videos

Vision is a per-model capability. Any model marked as vision-capable can look
at pixels:

- **`read_media_file <path>`:** png, jpg, gif, webp, bmp.
- **`/image [file]`:** share an image file, or paste a screenshot from the
  clipboard when no file is given.
- **`read_video_file <path>`:** mp4, mov, webm, mkv, avi, m4v. It extracts
  frames with `ffmpeg` (default 6, mode `even`; also `scene` and `interval`),
  capped at 16 frames and 20 MB. Needs `ffmpeg`: `/runtime install ffmpeg`
  (or any `ffmpeg` on PATH).

Text-only models get a one-line "image omitted" note instead of an error.

## Extending

Three extension points and one package format. The full guide is
[docs/EXTENDING.md](docs/EXTENDING.md).

- **Extensions:** drop an ESM file exporting `{ name, tools, impl }` into
  `extensions/` and list it in `omni.config.json`. Or just ask the agent to
  "create a tool that does X"; `create_tool` writes it and hot-loads it with no
  restart.
- **Skills:** a `skills/<name>/SKILL.md` with frontmatter becomes a
  `/slash-command`.
- **MCP servers:** add to `mcpServers` in the config or a project-local
  `.mcp.json`. `/mcp` shows status and reconnects.
- **Packages:** zip any of the above with an `omni-pkg.json` and host it behind
  a static `registry.json` for `/install`.

Inside the REPL, `/extend` walks the agent through scaffolding one for you.

## Layout

```
Omni/
  bin/omni.mjs            thin launcher
  src/
    cli/                  REPL, prompt box, paste handling, command registry, goal mode, model picker
    core/                 agent loop, tool-call parser, provider client, config, memory, context modes
    tools/                tool schemas + implementations
    integrations/         MCP proxy, NimTools bridge, LSP, RAG, package registry, router, update check
    local/                llama.cpp manager, GGUF reader, hardware profile, neural view
    ui.mjs  paths.mjs     terminal UI, vendored-binary resolution
  extensions/  prompts/  skills/  themes/  templates/  docs/
  tests/                  zero-dependency suites (npm test)
  install/  scripts/  schema/  packages/  router/
  vendor/                 rg/fd/jq (fetched by the installer, git-ignored)
  agent/                  your home: settings, sessions, memory (git-ignored)
```

`agent/` can be moved by setting `OMNI_HOME` as a real environment variable
(not in `.env`).

## Tests

```powershell
npm test                          # every suite (61), no network needed
$env:RUN_LIVE = "1"; npm test     # + live suites (need Python / real providers)
```

## License

MIT — © Erik Boivin / Global Warning Networks
