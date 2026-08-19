# Kotlin Engineering Reference & Deep Best Practices

## 1. Coroutine Scope Hierarchy
- Never use `GlobalScope`.
- Inject `CoroutineDispatcher` (e.g. `Dispatchers.IO`) for unit testing flexibility.

## 2. Multiplatform & Native Guidelines
- Use `expect` / `actual` declarations cleanly when sharing code across Kotlin Multiplatform (KMP) targets.

## 3. Serialization Performance
- Reuse `Json { ... }` instances; instantiation is expensive.
