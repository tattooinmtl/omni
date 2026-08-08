---
name: csharp-coding
command: /csharp
description: C# / .NET environment setup, syntax rules, best practices, and project scaffolding.
---

# C# / .NET Coding Skill

## Purpose
Guide the user through C# / .NET environment detection, installation, project scaffolding, modern C# 13+ syntax, and best practices.

## When to use
Use this skill when the user runs:

/csharp [subcommand]

Subcommands:
- (none) — Detect .NET environment, report status, and offer to fix issues
- new <project-name> — Scaffold a new .NET project
- check — Scan current project for env issues and best practice violations
- help — Show this help

---

## Phase 1 — Environment Detection & Installation

### Step 1: Detect existing .NET installation
Use `run_shell` to check:
```powershell
dotnet --version
dotnet --list-sdks
dotnet --list-runtimes
where dotnet
```

### Step 2: Report status
- ✅ / ❌ .NET SDK (9.0+ recommended)
- ✅ / ❌ .NET Runtime
- ✅ / ❌ dotnet CLI

### Step 3: Install .NET SDK if missing
```powershell
# Windows
winget install Microsoft.DotNet.SDK.9
# OR download from https://dotnet.microsoft.com/download/dotnet/9.0

# Linux
wget https://dot.net/v1/dotnet-install.sh
chmod +x dotnet-install.sh
./dotnet-install.sh --channel 9.0

# macOS
brew install --cask dotnet-sdk
```

### Step 4: Verify
```powershell
dotnet --version
dotnet new list
```

---

## Phase 2 — Project Scaffolding

### Create a new project
```powershell
dotnet new console -n MyProject
cd MyProject
dotnet build
dotnet run
```

### Common project templates
- `console` — Console Application
- `webapi` — ASP.NET Core Web API
- `webapp` — ASP.NET Core Web App (Razor Pages)
- `web` — ASP.NET Core Web App (MVC)
- `blazor` — Blazor Server
- `blazorwasm` — Blazor WebAssembly
- `classlib` — Class Library
- `worker` — Worker Service
- `xunit` / `nunit` / `mstest` — Test projects

### Clean Architecture structure
```
MySolution/
├── MySolution.sln
├── src/
│   ├── MyProject.Domain/          # Entities, value objects
│   ├── MyProject.Application/      # Use cases, DTOs, interfaces
│   ├── MyProject.Infrastructure/   # Data access, external services
│   └── MyProject.Api/              # Controllers, middleware
├── tests/
│   ├── MyProject.UnitTests/
│   └── MyProject.IntegrationTests/
└── README.md
```

---

## Phase 3 — Syntax Rules & Best Practices

### Modern C# 13+ Features

#### Records (immutable data)
```csharp
// ✅ Record for DTOs
public record PaymentRequest(
    string CustomerId,
    decimal Amount,
    string Currency
)
{
    // Compact constructor for validation
    public PaymentRequest
    {
        if (Amount <= 0) throw new ArgumentException("Amount must be positive");
    }
}

// Record with mutable init-only properties
public record User
{
    public required string Name { get; init; }
    public required string Email { get; init; }
    public DateTime CreatedAt { get; init; } = DateTime.UtcNow;
}
```

#### Pattern Matching
```csharp
// Switch expression with pattern matching
public string FormatResult(PaymentResult result) => result switch
{
    PaymentSuccess s => $"Success: {s.TransactionId} for {s.Amount:C}",
    PaymentFailure f => $"Failed: {f.ErrorCode} - {f.ErrorMessage}",
    PaymentPending p => $"Pending: {p.PendingId}, retry at {p.RetryAt}",
    _ => "Unknown"
};

// Property patterns with guards
public decimal CalculateFee(Payment payment) => payment switch
{
    { Amount: > 10000, Type: "domestic" } => payment.Amount * 0.01m,
    { Amount: > 10000, Type: "international" } => payment.Amount * 0.03m,
    { Type: "domestic" } => payment.Amount * 0.005m,
    { Type: "international" } => payment.Amount * 0.015m,
    _ => throw new ArgumentException("Unknown payment type")
};
```

#### Collection Expressions (C# 12+)
```csharp
string[] vowels = ["a", "e", "i", "o", "u"];
List<int> numbers = [1, 2, 3, 4, 5];
int[] combined = [1, 2, ..numbers, 6, 7];  // Spread operator
```

#### Primary Constructors (C# 12+)
```csharp
public class UserService(ILogger<UserService> logger, IUserRepository repository)
{
    public async Task<User?> GetUserAsync(int id)
    {
        logger.LogInformation("Fetching user {Id}", id);
        return await repository.GetByIdAsync(id);
    }
}
```

#### Required Properties (C# 11+)
```csharp
public class Configuration
{
    public required string ConnectionString { get; init; }
    public required int MaxConnections { get; init; }
    public TimeSpan Timeout { get; init; } = TimeSpan.FromSeconds(30);
}
```

#### Raw String Literals (C# 11+)
```csharp
string json = """
{
    "name": "Alice",
    "email": "alice@example.com"
}
""";

string sql = """
    SELECT * FROM users
    WHERE active = 1
    """;
```

### Naming Conventions
- **Classes, interfaces, records**: `PascalCase` (e.g., `UserService`)
- **Interfaces**: prefix with `I` (e.g., `IUserService`)
- **Methods, properties**: `PascalCase` (e.g., `GetUser`, `UserName`)
- **Local variables, parameters**: `camelCase` (e.g., `userId`, `userName`)
- **Private fields**: `_camelCase` (e.g., `_logger`, `_repository`)
- **Constants**: `PascalCase` (e.g., `MaxConnections`)
- **Namespaces**: `PascalCase` (e.g., `MyProject.Services`)

### Language Guidelines
- **Use `var`** when type is obvious from the right side
- **Use language keywords** for types: `string` not `String`, `int` not `Int32`
- **Use `string` interpolation** — not concatenation
- **Use `async`/`await`** for I/O-bound operations
- **Use LINQ** for collection manipulation
- **Use `using` declarations** — not `try-finally` with `Dispose`
- **Use `&&` / `||`** — not `&` / `|`
- **Use collection expressions** — not `new[] { ... }`

```csharp
// ✅ Modern C#
using var connection = new SqlConnection(connectionString);
await connection.OpenAsync();

var users = await connection.QueryAsync<User>("SELECT * FROM users");
var activeUsers = users.Where(u => u.IsActive).OrderBy(u => u.Name).ToList();

// ✅ using declaration (no braces needed)
using Font normalStyle = new Font("Arial", 10.0f);
```

### Async/Await Best Practices
- **Use `async`/`await`** for I/O-bound operations
- **Use `Task` return type** — not `void` (except event handlers)
- **Use `ConfigureAwait(false)`** in library code
- **Use `CancellationToken`** for cancellable operations
- **Avoid `.Result` and `.Wait()`** — they can deadlock

```csharp
public async Task<User?> GetUserAsync(int id, CancellationToken cancellationToken = default)
{
    using var connection = new SqlConnection(_connectionString);
    await connection.OpenAsync(cancellationToken);
    return await connection.QueryFirstOrDefaultAsync<User>(
        "SELECT * FROM users WHERE id = @id",
        new { id },
        cancellationToken: cancellationToken
    );
}
```

### Error Handling
- **Catch specific exceptions** — not `Exception` broadly
- **Use exception filters** for conditional catch
- **Use custom exception types** for domain errors
- **Use `using`** for IDisposable resources

```csharp
try
{
    var result = await ProcessPaymentAsync(request);
    return Ok(result);
}
catch (ValidationException ex)
{
    return BadRequest(new { error = ex.Message });
}
catch (NotFoundException ex)
{
    return NotFound(new { error = ex.Message });
}
catch (Exception ex) when (ex is not OperationCanceledException)
{
    _logger.LogError(ex, "Unexpected error processing payment");
    return StatusCode(500, "Internal server error");
}
```

### Testing with xUnit
```csharp
public class UserServiceTests
{
    private readonly Mock<IUserRepository> _repoMock;
    private readonly UserService _service;

    public UserServiceTests()
    {
        _repoMock = new Mock<IUserRepository>();
        _service = new UserService(NullLogger<UserService>.Instance, _repoMock.Object);
    }

    [Fact]
    public async Task GetUserAsync_ReturnsUser_WhenExists()
    {
        // Arrange
        var user = new User { Id = 1, Name = "Alice" };
        _repoMock.Setup(r => r.GetByIdAsync(1)).ReturnsAsync(user);

        // Act
        var result = await _service.GetUserAsync(1);

        // Assert
        Assert.NotNull(result);
        Assert.Equal("Alice", result.Name);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    public async Task GetUserAsync_Throws_WhenIdInvalid(int id)
    {
        await Assert.ThrowsAsync<ArgumentException>(() => _service.GetUserAsync(id));
    }
}
```

---

## Phase 4 — Verification & Build

### Build and test
```powershell
dotnet build
dotnet test
dotnet test --collect:"XPlat Code Coverage"
dotnet run
```

### Format and lint
```powershell
dotnet format
dotnet format --verify-no-changes
```

### Security
```powershell
dotnet list package --vulnerable
dotnet list package --outdated
```

---

## Phase 5 — Quick Reference

| Practice | Why |
|---|---|
| Records for DTOs | Immutable, less boilerplate |
| Pattern matching | Readable, exhaustive |
| Collection expressions | Modern, concise |
| Primary constructors | Less boilerplate |
| `required` properties | Force initialization |
| Raw string literals | Readable multi-line strings |
| `async`/`await` | Non-blocking I/O |
| `using` declarations | Automatic disposal |
| LINQ for collections | Readable, composable |
| `var` when obvious | Less noise |
| `dotnet format` | Enforced style |
| xUnit for testing | Standard .NET testing |

---

## Rules
- Always detect the environment before suggesting installation.
- Use `run_shell` for all commands — verify each succeeds before continuing.
- Read existing project files before suggesting changes.
- Target .NET 9+ and C# 13+ — use modern features.
- Use records for DTOs and value objects.
- Use pattern matching — not if-else chains for type switching.
- Use `async`/`await` for I/O — never `.Result` or `.Wait()`.
- Use `using` declarations for IDisposable resources.
- Use `var` when type is obvious from context.
- Run `dotnet build` and `dotnet test` after making changes.
- Use `dotnet format` to enforce style.

## Output
1. Environment status report
2. Installation/fix steps (if needed)
3. Project scaffold (if requested)
4. Code with modern C# 13+ patterns applied
5. Build, test, and format verification