---
name: truescript
description: >-
  Runtime contract specification, strict invariant assertions, zero-any static typing, non-nullable schema verification, and harness verification for TrueScript engineering.
---

# TrueScript Contract & Engineering Skill

Operational guide, architecture starter, best practices, and harness controls for TrueScript — the runtime-verified contract specification pattern for AI agents and mission-critical systems.

## 1. Stack Overview & Dependencies
- **Core Paradigm**: Static TypeScript + Mandatory Runtime Invariant Guards (`zod`, `valibot`, or native `TrueContract` guards).
- **Type Rigor**: Zero `any`, zero implicit casting, mandatory non-null assertion handling, branded types.
- **Tools & Compilers**: `tsc` (with `--strict --noImplicitAny --exactOptionalPropertyTypes --noUncheckedIndexedAccess`), `tsx`, `vitest`.

## 2. Standard Codebase Structure
```text
truescript-system/
├── tsconfig.json
├── package.json
├── src/
│   ├── contracts/
│   │   ├── DomainContracts.ts
│   │   └── Invariants.ts
│   ├── services/
│   │   └── ContractEngine.ts
│   └── index.ts
└── tests/
    └── Contracts.test.ts
```

## 3. How-To Workflows

### Type Checking & Contract Validation
```bash
npx tsc --noEmit
```

### Dev Execution with Contract Enforcement
```bash
npx tsx src/index.ts
```

### Verification & Testing
```bash
npx vitest run
```

## 4. Best Practices & Design Patterns
1. **Branded Types for Identifiers**: Use nominal branding (`type UserId = string & { readonly __brand: unique symbol }`) to prevent passing arbitrary strings where a specific ID is required.
2. **Pre-condition & Post-condition Invariants**: Every public function must validate input preconditions and output postconditions using explicit assertion functions (`assertInvariant()`).
3. **Exhaustive Pattern Matching**: Enforce compile-time exhaustiveness checks on union types using `never` fallback switches.
4. **Immutable State Records**: Use `Readonly<T>` and `ReadonlyArray<T>` across all contract boundaries.
5. **No Silent Fallbacks**: If data fails a contract check, throw a `ContractViolationError` immediately with full payload state details.

## 5. Tips, Tricks & Pitfalls
- **Unchecked Index Access**: Enable `noUncheckedIndexedAccess` in `tsconfig.json` so accessing array or object index `arr[i]` returns `T | undefined`.
- **Zod Schema Pre-parsing**: Parse untrusted network or agent JSON through Zod schemas before touching any internal method.

## 6. Harness Hooks & Safety Enforcement
- **PreToolUse Guard**: Enforce strict `tsc` checks on code files before permitting execution.
- **PostToolUse Verification**: Verify no contract assertions failed during test runs.
