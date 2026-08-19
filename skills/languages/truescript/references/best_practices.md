# TrueScript Engineering Reference & Deep Best Practices

## 1. Type Branding & Domain Integrity
- Prevent primitive obsession by branding raw `string` and `number` types.

## 2. Invariant Assertion Layer
- Place precondition check functions at entry points of all state-mutating methods.
- Place postcondition assertions immediately prior to returning values to callers.
