---
name: html-game-builder
command: /game
description: Build a small, self-contained HTML5 canvas game in a single file.
---

# HTML Game Builder

## Purpose
Build a complete, playable browser game as a single self-contained HTML file
(HTML + CSS + JS inline, no build step, no external dependencies).

## When to use
Use this skill when the user runs:

/game <description of the game>

## Rules
- Output ONE `.html` file that runs by double-clicking it — no servers, no CDNs.
- Use a `<canvas>` and `requestAnimationFrame` game loop.
- Implement: input handling, update/render loop, win/lose state, and a restart key.
- Keep it readable: clear sections for config, state, input, update, render.
- Use the write_file tool to create the file, then tell the user the path to open.
- Default to a small scope (one mechanic done well) unless asked otherwise.

## Output
1. The game file (written to disk via write_file)
2. Controls / how to play
3. The exact path to open in a browser
4. Ideas for extending it
