---
name: go-coding
command: /go
description: Go environment setup, syntax rules, best practices, and project scaffolding.
---

# Go Coding Skill

## Purpose
Guide the user through Go environment detection, installation, project scaffolding, idiomatic code writing, and best practices.

## When to use
Use this skill when the user runs:

/go [subcommand]

Subcommands:
- (none) — Detect Go environment, report status, and offer to fix issues
- new <project-name> — Scaffold a new Go project
- check — Scan current project for env issues and best practice violations
- help — Show this help

---

## Phase 1 — Environment Detection & Installation

### Step 1: Detect existing Go installation
Use `run_shell` to check:
```powershell
go version
go env GOPATH
go env GOROOT
go env GOOS
go env GOARCH
```

Also check for useful tools:
```powershell
where golangci-lint
where staticcheck
where goimports
where dlv  # Delve debugger
```

### Step 2: Report status
Report what's installed and what's missing:
- ✅ / ❌ Go compiler (go)
- ✅ / ❌ GOPATH configured
- ✅ / ❌ golangci-lint (linter)
- ✅ / ❌ staticcheck (static analysis)
- ✅ / ❌ goimports (import management)
- ✅ / ❌ Delve debugger (dlv)

### Step 3: Install Go if missing

**Windows:**
```powershell
winget install GoLang.Go
# OR download from https://go.dev/dl/ and run the MSI installer
```

**Linux:**
```bash
# Download the latest tarball from https://go.dev/dl/
wget https://go.dev/dl/go1.24.0.linux-amd64.tar.gz
sudo tar -C /usr/local -xzf go1.24.0.linux-amd64.tar.gz
export PATH=$PATH:/usr/local/go/bin
```

**macOS:**
```bash
brew install go
```

### Step 4: Configure environment
Ensure GOPATH and bin directory are set:
```powershell
# Windows (PowerShell)
go env -w GOPATH=$env:USERPROFILE\go
go env -w GOBIN=$env:USERPROFILE\go\bin
# Add to PATH: $env:USERPROFILE\go\bin
```

```bash
# Linux/macOS
echo 'export PATH=$PATH:$(go env GOPATH)/bin' >> ~/.bashrc
source ~/.bashrc
```

### Step 5: Install useful tools
```powershell
go install golang.org/x/tools/gopls@latest
go install honnef.co/go/tools/cmd/staticcheck@latest
go install github.com/golangci/golangci-lint/cmd/golangci-lint@latest
go install golang.org/x/tools/cmd/goimports@latest
go install github.com/go-delve/delve/cmd/dlv@latest
```

### Step 6: Verify
```powershell
go version
go env GOPATH
golangci-lint --version
staticcheck --version
```

---

## Phase 2 — Project Scaffolding

### Create a new project
```powershell
mkdir <project-name>
cd <project-name>
go mod init github.com/yourname/<project-name>
```

### Project structure — start flat, grow on demand

**Level 1: Small tool or script (flat)**
```
weather/
├── go.mod
├── main.go
├── weather.go
└── weather_test.go
```

**Level 2: One binary with reusable internals**
```
bookstore/
├── go.mod
├── main.go
└── internal/
    ├── auth/
    │   ├── auth.go
    │   └── auth_test.go
    └── store/
        ├── store.go
        └── store_test.go
```

**Level 3: Multiple binaries**
```
bookstore/
├── go.mod
├── cmd/
│   ├── api/
│   │   └── main.go
│   └── migrate/
│       └── main.go
└── internal/
    ├── auth/
    └── store/
```

**Key rules:**
- `directory = package` — every file in a directory declares the same package
- `internal/` is compiler-enforced privacy — code outside the module cannot import it
- `cmd/` is only needed when you have more than one binary
- Do NOT use `src/` — that's a Java/Node habit, not Go
- Do NOT copy `golang-standards/project-layout` by default — it's not official and is overkill for most projects
- Name packages by what they provide (`store`, `auth`, `weather`), not by role (`utils`, `common`, `helpers`)

---

## Phase 3 — Syntax Rules & Best Practices

### Code Formatting
- **Always run `go fmt` or `gofmt`** — formatting is enforced by convention
- **Use `goimports`** to automatically manage imports
```powershell
go fmt ./...
goimports -w *.go
```

### Naming Conventions
- **Package names**: lowercase, short, single word (e.g., `httputil`, not `http_util`)
- **Exported names**: `PascalCase` (e.g., `NewClient`, `UserService`)
- **Unexported names**: `camelCase` (e.g., `parseURL`, `validateInput`)
- **Constants**: `PascalCase` (e.g., `MaxRetryCount`), not `SCREAMING_SNAKE_CASE`
- **Interfaces**: single-method interfaces use `-er` suffix (e.g., `Reader`, `Writer`, `Closer`)
- **Avoid underscores** in names — Go favors short, concise names
- **Receiver names**: short, consistent, typically 1-2 letters (e.g., `u` for `User`)

```go
// Package httputil provides HTTP utility functions for common web operations.
package httputil

// Exported function
func NewClient() *Client {}

// Unexported function
func parseURL(url string) error {}

// Interface with -er suffix
type Reader interface {
    Read([]byte) (int, error)
}
```

### Import Organization
Group imports in order: standard library, third-party, local packages
```go
import (
    "fmt"
    "net/http"

    "github.com/gin-gonic/gin"

    "myproject/internal/config"
)
```

### Error Handling
- **Never ignore errors** — always check `err`
- **Wrap errors with `fmt.Errorf` and `%w`** to preserve the error chain
- **Handle errors early** to reduce nesting
- **Error is always the last return value**

```go
// Standard error handling
func ReadConfig(filename string) (*Config, error) {
    data, err := os.ReadFile(filename)
    if err != nil {
        return nil, fmt.Errorf("reading config file: %w", err)
    }
    var config Config
    if err := json.Unmarshal(data, &config); err != nil {
        return nil, fmt.Errorf("parsing config: %w", err)
    }
    return &config, nil
}

// Handle errors early — reduce nesting
func ProcessFile(filename string) error {
    file, err := os.Open(filename)
    if err != nil {
        return err
    }
    defer file.Close()
    return processData(file)
}
```

### Functions and Methods
- **Value receiver**: use when the method does not modify the receiver
- **Pointer receiver**: use when modification is needed
- **Be consistent**: don't mix value and pointer receivers on the same type
- **Multiple return values**: error is always last
- **Keep function signatures concise** — use a struct for complex parameters

```go
type User struct {
    Name string
    Age  int
}

// Value receiver — no modification
func (u User) String() string {
    return fmt.Sprintf("%s (%d)", u.Name, u.Age)
}

// Pointer receiver — modification needed
func (u *User) UpdateAge(age int) {
    u.Age = age
}
```

### Concurrency
- **Use `context.Context`** to control goroutine lifecycles
- **Avoid goroutine leaks** — always define explicit exit conditions
- **Use channels for communication** between goroutines
- **Use `sync.WaitGroup`** for coordinating multiple goroutines
- **Prefer `select` with `ctx.Done()`** for cancellation

```go
func processData(ctx context.Context, data <-chan string) <-chan Result {
    results := make(chan Result)
    go func() {
        defer close(results)
        for {
            select {
            case item := <-data:
                results <- process(item)
            case <-ctx.Done():
                return
            }
        }
    }()
    return results
}
```

### Comments
- **Exported names must have comments** — start with the name being documented
- **Comments are full sentences** — begin with the name, end with a period
- **Package comments** go on the package declaration

```go
// Package math provides basic mathematical functions.
package math

// Sqrt returns the square root of x.
// It panics if x is negative.
func Sqrt(x float64) float64 { ... }
```

### Testing
- **Table-driven tests** are the idiomatic pattern
- **Test files end with `_test.go`**
- **Test functions start with `Test` (testing.T), `Benchmark` (testing.B), `Example` (documentation)**
- **Use `t.Run` for subtests**

```go
func TestUser_UpdateAge(t *testing.T) {
    tests := []struct {
        name     string
        user     User
        newAge   int
        expected int
    }{
        {"update age", User{"Alice", 25}, 30, 30},
        {"zero age", User{"Bob", 20}, 0, 0},
    }
    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            tt.user.UpdateAge(tt.newAge)
            if tt.user.Age != tt.expected {
                t.Errorf("UpdateAge() = %d, want %d", tt.user.Age, tt.expected)
            }
        })
    }
}
```

### Performance
- **Preallocate slice capacity** to avoid repeated resizing
- **Use `strings.Builder`** for efficient string construction
- **Write correct code first, then optimize** — use `pprof` to find real bottlenecks

```go
// Preallocate slice capacity
results := make([]Result, 0, len(items))

// Efficient string building
var builder strings.Builder
builder.Grow(estimateSize(parts))
for _, part := range parts {
    builder.WriteString(part)
}
return builder.String()
```

### Package Design
- **Define interfaces in the consumer package**, not the implementation package
- **Accept interfaces, return structs**
- **Keep packages small and focused** — a package should do one thing well
- **Avoid generic package names** like `util`, `common`, `helpers`

---

## Phase 4 — Verification & Build

### Build and check
```powershell
go build ./...
go vet ./...
golangci-lint run
staticcheck ./...
go test ./... -v
go test -race ./...     # Race detector
go test -cover ./...     # Coverage
```

### Format check
```powershell
go fmt ./...
goimports -w .
```

---

## Phase 5 — Quick Reference

| Practice | Why |
|---|---|
| `go fmt` / `goimports` | Enforced formatting convention |
| Wrap errors with `%w` | Preserve error chain |
| Handle errors early | Reduce nesting |
| Table-driven tests | Idiomatic, clear, composable |
| `context.Context` for goroutines | Cancellation and timeouts |
| Preallocate slices | Avoid repeated resizing |
| `strings.Builder` | Efficient string construction |
| Start flat, grow on demand | Avoid premature structure |
| `internal/` for privacy | Compiler-enforced |
| `cmd/` only for multiple binaries | Keep it simple otherwise |
| Accept interfaces, return structs | Go idiom for flexibility |
| Short, consistent receiver names | Idiomatic Go style |

---

## Rules
- Always detect the environment before suggesting installation.
- Use `run_shell` for all commands — verify each succeeds before continuing.
- Read existing project files before suggesting changes.
- Always run `go fmt` and `go vet` after making changes.
- Never ignore errors — always check `err`.
- Start projects flat — only add `internal/` and `cmd/` when the project demands it.
- Do not copy `golang-standards/project-layout` by default.
- Use table-driven tests for all test code.
- Keep functions short and focused — Go values simplicity.

## Output
1. Environment status report
2. Installation/fix steps (if needed)
3. Project scaffold (if requested)
4. Code with idiomatic Go patterns applied
5. Build and test verification