---
name: using-addon-skills
description: Use when a task mentions a language, framework, design system, game engine, agent harness, or research target — the auto-trigger rules for the dariusai-harness addon library (78 skills across 11 groups, on top of the 14 superpowers process skills). Pairs with superpowers:using-superpowers, which is the methodology layer; this skill is the domain layer.
---

<SUBAGENT-STOP>
If you were dispatched as a subagent to execute a specific task, ignore this skill.
</SUBAGENT-STOP>

<EXTREMELY-IMPORTANT>
If you think there is even a 1% chance an addon skill might apply to what you are doing, you ABSOLUTELY MUST invoke it before any response or action.

The superpowers bootstrap is the **process layer** — how to plan, debug, TDD, review. This skill is the **domain layer** — what languages, frameworks, designs, agents, and tools exist and how to use them. Skipping it is the same failure as skipping superpowers:brainstorming.
</EXTREMELY-IMPORTANT>

## The Rule

**Invoke the matching addon skill BEFORE any response or action** when the task names a language, framework, design system, game engine, agent harness, CLI tool, or research target. If the task doesn't name a domain, this skill doesn't apply — the superpowers bootstrap handles it.

Then announce "Using [skill] to [purpose]" and follow the skill exactly. If it has a checklist, create a todo per item via the `set_todos` tool.

## Library Map

The library lives at `addon/skills/<group>/<name>/SKILL.md`. The `invoke_skill(name)` tool reads the body and returns it for you to follow. **Total: 92 skills**, 14 in `superpowers/` (process layer, auto-triggered by the doctrine) and 78 in the other 11 groups (domain layer, this skill covers them).

### superpowers (14) — process layer (auto-triggered by the doctrine)

`brainstorming`, `systematic-debugging`, `test-driven-development`, `verification-before-completion`, `writing-plans`, `writing-skills`, `using-superpowers`, `using-git-worktrees`, `dispatching-parallel-agents`, `executing-plans`, `subagent-driven-development`, `finishing-a-development-branch`, `requesting-code-review`, `receiving-code-review`.

### languages (21) — invoke when the task names a language

Trigger patterns: "write me a Python script", "fix this Rust crate", "build a Java service", "query the database", "I need a bash one-liner".

| skill | trigger |
|---|---|
| `python-coding` | Python source, pip, pytest, venv, Django, Flask, FastAPI, pandas, NumPy |
| `typescript-coding` | TypeScript (vs. plain JS), tsconfig, `.ts`/`.tsx` files |
| `nodejs-coding` | Node.js, npm, `package.json`, server-side JS without a frontend framework |
| `web-coding` | plain HTML/CSS/JS (no TypeScript, no framework) |
| `html-js-css` | HTML/CSS/JS specifically, including DOM and CSS layouts |
| `jsx-react` | React, JSX, hooks, `useState`, `useEffect` |
| `htmx` | htmx, `hx-get`, `hx-post`, server-rendered HTML with htmx |
| `rust-coding` | Rust, Cargo, `cargo build`, `cargo test`, ownership/borrowing |
| `go-coding` | Go, `go.mod`, goroutines, channels |
| `cpp-coding` | C / C++, CMake, g++ / clang, build systems |
| `csharp-coding` | C# / .NET, dotnet CLI, ASP.NET |
| `java-coding` | Java, Maven, Gradle, Spring |
| `kotlin` | Kotlin, Android, Ktor |
| `ruby-coding` | Ruby, Rails, Bundler, gem |
| `php-coding` | PHP, Composer, Laravel, WordPress |
| `perl-coding` | Perl, CPAN |
| `bash-coding` | Bash / shell scripting, set -e, traps, env vars |
| `cobol-coding` | COBOL, GnuCOBOL, fixed/free format |
| `sql-coding` | SQL, queries, indexes, query plans, optimization |
| `truescript` | the project's own "TrueScript" language (if mentioned) |
| `video-coding` | video/audio processing code (FFmpeg, codecs, etc.) |

**Rule of thumb**: if the task names a language, invoke `<lang>-coding` first. If the task is generic "build a web app", start with `web-coding` or `html-js-css`.

### codebase-starters (10) — invoke when scaffolding a new project

Trigger patterns: "start a new X project", "scaffold a X service", "create the boilerplate for X".

| skill | trigger |
|---|---|
| `python` | "scaffold a new Python project" |
| `typescript` | "scaffold a new TypeScript project" |
| `nodejs` | "scaffold a new Node.js project" |
| `rust` | "scaffold a new Rust crate" |
| `go` | "scaffold a new Go module" |
| `cpp` | "scaffold a new C++ project" |
| `csharp` | "scaffold a new .NET project" |
| `ruby` | "scaffold a new Ruby project" |
| `php` | "scaffold a new PHP project" |
| `cobol` | "scaffold a new COBOL project" |

`languages/X-coding` is for **writing X**; `codebase-starters/X` is for **creating a new X project**. If the task is "create a new TypeScript project", invoke `codebase-starters/typescript`. If the task is "add a feature to an existing TypeScript project", invoke `languages/typescript-coding`.

### design (4) — invoke when the task is a visual design surface

Trigger patterns: "design a landing page", "build a brand kit", "polish the UI", "redesign the homepage".

| skill | trigger |
|---|---|
| `design-taste-frontend` | any landing page, portfolio, or redesign (default — v2) |
| `high-end-visual-design` | explicit "make it look premium / high-end / agency-grade" |
| `redesign-existing-projects` | "redesign X" / "upgrade the existing UI" |
| `brandkit` | brand-guidelines boards, identity decks, logo systems |

### gamedev (6) — invoke when the task is a game

Trigger patterns: "build a game", "tower defense", "3D model", "voxel", "HTML5 canvas game".

| skill | trigger |
|---|---|
| `html-game-builder` | small self-contained HTML5 canvas game |
| `threejs-tower-defense` | Three.js tower-defense |
| `tower-defense-map-editor` | the tower-defense map editor UI |
| `threejs-3d-modeler` | generate procedural Three.js models |
| `threejs-3d-model-editor` | edit one existing Three.js model by name |
| `nim-voxel-siege` | NimVoxelEngine/NimVoxelEditor castle-siege voxel game |

### agent-orchestration (5) — invoke when the task mentions a subagent, worktree, or scheduling

Trigger patterns: "schedule this", "launch a subagent", "open a worktree", "do a handoff", "start a goal loop".

| skill | trigger |
|---|---|
| `launch-subagent` | any subagent / Task tool / parallel-agents mention |
| `git-worktree` | worktrees, parallel agents on one repo |
| `goal-loop` | `/goal`, Ralph loop, long-running autonomous run |
| `agent-self-scheduling` | cron, intervals, "run every N minutes", heartbeats |
| `handoff` | compact context for a fresh agent session |

(`dispatching-parallel-agents` and `subagent-driven-development` live in superpowers — the doctrine auto-triggers them when subagent work is mentioned.)

### research-and-web (2) — invoke when the task is research or browser automation

Trigger patterns: "research X", "browser automation", "fetch X from a URL".

| skill | trigger |
|---|---|
| `browser-harness` | browser automation / driving a real browser |
| `research-prompt` | draft a research prompt |

(DeepAPI, Pi-web-search, Fireflies, YouTube skills were removed — they depended on external services that aren't part of Dariu's harness.)

### tooling (7) — invoke when the task needs harness-level tooling

Trigger patterns: "review the code", "find a skill", "diagnose this project", "extend the agent".

| skill | trigger |
|---|---|
| `find-skills` | "find a skill for X" / discovery |
| `code-review` | a code-review pass before declaring done |
| `project-doctor` | full project audit / health check |
| `extend-omni` | extend the Omni brain / agent runtime |
| `extend-nimagent` | extend the Nim agent runtime |
| `nimhub` | NimHub / sharing / publish |
| `vs-project-starter` | Visual Studio project starter |

### thinking-and-docs (12) — invoke when the task is a soft decision or a doc

Trigger patterns: "before I build, ask me", "log this decision", "draft a doc", "teach me", "what should I do next".

| skill | trigger |
|---|---|
| `before-building` | "before I build X, ask me Y" / requirements gathering |
| `brain-to-docs` | turn a brain's worth of notes into a doc |
| `decisions` | log an ADR / "record this decision" |
| `read-all-adrs` | "show me all past decisions" |
| `next-decision` | "what's the next decision to make" |
| `level-up` | gauge the user's knowledge / skill-up |
| `teach` | teach the user something |
| `prompt-me` | "ask me clarifying questions first" |
| `short` | "be brief" / short-form output |
| `stop-overthinking` | "stop overthinking" / kill the analysis loop |
| `remind` | schedule a reminder / cron-style nudge |
| `save-idea` | "save this idea for later" |

### skill-authoring (4) — invoke when the task is about skills themselves

Trigger patterns: "write a new skill", "push this skill to GitHub", "make a hook".

| skill | trigger |
|---|---|
| `effective-agent-skills` | "write a new skill" / skill design rules |
| `using-addon-skills` | this skill — when the task mentions a domain |
| `push-skill-to-github` | "publish this skill" |
| `skill-hook-creator` | "make a hook for this skill" |

### ops-and-setup (6) — invoke when the task is about the host, auth, or DB

Trigger patterns: "safe prod DB access", "git auth failed", "blocked shell commands", "production push".

| skill | trigger |
|---|---|
| `create-readonly-db-role` | "read-only DB role for agents" (Postgres) |
| `read-prod-database` | read production DB safely |
| `global-agent-guardrails` | dangerous-command denylist across agents |
| `github-outside-sandbox` | gh / git auth failures inside a sandbox |
| `prod-push` | production deploy / push workflow |
| `setup-help` | "help me set this up" / bootstrap a new env |

(macOS-only tools — `anti-sleep`, `macbook-metrics-setup`, `nuke-cursor-app` — were removed; Dariu's host is Windows.)

### archive (1) — superseded; don't auto-trigger

`design-taste-frontend-v1` — superseded by `design/design-taste-frontend`. Load only when v1's specific behaviour is needed.

## Red Flags

These thoughts mean STOP — you're rationalizing:

| Thought | Reality |
|---|---|
| "The user didn't name a language" | The user said "fix this script" — figure out the language from the file. |
| "I know Python syntax" | Knowing the syntax ≠ using python-coding. The skill has the rubric. |
| "This is a small fix" | The skill has a checklist. Use it. |
| "I'll just write the code" | The skill tells you HOW to write it (best practices, scaffolding). |
| "The library is auto-imported" | No — skills are loaded by name. invoke_skill() is the loader. |
| "Adding more skills is overkill" | The cost of one extra call is small. The cost of a wrong framework choice is large. |
| "I'll skip the design skill" | "Make it look nice" without a skill = generic slop. Use design-taste-frontend. |
| "This is a one-off agent" | The methodology also matters for one-offs. The harder the domain, the more the skill helps. |

## How to Invoke

```text
invoke_skill("python-coding")    # for the languages/python-coding skill
invoke_skill("design-taste-frontend")  # for the design skill
invoke_skill("brainstorming")    # for superpowers (the doctrine also auto-triggered it)
invoke_skill("language:python-coding")  # explicit group path if ambiguous
```

The tool reads the SKILL.md from disk and returns the full body. The doctrine says skills are "code that shapes behaviour" — read the body, follow it exactly, don't paraphrase.

## Discovery

When you don't know what the library calls a thing:

- `browse_brain()` (no argument) — lists the top-level groups.
- `browse_brain("languages")` — lists the skills in the `languages` group.
- `search_brain("python")` — returns ids and labels for matches.

`invoke_skill(name)` on the one id that matches.

## What was pruned (not in the library)

These skills USED to live in `addon/skills/` and were removed because they reference tools or services that aren't part of Dariu's harness:

- **External harnesses**: `cmux`, `herdr`, `fable-review`, `fable-safe-prompt`, `gpt-review`, `codex-subagent`, `corral-launch-agents`, `run-deep-swe`
- **External APIs**: `deepapi`, `deep-research`, `online-shopping`, `fireflies-transcript`, `youtube-transcript`, `pi-web-search`, `pi-custom-model`
- **macOS-only**: `anti-sleep`, `macbook-metrics-setup`, `nuke-cursor-app` (Dariu runs on Windows)
- **Cross-harness distribution**: `distribute-skill-to-all-agents`, `folder-specific-claude-and-agents-md`
- **Off-purpose**: `google-safe-browsing` (debugging site flags, not Dariu's purpose)

The 33 flat duplicates at `addon/skills/<name>/SKILL.md` (no group folder) were also removed — `invoke_skill()` could not reach them (its glob requires `addon/skills/<group>/<name>/SKILL.md`).
