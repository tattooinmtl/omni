---
name: typescript-coding
command: /typescript
description: TypeScript environment setup, syntax rules, best practices, and project scaffolding.
---

# TypeScript Coding Skill

## Purpose
Guide the user through TypeScript environment detection, installation, project scaffolding, modern TypeScript 5.7+ syntax, type system best practices, and project configuration.

## When to use
Use this skill when the user runs:

/typescript [subcommand]

Subcommands:
- (none) — Detect TypeScript environment, report status, and offer to fix issues
- new <project-name> — Scaffold a new TypeScript project
- check — Scan current project for type errors and best practice violations
- help — Show this help

---

## Phase 1 — Environment Detection & Installation

### Step 1: Detect existing installation
Use `run_shell` to check:
```powershell
node --version
npm --version
where tsc
npx tsc --version
where tsx
```

### Step 2: Report status
- ✅ / ❌ Node.js (required for TypeScript)
- ✅ / ❌ TypeScript compiler (tsc)
- ✅ / ❌ tsx (TypeScript execution)

### Step 3: Install TypeScript if missing
```powershell
npm install -g typescript
npm install -g tsx
```

### Step 4: Verify
```powershell
tsc --version
tsx --version
```

---

## Phase 2 — Project Scaffolding

### Option A: Plain TypeScript project
```powershell
mkdir my-project
cd my-project
npm init -y
npm install typescript @types/node --save-dev
npx tsc --init
```

### tsconfig.json (modern, strict)
```json
{
  "compilerOptions": {
    "target": "ES2024",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2024"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "exactOptionalPropertyTypes": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

### Project structure
```
my-project/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts
│   ├── types/
│   │   └── index.ts
│   ├── services/
│   │   └── UserService.ts
│   └── utils/
│       └── logger.ts
├── tests/
│   └── UserService.test.ts
└── dist/               # Compiled output
```

### Option B: Vite + TypeScript (web)
```powershell
npm create vite@latest my-project -- --template vanilla-ts
```

### Option C: Bun + TypeScript (fastest runtime)
```powershell
bun init
# Bun has built-in TypeScript support — no tsconfig needed for basics
```

---

## Phase 3 — Syntax Rules & Best Practices

### Strict Mode (mandatory)
- **Always enable `"strict": true`** in tsconfig.json
- **Enable `noUncheckedIndexedAccess`** — array access returns `T | undefined`
- **Enable `exactOptionalPropertyTypes`** — distinguishes `undefined` from missing
- **Never use `any`** — use `unknown` when type is truly unknown

### Type System Best Practices

#### Use `unknown` over `any`
```typescript
// ❌ Bad — any disables type checking
function process(data: any) {
    return data.name.toUpperCase();  // No error, but crashes at runtime
}

// ✅ Good — unknown forces type narrowing
function process(data: unknown) {
    if (typeof data === 'object' && data !== null && 'name' in data) {
        return (data as { name: string }).name.toUpperCase();
    }
    throw new Error('Invalid data');
}

// ✅ Even better — use a type guard
function isUser(data: unknown): data is User {
    return typeof data === 'object' && data !== null && 'name' in data && 'email' in data;
}

function process(data: unknown) {
    if (isUser(data)) {
        return data.name.toUpperCase();  // Type-safe
    }
    throw new Error('Invalid user data');
}
```

#### Use `satisfies` for type checking without widening
```typescript
type Config = {
    readonly port: number;
    readonly host: string;
    readonly debug?: boolean;
};

// ✅ satisfies checks the type without widening
const config = {
    port: 3000,
    host: 'localhost',
    debug: true,
} satisfies Config;

// config.debug is still `boolean`, not `boolean | undefined`
```

#### Use `as const` for literal types
```typescript
// ✅ as const makes properties readonly and infers literal types
const statuses = ['pending', 'active', 'closed'] as const;
type Status = typeof statuses[number];  // 'pending' | 'active' | 'closed'

// ✅ const assertions in objects
const config = {
    port: 3000,
    host: 'localhost',
} as const;
// config.port is type 3000, not number
```

#### Use branded/opaque types for domain safety
```typescript
// Branded type — prevents mixing up IDs
type UserId = string & { readonly __brand: 'UserId' };
type OrderId = string & { readonly __brand: 'OrderId' };

function getUser(id: UserId) { ... }
function getOrder(id: OrderId) { ... }

const uid = '123' as UserId;
const oid = '456' as OrderId;

getUser(uid);  // ✅
getUser(oid);  // ❌ Type error — different brand
```

#### Use discriminated unions for state
```typescript
type Result<T, E = Error> =
    | { success: true; data: T }
    | { success: false; error: E };

function handleResult(result: Result<string>) {
    if (result.success) {
        console.log(result.data);  // T is narrowed
    } else {
        console.error(result.error);  // E is narrowed
    }
}
```

#### Use `enum` or union types for constants
```typescript
// ✅ Union types (lighter, tree-shakeable)
type Status = 'pending' | 'active' | 'closed';

// ✅ Const enum (compiled away, no runtime overhead)
const enum Direction {
    Up = 'up',
    Down = 'down',
    Left = 'left',
    Right = 'right',
}
```

### Modern TypeScript Features

#### Decorators (TypeScript 5.0+)
```typescript
// Standard decorators (TC39 stage 3)
function log(target: any, context: ClassMethodDecoratorContext) {
    return function(...args: any[]) {
        console.log(`Calling ${String(context.name)}`);
        return target.apply(this, args);
    };
}

class Service {
    @log
    fetchData() { ... }
}
```

#### `using` declarations (TypeScript 5.2+)
```typescript
// Resource disposal (like C# using)
class DatabaseConnection implements Disposable {
    [Symbol.dispose]() {
        this.close();
    }
}

{
    using conn = new DatabaseConnection();
    // conn is automatically disposed at end of scope
}
```

#### `const` type parameters (TypeScript 5.0+)
```typescript
// Prevents inference from widening to mutable arrays
function first<T const>(arr: readonly T[]): T | undefined {
    return arr[0];
}

const result = first([1, 2, 3]);  // T is 1 | 2 | 3, not number
```

### Naming Conventions
- **Types and interfaces**: `PascalCase` (e.g., `UserService`, `PaymentResult`)
- **Interfaces**: no `I` prefix (e.g., `Repository`, not `IRepository`)
- **Variables and functions**: `camelCase` (e.g., `fetchUser`, `userName`)
- **Constants**: `SCREAMING_SNAKE_CASE` (e.g., `MAX_CONNECTIONS`)
- **Types**: `PascalCase` (e.g., `type Status = ...`)
- **Enums**: `PascalCase` for enum, `PascalCase` for members

### Error Handling
- **Create custom error classes** extending `Error`
- **Use `Result<T, E>` type** for operations that can fail
- **Never throw in constructors** — use factory methods instead
- **Use `try/catch` with typed errors**

```typescript
class DomainError extends Error {
    constructor(message: string, public readonly code: string) {
        super(message);
        this.name = 'DomainError';
    }
}

class ValidationError extends DomainError {
    constructor(message: string, public readonly field: string) {
        super(message, 'VALIDATION_ERROR');
    }
}

// Result type for error handling
type Result<T, E = Error> =
    | { success: true; data: T }
    | { success: false; error: E };

async function fetchUser(id: string): Promise<Result<User, DomainError>> {
    try {
        const response = await fetch(`/api/users/${id}`);
        if (!response.ok) {
            return { success: false, error: new DomainError('Not found', 'NOT_FOUND') };
        }
        const data: unknown = await response.json();
        if (!isUser(data)) {
            return { success: false, error: new ValidationError('Invalid user data', 'data') };
        }
        return { success: true, data };
    } catch (error) {
        return { success: false, error: new DomainError('Network error', 'NETWORK') };
    }
}
```

### Testing with Vitest
```typescript
import { describe, test, expect } from 'vitest';
import { UserService } from '../src/services/UserService.js';

describe('UserService', () => {
    describe('getUser', () => {
        test('should return user when found', async () => {
            const service = new UserService(mockRepo);
            const result = await service.getUser('123');
            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data.name).toBe('Alice');
            }
        });
    });
});
```

---

## Phase 4 — Verification & Build

### Type check
```powershell
npx tsc --noEmit          # Type check without emitting
npx tsc                   # Compile to dist/
```

### Lint and format
```powershell
npx eslint src/ --fix
npx prettier --write src/
```

### Test
```powershell
npx vitest                # Run tests
npx vitest run            # Run once (no watch)
npx vitest --coverage     # With coverage
```

### Run
```powershell
npx tsx src/index.ts      # Run directly (no compilation)
node dist/index.js        # Run compiled output
```

---

## Phase 5 — Quick Reference

| Practice | Why |
|---|---|
| `strict: true` | Catch errors at compile time |
| `unknown` over `any` | Force type narrowing |
| `satisfies` operator | Type check without widening |
| `as const` | Literal type inference |
| Branded types | Domain type safety |
| Discriminated unions | Type-safe state machines |
| `using` declarations | Automatic resource disposal |
| `const` type parameters | Prevent inference widening |
| No `I` prefix on interfaces | Modern convention |
| `Result<T, E>` type | Explicit error handling |
| `tsx` for execution | No compilation step |
| `noUncheckedIndexedAccess` | Safe array access |

---

## Rules
- Always detect the environment before suggesting installation.
- Use `run_shell` for all commands — verify each succeeds before continuing.
- Read existing project files before suggesting changes.
- Always enable `strict: true` in tsconfig.json.
- Never use `any` — use `unknown` with type narrowing instead.
- Use `satisfies` for type checking without widening.
- Use discriminated unions for state management.
- Use branded types for domain IDs to prevent mix-ups.
- Run `tsc --noEmit` and ESLint after making changes.
- Use `tsx` for development execution — no need to compile first.

## Output
1. Environment status report
2. Installation/fix steps (if needed)
3. Project scaffold (if requested)
4. Code with modern TypeScript patterns applied
5. Type check, lint, and test verification