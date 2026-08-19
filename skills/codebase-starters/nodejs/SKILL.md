---
name: nodejs
description: >-
  Production Node.js 20/22 LTS server starter, ES modules, Express/Fastify, async handling, pino logging, Vitest/Jest, and harness verification for Node.js backend engineering.
---

# Node.js Codebase & Engineering Skill

Comprehensive operational guide, starter architecture, best practices, and harness controls for Node.js backend runtime engineering.

## 1. Stack Overview & Dependencies
- **Runtime**: Node.js 20 LTS / Node.js 22 LTS
- **Module Format**: ECMAScript Modules (`"type": "module"`)
- **Package Managers**: `npm`, `pnpm`, or `yarn`
- **Core Dependencies**:
  - `express` or `fastify`: High-performance HTTP web framework
  - `pino`: Zero-overhead JSON logger
  - `zod`: Type-safe schema validation
  - `dotenv` / `node:env`: Environment variable management
  - `vitest` / `jest`: Test runner & assertion framework
  - `eslint` & `prettier`: Static linting and code formatting

## 2. Standard Codebase Structure
```text
nodejs-server/
├── package.json
├── package-lock.json
├── README.md
├── src/
│   ├── server.js
│   ├── config.js
│   ├── routes/
│   │   └── api.js
│   └── middleware/
│       ├── errorHandler.js
│       └── logger.js
└── tests/
    └── server.test.js
```

## 3. How-To Workflows

### Install Dependencies
```bash
npm ci
```

### Dev Mode with Hot Reload
```bash
# Node 18.11+ built-in watch mode
node --watch src/server.js
```

### Code Quality & Formatting
```bash
npm run lint
npm run format
```

### Testing & Verification
```bash
npx vitest run
```

## 4. Best Practices & Design Patterns
1. **Async / Await Error Propagation**: Wrap async express routes or use `express-async-errors` / Fastify built-in async handler so unhandled rejections don't crash the event loop silently.
2. **Graceful Shutdown**: Listen for `SIGTERM` and `SIGINT` signals, stop accepting new requests, close database pools, and call `server.close()`.
3. **Structured JSON Logging**: Use `pino` instead of `console.log` for machine-readable JSON logs with trace IDs.
4. **Environment Schema Validation**: Validate process env variables at startup with `zod` schema to fail fast if required keys are missing.
5. **Non-Blocking Event Loop**: Never execute CPU-heavy sync computations on the main loop thread; delegate to `node:worker_threads`.

## 5. Tips, Tricks & Pitfalls
- **Unhandled Rejections**: Always set `process.on('unhandledRejection')` and `process.on('uncaughtException')`.
- **Stream Memory Usage**: Use `node:stream/promises` (`pipeline`) for file downloads/uploads instead of buffering full buffers into RAM.
- **Node Built-in Modules**: Prefer `node:fs/promises`, `node:path`, `node:crypto`, `node:util`.

## 6. Harness Hooks & Safety Enforcement
- **PreToolUse Guard**: Block unsafe `npm publish` or deletion of `node_modules` outside target root.
- **PostToolUse Verification**: Trigger `npm test` automatically after code changes.
