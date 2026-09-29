# OmniBots from Omni: what `/omnibots` needs to work

`/omnibots` starts **OmniBots**, the desktop app where Omi and its bot team work (it lives in the system tray). You
can also check it and close it from Omni. This page lists everything that has to be in place, how to check each
piece, and what to do when something is off.

## What you type

| In Omni | What happens |
|---|---|
| `/omnibots` or `/omnibots start` (also `open`) | Starts OmniBots, or brings its window to the front if it's already running |
| `/omnibots status` | Asks the running app for a short status: version, bots, how many are working, jobs |
| `/omnibots stop` (also `close`, `quit`) | Closes it cleanly. Unfinished goals pick up again on the next start |
| "start omnibots" (plain words) | The `omnibots` skill makes the agent call the same launcher |

Type the word without a dash: `/omnibots -stop` prints the usage line. From a terminal, `omni /omnibots status` works
too, even with no model key: the command runs the launcher directly and doesn't spend a model turn.

## Checklist: what must be in place

### 1. OmniBots is installed in your user folder, next to `.omni`

The one-line installer puts it in `%USERPROFILE%\.omnibots` (for this PC: `C:\Users\ThePa\.omnibots`):

```powershell
irm https://raw.githubusercontent.com/tattooinmtl/Omnibots/master/install.ps1 | iex
```

That folder then holds:

- the OmniBots code: a git clone of `tattooinmtl/Omnibots`, with `PLAN.md` and the rest
- its own Python environment: `.omnibots\.venv`, with PySide6, keyring, httpx, pydantic and Playwright
- the bots' data, next to the code: `bots\`, `db\`, `logs\`, `settings.toml` and the rest. Git ignores all of it,
  and an install or update never touches it.

It needs **Python 3.12 or newer** and **Git** on the PC. The installer offers to install both with winget if they're
missing. Run the same line again to update OmniBots.

**Check:** `C:\Users\ThePa\.omnibots\omnibots\__main__.py` and `C:\Users\ThePa\.omnibots\.venv\Scripts\python.exe` exist.

### 2. The launcher and the command are in Omni (Omni 3.5.10 or later)

| File in `~/.omni` | What it is |
|---|---|
| `extensions/omnibots-launcher.js` | Finds OmniBots and its Python, and starts, checks and stops the app (tools `omnibots_start`, `omnibots_status`, `omnibots_stop`) |
| `omni.config.json` → `"extensions"` | Must contain `"extensions/omnibots-launcher.js"`, or the extension isn't loaded |
| `src/cli/omnibots-cmd.mjs` | The `/omnibots` command. It runs the launcher's tools directly |
| `skills/omnibots/SKILL.md` | For plain-language requests ("start omnibots") |
| `tests/omnibots-launcher.test.mjs` | The tests: `node tests/omnibots-launcher.test.mjs` |
| `extensions/omnibots-launcher.json` | Created by the launcher: which Python works for each OmniBots folder, on this PC. Git-ignored, never committed |

**Check:** `/help` lists `/omnibots`, and `/omnibots status` answers (running or "not running"), not
"omnibots launcher is not loaded".

### 3. Omni can find the OmniBots folder

The launcher looks in this order and uses the first folder that has the OmniBots code:

1. the `OMNIBOTS_DIR` environment variable, if it's set. When it's set, only that folder is used.
2. `%USERPROFILE%\.omnibots` (the installer's default)
3. `C:\omnibots` (an old developer copy)
4. `%LOCALAPPDATA%\OmniBots` (the old install location)

On this PC, `OMNIBOTS_DIR` is set to `C:\Users\ThePa\.omnibots` (a user environment variable). Omni only sees a
changed variable after it's **closed and opened again**.

**Check (PowerShell):** `[Environment]::GetEnvironmentVariable("OMNIBOTS_DIR", "User")`

### 4. The right Python is found by itself

For that folder, the launcher tries these in order, and uses the first one that can load OmniBots' libraries
(PySide6, keyring, httpx, pydantic, Python 3.11+):

1. the one it remembered last time (`omnibots-launcher.json`)
2. `<OmniBots folder>\.venv\Scripts\python.exe` (the installer's environment)
3. `%LOCALAPPDATA%\OmniBots\.venv`
4. every `python` on PATH

If none works, it makes `<OmniBots folder>\.venv` and installs OmniBots into it. That happens once and takes a
minute or two. The app is then started windowless (`pythonw -m omnibots`). Only one copy of OmniBots runs at a
time: starting it again just brings the open window to the front.

## Quick test

1. Close Omni fully and open it again.
2. Run `/omnibots status`. Before the first start it should say **OmniBots is not running**.
3. Run `/omnibots`. It should say **OmniBots started … version 0.3.0** (or newer) and name
   `C:\Users\ThePa\.omnibots\.venv\Scripts\python.exe`. The OmniBots icon appears in the tray.
4. Run `/omnibots status` for the short status, then `/omnibots stop`, which should say **OmniBots closed**.

## When something goes wrong

| Omni says | What it means | What to do |
|---|---|---|
| `omnibots launcher is not loaded` | `omni.config.json` doesn't list the extension | Add `"extensions/omnibots-launcher.js"` to `"extensions"`, then restart Omni |
| `no OmniBots checkout at <folder> (set OMNIBOTS_DIR …)` | `OMNIBOTS_DIR` points at a folder without OmniBots | Fix the variable, or run the installer, then restart Omni |
| `no OmniBots checkout in … (install it …)` | No OmniBots folder found at all | Run the one-line installer |
| `has no working Python environment yet` | Nothing found can run OmniBots yet | Run `/omnibots`: it makes the environment |
| `no Python 3.11+ found on PATH` | No Python to build the environment with | Install Python 3.12+, then run `/omnibots` again |
| `open but still finishing its start` | First run: OmniBots is asking where to put the bots' projects | Look for its window (or click the tray icon) and pick a folder |
| `didn't answer within 30 s` | It was launched, but didn't reply | Check the tray, and the log in `%USERPROFILE%\.omnibots\logs\app.log` |
| `got the stop request but is still open` | It's finishing a step, or waiting in its first-run window | Close it from the tray icon → Exit |
| `usage: /omnibots [start\|status\|stop]` | An unknown word after `/omnibots` (for example `-stop`) | Type it without the dash |

## Omni's website

The OmniBots site has a **Works with Omni** section. Omni's page (`website/index.html` in this checkout; `website/`
is not in git and FastComet serves the public copy) now has the matching notice:

- Header and footer link **OmniBots ↗** to https://omnibots.globalwarningnetworks.com.
- Section **Works with OmniBots** (`#omnibots`): what Omi's team does, that it uses Omni's keys, `/omnibots`,
  `/omnibots status` and `/omnibots stop`, the folders `~\.omni` and `~\.omnibots`, and **install Omni first**.
- The OmniBots install line, with its own Copy button:
  `irm https://raw.githubusercontent.com/tattooinmtl/Omnibots/master/install.ps1 | iex`
- **More about OmniBots** links to https://omnibots.globalwarningnetworks.com.

A git push does not publish that page. Upload `website/` to FastComet for omni.globalwarningnetworks.com.

## Rules to keep

- Omni only **starts, checks and stops** OmniBots. It never writes into OmniBots' folders, and OmniBots only reads
  Omni's config. The two stay separate projects: `tattooinmtl/omni` and `tattooinmtl/Omnibots`.
- The launcher's status is a short summary. It never passes on provider details or keys.
- `extensions/omnibots-launcher.json` holds paths from this PC. It stays git-ignored.

## Changing this file

Omni's `.gitignore` keeps loose `*.md` files out of the public repo. This one is published through its own exception
there, `!/instructions_omnibots.md`, at the user's request. A change to it ships like any other change, following
`AGENTS.md`: tests, the next patch version, a changelog entry, then a PR into `main`, merged once its checks pass.
