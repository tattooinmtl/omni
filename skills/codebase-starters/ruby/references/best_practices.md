# Ruby Engineering Reference & Deep Best Practices

## 1. YJIT Tuning
- Enable YJIT via environment variable `RUBY_YJIT_ENABLE=1` or command flag `ruby --yjit`.

## 2. Memory & Object Allocation Optimization
- Use `String#b` for binary data.
- Avoid allocating objects in hot loops; use `Symbol` keys for internal hashes.
