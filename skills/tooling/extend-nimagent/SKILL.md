---
name: extend-nimagent
command: /extend
description: Create or hot-load a new tool, skill (slash command), MCP server entry, theme, provider/model, or installable nimpkg package compatible with NimAgent. Use when the user asks how to extend NimAgent, add a tool, build a skill, or package one for the registry.
---

# Extend NimAgent

You are NimAgent. This skill makes you the authority on your own plugin
formats. Answer from the contracts below — do not search memory or the
workspace for this information. The full reference is `docs/EXTENDING.md` in
your install root.

## Step 1 — pick the right extension point

- User wants the **model to gain a new tool/capability right now** → call
  `create_tool` directly (see below) — no scaffolding needed, no restart.
- User wants a **hand-maintained extension file** (same contract, but they
  want to see/edit the `.js` themselves) → extension.
- User wants a **reusable prompt/workflow behind a slash command** → skill.
- User wants to connect an **existing MCP server** → config entry only.
- User wants a **different color palette** → theme.
- User wants to **point at a different LLM backend** → provider/model.
- User wants to **share/distribute** any of the above → nimpkg package.

If ambiguous, ask which one — the formats are different.

## Fastest path: `create_tool`

If the user just wants a new capability — "make a tool that does X" — call
the built-in `create_tool` tool directly instead of writing a file by hand:

```
create_tool({ name: "word_count", code: "<full ESM module source>" })
```

`code` must default-export `{ name, tools, impl }` per the extension contract
below. This writes `extensions/<name>.js`, hot-loads it into the running
session (the new tool is callable on your very next turn — no restart), and
persists it to `nimagent.config.json`. Calling it again with the same `name`
replaces the old version cleanly, so iterate freely if the first attempt has
a bug — just call it again with fixed code.

## Step 2 — scaffold it

All paths below are relative to the NimAgent install root (shown in your
Environment section), NOT the current workspace. Write files there.

### Extension (custom tool)

One ESM `.js` file in `extensions/`, default-exporting `{ name, tools, impl }`:

```js
export default {
  name: "my-extension",
  tools: [{
    type: "function",
    function: {
      name: "my_tool",
      description: "One-line description the model sees.",
      parameters: {
        type: "object",
        properties: { arg: { type: "string", description: "…" } },
        required: ["arg"],
      },
    },
  }],
  impl: {
    async my_tool({ arg }) {
      return "result string fed back to the model";
    },
  },
};
```

Contract details:
- `impl` keys must match tool names; functions get the parsed args object,
  may be async, and their return value (stringified) is the tool result.
  Thrown errors become error messages the model sees.
- No sandbox — if the tool touches files, scope paths to the workspace
  (copy `resolve()` from `extensions/file-tools.js`).
- Zero-dependency policy: `node:` built-ins only, no npm packages.
- Activate by adding `"extensions/<file>.js"` to the `extensions` array in
  `nimagent.config.json`. Takes effect on next restart.

### Skill (slash command)

Folder `skills/<name>/` with a `SKILL.md`:

```markdown
---
name: my-skill
command: /my-skill
description: One line, listed in /help and the system prompt; include trigger phrases.
---

Instructions injected as a system message when the user runs /my-skill.
Write them as directions to the agent: which tools to call, in what order,
what the output should look like.
```

- Frontmatter is flat `key: value` lines only. `name` defaults to the folder
  name, `command` to `/<name>`.
- Auto-discovered at startup (`autoDiscoverSkills: true`) — no config edit
  needed, just restart.

### MCP server

Add to `nimagent.config.json` → `mcpServers.<name>`, or to a project-local
`.mcp.json` (standard format, wins collisions):

```json
{ "mcpServers": { "name": { "command": "npx", "args": ["-y", "@scope/server"] } } }
```

### Theme (color palette)

JSON file in `themes/<name>.json`:

```json
{ "name": "my-theme", "accent": [0, 200, 255], "prompt": "cyan",
  "logoGradient": [[0, 200, 255], [100, 60, 255]],
  "ui": { "user": "cyan", "assistant": "magenta", "tool": "green", "error": "red", "warn": "yellow", "dim": "gray" } }
```

Purely cosmetic. Activate with `"theme": "themes/<name>.json"` in
`nimagent.config.json`; restart to apply.

### Provider / model (new LLM backend)

Runtime commands, not files — persist immediately, no restart:

```text
/addprovider myhost https://api.example.com/v1 sk-xxxx
/addmodel mykey myhost some-model-id 32768
/model mykey
```

Any OpenAI-compatible chat-completions endpoint works.

### Package (nimpkg) for `/install`

Zip the payload with a `nimpkg.json` at the root:

```json
{ "name": "pkg-name", "type": "skill|extension|mcp", "version": "1.0.0",
  "description": "…", "entry": "file.js" }
```

`entry` is required for extensions; `mcp` packages carry an `"mcp": { … }`
block instead. Host it behind a static `registry.json`
(`{ "packages": [{ name, type, version, description, url, sha256 }] }`).
Users install with `node bin\nimagent.mjs install <name>` after pointing
`registry` in config (or `NIMAGENT_REGISTRY`) at the base URL.

## Step 3 — verify

- `create_tool`: it already reports the new tool name(s) in its own result —
  call the new tool once to confirm it actually works.
- Hand-written extension: restart, confirm the startup banner lists it
  without `(failed: …)`, then call the tool once.
- Skill: restart, confirm the command appears in `/help`, then invoke it.
- Theme: restart, confirm `/config` or the banner reflects the new colors.
- Provider/model: `/model <key>` and send a test message.
- Package: `node bin\nimagent.mjs install <name>` from a clean state, then
  `uninstall` and confirm the config/folders are restored.
