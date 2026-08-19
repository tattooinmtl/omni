# Go Engineering Reference & Deep Best Practices

## 1. Concurrency Patterns
- Use `errgroup.WithContext(ctx)` for managing fan-out worker goroutines with unified error cancellation.

## 2. HTTP Server Hardening
- Set explicit timeouts on `http.Server`: `ReadTimeout`, `WriteTimeout`, `IdleTimeout`. Never use zero default timeouts in production.

## 3. Profiling & Diagnostics
- Use `net/http/pprof` for CPU and heap allocation profiling.
