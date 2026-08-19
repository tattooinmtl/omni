---
name: typescript
description: >-
  Production TypeScript 5.x codebase starter, strict mode, ESM, Node/Browser target, Zod, Vitest, ESLint TypeScript, and harness verification.
---

# TypeScript Codebase & Engineering Skill

Comprehensive operational guide, starter architecture, best practices, and harness controls for modern TypeScript engineering.

## 1. Stack Overview & Dependencies
- **Compiler**: TypeScript 5.4+ (`tsc`)
- **Execution Runners**: `tsx` (fast Node dev runner), `vitest` (fast testing)
- **Module Resolution**: `NodeNext` or `Bundler`
- **Core Dependencies**:
  - `zod`: Type inference & runtime parsing
  - `vitest`: Testing framework
  - `@typescript-eslint/eslint-plugin`: Type-aware static analysis
  - `prettier`: Formatter

## 2. Standard Codebase Structure
```text
typescript-project/
├── tsconfig.json
├── package.json
├── README.md
├── src/
│   ├── index.ts
│   ├── config.ts
│   ├── models/
│   └── services/
└── tests/
    └── index.test.ts
```

## 3. How-To Workflows

### Type Checking & Compilation
```bash
npx tsc --noEmit
npx tsc -p tsconfig.json
```

### Dev Execution
```bash
npx tsx src/index.ts
```

### Formatting & Linting
```bash
npx eslint src/ --ext .ts
npx prettier --check src/
```

### Testing & Verification
```bash
npx vitest run
```

## 4. Best Practices & Design Patterns
1. **Strict Compiler Settings**: Set `"strict": true`, `"noImplicitReturns": true`, `"noFallthroughCasesInSwitch": true`, `"noUnusedLocals": true`.
2. **Discriminated Unions**: Use tag fields (`type: 'success' | 'error'`) for pattern-matchable Result and State types.
3. **Zod Type Inference**: Define schemas with Zod and derive TS types (`type User = z.infer<typeof UserSchema>`).
4. **Utility Types**: Leverage `Readonly`, `Partial`, `Required`, `Pick`, `Omit`, `Record`, `ReturnType`.
5. **ESM Imports**: Include extension `.js` in relative imports when using `NodeNext` module resolution.

## 5. Tips, Tricks & Pitfalls
- **Avoid `any`**: Use `unknown` for values of uncertain type; narrow with type guards (`typeof`, `instanceof`, or custom type predicate `fn(x): x is T`).
- **Enums vs Const Assertion**: Prefer `const OBJ = { ... } as const` or union types over TS numeric enums.
- **Type Guards**: Write explicit `isUser(val: unknown): val is User` for complex objects.

## 6. Harness Hooks & Safety Enforcement
- **PreToolUse Guard**: Run type check before allowing build execution.
- **PostToolUse Verification**: Trigger `npx vitest` automatically after TS file updates.
