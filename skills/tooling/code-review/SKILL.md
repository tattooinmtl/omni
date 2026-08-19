---
name: code-review
command: /code-review
description: Review changed or specified code for correctness bugs and quality issues.
---

# Code Review

## Purpose
Review code for correctness bugs, security issues, and quality/simplification opportunities.

## When to use
Use this skill when the user runs:

/code-review [path-or-glob]

If no path is given, review the most recently changed files in the project
(use `git status`/`git diff` via run_shell when the project is a git repo).

## Rules
- Read the actual code before commenting — never review from the filename alone.
- Separate findings into: Bugs (correctness), Security, and Cleanups (quality).
- For each finding give: file:line, what's wrong, why it matters, and a concrete fix.
- Prefer high-confidence findings. Mark anything uncertain as "possible".
- Do not rewrite the whole file; suggest minimal targeted edits.

## Output
1. Summary (one line: overall health)
2. Bugs — ordered by severity
3. Security concerns
4. Cleanups / simplifications
5. Suggested next steps
