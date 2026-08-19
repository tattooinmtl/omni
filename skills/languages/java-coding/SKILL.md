---
name: java-coding
command: /java
description: Java environment setup, syntax rules, best practices, and project scaffolding.
---

# Java Coding Skill

## Purpose
Guide the user through Java environment detection, installation, project scaffolding, modern Java 25+ syntax, and best practices.

## When to use
Use this skill when the user runs:

/java [subcommand]

Subcommands:
- (none) — Detect Java environment, report status, and offer to fix issues
- new <project-name> — Scaffold a new Java project
- check — Scan current project for env issues and best practice violations
- help — Show this help

---

## Phase 1 — Environment Detection & Installation

### Step 1: Detect existing Java installation
Use `run_shell` to check:
```powershell
java --version
javac --version
echo $env:JAVA_HOME
where mvn
where gradle
```

### Step 2: Report status
- ✅ / ❌ JDK (25+ recommended — current LTS)
- ✅ / ❌ JAVA_HOME configured
- ✅ / ❌ Maven (build tool)
- ✅ / ❌ Gradle (build tool)

### Step 3: Install JDK if missing

**Windows:**
```powershell
# Option A: winget (Oracle JDK)
winget install Oracle.JDK.25

# Option B: Eclipse Temurin (OpenJDK, recommended)
winget install EclipseAdoptium.Temurin.25.JDK

# Option C: Manual download
# Download from https://adoptium.net/ and run the MSI installer
```

**Linux:**
```bash
# Using SDKMAN (recommended)
curl -s "https://get.sdkman.io" | bash
sdk install java 25-tem

# Using package manager
sudo apt install openjdk-25-jdk
```

**macOS:**
```bash
brew install openjdk@25
# OR
sdk install java 25-tem
```

### Step 4: Configure JAVA_HOME
```powershell
# Windows (PowerShell)
[System.Environment]::SetEnvironmentVariable("JAVA_HOME", "C:\Program Files\Java\jdk-25", "User")
# Add to PATH: %JAVA_HOME%\bin
```

```bash
# Linux/macOS
echo 'export JAVA_HOME=$(dirname $(dirname $(readlink -f $(which java))))' >> ~/.bashrc
source ~/.bashrc
```

### Step 5: Install build tools
```powershell
# Maven
winget install Apache.Maven
# OR
# Download from https://maven.apache.org/download.cgi

# Gradle
winget install Gradle.Gradle
# OR
# Download from https://gradle.org/install/
```

### Step 6: Verify
```powershell
java --version
javac --version
mvn --version
gradle --version
```

---

## Phase 2 — Project Scaffolding

### Option A: Maven project
```powershell
mvn archetype:generate -DgroupId=com.example -DartifactId=my-app -DarchetypeArtifactId=maven-archetype-quickstart -DinteractiveMode=false
cd my-app
```

### Option B: Gradle project
```powershell
gradle init --type java-application
```

### Standard project structure
```
my-app/
├── pom.xml                    # Maven (or build.gradle for Gradle)
├── src/
│   ├── main/
│   │   ├── java/
│   │   │   └── com/example/
│   │   │       ├── Application.java
│   │   │       ├── controller/
│   │   │       │   └── UserController.java
│   │   │       ├── service/
│   │   │       │   └── UserService.java
│   │   │       ├── model/
│   │   │       │   ├── User.java
│   │   │       │   └── PaymentResult.java
│   │   │       ├── repository/
│   │   │       │   └── UserRepository.java
│   │   │       └── config/
│   │   │           └── AppConfig.java
│   │   └── resources/
│   │       ├── application.properties
│   │       └── logback.xml
│   └── test/
│       └── java/
│           └── com/example/
│               └── UserServiceTest.java
└── README.md
```

### Spring Boot project (web API)
```powershell
# Using Spring Initializr
curl https://start.spring.io/starter.zip -d dependencies=web,data-jpa -d javaVersion=25 -o my-app.zip
# OR use the web interface at https://start.spring.io/
```

---

## Phase 3 — Syntax Rules & Best Practices

### Use Java 25+ Features

#### Records (immutable data carriers)
- **Use records for DTOs, value objects, and API responses**
- **Records auto-generate constructors, accessors, equals, hashCode, toString**
- **Use compact constructor for validation**
- **Never use mutable classes for pure data**

```java
// ✅ Good — record with validation
public record PaymentRequest(
    String customerId,
    BigDecimal amount,
    String currency,
    String description
) {
    // Compact constructor for validation
    public PaymentRequest {
        if (amount.compareTo(BigDecimal.ZERO) <= 0) {
            throw new IllegalArgumentException("Amount must be positive");
        }
        if (currency == null || currency.length() != 3) {
            throw new IllegalArgumentException("Invalid currency code");
        }
    }

    public boolean isLargePayment() {
        return amount.compareTo(new BigDecimal("10000")) > 0;
    }
}

// ❌ Bad — traditional mutable class
public class PaymentRequest {
    private String customerId;
    private BigDecimal amount;
    // ... getters, setters, equals, hashCode, toString boilerplate
}
```

#### Sealed Classes (closed type hierarchies)
- **Use sealed classes/interfaces** to restrict which types can extend
- **Enables exhaustive pattern matching** — compiler verifies all cases
- **No default case needed** — compiler catches missing subtypes

```java
// ✅ Sealed class hierarchy
public sealed interface PaymentResult
    permits PaymentSuccess, PaymentFailure, PaymentPending {}

public record PaymentSuccess(String transactionId, BigDecimal amount)
    implements PaymentResult {}
public record PaymentFailure(String errorCode, String errorMessage)
    implements PaymentResult {}
public record PaymentPending(String pendingId, Instant retryAt)
    implements PaymentResult {}

// Exhaustive switch — no default needed
public String formatResult(PaymentResult result) {
    return switch (result) {
        case PaymentSuccess(var txId, var amount) ->
            "Payment successful: " + txId + " for " + amount;
        case PaymentFailure(var code, var msg) ->
            "Payment failed: " + code + " - " + msg;
        case PaymentPending(var id, var retryAt) ->
            "Payment pending: " + id + ", retry at " + retryAt;
    };
}
```

#### Pattern Matching
- **Use `instanceof` pattern matching** — eliminates explicit casts
- **Use `switch` pattern matching** — destructuring with type checking
- **Pattern variables are scoped** — only in scope when pattern matches

```java
// Pattern matching with instanceof
public BigDecimal calculateFee(Payment payment) {
    if (payment instanceof DomesticPayment p) {
        return p.amount().multiply(new BigDecimal("0.01"));
    } else if (payment instanceof InternationalPayment p) {
        return p.amount().multiply(new BigDecimal("0.03"))
            .add(p.conversionFee());
    } else {
        throw new IllegalArgumentException("Unknown payment type");
    }
}

// Pattern matching in switch with guards
public String getPaymentDescription(Object obj) {
    return switch (obj) {
        case Payment p when p.amount().compareTo(BigDecimal.ZERO) > 0 ->
            "Payment: " + p.amount();
        case String s -> "Description: " + s;
        case null -> "No payment info";
        default -> "Unknown";
    };
}
```

#### Virtual Threads (Java 21+)
- **Use virtual threads for I/O-bound workloads** — not CPU-bound
- **Millions of virtual threads** can run concurrently with minimal overhead
- **Eliminates need for reactive/async frameworks** for I/O-bound code
- **Use `Executors.newVirtualThreadPerTaskExecutor()`**

```java
// ✅ Virtual threads for concurrent I/O
try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
    var future1 = executor.submit(() -> callPaymentGateway());
    var future2 = executor.submit(() -> callFraudService());
    var future3 = executor.submit(() -> callNotificationService());

    var gatewayResult = future1.get();
    var fraudCheck = future2.get();
    var notification = future3.get();
}
```

#### Text Blocks
- **Use text blocks for multi-line strings** — SQL, JSON, HTML
- **Preserves formatting** — no concatenation or escape sequences

```java
// ✅ Text block for SQL
String sql = """
    SELECT u.id, u.name, u.email
    FROM users u
    WHERE u.active = true
    ORDER BY u.name
    """;

// ✅ Text block for JSON
String json = """
    {
        "name": "Alice",
        "email": "alice@example.com",
        "role": "admin"
    }
    """;
```

#### Unnamed Variables (Java 22+)
- **Use `_` for variables you don't use** — eliminates "unused variable" warnings
- **Use `var _`** for unnamed variable declarations (not explicit type)

```java
// ✅ Unnamed variable in catch
try {
    parseInt(value);
} catch (NumberFormatException _) {
    log("Invalid number format");
}

// ✅ Unnamed variable in loop
int count = 0;
for (var _ : myList) {
    count++;
}
```

#### JavaDoc with Markdown (Java 23+)
- **Use `///` comments for Markdown JavaDoc** — not HTML tags
- **Don't mix Markdown with HTML tags or `{@code}`/`{@link}`**

```java
///
/// A utility class for **String** operations.
///
/// Use this class to perform common manipulations. For more details,
/// see [String].
/// You can also use `new StringManipulator()`.
///
public class StringManipulator { ... }
```

### Naming Conventions
- **Classes and interfaces**: `PascalCase` (e.g., `UserService`, `PaymentResult`)
- **Methods and variables**: `camelCase` (e.g., `fetchUser`, `userName`)
- **Constants**: `SCREAMING_SNAKE_CASE` (e.g., `MAX_CONNECTIONS`)
- **Packages**: `lowercase` (e.g., `com.example.userservice`)
- **Files**: Same name as the public class (e.g., `UserService.java`)

### Core Principles
- **Immutability first** — prefer `final` fields, records, and immutable collections
- **Composition over inheritance** — favor composition for flexibility
- **Fail fast** — detect errors early with validation
- **Explicit over implicit** — clear code over clever code
- **Use `var`** for local variables when type is obvious
- **Prefer streams** for collection processing

### Error Handling
- **Use custom exception hierarchies** — not generic `RuntimeException`
- **Use sealed exception types** for domain errors
- **Try-with-resources** for all AutoCloseable resources
- **Never catch `Exception` broadly** — catch specific exceptions

```java
// Custom exception hierarchy
public sealed class DomainException extends Exception
    permits ValidationException, NotFoundException, AuthorizationException {}

public final class ValidationException extends DomainException {
    public ValidationException(String message) { super(message); }
}

public final class NotFoundException extends DomainException {
    public NotFoundException(String message) { super(message); }
}

// Try-with-resources
public User loadUser(String id) throws DomainException {
    try (var conn = dataSource.getConnection();
         var stmt = conn.prepareStatement("SELECT * FROM users WHERE id = ?")) {
        stmt.setString(1, id);
        try (var rs = stmt.executeQuery()) {
            if (rs.next()) return mapUser(rs);
            throw new NotFoundException("User " + id + " not found");
        }
    } catch (SQLException e) {
        throw new DomainException("Database error", e);
    }
}
```

### Testing with JUnit 5
- **Use JUnit 5** (Jupiter) — not JUnit 4
- **Use `@ParameterizedTest`** for multiple inputs
- **Use AssertJ** for fluent assertions
- **Follow AAA pattern** — Arrange, Act, Assert
- **Test method names**: `should_ExpectedBehavior_When_Condition`

```java
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import static org.assertj.core.api.Assertions.*;

class UserServiceTest {

    @Test
    void should_return_user_when_id_exists() {
        // Arrange
        var service = new UserService(repository);
        var userId = "123";

        // Act
        var user = service.getById(userId);

        // Assert
        assertThat(user).isPresent();
        assertThat(user.get().id()).isEqualTo(userId);
    }

    @ParameterizedTest
    @CsvSource({"1, true", "0, false", "-1, false"})
    void should_validate_positive_numbers(int input, boolean expected) {
        assertThat(validator.isPositive(input)).isEqualTo(expected);
    }
}
```

### Security Best Practices
- **Never use `Runtime.exec()` with user input** — command injection
- **Use `PreparedStatement`** for all SQL — never string concatenation
- **Use `MessageDigest` or BCrypt** for password hashing
- **Validate all input** — use Bean Validation (`@Valid`, `@NotNull`, etc.)
- **Use `SecurityManager` alternatives** — Java 25 deprecated SecurityManager

```java
// PreparedStatement (SQL injection prevention)
try (var stmt = conn.prepareStatement("SELECT * FROM users WHERE email = ?")) {
    stmt.setString(1, email);
    try (var rs = stmt.executeQuery()) { ... }
}

// Password hashing with BCrypt
String hashed = BCrypt.hashpw(password, BCrypt.gensalt(12));
boolean valid = BCrypt.checkpw(input, hashed);

// Bean Validation
public record CreateUserRequest(
    @NotBlank String name,
    @Email String email,
    @Min(18) int age
) {}
```

---

## Phase 4 — Verification & Build

### Build
```powershell
mvn clean compile          # Maven
mvn clean package          # Build JAR
gradle build               # Gradle
gradle clean build         # Clean build
```

### Test
```powershell
mvn test                   # Maven
mvn test -Dtest=UserServiceTest  # Specific test
gradle test                # Gradle
```

### Lint and static analysis
```powershell
mvn checkstyle:check       # Checkstyle
mvn spotbugs:check         # SpotBugs
mvn pmd:check              # PMD
# SonarQube for comprehensive analysis
```

### Run
```powershell
mvn exec:java              # Maven
gradle run                 # Gradle
java -jar target/app.jar   # Direct JAR
```

---

## Phase 5 — Quick Reference

| Practice | Why |
|---|---|
| Records for DTOs | Immutable, less boilerplate |
| Sealed classes | Exhaustive pattern matching |
| Pattern matching | Eliminates casts, readable |
| Virtual threads | High-throughput I/O concurrency |
| Text blocks | Readable multi-line strings |
| `var` for locals | Less boilerplate, readable |
| Immutability first | Thread-safe, fewer bugs |
| Composition over inheritance | Flexible, testable |
| Try-with-resources | Automatic resource cleanup |
| JUnit 5 + AssertJ | Modern testing |
| PreparedStatement | SQL injection prevention |
| BCrypt for passwords | Secure hashing |

---

## Rules
- Always detect the environment before suggesting installation.
- Use `run_shell` for all commands — verify each succeeds before continuing.
- Read existing project files before suggesting changes.
- Target Java 25+ (current LTS) — use modern features.
- Use records for DTOs and value objects — not mutable classes.
- Use sealed classes for closed type hierarchies.
- Use pattern matching — not explicit casts.
- Use virtual threads for I/O-bound workloads.
- Prefer immutability — use `final` fields and immutable collections.
- Never catch broad `Exception` — catch specific exceptions.
- Use try-with-resources for all AutoCloseable resources.
- Run tests and static analysis after making changes.

## Output
1. Environment status report
2. Installation/fix steps (if needed)
3. Project scaffold (if requested)
4. Code with modern Java 25+ patterns applied
5. Build, test, and static analysis verification