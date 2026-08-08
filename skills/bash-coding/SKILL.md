---
name: bash-coding
command: /bash
description: Bash/Shell scripting environment setup, syntax rules, best practices, and project scaffolding.
---

# Bash / Shell Scripting Skill

## Purpose
Guide the user through Bash/shell environment detection, script writing, syntax rules, best practices, and shell scripting standards.

## When to use
Use this skill when the user runs:

/bash [subcommand]

Subcommands:
- (none) — Detect shell environment, report status
- new <script-name> — Scaffold a new shell script
- check — Lint current script with shellcheck
- help — Show this help

---

## Phase 1 — Environment Detection

### Step 1: Detect existing shell
Use `run_shell` to check:
```powershell
where bash
where sh
where zsh
where pwsh        # PowerShell
where shellcheck  # Linter
```

### Step 2: Report status
- ✅ / ❌ Bash
- ✅ / ❌ ShellCheck (linter)
- ✅ / ❌ PowerShell (Windows)

### Step 3: Install missing tools

**Windows (WSL2 recommended for Bash):**
```powershell
wsl --install
# Inside WSL:
sudo apt install bash shellcheck
```

**Linux:**
```bash
sudo apt install bash shellcheck
```

**macOS:**
```bash
brew install bash shellcheck
```

---

## Phase 2 — Script Scaffolding

### Basic script template
```bash
#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

# Script description
# Usage: ./script.sh [args]

# --- Functions ---
main() {
    echo "Hello, World!"
}

# --- Main ---
main "$@"
```

### Key flags explained
- `set -e` — Exit on error
- `set -u` — Error on undefined variable
- `set -o pipefail` — Pipeline fails if any command fails
- `IFS=$'\n\t'` — Safer word splitting

---

## Phase 3 — Syntax Rules & Best Practices

### Shebang
- **Use `#!/usr/bin/env bash`** — not `#!/bin/bash` (more portable)

### Strict Mode (mandatory)
- **Always use `set -euo pipefail`** at the top of every script
- **Set `IFS=$'\n\t'`** for safer word splitting

### Variables
- **Always quote variables** — `"$var"`, not `$var`
- **Use `${var}`** for clarity in strings: `"${var}_suffix"`
- **Use `local`** for function-local variables
- **Use uppercase for environment variables**, lowercase for locals

```bash
# ✅ Good — quoted variables
echo "Hello, $name"
file_path="${directory}/${filename}"

# ❌ Bad — unquoted, word splitting risk
echo Hello $name

# ✅ Local variables
my_function() {
    local result="value"
    echo "$result"
}
```

### Functions
- **Use `function_name() { }`** syntax (not `function name { }`)
- **Use `local` for all function-local variables**
- **Return exit codes**, not strings (use `echo` + `$(...)` for output)

```bash
# ✅ Function with local variables and return
is_even() {
    local num="$1"
    if (( num % 2 == 0 )); then
        return 0
    else
        return 1
    fi
}

# Function that returns a string via echo
get_greeting() {
    local name="$1"
    echo "Hello, $name"
}

# Usage
greeting=$(get_greeting "Alice")
if is_even 4; then
    echo "4 is even"
fi
```

### Conditionals
- **Use `[[ ]]`** for tests — not `[ ]` (more robust, supports regex)
- **Use `(( ))`** for arithmetic comparisons

```bash
# ✅ String test
if [[ -z "$var" ]]; then
    echo "Variable is empty"
fi

# ✅ File test
if [[ -f "$file" ]]; then
    echo "File exists"
fi

# ✅ Regex match
if [[ "$email" =~ ^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$ ]]; then
    echo "Valid email"
fi

# ✅ Arithmetic
if (( count > 10 )); then
    echo "Count is high"
fi
```

### Loops
- **Use `for ... in`** for iteration
- **Use `while read`** for line-by-line file processing

```bash
# Iterate over array
for item in "${items[@]}"; do
    echo "$item"
done

# C-style loop
for (( i=0; i<10; i++ )); do
    echo "Iteration $i"
done

# Read file line by line
while IFS= read -r line; do
    echo "Line: $line"
done < input.txt
```

### Arrays
- **Use `declare -a`** for indexed arrays
- **Use `declare -A`** for associative arrays
- **Always quote `"${array[@]}"`** when expanding

```bash
# Indexed array
declare -a fruits=("apple" "banana" "cherry")
for fruit in "${fruits[@]}"; do
    echo "$fruit"
done

# Associative array
declare -A config
config[host]="localhost"
config[port]="8080"
config[debug]="true"

for key in "${!config[@]}"; do
    echo "$key = ${config[$key]}"
done
```

### Error Handling
- **Check exit codes** with `$?` or `if` statements
- **Use `trap`** for cleanup on exit
- **Provide meaningful error messages**

```bash
# Trap for cleanup
cleanup() {
    echo "Cleaning up..."
    rm -f "$temp_file"
}
trap cleanup EXIT

temp_file=$(mktemp)

# Check command success
if ! curl -s "$url" > "$temp_file"; then
    echo "ERROR: Failed to download $url" >&2
    exit 1
fi
```

### Security
- **Never use `eval`** on user input
- **Quote all variables** — prevent word splitting and glob expansion
- **Use `mktemp`** for temporary files — not predictable names
- **Avoid `sudo` inside scripts** — let the user run with sudo
- **Validate all input** — don't trust arguments

---

## Phase 4 — Verification

### Lint
```powershell
shellcheck script.sh
shellcheck -x script.sh  # Follow sourced files
```

### Run
```powershell
chmod +x script.sh
./script.sh
bash script.sh
```

---

## Phase 5 — Quick Reference

| Practice | Why |
|---|---|
| `set -euo pipefail` | Fail fast, catch errors |
| `#!/usr/bin/env bash` | Portable shebang |
| Quote all variables | Prevent word splitting |
| `[[ ]]` over `[ ]` | More robust tests |
| `(( ))` for arithmetic | Clearer math |
| `local` in functions | Prevent variable leaks |
| `trap` for cleanup | Resource cleanup |
| `mktemp` for temp files | Secure temp files |
| ShellCheck | Static analysis |
| `IFS=$'\n\t'` | Safer word splitting |

---

## Rules
- Always use `set -euo pipefail` at the top of every script.
- Always quote variables — `"$var"`, not `$var`.
- Use `[[ ]]` for tests, `(( ))` for arithmetic.
- Use `local` for all function-local variables.
- Never use `eval` on user input.
- Use `trap` for cleanup on exit.
- Run `shellcheck` after writing scripts.
- Use `#!/usr/bin/env bash` for the shebang.

## Output
1. Environment status report
2. Script scaffold (if requested)
3. Code with best practices applied
4. ShellCheck verification