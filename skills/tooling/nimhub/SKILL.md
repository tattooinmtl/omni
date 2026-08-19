---
name: nimhub
command: /nimhub
description: Launch the NimHub dashboard — opens a browser page that lists, launches, and provides a global AI for editing every NimAgent editor and engine.
---

# /nimhub

Immediately call `launch_nimhub`. Do not create a replacement page, do not ask for a project name, and do not describe the dashboard in detail first — just open it.

The dashboard at `http://127.0.0.1:41731/nimhub` (served by `editor/server.mjs`, the same server that hosts the Nim TD Engine) lists every editor and engine NimAgent has on disk with three buttons each:

- **Launch** — spawns the editor (Electron, browser open, or skill command).
- **AI Edit** — targets the Global AI at that card.
- **Folder** — reveals the project folder in Explorer.

The Global AI can target any one card and edit the underlying source on disk (e.g. `/api/ai?domain=nimhub`). Every edit is preceded by an automatic snapshot of the **original** file under `NimProjects/_nimhub_backups/<timestamp>_<label>/`. From the dashboard's **Snapshots** button (top right) the user can list every snapshot and restore any one to its original state — so they can ask the AI to make invasive changes (new textures, new core functions, new editor tools) without fear of permanently breaking the editor or engine.

Tell the user:

> NimHub is open. The Global AI on the right can edit any editor/engine you pick — its **originals are snapshotted first** (top right → Snapshots), so if the AI goes too far, restoring is one click.
