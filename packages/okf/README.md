# OKF — Open Knowledge Format

A tiny, open, portable format for accumulating coding knowledge, plus an MCP
server that lets any agent (Omni, Claude Code, or any other MCP client)
read and write it.

v2 organizes the cards into a **hierarchical, indexed knowledge base**: cards
serve over MCP (okf_browse/okf_search/okf_add/…), so the agent navigates and
grows coding knowledge across sessions.

## Using with Omni

The okf server is installed as a package and auto-discovered by the config. Cards
live in a folder taxonomy, every folder carries a generated `index.okf` table of
contents, and agents navigate the tree top-down (like browsing docs) instead of
relying on search alone.

## Using with other MCP clients

Any MCP client can connect to the okf server — Claude Code, Claude API with MCP
support, or any other tool. This makes it easy to share knowledge across different
agents and workflows.

## Format details

v2 organizes the cards into a **hierarchical, indexed knowledge base**: cards
live in a folder taxonomy, every folder carries a generated `index.okf` table
of contents, and agents navigate the tree top-down (like browsing docs) instead
of relying on search alone.

## The format

One card per file, plain markdown with a frontmatter block — readable in any
editor, greppable, diffable, syncable:

```markdown
---
okf: 1
id: prefer-early-return-3f9a
title: Prefer early returns over nested conditionals
type: pattern
tags: style, readability
language: javascript
source: https://example.com/article
created: 2026-07-14T00:00:00.000Z
updated: 2026-07-14T00:00:00.000Z
links: guard-clauses-ab12
---

Return early on the failure path so the happy path stays at the left margin.

​```js
if (!user) return null;
// happy path continues un-nested
​```
```

Card `type` is one of: `pattern`, `snippet`, `gotcha`, `decision`, `howto`,
`reference`. A card's folder is its location on disk — the single source of
truth; it is never duplicated into frontmatter, so the two can't drift.

## The taxonomy

```text
knowledge/
├── index.okf                ← generated root index
├── languages/    go, python, javascript, typescript, c, cpp, csharp, rust,
│                 java, php, ruby, swift, kotlin, dart, lua, powershell,
│                 bash, sql, html, css
├── frameworks/   react, vue, svelte, htmx, express, fastapi, django, flask,
│                 laravel, aspnet, spring, electron
├── databases/    sqlite, postgresql, mysql, redis, mongodb, supabase
├── tools/        git, docker, cmake, npm, pnpm, cargo, go-cli, dotnet-cli,
│                 powershell
└── patterns/     architecture, testing, security, concurrency, networking,
                  error-handling
```

Top-level categories are closed (extending them needs `force:true` — a
guardrail so small models can't sprawl the taxonomy); second-level topics are
open slugs; maximum depth is 3 (`languages/go/examples`).

## Generated indexes — the anti-hallucination design

Every folder gets an `index.okf`: one line per subfolder (recursive card count
+ top tags) and one line per card (id, type, tags, title, first sentence).
Indexes are rebuilt **deterministically from card frontmatter** on every
add/update/move/delete — no model ever writes an index, so an index can never
be hallucinated or stale. `okf_browse` goes one step further and computes its
listing live from disk on every call; the on-disk `index.okf` files exist for
humans, editors, and git diffs.

Further guardrails, aimed at small local models:

- unknown card ids fail with "did you mean" suggestions instead of dead ends
- `links` must reference existing cards — fabricated graph edges are rejected
- near-duplicate titles are rejected with the existing card's id (use
  `okf_update {append}`, or `force:true` when genuinely different)
- browse errors list the valid folders under the deepest existing ancestor,
  so a wrong path self-corrects on the next call

## Storage

Cards live in `<OMNI_HOME>/knowledge/` (default `C:\Users\ThePa\.omni\agent\knowledge\`).
Override with the `OKF_DIR` environment variable.

## The MCP server

`server.mjs` is a zero-dependency stdio MCP server exposing:

| Tool | Purpose |
| --- | --- |
| `okf_browse` | Walk the folder index top-down (live from disk, never stale) |
| `okf_search` | Ranked keyword fallback (title > tags > folder > body) with snippets |
| `okf_add` | Save a new card into a taxonomy folder |
| `okf_get` | Fetch a full card by id |
| `okf_list` | List cards, newest first; filter by tag/type/folder subtree |
| `okf_update` | Edit a card or append to its body |
| `okf_move` | Re-file a card into another folder |
| `okf_delete` | Remove a card (reports dangling backlinks) |
| `okf_reindex` | Rebuild all `index.okf` files after manual edits / git pull |

It is registered in `omni.config.json` under `mcpServers.okf` with
`directTools: true`, so the tools appear as first-class `mcp__okf__*` tools.

## Local vs frontier models

Omni injects strict index-first navigation rules into the system prompt
**only when the active model is local** (the bundled llama.cpp `local`
provider, Ollama, or any loopback baseUrl) — see `src/core/okfnav.mjs`.
Frontier hosted models (NVIDIA, OpenAI, Anthropic, …) get the tools without
the forced method and may search directly.

To use the same knowledge base from Claude Code, add to `.mcp.json`:

```json
{
  "mcpServers": {
    "okf": { "command": "node", "args": ["C:\\Users\\ThePa\\.omni\\packages\\okf\\server.mjs"] }
  }
}
```
