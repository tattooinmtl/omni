# C# / .NET Engineering Reference & Deep Best Practices

## 1. High-Performance Memory & IO
- Use `ArrayPool<T>` and `MemoryPool<T>` for heavy allocations.
- Avoid boxing value types; use generic interfaces (`IEquatable<T>`, `IComparable<T>`).

## 2. Entity Framework Core Performance
- Use `.AsNoTracking()` for read-only queries.
- Use explicit projection (`.Select(...)`) to avoid fetching unused columns.

## 3. Resilience & Retries
- Use `Polly` for HTTP retries, circuit breakers, and rate limit handling.
