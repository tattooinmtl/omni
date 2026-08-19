---
name: skill-hook-creator
description: >-
  Scaffold, construct, validate, and register new skills and lifecycle hooks for AI agents and harnesses (.omni, DariusAI-Harness, Thoth, Antigravity, Claude, Codex, Cursor). Use when creating new skills, adding hooks, or validating skill repositories.
---

# Skill & Lifecycle Hook Creator Guide

This skill provides operational workflows and automated tools to create, validate, and deploy new skills and lifecycle hooks across multi-agent environments.

## 1. Automated CLI Tool Usage

The codebase includes an automated Python tool at `tools/create_skill_hook.py`.

### Create a New Skill
```bash
python tools/create_skill_hook.py create-skill \
  --name "rust" \
  --category "codebases" \
  --description "Production operational guidance, codebase architecture, and best practices for Rust applications."
```

### Create/Register a Lifecycle Hook
```bash
python tools/create_skill_hook.py create-hook \
  --name "security-guard" \
  --event "PreToolUse" \
  --matcher "run_command" \
  --command "python hooks/harness_guard.py" \
  --timeout 30
```

### Validate Repository Skills and Hooks
```bash
python tools/create_skill_hook.py validate
```

### List All Registered Skills and Hooks
```bash
python tools/create_skill_hook.py list
```

## 2. Skill Architecture Standards

Every skill folder must contain:
1. `SKILL.md`: Main instruction file with YAML frontmatter (`name`, `description`).
2. `examples/`: Production reference codebases, starter templates, and code snippets.
3. `references/`: Architectural deep dives, lint/compiler configurations, best practices, and edge case guides.
4. `scripts/`: Optional helper scripts for automated setup or execution.

## 3. Hook Specifications & Contract

Lifecycle hooks register in `hooks/hooks.json` under one of the 5 lifecycle events:
- **`PreToolUse`**: Blocks, gates, or modifies arguments before tool execution.
- **`PostToolUse`**: Post-execution analysis, formatting, or auto-cleanup.
- **`PreInvocation`**: Injects context/steps before LLM generation.
- **`PostInvocation`**: Evaluates response and decides to force continue or terminate.
- **`Stop`**: Evaluates loop completion; re-enters loop if goals remain unfulfilled.
