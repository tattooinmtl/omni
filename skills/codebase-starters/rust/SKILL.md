---
name: rust
description: >-
  Production Rust 2021 edition codebase starter, Cargo workspace, Tokio async, Serde, Clippy, cargo-test, safety guarantees, and harness verification for Rust systems programming.
---

# Rust Codebase & Engineering Skill

Comprehensive operational guide, starter architecture, best practices, and harness controls for high-performance Rust systems engineering.

## 1. Stack Overview & Dependencies
- **Compiler & Edition**: Rust 2021 Edition (`rustc` / `cargo`)
- **Async Runtime**: `tokio` (with `full` features)
- **Core Dependencies**:
  - `serde` + `serde_json`: Derivation for high-speed serialization
  - `tracing` + `tracing-subscriber`: Structured async diagnostics logging
  - `anyhow` / `thiserror`: Ergonomic error handling
  - `reqwest` / `axum`: Async HTTP client / server framework
  - `cargo-clippy`: Strict static analysis linter
  - `cargo-fmt`: Official code formatter

## 2. Standard Codebase Structure
```text
rust-service/
├── Cargo.toml
├── Cargo.lock
├── README.md
├── src/
│   ├── main.rs
│   ├── config.rs
│   ├── error.rs
│   └── service.rs
└── tests/
    └── integration_test.rs
```

## 3. How-To Workflows

### Build Project
```bash
# Debug build
cargo build

# Release optimized build
cargo build --release
```

### Run Executable
```bash
cargo run
```

### Static Analysis & Formatting
```bash
# Check code formatting
cargo fmt --check

# Run strict Clippy analysis
cargo clippy --all-targets --all-features -- -D warnings
```

### Testing & Verification
```bash
cargo test --all-targets -- --nocapture
```

## 4. Best Practices & Design Patterns
1. **Ownership & Borrow Checker**: Prefer references (`&T`, `&str`, `&[T]`) over cloning heavy types unless ownership transfer is explicitly required.
2. **Error Handling with `Result<T, E>`**: Avoid `.unwrap()` or `.expect()` in production code paths. Use `?` operator and `thiserror` for custom domain error enums.
3. **Type State Pattern**: Use generic type parameters to enforce object state transitions at compile time (e.g. `Order<Draft>` vs `Order<Submitted>`).
4. **Tokio Async Concurrency**: Use `tokio::spawn` for independent tasks and `tokio::select!` for multiplexing async futures.
5. **Zero-Cost Abstractions**: Leverage iterators (`.map()`, `.filter()`, `.fold()`) which compile down to optimal machine code without heap allocations.

## 5. Tips, Tricks & Pitfalls
- **Deadlock in Async Locks**: Never hold a `std::sync::MutexGuard` across an `.await` point. Use `tokio::sync::Mutex` or scope the lock block.
- **Cargo Check vs Build**: Use `cargo check` during fast dev loops to check types without compiling binary artifacts.
- **Unsafe Code Audit**: Mark `unsafe` blocks explicitly with safety comments justifying memory guarantees.

## 6. Harness Hooks & Safety Enforcement
- **PreToolUse Guard**: Run `cargo check` before allowing release compilation.
- **PostToolUse Verification**: Trigger `cargo clippy` and `cargo test` automatically after Rust code edits.
