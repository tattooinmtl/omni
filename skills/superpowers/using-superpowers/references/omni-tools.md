# Omni Tool Mapping

Skills speak in actions ("dispatch a subagent", "create a todo", "read a file"). On **Omni** these resolve to the tools below.

| Action skills request | Omni tool |
|----------------------|-----------|
| Read a file | `read_file` |
| Read multiple files at once | `read_many_files` |
| **Write / create a file** | **`write_file`** |
| Edit an exact substring in a file | `edit_file` |
| Multi-file / multi-hunk patch | `apply_patch` |
| Find-and-replace across files | `find_replace` |
| List a directory | `list_dir` |
| Move / rename a file or directory | `move_file` (file-tools extension) |
| Copy a file or directory | `copy_file` (file-tools extension) |
| Delete a file or directory | `delete_path` (file-tools extension) |
| Create a directory | `make_dir` (file-tools extension) |
| Search file contents (regex) | `search` |
| Find files by name/pattern | `find_files` |
| Create a todo / track tasks | `project_todo` with `action: add` |
| Mark a todo done | `project_todo` with `action: done` |
| Dispatch a subagent | `spawn_agent` |
| Check subagent status | `agent_status` |
| Stop a subagent | `stop_agent` |
| Run a shell command | `run_shell` |
| Run tests | `run_test` |
| Start a dev server / background process | `start_process` |
| Read an image / see what's in it | `read_media_file` (vision-tools extension) |
| Web search | `web_search` (web-search extension) |
| Fetch a web page | `web_fetch` (web-search extension) |
| Git status | `git_status` |
| Git diff | `git_diff` |
| Git commit | `git_commit` |
| **Git push** | **`git_push`** (git-ops extension) |
| **Git pull** | **`git_pull`** (git-ops extension) |
| **Git fetch** | **`git_fetch`** (git-ops extension) |
| **Git clone** | **`git_clone`** (git-ops extension) |
| **Git branch** | **`git_branch`** (git-ops extension) |
| **Git checkout** | **`git_checkout`** (git-ops extension) |
| **Git log** | **`git_log`** (git-ops extension) |
| **Git stash** | **`git_stash`** (git-ops extension) |
| **Git tag** | **`git_tag`** (git-ops extension) |
| **Git merge** | **`git_merge`** (git-ops extension) |
| **Git rebase** | **`git_rebase`** (git-ops extension) |
| **Git remote management** | **`git_remote`** (git-ops extension) |
| **Git init** | **`git_init`** (git-ops extension) |

## Task tracking

When a skill says to create a todo list or track tasks, use **`project_todo`** — NOT `manage_task` (which is not a tool in Omni). Workflow:

```
project_todo({ action: "add",    title: "Step 1 description" })
project_todo({ action: "update", id: "T001", status: "in_progress" })
project_todo({ action: "done",   id: "T001" })
project_todo({ action: "list" })   // to check remaining tasks
```

## Important: tool names are case-sensitive

Always use the exact tool name shown above. For example: file writes use `write_file`, single-substring edits use `edit_file`, multi-hunk or multi-file edits use `apply_patch`.
