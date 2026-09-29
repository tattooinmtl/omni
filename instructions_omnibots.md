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
missing. Run the same line again to update OmniBots. The installer runs the OmniBots doctor at the end (section 5).

**Check:** `C:\Users\ThePa\.omnibots\omnibots\__main__.py` and `C:\Users\ThePa\.omnibots\.venv\Scripts\python.exe` exist.

**The only folders either app keeps config, keys or data in:**

| Folder | What's there |
|---|---|
| `%USERPROFILE%\.omni` | Omni. `agent\settings.json` (and `.env`) hold the providers and keys **both** apps use |
| `%USERPROFILE%\.omnibots` | OmniBots: code, `.venv`, `settings.toml`, `db\omnibots.sqlite`, the bots' data, and `config\` only when Omni isn't installed |
| `%LOCALAPPDATA%\OmniBots` | Only Qt's window cache (`cache\qtpipelinecache-…`) |
| The projects folder (e.g. `C:\omnibots_output`) | The bots' projects, one folder per goal |

Anything that looks like their config somewhere else (an old `C:\omnibots` copy, an old `%LOCALAPPDATA%\OmniBots`
install with a database, a loose `%USERPROFILE%\.env`) is reported by the OmniBots doctor and left for you to remove.

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

### 5. Providers and keys: one list, shared (OmniBots 2026-09-29 or later)

**With Omni installed** (install Omni first, then OmniBots), the providers and keys live in Omni's
`%USERPROFILE%\.omni\agent\settings.json` (and `.env`), and both apps use that one list.

- In Omni: `/apikey`, `/provider` and the rest, as always.
- In OmniBots: **Settings → Providers** adds, edits and removes providers in that same `settings.json`. It only
  changes provider entries; every other Omni setting in the file stays as it was. A key is written only when you
  type one, so a key that comes from an environment variable is never copied into the file.
- Omni sees a change the next time it loads settings; OmniBots within a few seconds.

**Without Omni** (someone installs only OmniBots), OmniBots makes its own copy of Omni's layout in
`%USERPROFILE%\.omnibots\config`: `settings.json`, `.env` and `omni.config.json`, in Omni's formats, with **no
keys** in them. The keys are stored in OmniBots' database (`db\omnibots.sqlite`, table `provider_keys`), each one
encrypted with Windows DPAPI, so only that Windows user on that PC can read them. A key typed into those files is
moved into the database by the doctor. Install Omni later and OmniBots goes back to Omni's `settings.json`; the
keys then need adding in Omni.

If OmniBots' `settings.toml` names an Omni folder (`[omni] install_root`) or `OMNI_INSTALL_ROOT` is set, and that
folder isn't an Omni install, OmniBots reports the error instead of switching to its own copy.

### 6. The OmniBots doctor

The doctor checks everything both apps need, repairs what it safely can, and keeps it that way. Its reference is
`%USERPROFILE%\.omnibots\omnibots\doctor\layout.json` (explained in `docs\DOCTOR.md` there): the folders above,
OmniBots' settings and database, Python packages, the provider config and keys, Omni's files (read-only), the
environment variables, and old copies in other places. It creates and upgrades (the database after a backup),
**never deletes**, **never writes to `~\.omni`**, and never shows a key.

| How to run it | |
|---|---|
| Every OmniBots start | The quick part, quietly (folders, settings, the provider config) |
| OmniBots → **Settings → Doctor → Run doctor** | Everything; tick *Test provider keys online* to try each key |
| Ask Omi: "call the doctor" | Omi's `call_doctor` tool |
| `%USERPROFILE%\.omnibots\.venv\Scripts\python.exe -m omnibots.doctor` | From a terminal (`--no-fix`, `--online`, `--all`, `--json`) |
| The OmniBots installer | Once, at the end |

The last report is in `%USERPROFILE%\.omnibots\logs\doctor.json`. Omni's own `/doctor` still looks after Omni.

## Quick test

1. Close Omni fully and open it again.
2. Run `/omnibots status`. Before the first start it should say **OmniBots is not running**.
3. Run `/omnibots`. It should say **OmniBots started … version 0.3.0** (or newer) and name
   `C:\Users\ThePa\.omnibots\.venv\Scripts\python.exe`. The OmniBots icon appears in the tray.
4. Run `/omnibots status` for the short status, then `/omnibots stop`, which should say **OmniBots closed**.
5. In OmniBots, open **Settings → Doctor** and press **Run doctor**. It should report no problems and say the
   providers come from Omni.

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

| OmniBots says (Settings → Doctor) | What it means | What to do |
|---|---|---|
| `no provider has a key` | Nothing to think with yet | Add a key in Omni (`/apikey`), or in OmniBots → Settings → Providers |
| `Omni was not found (looked in: …)` | `[omni] install_root` or `OMNI_INSTALL_ROOT` names a folder that isn't Omni | Fix or clear that setting, then restart OmniBots |
| `Omni's omni.config.json doesn't list extensions/omnibots-launcher.js` | `/omnibots` won't work in Omni | Update Omni (3.5.10+), or add the line (section 2) |
| `keys are sitting in text files` | A key was typed into `~\.omnibots\config\.env` or `settings.json` | Run the doctor with repairs on: it moves them into the encrypted store |
| `can't be read` (stored keys) | The database came from another PC or Windows user | Type those keys again in Settings → Providers |
| `… still has settings.toml, db …; OmniBots doesn't use it` | An old copy in another folder | Move anything you need into `~\.omnibots`, then delete the old copy yourself |

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

- Omni only **starts, checks and stops** OmniBots. It never writes into OmniBots' folders. The two stay separate
  projects: `tattooinmtl/omni` and `tattooinmtl/Omnibots`.
- OmniBots reads Omni's config, with one writer: **Settings → Providers**, which edits only the provider entries in
  Omni's `settings.json` (the shared list, at the user's request, 2026-09-29). Nothing else in `~\.omni` is written
  by OmniBots, the doctor included.
- Without Omni, OmniBots' keys are DPAPI-encrypted in its database, never in a text file.
- The launcher's status is a short summary. It never passes on provider details or keys.
- `extensions/omnibots-launcher.json` holds paths from this PC. It stays git-ignored.

## Changing this file

Omni's `.gitignore` keeps loose `*.md` files out of the public repo. This one is published through its own exception
there, `!/instructions_omnibots.md`, at the user's request. A change to it ships like any other change, following
`AGENTS.md`: tests, the next patch version, a changelog entry, then a PR into `main`, merged once its checks pass.
