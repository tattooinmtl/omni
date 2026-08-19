---
name: kotlin
description: >-
  Production codebase starter, best practices, Gradle/Kotlin DSL, Coroutines, Flow, Serialization, KtLint/detekt, and harness verification for Kotlin (JVM/Android/Multiplatform).
---

# Kotlin Codebase & Engineering Skill

Comprehensive operational guide, starter architecture, best practices, and harness controls for Kotlin engineering.

## 1. Stack Overview & Dependencies
- **Runtime**: Kotlin 1.9+ / 2.0+ (JVM Target 17 or 21)
- **Build System**: Gradle with Kotlin DSL (`build.gradle.kts`)
- **Core Dependencies**:
  - `kotlinx.coroutines`: Async & structured concurrency
  - `kotlinx.serialization`: High-performance JSON serialization
  - `ktor-client` / `ktor-server` or `Spring Boot`: Web & API framework
  - `kotest` / `JUnit 5` + `mockk`: Testing & mocking framework
  - `ktlint` / `detekt`: Code style & static analysis

## 2. Standard Codebase Structure
```text
kotlin-service/
├── build.gradle.kts
├── settings.gradle.kts
└── src/
    ├── main/
    │   └── kotlin/
    │       └── com/example/app/
    │           ├── Main.kt
    │           ├── config/
    │           ├── model/
    │           └── service/
    └── test/
        └── kotlin/
            └── com/example/app/
                └── AppTest.kt
```

## 3. How-To Workflows

### Build & Compile
```bash
./gradlew build
```

### Run Dev Server / App
```bash
./gradlew run
```

### Static Analysis & Formatting
```bash
# Check style with Ktlint / Detekt
./gradlew ktlintCheck detekt

# Format code
./gradlew ktlintFormat
```

### Testing & Verification
```bash
./gradlew test
```

## 4. Best Practices & Design Patterns
1. **Null Safety**: Embrace Kotlin's non-null types (`T` vs `T?`). Avoid force unwrapping `!!`; use `?.let`, `?:`, or `requireNotNull()`.
2. **Structured Concurrency**: Use `coroutineScope` or `supervisorScope` for concurrency. Never spawn unmanaged `GlobalScope.launch`.
3. **Immutability First**: Use `val` instead of `var`, `data class`, and read-only collections (`listOf`, `mapOf`).
4. **Sealed Classes & Interfaces**: Use `sealed class` or `sealed interface` for type-safe algebraic data types and domain state modeling.
5. **Extension Functions**: Encapsulate domain utilities cleanly without polluting class hierarchies.

## 5. Tips, Tricks & Pitfalls
- **Flow vs Suspend Functions**: Use `suspend` for single async returns and `Flow<T>` for reactive streams of asynchronous data.
- **Inline Classes / Value Classes**: Use `@JvmInline value class` for type-safe wrappers without object allocation overhead.
- **Coroutines Exception Handling**: Wrap scope launching with `CoroutineExceptionHandler` or handle exceptions within flow operators (`catch`).

## 6. Harness Hooks & Safety Enforcement
- **PreToolUse Guard**: Verify Gradle wrapper (`./gradlew`) execution without bypassing security checks.
- **PostToolUse Verification**: Trigger `./gradlew ktlintCheck test` automatically on code modifications.
