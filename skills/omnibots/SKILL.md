---
name: omnibots
command: /omnibots
description: Start the OmniBots desktop app (Omi and the bot team, in the system tray), or bring it to the front; "/omnibots status" or "/omnibots stop" check or close it. Use when the user says start omnibots, open omi's bots, launch the bot team.
---

The user wants the OmniBots desktop app (Omi's bot team, a tray app).

- No argument, or "start" / "open": call `omnibots_start`. It finds the Python environment by itself (or makes one the first time, which can take a few minutes: say so if it does).
- "status": call `omnibots_status`.
- "stop" / "close" / "quit": call `omnibots_stop`.

Then tell the user in one or two lines what happened (started, already running and brought to the front, or the error). When it started, remind them: click the tray icon → "Open OmniBots (Omi's window)" and type a goal in the prompt box.

Don't run any other command to start it, and don't install anything yourself: the tool does it.
