# OMNI-AGENT

Omni-present harness for agents

A from-scratch terminal coding agent for Windows — now with expanded capabilities for semantic
code navigation, test coverage analysis, and security scanning. Talks to **OpenAI-compatible**
providers (NVIDIA NIM, local llama.cpp, Ollama, OpenRouter, …), runs a
tool-calling agent loop with per-tool permissions, persistent memory, and goal
mode — all with **zero npm dependencies** (pure Node ≥ 20 + built-in `fetch`).

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

## Install

One line, straight from here — checks the latest version, downloads it, and wires up the `omni` command:

```powershell
irm https://omni.globalwarningnetworks.com/install.ps1 | iex
```

Or clone it yourself:

```powershell
# Requires Git and Node.js 20+
git clone https://github.com/tattooinmtl/omni.git
cd omni
.\install\install.ps1
omni
```

Both routes run the same script — [`install/install.ps1`](install/install.ps1) — and
it is the only installer. The public URL serves a shim that fetches that file
from this repo, so the installer is whatever is on `main`: push a change and the
one-liner picks it up, with nothing to redeploy. It detects what it's pointed at
(a git checkout updates with `git pull`, anything else resyncs from the branch
zip), and re-running is always safe — your `.env` and `agent/settings.json` are
never overwritten.

```powershell
.\install\install.ps1 -AutoUpdate   # update in place without prompting
.\install\install.ps1 -Force        # resync every file from GitHub
```

Omni ships **with no API keys** — supply your own. First run writes a clean
`settings.json` into `agent/` (git-ignored). A free NVIDIA NIM key (the default
provider) is available at <https://build.nvidia.com>:

```powershell
node bin\omni.mjs --set-key nvidia nvapi-xxxxxxxx   # persist a key, then exit
$env:OMNI_NVIDIA_KEY = "nvapi-xxxxxxxx"             # or an env var (overrides the file)
# …or inside the REPL:  /apikey nvidia nvapi-xxxxxxxx
```

Got a second NVIDIA account? Give each its own key and Omni fails over to
the other one automatically when a key gets rate-limited (429), instead of
waiting out the backoff:

```powershell
# .env (or the REPL: /apikey nvidia1 <key>  /apikey nvidia2 <key>)
OMNI_NVIDIA1_KEY=nvapi-xxxxxxxx
OMNI_NVIDIA2_KEY=nvapi-yyyyyyyy
# switch manually anytime:  /switch-provider nvidia1|nvidia2   (alias /swp)
```

Secrets policy: the repo contains **no keys and no user data** — only
[`settings.example.json`](settings.example.json) and [`.env.example`](.env.example)
with empty placeholders. `agent/`, `.env`, and `vendor/` are git-ignored.

## Usage

```powershell
omni                                   # interactive REPL
omni --version                         # installed version + install path (also -V)
node bin\omni.mjs "fix the bug"        # one-shot mode
node bin\omni.mjs --model local/coder --resume
node bin\omni.mjs install <pkg>        # package manager (install|uninstall|list|search)
```

`omni --version` answers before any config is read, so it still works when
`settings.json` is broken — which is usually when you need it. Inside the REPL,
`/version` reports the same thing.

## Commands

Tab completes `/commands`. `/help` shows this grouped menu with usage strings.

| Category | Commands |
|---|---|
| Session | `/help` `/status` `/clear` `/compact [now]` `/resume` `/cost` `/cwd` `/config` `/version` `/exit` |
| Agent | `/goal` `/effort` `/route` `/diff` `/memory` `/tools` `/perm` `/workspace` |
| Models & Providers | `/model` `/models` `/default` `/doctor` `/addmodel` `/providers` `/provider` `/apikey` `/switch-provider` `/addprovider` `/llama` |
| Packages & Integrations | `/packages` `/install` `/uninstall` `/mcp` `/bridge` |

Unknown commands get a nearest-match suggestion. Multi-line input: end a line
with `\`.

### Goal mode

```
/goal migrate every fetch() call to the new client --tokens 200k
/goal pause | resume | edit <objective> | clear | status
```

Sets an objective the agent keeps working toward **across turns automatically**
— when a turn ends without the objective being met, Omni queues a
continuation until the model calls the `goal_complete` tool with a verified
summary, the iteration cap (25) is hit, or the token budget runs out.

### Effort

```
/effort            show current tier
/effort off|low|medium|high|xhigh
```

Sets the reasoning-effort tier sent to the provider (persisted; `xhigh` is sent
as `high` to OpenAI-compatible APIs).

### Tool permissions

| State | Behavior |
|---|---|
| `allow` | Permits the action silently (default) |
| `deny` | Blocks the action with an error message the model sees |
| `ask` | Prompts you for confirmation (`y` / `N` / `a` = always this session) |

`/perm <tool|*> <allow|deny|ask>` — persisted in `settings.json`. In one-shot
mode `ask` behaves as `deny`.

### Workspace & folder trust

File tools are sandboxed to the workspace root (symlink-aware — no `..` or
link escapes). Where that root lands depends on how you launch:

- **From nowhere in particular** (home, Documents, a drive root): Omni
  creates and enters the **workspace hub** — `Documents\OmniWorkspace` — the
  home for every project it builds. If your Documents folder is OneDrive-synced,
  the first run offers a local `C:\OmniWorkspace` instead (build output and
  sync clients don't mix). The choice persists in `settings.json`.
- **Inside a project folder** (`omni` in a repo): a one-time *"trust this
  folder?"* prompt — trusted folders are cached in `agent/folder-trust.json`,
  declining drops you into the hub instead.

`/workspace` shows root/trust/scope, `/workspace trust|untrust` manages the
cache, and `/workspace scope system` (extra confirm) lifts the sandbox
machine-wide when you really want the agent working across the whole PC —
`/workspace scope folder` puts the walls back up.

## Tools the agent can use

- **Files & code** — `read_file`, `read_many_files`, `write_file`, `edit_file`,
  `apply_patch`, `list_dir`, `find_files` (fd), `search` (ripgrep),
  `find_replace` (ripgrep-powered multi-file replace), `rename_symbol`
  (semantic whole-workspace rename via the language server), `jq_query`
- **Shell & processes** — `run_shell` (PowerShell), `run_test`,
  `start_process` / `process_status` / `stop_process`
- **Project & git** — `project_inspect`, `project_todo`, `git_status`,
  `git_diff`, `git_commit`, `create_markdown_report`
- **System diagnostics** — `system_info` (OS/CPU/RAM/GPU/disks),
  `dev_env_report` (~85 toolchains probed in parallel across 16 categories,
  incl. broken-PATH detection), `where_is`
- **Memory** — `memory_save` / `memory_search` / `memory_list` /
  `memory_forget`, stored in `agent/memory.jsonl`; recent memories are injected
  into the system prompt at startup
- **Goal** — `goal_complete` (goal mode's completion gate)
- **Web (extensions, no API keys)** — `web_search` (DuckDuckGo), `web_fetch`
  (page → text), `youtube_transcript` (title + description + full timestamped
  transcript; the agent "watches" videos by reading them)
- **Extensions** — `move_file`, `copy_file`, `delete_path`, `make_dir`, plus
  anything you drop in `extensions/` or install from the package registry
- **MCP** — one `mcp` proxy tool reaches any configured MCP server lazily

### Robust tool calling on any provider

Providers without native OpenAI tool calling (e.g. NVIDIA NIM) use a text
protocol. The parser (`src/core/toolcalls.mjs`) tolerates the canonical format
plus what models actually emit — GLM `<arg_key>/<arg_value>`, Qwen
JSON-in-`<tool_call>`, bare `<function=…>`, unclosed envelopes, hybrids — with
schema-aware argument coercion. Unparseable or truncated tool calls trigger a
corrective retry instead of silently ending the turn.

## Extending

Three extension points, one package format — see [docs/EXTENDING.md](docs/EXTENDING.md):

- **Extensions** — drop an ESM file exporting `{ name, tools, impl }` into
  `extensions/` and list it in `omni.config.json` to give the agent new tools
- **Skills** — a `skills/<name>/SKILL.md` with frontmatter becomes a `/slash-command`
  (auto-discovered at startup)
- **MCP servers** — add to `mcpServers` in the config or a project-local `.mcp.json`
- **Packages** — zip any of the above with a `omni-pkg.json` and host it behind a
  static `registry.json` for `/install`

Inside the REPL, `/extend` walks the agent through scaffolding one for you.

## Layout

```
Omni/
  bin/omni.mjs            thin launcher
  src/
    cli/                  REPL, command registry, goal mode, model picker
    core/                 agent loop, tool-call parser, provider client, config
    tools/                tool schemas + implementations
    integrations/         MCP proxy, NimTools bridge, package registry, router
    local/                llama.cpp server manager, GGUF reader
    ui.mjs  paths.mjs     terminal UI, vendored-binary resolution
  extensions/  prompts/  skills/  themes/  templates/
  tests/                  zero-dependency suites — npm test
  install/  scripts/  schema/  packages/  router/
  vendor/                 rg/fd/jq (fetched by installer, git-ignored)
  agent/                  your home: settings, sessions, memory (git-ignored)
```

## Tests

```powershell
npm test               # toolcalls + router + tools suites
$env:RUN_LIVE = "1"; npm test   # + live sidecar suite (needs Python)
```

## Local models (llama.cpp)

Point `llama.modelsDir` at a folder of `.gguf` files, then `/llama list`,
`/llama start 1`, `/model local/coder`. `contextSize: 0` reads the trained
context from the GGUF header.

## License

MIT — © Erik Boivin / Global Warning Networks
