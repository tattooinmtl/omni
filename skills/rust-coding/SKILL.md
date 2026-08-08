---
name: rust-coding
command: /rust
description: Rust environment setup, syntax rules, best practices, and project scaffolding.
---

# Rust Coding Skill

## Purpose
Guide the user through Rust environment detection, installation, project scaffolding, idiomatic code writing, and best practices.

## When to use
Use this skill when the user runs:

/rust [subcommand]

Subcommands:
- (none) — Detect Rust environment, report status, and offer to fix issues
- new <project-name> — Scaffold a new Rust project
- check — Scan current project for env issues and best practice violations
- help — Show this help

---

## Phase 1 — Environment Detection & Installation

### Step 1: Detect existing Rust installation
Use `run_shell` to check:
```powershell
rustc --version
cargo --version
rustup --version
```

Also check for the MSVC build tools (required on Windows):
```powershell
where cl.exe
```

### Step 2: Report status
Report what's installed and what's missing:
- ✅ / ❌ Rust compiler (rustc)
- ✅ / ❌ Cargo package manager
- ✅ / ❌ rustup toolchain manager
- ✅ / ❌ MSVC build tools (Windows) or gcc/clang (Linux/macOS)

### Step 3: Install missing components
If Rust is not installed, guide the user through installation:

**Windows:**
```powershell
# Download rustup-init.exe and run it
winget install Rustlang.Rustup
# OR download from https://win.rustup.rs/x86_64
# Then run rustup-init.exe
```

**Linux/macOS:**
```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

If MSVC build tools are missing on Windows:
```powershell
winget install Microsoft.VisualStudio.2022.BuildTools
# Select "Desktop development with C++" workload
```

### Step 4: Configure toolchain
After installation, ensure the stable toolchain is default:
```powershell
rustup default stable
rustup update
```

### Step 5: Install useful components
```powershell
rustup component add rustfmt clippy rust-src rust-analyzer
cargo install cargo-audit cargo-watch cargo-edit cargo-hack
```

### Step 6: Verify
```powershell
rustc --version
cargo --version
rustfmt --version
cargo clippy --version
```

---

## Phase 2 — Project Scaffolding

### Create a new project
```powershell
cargo new <project-name>
cd <project-name>
```

### Standard project structure
```
my-project/
├── Cargo.toml          # Project manifest
├── Cargo.lock          # Dependency lock file
├── src/
│   ├── main.rs         # Binary entry point
│   ├── lib.rs          # Library root (public API)
│   ├── config.rs       # Configuration
│   ├── errors.rs       # Error types
│   ├── models/
│   │   ├── mod.rs
│   │   ├── user.rs
│   │   └── post.rs
│   └── handlers/
│       ├── mod.rs
│       └── auth.rs
├── tests/              # Integration tests
│   └── integration_test.rs
├── benches/            # Benchmarks
│   └── benchmark.rs
└── examples/
    └── basic_usage.rs
```

### Workspace for multi-crate projects
```toml
# Cargo.toml (workspace root)
[workspace]
members = ["crates/core", "crates/api", "crates/cli"]

[workspace.dependencies]
serde = { version = "1", features = ["derive"] }
tokio = { version = "1", features = ["full"] }
```

### Recommended Cargo.toml lints configuration
```toml
[lints.rust]
missing_debug_implementations = "warn"
redundant_imports = "warn"
unsafe_op_in_unsafe_fn = "warn"
unused_lifetimes = "warn"

[lints.clippy]
cargo = { level = "warn", priority = -1 }
complexity = { level = "warn", priority = -1 }
correctness = { level = "warn", priority = -1 }
pedantic = { level = "warn", priority = -1 }
perf = { level = "warn", priority = -1 }
style = { level = "warn", priority = -1 }
suspicious = { level = "warn", priority = -1 }
```

---

## Phase 3 — Syntax Rules & Best Practices

### Ownership and Borrowing
- **Prefer borrowing over cloning** — only own data when you must modify or store it
- **Accept `&str` over `&String`** — `&str` accepts string literals, `&String`, and more
- **Accept `&[T]` over `&Vec<T>`** — slices are more flexible
- **Use `impl Trait` parameters** for iterator flexibility
- **Use `Cow<str>`** when a function may or may not need to allocate

```rust
// BAD — unnecessary clone
fn greet(name: String) { println!("Hello, {name}!"); }
let name = String::from("Alice");
greet(name.clone());

// GOOD — borrow instead
fn greet(name: &str) { println!("Hello, {name}!"); }
let name = String::from("Alice");
greet(&name);
```

### Error Handling
- **Use `thiserror` for library errors** — structured, typed errors
- **Use `anyhow` for application errors** — ergonomic error handling with context
- **Use the `?` operator** — never `unwrap()` in production code
- **Create domain-specific `Result` types** — clean function signatures
- **Use `let-else` for early returns** — clean guard clauses

```rust
use thiserror::Error;

#[derive(Error, Debug)]
pub enum AppError {
    #[error("User not found: {0}")]
    NotFound(String),
    #[error("Validation failed: {0}")]
    Validation(String),
    #[error("Database error")]
    Database(#[from] sqlx::Error),
    #[error("IO error")]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, AppError>;
```

```rust
use anyhow::{Context, Result};

fn read_config(path: &str) -> Result<Config> {
    let content = std::fs::read_to_string(path)
        .with_context(|| format!("Failed to read config from {path}"))?;
    let config: Config = toml::from_str(&content)
        .context("Failed to parse config file")?;
    Ok(config)
}
```

### Structs and Enums
- **Use the Builder pattern** for structs with many optional fields
- **Use enums for state machines** — the compiler ensures exhaustive matching
- **Derive common traits**: `Debug, Clone, PartialEq, Eq, Hash`
- **All public types must implement `Debug`** — for easy debugging
- **Types meant to be read should implement `Display`**
- **Sensitive data types** must implement custom `Debug` that doesn't leak data

```rust
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct UserId(String);

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct User {
    pub id: UserId,
    pub name: String,
    pub email: String,
}
```

### Pattern Matching
- **Match exhaustively** — avoid wildcard `_` so the compiler catches new variants
- **Use `if let` for single patterns** — cleaner than match with empty arms
- **Use `let-else` for early returns** — guard clauses without nesting

```rust
// Exhaustive match — compiler catches new variants
match status {
    Status::Active => handle_active(),
    Status::Inactive => handle_inactive(),
    Status::Suspended { reason } => handle_suspended(reason),
}

// let-else for early return
fn process_user(id: &str) -> Result<()> {
    let Some(user) = find_user(id) else {
        return Err(AppError::NotFound(id.to_string()));
    };
    Ok(())
}
```

### Iterators
- **Chain iterator methods** — `iter().filter().map().collect()` over manual loops
- **Use `collect` to transform collections** — into HashMap, Result<Vec<T>>, etc.
- **Pre-allocate collections** with `Vec::with_capacity()` when size is known

```rust
// GOOD — iterator chain
let results: Vec<String> = items
    .iter()
    .filter(|item| item.is_active())
    .map(|item| item.name.to_uppercase())
    .collect();
```

### Concurrency
- **Use `tokio` for async runtime** — the standard async ecosystem
- **Use `Arc<Mutex<T>>` for shared mutable state** — but prefer channels
- **Prefer channels over shared state** — `tokio::sync::mpsc` for message passing
- **Use `tokio::join!` for concurrent operations**

```rust
use tokio;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let (users, posts) = tokio::join!(fetch_users(), fetch_posts());
    println!("Users: {}, Posts: {}", users?.len(), posts?.len());
    Ok(())
}
```

### Naming Conventions
- **Types**: `PascalCase` (e.g., `HttpClient`)
- **Functions and variables**: `snake_case` (e.g., `fetch_user`)
- **Constants**: `SCREAMING_SNAKE_CASE` (e.g., `MAX_CONNECTIONS`)
- **Modules**: `snake_case` (e.g., `user_handler`)
- **Avoid weasel words**: `Service`, `Manager`, `Factory` — use descriptive names instead
- **Keep names short**: max 2 short words compounded (e.g., `AppConfig` not `GlobalApplicationConfig`)
- **Don't bake module info into prefixes**: `foo::Id` not `foo::FooId`

### Lint Overrides
- **Use `#[expect(...)]` over `#[allow(...)]`** — warns if the lint is no longer triggered
- **Always include a reason**: `#[expect(clippy::unused_async, reason = "API fixed, will use I/O later")]`

### Performance
- **Avoid unnecessary allocations** — use `eq_ignore_ascii_case` instead of `to_lowercase()`
- **Pre-allocate collections** — `Vec::with_capacity(items.len())`
- **Use `&str` and `&[T]`** to avoid cloning

### Testing
- **Unit tests in `#[cfg(test)] mod tests`** within each module
- **Integration tests in `tests/` directory**
- **Use `proptest` for property-based testing**
- **Test that sensitive `Debug` impls don't leak data**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_add() {
        assert_eq!(add(2, 3), 5);
    }
}
```

### Crate Design
- **Split into smaller crates** — improves compile times and modularity
- **Features unlock extra functionality** — don't use features for independent components
- **Re-export proc macro crates** from their parent crate

---

## Phase 4 — Verification & Build

### Build and check
```powershell
cargo build
cargo clippy -- -D warnings
cargo fmt -- --check
cargo test
cargo audit
```

### Watch mode for development
```powershell
cargo watch -x run    # Rebuild and run on file change
cargo watch -x test   # Re-run tests on file change
```

---

## Phase 5 — Quick Reference

| Practice | Why |
|---|---|
| Borrow over clone | Avoid unnecessary allocations |
| Accept `&str` over `&String` | More flexible APIs |
| `thiserror` for libraries | Structured, typed errors |
| `anyhow` for applications | Ergonomic error handling |
| `?` operator over `unwrap` | Graceful error propagation |
| Iterator chains | Functional, composable, efficient |
| `let-else` for early returns | Clean guard clauses |
| Derive common traits | Less boilerplate |
| Pre-allocate collections | Fewer reallocations |
| Channels over shared state | Safer concurrency |
| `#[expect(...)]` over `#[allow(...)]` | Catches stale lint overrides |
| Split into smaller crates | Faster compile times |

---

## Rules
- Always detect the environment before suggesting installation.
- Use `run_shell` for all commands — verify each succeeds before continuing.
- Read existing project files before suggesting changes.
- Prefer idiomatic Rust patterns — borrow over clone, `?` over `unwrap`, iterators over loops.
- Run `cargo clippy` and `cargo fmt` after making changes.
- Never use `unwrap()` in production code — use `?` or `expect()` with a message.
- Match exhaustively — avoid wildcard `_` in match arms.
- Keep names short and free of weasel words (Service, Manager, Factory).

## Output
1. Environment status report
2. Installation/fix steps (if needed)
3. Project scaffold (if requested)
4. Code with idiomatic patterns applied
5. Build and test verification