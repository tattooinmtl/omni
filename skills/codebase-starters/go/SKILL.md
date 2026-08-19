---
name: go
description: >-
  Production Go 1.22+ codebase starter, Go Modules, Goroutines, Channels, Context propagation, golangci-lint, go test, and harness verification for Go engineering.
---

# Go Codebase & Engineering Skill

Comprehensive operational guide, starter architecture, best practices, and harness controls for high-performance Go microservices and CLI tools.

## 1. Stack Overview & Dependencies
- **Runtime**: Go 1.22 / Go 1.23+
- **Module Manager**: Go Modules (`go.mod`)
- **Core Dependencies**:
  - `net/http` (standard library with Go 1.22+ enhanced routing) or `gin` / `chi`
  - `golang.org/x/sync/errgroup`: Structured goroutine concurrency
  - `github.com/stretchr/testify`: Testing & assertion framework
  - `golangci-lint`: Fast multi-linter static analysis tool
  - `gopls`: Official Go language server

## 2. Standard Codebase Structure
```text
go-service/
├── go.mod
├── go.sum
├── README.md
├── main.go
├── cmd/
│   └── server/
│       └── main.go
├── internal/
│   ├── config/
│   ├── handler/
│   └── service/
└── pkg/
    └── utils/
```

## 3. How-To Workflows

### Initialize & Download Dependencies
```bash
go mod tidy
go mod download
```

### Build & Compile Executable
```bash
go build -o bin/server ./cmd/server
```

### Dev Run Mode
```bash
go run ./cmd/server
```

### Static Analysis & Formatting
```bash
# Code formatting
gofmt -w -s .

# Run linter
golangci-lint run ./...
```

### Testing & Verification
```bash
go test -v -race -cover ./...
```

## 4. Best Practices & Design Patterns
1. **Explicit Error Check**: Always inspect returned errors immediately (`if err != nil { return fmt.Errorf("...: %w", err) }`). Wrap errors using `%w` to support `errors.Is` and `errors.As`.
2. **Context Propagation**: Pass `ctx context.Context` as the first parameter to functions performing IO or cancellation-aware tasks. Respect `ctx.Done()`.
3. **Goroutine Leak Prevention**: Always ensure spawned goroutines have a guaranteed termination path (via channel close, context cancellation, or sync.WaitGroup).
4. **Interface Segregation**: Accept interfaces, return concrete structs. Keep interfaces small and consumer-focused.
5. **Zero-Value Usability**: Design structs so their zero value (`var s Struct`) is immediately usable without requiring explicit constructor setup where possible.

## 5. Tips, Tricks & Pitfalls
- **Race Detector**: Always run unit tests with `-race` (`go test -race ./...`) during CI builds to catch data races early.
- **Defer Overhead**: Use `defer file.Close()` immediately after successful resource acquisition.
- **Slice Allocation**: Pre-allocate slice capacity when length is known (`make([]T, 0, capacity)`).

## 6. Harness Hooks & Safety Enforcement
- **PreToolUse Guard**: Run `go vet ./...` before permitting binary compilation.
- **PostToolUse Verification**: Trigger `go test -race ./...` automatically after editing Go files.
