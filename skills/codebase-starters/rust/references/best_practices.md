# Rust Engineering Reference & Deep Best Practices

## 1. Memory Safety & Pinning
- Understand `Pin<Box<T>>` when working with async Futures and self-referential structs.

## 2. Tokio Async Best Practices
- Avoid blocking the thread in async functions; use `tokio::task::spawn_blocking` for CPU-bound or blocking OS calls.

## 3. Performance Optimization
- Profile with `cargo flamegraph` to pinpoint CPU hot spots.
- Use `#[inline]` judiciously on hot loop accessor methods.
