---
name: csharp
description: >-
  Production C# / .NET 8+ codebase starter, ASP.NET Core, Entity Framework Core, Async/Await, LINQ, xUnit, Roslyn analyzers, and harness controls for C#.
---

# C# / .NET Codebase & Engineering Skill

Comprehensive operational guide, starter architecture, best practices, and harness controls for C# and .NET engineering.

## 1. Stack Overview & Dependencies
- **Runtime**: .NET 8 / .NET 9 SDK
- **Language Level**: C# 12 / C# 13
- **Build & Package Tool**: `dotnet` CLI & NuGet
- **Core Dependencies**:
  - `Microsoft.AspNetCore.OpenApi` / `Swashbuckle`: REST API & Swagger
  - `Microsoft.EntityFrameworkCore`: ORM & database context
  - `MediatR` / `FluentValidation`: CQRS & validation pipeline
  - `xUnit`, `FluentAssertions`, `NSubstitute`: Testing framework
  - `StyleCop.Analyzers` / `Roslyn`: Static code analysis

## 2. Standard Codebase Structure
```text
csharp-solution/
├── CSharpSolution.sln
├── src/
│   └── App.WebApi/
│       ├── App.WebApi.csproj
│       ├── Program.cs
│       ├── Controllers/
│       ├── Models/
│       └── Services/
└── tests/
    └── App.Tests/
        ├── App.Tests.csproj
        └── ServiceTests.cs
```

## 3. How-To Workflows

### Restore & Build
```bash
dotnet restore
dotnet build --configuration Release
```

### Dev Execution / Run
```bash
dotnet run --project src/App.WebApi/App.WebApi.csproj
```

### Code Formatting & Analysis
```bash
# Format solution
dotnet format

# Run Roslyn analyzer build
dotnet build /warnaserror
```

### Testing & Verification
```bash
dotnet test --logger "console;verbosity=detailed"
```

## 4. Best Practices & Design Patterns
1. **Async / Await Best Practices**: Use `await` consistently; never use `.Result` or `.Wait()` which cause threadpool starvation and deadlocks. Always pass `CancellationToken`.
2. **Nullable Reference Types**: Enable `<Nullable>enable</Nullable>` in `.csproj`. Validate non-null contracts explicitly.
3. **Dependency Injection**: Register services with appropriate lifetimes (`AddTransient`, `AddScoped`, `AddSingleton`). Inject interfaces, not concrete implementations.
4. **Pattern Matching & Records**: Use `record` for immutable DTOs/value objects and C# pattern matching (`switch` expressions).
5. **LINQ Efficiency**: Avoid `IEnumerable` multiple enumeration; use `IQueryable` for database queries and `.ToList()` / `.ToArray()` consciously.

## 5. Tips, Tricks & Pitfalls
- **Configure Execution Context**: Use `.ConfigureAwait(false)` in library projects to avoid synchronization context overhead.
- **Memory Allocation**: Use `Span<T>`, `ReadOnlySpan<T>`, and `Memory<T>` for zero-allocation slice operations on strings and byte buffers.
- **Record Mutability**: Use positional records with `init`-only properties to maintain immutability.

## 6. Harness Hooks & Safety Enforcement
- **PreToolUse Guard**: Block unsafe `dotnet ef database drop` commands without explicit confirmation.
- **PostToolUse Verification**: Trigger `dotnet test` automatically after code changes.
