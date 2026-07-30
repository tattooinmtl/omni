---
name: okf-knowledge
command: /okf
description: Navigate and grow the Open Knowledge Format (OKF) knowledge base — a hierarchical, indexed library of coding lessons, patterns, and gotchas.
---

# OKF Knowledge

## Purpose
Make the agent a better coder over time by consulting and growing a persistent
knowledge base of coding lessons (Open Knowledge Format cards), served by the
`okf` MCP server. Cards live in a folder taxonomy (languages/, frameworks/,
databases/, tools/, patterns/) and every folder has a generated `index.okf` —
navigate it like a table of contents instead of searching blindly.

## When to use
- Before starting a non-trivial task: navigate to the topic with `okf_browse`
  (root → category → topic) or `okf_search` for a keyword, and apply what's
  found.
- After solving something non-obvious — a tricky bug, a Windows quirk, an API
  gotcha, a design decision — capture it with `okf_add` in the right folder so
  the next session benefits.
- When the user runs `/okf <query>`: search and summarize matching cards; with
  no query, `okf_browse` the root index and summarize what knowledge exists.

## Retrieval strategy
- Index-first: `okf_browse` (no args) shows the root index; descend with
  `okf_browse({path:"languages/go"})`. Folder paths and card ids in browse
  output are ground truth — never invent either.
- Fallback: if two browse steps don't reach the topic, switch to
  `okf_search({query})` (weighted keyword match over title, tags, folder,
  body; optional `folder` filter to scope a subtree).
- Capable frontier models may go straight to `okf_search` when they already
  know the exact keyword; small local models should always browse first (the
  agent injects strict navigation rules for them automatically).

## Rules
- Search or browse first, add second: check for an existing card before
  `okf_add`; extend an existing card with `okf_update` (`append`) when the
  knowledge overlaps. The server rejects near-duplicate titles.
- File cards in the taxonomy: top-level is one of languages, frameworks,
  databases, tools, patterns (max 3 levels, e.g. `languages/go/examples`).
  New top-level categories require `force:true` — prefer the existing five.
- Keep cards atomic: one lesson per card, a clear title, correct `type`
  (pattern | snippet | gotcha | decision | howto | reference), and 2-5 tags.
- Include a minimal code example in the body when the lesson is about code.
- Record the `source` (URL or file path) when the knowledge came from
  somewhere specific.
- Link related cards via `links` so knowledge forms a graph, not a pile —
  links must point at existing card ids (the server validates them).
- Never edit `index.okf` files by hand — they are generated; `okf_reindex`
  rebuilds them after manual card edits or a git pull.
- Never store secrets (API keys, tokens, passwords) in cards.
