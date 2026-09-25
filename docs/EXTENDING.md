# Extending Omni

Omni has three extension points, plus a package format for distributing them,
plus cosmetic/runtime config (themes, providers):

| What | Adds | Lives at | Needs restart |
|---|---|---|---|
| **Extension** | New tools the model can call | `extensions/<name>.js` + config entry | no — `create_tool` hot-loads |
| **Skill** | A `/slash-command` that injects instructions | `skills/<name>/SKILL.md` | yes |
| **MCP server** | External tool server via the `mcp` proxy tool | `omni.config.json` or `.mcp.json` | yes |
| **Package** | Any of the above, zipped for the registry | `omni-pkg.json` + payload | — |
| **Theme** | Terminal color palette | `themes/<name>.json` + config entry | yes |
| **Provider/model** | A new OpenAI-compatible LLM backend | `/addprovider`, `/addmodel` (persisted) | no |

All paths are relative to the Omni install root (the folder containing
`omni.config.json`), **not** the workspace you run `omni` in.

## Creating a tool on the spot (no restart)

Just ask: *"create a tool that does X"*. The agent has a built-in `create_tool`
tool that writes an extension's source to `extensions/<name>.js`, **hot-loads
it into the running session immediately** (the new tool is callable on the
very next turn), and persists it to `omni.config.json` so it survives
restarts. Asking again with the same name replaces the old version — old tool
names from that file are dropped first, so the agent can iterate on a broken
tool without leaving stale duplicates behind.

This is the fast path for anything you'd otherwise hand-write as an extension
(see below) — the agent already knows the `{ name, tools, impl }` contract and
will write it correctly from the description alone.

## Extensions (custom tools, written by hand)

An extension is a single ESM JavaScript file that default-exports:

```js
export default {
  name: "my-extension",          // shown in the startup banner
  tools: [ /* OpenAI function-tool schemas */ ],
  impl:  { /* toolName: fn */ },
};
```

**Shipped extensions:**

- `extensions/file-tools.js` — `move_file`, `copy_file`, `delete_path`, `make_dir`
- `extensions/web-search.js` — `web_search` (DuckDuckGo), `web_fetch` (HTTP, no JS), `youtube_transcript`
- `extensions/browser-use.js` — `browser_navigate`, `browser_screenshot`, `browser_get_text`, `browser_get_html`, `browser_extract`, `browser_click`, `browser_type`, `browser_evaluate`, `browser_status`, `browser_close`. Drives a headless Edge/Chrome over Chrome DevTools Protocol — use for JS-rendered pages, SPAs, dashboards, login-walled content that `web_fetch` can't read. Node 21+ required (built-in `WebSocket`). `/browser [status|close|navigate <url>|screenshot]` for manual control.

Each entry in `tools` is a standard OpenAI-style function tool schema, and each
key in `impl` must match a tool name:

```js
// extensions/word-count.js
export default {
  name: "word-count",
  tools: [
    {
      type: "function",
      function: {
        name: "word_count",
        description: "Count words and lines in a text file.",
        parameters: {
          type: "object",
          properties: { path: { type: "string", description: "File to count" } },
          required: ["path"],
        },
      },
    },
  ],
  impl: {
    async word_count({ path: p }) {
      const fs = await import("node:fs");
      const text = fs.readFileSync(p, "utf8");
      return `${text.split(/\s+/).filter(Boolean).length} words, ${text.split("\n").length} lines`;
    },
  },
};
```

Rules of the contract (see `registerExtensions` in `src/tools/index.mjs`):

- `impl` functions receive the parsed arguments object; they may be sync or
  async. Whatever they **return is stringified and fed back to the model** as
  the tool result. A thrown error becomes an error message the model sees.
- Extensions load once at startup. A file that fails to import is reported in
  the banner as `name (failed: <message>)` and skipped — the rest still load.
  (`create_tool` above hot-loads instead, without a restart.)
- Omni does not sandbox extensions; scope your own paths. Copy the
  `resolve()` helper from `extensions/file-tools.js` to keep file access inside
  the workspace.
- Tool names are subject to permissions like any built-in:
  `/perm word_count ask`.
- Zero-dependency policy: prefer `node:` built-ins. There is no `node_modules`
  in the install root.

To activate, add the file path to `omni.config.json` and restart:

```json
{ "extensions": ["extensions/file-tools.js", "extensions/word-count.js"] }
```

## Skills (slash commands)

A skill is a folder under `skills/` containing a `SKILL.md` with YAML-ish
frontmatter followed by instructions:

```markdown
---
name: release-notes
command: /release-notes
description: Draft release notes from recent git history.
---

# Release Notes

When invoked, run `git log` since the last tag via run_shell, group commits
by type, and draft markdown release notes...
```

- Frontmatter is YAML-ish `key: value` lines, with one block-scalar
  concession: a `description:` field may use `|`, `|-`, `>`, or `>-` to
  span multiple lines (the indented continuation is folded into a single
  value). Other keys stay single-line.
  `name` defaults to the folder name, `command` defaults to `/<name>`.
- The `description` is listed in the system prompt and in `/help`; the **body
  is injected as a system message only when the user runs the command** — so
  put trigger hints in the description and the full playbook in the body.
- Extra files in the skill folder (templates, examples) are copied along by
  the installer; reference them by path in the body.
- Skills are discovered at startup in two scopes:
  1. **Built-in**: every `skills/*/SKILL.md` under the install root, when
     `autoDiscoverSkills` is `true` (the default config).
  2. **User**: every `<skill>/SKILL.md` under `~/.kimi-code/skills/` and
     `~/.agents/skills/` (added by the omni-harness so per-user skill
     libraries are picked up automatically — no per-skill wiring needed). Set
     `"autoDiscoverSkills": false` to disable *both* scopes, or list folders
     explicitly under `skills` in `omni.config.json` to whitelist.
  When two skills share a command, the user-installed one shadows the
  built-in.
- To normalize a batch of user-installed skills (collapse multi-line
  descriptions, tag each file with an `omni-harness` banner), run
  `node scripts/normalize-user-skills.mjs`. It is idempotent.

## MCP servers

Add a standard MCP server definition either to `omni.config.json`:

```json
{ "mcpServers": { "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] } } }
```

…or to a project-local `.mcp.json` in the workspace (the vendor-neutral
standard; it wins on name collisions). The agent reaches every server through
the single lazy `mcp` proxy tool, so added servers cost almost no context.

## Themes (color palette)

A theme is a JSON file in `themes/` describing the terminal UI palette:

```json
{
  "name": "forge-yellow",
  "description": "Molten-forge palette: yellow at the top cooling into dark orange and purple.",
  "accent": [255, 176, 0],
  "prompt": "cyan",
  "logoGradient": [[255, 214, 0], [255, 176, 0], [206, 64, 120], [150, 32, 210]],
  "ui": { "user": "cyan", "assistant": "magenta", "tool": "green", "error": "red", "warn": "yellow", "dim": "gray" }
}
```

- `accent` is `[r, g, b]`. `logoGradient` is a list of `[r, g, b]` stops applied
  top-to-bottom across the startup banner. `ui.*` and `prompt` accept either
  ANSI color names (`cyan`, `magenta`, …) or hex/rgb.
- Purely cosmetic — no tool/capability implications. Activate with
  `"theme": "themes/<name>.json"` in `omni.config.json`; restart to apply.

## Providers / models (connect a new LLM backend)

Not a file-based plugin — a runtime-registered config entry. Any
OpenAI-compatible chat-completions endpoint works:

```text
/addprovider           # opens an arrow-key preset picker (last row = custom)
/addprovider myhost https://api.example.com/v1 sk-xxxx   # typed form
/addmodel mykey myhost some-model-id 32768
/model mykey
```

**Interactive picker.** `/addprovider` with no args opens a full-screen menu
of every preset shipped with Omni (`kimi`, `minimax`, `agnes`, `nvidia`,
`claude`, `openai`, `openrouter`, `cursor`, `mistral`, `deepseek`, `xai`,
`grok`, plus `groq`/`google`/`together`/`fireworks`/`ollama`/`local`),
followed by a `Custom Provider…` row at the bottom. Use ↑/↓ (or mouse
click) to move, Enter to select, Esc/`q` to cancel. Selecting a preset
installs it and then asks for an API key (Enter to skip). Selecting
`Custom Provider…` prompts for **name → endpoint URL → API key**, each
confirmed with Enter; an empty line at any step cancels without changes.

`/addprovider <name> <baseUrl> [apiKey]` (the legacy form) still works for
piped input and scripts, where the interactive picker is unavailable.

`/addmodel <key> <provider> <model-id> [maxTokens]` points a model key at
a provider (the provider must already exist). Both persist to
`settings.json` immediately — no restart needed, switch with
`/model <key>` right away. `/apikey <provider> <key>` updates credentials
later.

**Probing real context windows.** `/probe-contexts` (alias `/probe-ctx`)
hits every configured model's `/v1/models` endpoint in parallel and stores
the `context_length` (or `max_model_len` / `meta.n_ctx_train` /
`top_provider.context_length`) it finds as `contextWindowDetected` in
`settings.json`. Restrict to one provider with `/probe-contexts minimax.io`;
get a machine-readable summary with `/probe-contexts --json`. The probe
never overwrites an explicit `/context <size>` user override — the
resolution ladder keeps user-set values above detected ones.

## Local models: hardware profile + backend selection

Omni scans your CPU / RAM / GPU once on first boot and caches the result
to `agent/hardware-profile.json`. `/llama-start` reads it to pick the
right backend and thread count without spawning subprocesses on every
launch. A **cheap fingerprint** (arch + core count + rounded totalmem)
is checked every boot in <5 ms; the full scan (PowerShell +
`nvidia-smi` → `dxdiag` → `Win32_VideoController` fallback chain for
VRAM) only re-runs when the fingerprint drifts. Force a re-scan with
`/hardware rescan` after a GPU swap.

### Profile schema

```jsonc
{
  "scannedAt": "2026-08-26T15:32:11.204Z",
  "platform": "win32", "arch": "x64",
  "cpuCores": 8,       // physical
  "cpuThreads": 16,    // logical
  "totalRamGB": 32.0,
  "gpuName": "AMD Radeon(TM) Graphics",
  "gpuVramGB": 3.0,
  "gpuVramSource": "dxdiag",   // "nvidia-smi" | "dxdiag" | "Win32_VideoController.AdapterRAM"
  "fingerprint": "…",
  "recommendedBackend": "cpu", // "cpu" or "vulkan"
  "recommendedThreads": 8,
  "notes": ["gpuVramGB=3<6 → recommendedBackend forced to cpu"]
}
```

### Backend selection knobs (in `settings.json`)

```jsonc
{
  "llama": {
    "modelsDir": "D:\\my-ggufs",  // else OMNI_MODELS_DIR env, else C:\models
    "gpuMinVramGB": 6,            // recommendedBackend floor — default 6
    "allowLowVram": false,        // set true to always allow Vulkan below the floor
    "threads": 12,                // else profile.recommendedThreads → os.cpus().length
    "extraArgs": ["--flash-attn"] // appended verbatim to llama-server
  }
}
```

Order of precedence at `/llama-start` time:
1. Explicit arg (`/llama-start <model> vulkan`) with `--force`
2. Explicit arg without `--force` — subject to the VRAM floor
3. `profile.recommendedBackend`
4. Fallback to `cpu`

### Adding a new backend binary

`/llama-start` looks for `server/llama-server-<backend>.exe`. To add
(say) a CUDA build, drop a `llama-server-cuda.exe` into `server/` and
extend the `SUPPORTED_BACKENDS` array in `src/local/llama.mjs`. The
legacy monolithic `llama-server.exe` is still accepted and treated as
CPU-only.

### Ollama and other loopback servers

Omni treats a model as "local" (and appends the strict small-model
prompt rails via `src/core/local-prompt.mjs`) when the provider is
named `local` or `ollama`, **or** its `baseUrl` matches
`http://(localhost|127.0.0.1|0.0.0.0|[::1])[:/]…`. Point at a different
`ollama` port or a loopback vLLM server and the same rails apply — no
config change needed.

## Packaging for the registry (`omni-pkg`)

To distribute via `node bin\omni.mjs install <name>` (or `/install`), zip
your payload with a `omni-pkg.json` manifest at the zip root (or one level down):

```json
{
  "name": "word-count",
  "type": "extension",            // "skill" | "extension" | "mcp"
  "version": "1.0.0",
  "description": "Word/line counting tool.",
  "entry": "word-count.js"        // extension only: file copied to extensions/<name>.js
}
```

- `type: "skill"` — the zip must contain `SKILL.md`; the whole payload is
  copied to `skills/<name>/`. No config edit needed.
- `type: "extension"` — `entry` is copied to `extensions/<name>.js` and added
  to the config's `extensions` array automatically.
- `type: "mcp"` — the manifest's `"mcp": { ... }` block is written to
  `mcpServers.<name>` in the config.

The hosting side is a static `registry.json`:

```json
{ "packages": [ { "name": "word-count", "type": "extension", "version": "1.0.0",
    "description": "…", "url": "word-count.zip", "sha256": "<hex>" } ] }
```

`url` may be absolute or relative to the registry base. If `sha256` is present
it is verified after download. Registry resolution order:
`--registry` arg → `OMNI_REGISTRY` env → `registry` in config → the default.
Installs are tracked in `agent/packages.json` so `uninstall` undoes exactly
what was added.
