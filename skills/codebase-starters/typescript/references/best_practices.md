# TypeScript Engineering Reference & Deep Best Practices

## 1. Type Narrowing Guards
- Write custom predicate functions: `function isRecord(val: unknown): val is Record<string, unknown>`.

## 2. Conditional & Mapped Types
- Use mapped type modifiers (`-readonly`, `[K in keyof T]`) for state transformations.

## 3. Library Bundling
- Use `tsup` or `vite` library mode to output both ESM (`.mjs`) and CommonJS (`.cjs`) with declarations (`.d.ts`).
