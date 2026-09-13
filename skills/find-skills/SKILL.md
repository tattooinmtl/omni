---
name: find-skills
command: /find-skills
description: Discover skills already on this machine — the bundled catalog plus anything the scan-now hook indexed — and scan a chosen folder to bring new ones in. Use when the user asks "how do I do X", "is there a skill for X", "find a skill that can…", or wants to add skills from a folder.
---

# Find Skills

Discover skills that already exist on this machine, and pull in new ones from
a folder the user points at. Everything here is local — no registry calls, no
network, no external account.

## Where skills come from

There are two sources, and they behave differently:

| Source | Location | How it loads |
| --- | --- | --- |
| **Bundled** | `<INSTALL_ROOT>/skills/**/SKILL.md` | Auto-discovered at startup, always available |
| **External** | Whatever `skillIndex` points at (default `C:/.skills/skills.json`) | Indexed by the scan-now hook, loaded on demand |

External skills show up in `find_skill` output tagged `[external]`. On a name
collision the bundled skill wins — it is version-controlled with the install
and can't drift.

## Step 1: Search before improvising

Whenever you're about to build a workflow from scratch, search first. Both
sources are covered by one call:

```
find_skill("tower defense game")
find_skill("full stack web app")
```

Use the task's vocabulary, not the skill's name — descriptions are what get
ranked. If nothing matches, broaden: "testing" before "playwright e2e".

## Step 2: Load the one that fits

```
invoke_skill("/threejs-tower-defense")
```

This loads the full body for the current turn only, then it's evicted. Works
the same for bundled and external skills. If the command is wrong you get a
clear "unknown skill" back — re-run `find_skill` rather than guessing again.

## Step 3: Scanning a folder the user chooses

When the user wants skills from a folder that isn't indexed yet, run the
scanner against it. This is opt-in per folder — it never walks the whole
machine.

Report what's there, without writing anything:

```bash
node C:/.skills/bin/scan-now.js --root D:/projects/my-skill-pack --json
```

If the user wants those skills permanently available, import them — this
junctions each top-level skill folder into the canonical skills directory and
refuses to overwrite an existing name:

```bash
node C:/.skills/bin/scan-now.js --root D:/projects/my-skill-pack --import
```

Then re-index so `find_skill` can see them:

```bash
node C:/.skills/bin/scan-now.js
```

Useful flags: `--dry-run` (report only), `--max-depth <n>` (default 6),
`--json` (machine-readable). The scanner refuses drive roots and anything
inside `node_modules`, `.git`, `%TEMP%`, `%APPDATA%`, or the recycle bin.

**Importing copies someone else's instructions into a place the agent will
load from.** Confirm with the user before `--import`, and say which folder.

## Step 4: If nothing exists

Say so plainly, then offer the two real options:

1. Do the task directly — no skill needed for most work.
2. Write one, if it's something they repeat. A skill is a folder with a
   `SKILL.md`: frontmatter (`name`, `command`, `description`) plus an
   instruction body. `/extend` walks through scaffolding and verifying it.

## Notes

- Skill bodies are never ambient. `find_skill` returns one line each; only
  `invoke_skill` pays for a body.
- A stale index is the usual cause of "I know that skill exists but
  `find_skill` can't see it" — re-run the scanner.
- `skillIndex: ""` in `omni.config.json` turns external skills off entirely.
