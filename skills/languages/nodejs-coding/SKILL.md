---
name: nodejs-coding
command: /nodejs
description: Node.js environment setup, syntax rules, best practices, and project scaffolding.
---

# Node.js Coding Skill

## Purpose
Guide the user through Node.js environment detection, installation, project scaffolding, ES Modules, architecture patterns, and best practices.

## When to use
Use this skill when the user runs:

/nodejs [subcommand]

Subcommands:
- (none) — Detect Node.js environment, report status, and offer to fix issues
- new <project-name> — Scaffold a new Node.js project
- check — Scan current project for env issues and best practice violations
- help — Show this help

---

## Phase 1 — Environment Detection & Installation

### Step 1: Detect existing Node.js installation
Use `run_shell` to check:
```powershell
node --version
npm --version
where npx
where pnpm
where yarn
where bun
```

Check for version managers:
```powershell
where fnm
where nvm
where volta
```

### Step 2: Report status
- ✅ / ❌ Node.js (LTS recommended — v22 or v24)
- ✅ / ❌ npm
- ✅ / ❌ pnpm (optional, faster)
- ✅ / ❌ Version manager (fnm/nvm/volta)

### Step 3: Install Node.js if missing

**Windows (recommended — use a version manager):**
```powershell
# Option A: fnm (fast, recommended)
winget install Schniz.fnm
fnm install --lts
fnm use lts-latest

# Option B: nvm-windows
winget install CoreyButler.NVMforWindows
nvm install lts
nvm use lts

# Option C: Official installer
# Download from https://nodejs.org/ and run the MSI installer
```

**Linux:**
```bash
# Using fnm
curl -fsSL https://fnm.vercel.app/install | bash
fnm install --lts

# Using nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash
nvm install --lts
```

**macOS:**
```bash
brew install node@22
# OR
brew install fnm && fnm install --lts
```

### Step 4: Install useful global tools
```powershell
npm install -g pnpm           # Faster package manager
npm install -g eslint         # Linter
npm install -g prettier       # Formatter
npm install -g typescript     # TypeScript compiler
npm install -g tsx            # TypeScript execution
npm install -g pm2           # Process manager for production
```

### Step 5: Verify
```powershell
node --version
npm --version
pnpm --version
npx eslint --version
```

---

## Phase 2 — Project Scaffolding

### Option A: Basic Node.js project (ES Modules)
```powershell
mkdir my-project
cd my-project
npm init -y
```

Set `"type": "module"` in package.json for ES Modules:
```json
{
  "name": "my-project",
  "version": "1.0.0",
  "type": "module",
  "engines": {
    "node": ">=22.0.0"
  },
  "scripts": {
    "start": "node src/index.js",
    "dev": "node --watch src/index.js",
    "test": "node --test",
    "lint": "eslint src/",
    "format": "prettier --write src/"
  }
}
```

### Standard project structure (component-based)
```
my-project/
├── package.json
├── src/
│   ├── index.js              # Entry point
│   ├── config/
│   │   └── index.js          # Configuration
│   ├── components/
│   │   ├── users/
│   │   │   ├── users.router.js
│   │   │   ├── users.service.js
│   │   │   └── users.model.js
│   │   └── orders/
│   │       ├── orders.router.js
│   │       ├── orders.service.js
│   │       └── orders.model.js
│   ├── middleware/
│   │   ├── auth.js
│   │   └── error-handler.js
│   └── utils/
│       └── logger.js
├── tests/
│   ├── users.test.js
│   └── orders.test.js
├── .env
├── .eslintrc.json
├── .prettierrc
└── .gitignore
```

### Option B: Express API project
```powershell
mkdir my-api
cd my-api
npm init -y
npm install express
npm install --save-dev eslint prettier
```

### Option C: Fastify project (faster alternative)
```powershell
npm init -y
npm install fastify
```

### Option D: TypeScript project
```powershell
npm init -y
npm install typescript @types/node --save-dev
npx tsc --init
# Set "type": "module" in package.json
# Set "module": "ESNext" and "moduleResolution": "bundler" in tsconfig.json
```

---

## Phase 3 — Syntax Rules & Best Practices

### ES Modules (modern standard)
- **Use ES Modules** (`import`/`export`) — not CommonJS (`require`)
- **Set `"type": "module"`** in package.json
- **Use `node:` protocol** for built-in modules
- **Use `.js` extension** in imports (even for TypeScript)

```javascript
// ✅ ES Modules with node: protocol
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:http';

// Named exports
export function processData(data) { ... }
export const config = { ... };

// Default export
export default class UserService { ... }

// Dynamic import (code splitting)
const module = await import('./heavy-module.js');
```

### Use `const` and `let` — Never `var`
- **`const`** for values that don't get reassigned (default choice)
- **`let`** for values that need reassignment
- **Never use `var`** — it has function scope, not block scope

### Async/Await
- **Use `async`/`await`** — not callback chains or raw `.then()`
- **Always handle errors** with `try/catch`
- **Always await promises before returning** — avoid partial stack traces
- **Use `Promise.all()` for concurrent operations**

```javascript
// ✅ Good — async/await with error handling
async function fetchUser(id) {
    try {
        const response = await fetch(`/api/users/${id}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.json();
    } catch (error) {
        logger.error('Failed to fetch user:', error);
        throw error;
    }
}

// ✅ Concurrent operations
async function fetchDashboard() {
    const [user, posts, notifications] = await Promise.all([
        fetchUser(userId),
        fetchPosts(userId),
        fetchNotifications(userId),
    ]);
    return { user, posts, notifications };
}
```

### Error Handling
- **Extend the built-in `Error` object** with custom error classes
- **Distinguish operational vs programmer errors**
- **Handle errors centrally** — not scattered across middleware
- **Catch unhandled promise rejections** — `process.on('unhandledRejection')`
- **Catch uncaught exceptions** — `process.on('uncaughtException')`
- **Exit gracefully** on unknown errors

```javascript
// Custom error classes
class AppError extends Error {
    constructor(message, statusCode) {
        super(message);
        this.statusCode = statusCode;
        this.isOperational = true;
        Error.captureStackTrace(this, this.constructor);
    }
}

class ValidationError extends AppError {
    constructor(message) {
        super(message, 400);
    }
}

class NotFoundError extends AppError {
    constructor(message) {
        super(message, 404);
    }
}

// Central error handler
function errorHandler(error, req, res, next) {
    if (error.isOperational) {
        res.status(error.statusCode).json({ error: error.message });
    } else {
        logger.error('Unexpected error:', error);
        res.status(500).json({ error: 'Internal server error' });
        process.exit(1);  // Exit on unknown errors
    }
}

// Global error handlers
process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled Rejection:', reason);
    process.exit(1);
});

process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception:', error);
    process.exit(1);
});
```

### Architecture — Component-Based Structure
- **Structure by business components** — not by technical role
- **Each component has its own router, service, and model**
- **Layer your components** — web layer → service layer → data layer
- **Keep the web layer thin** — routing and HTTP concerns only
- **Business logic in the service layer** — not in controllers

```javascript
// components/users/users.router.js
import { Router } from 'express';
import { UserService } from './users.service.js';

const router = Router();
const userService = new UserService();

router.get('/', async (req, res, next) => {
    try {
        const users = await userService.getAll();
        res.json(users);
    } catch (error) {
        next(error);
    }
});

router.get('/:id', async (req, res, next) => {
    try {
        const user = await userService.getById(req.params.id);
        if (!user) return res.status(404).json({ error: 'User not found' });
        res.json(user);
    } catch (error) {
        next(error);
    }
});

export default router;

// components/users/users.service.js
export class UserService {
    async getAll() {
        // Business logic here
    }

    async getById(id) {
        // Business logic here
    }
}
```

### Configuration Management
- **Use environment variables** — not hardcoded values
- **Use hierarchical config** — default → environment → local
- **Never commit secrets** to version control
- **Use `dotenv`** for local development

```javascript
// config/index.js
import { config } from 'dotenv';

config();

export const appConfig = {
    port: process.env.PORT || 3000,
    nodeEnv: process.env.NODE_ENV || 'development',
    database: {
        url: process.env.DATABASE_URL,
        poolSize: parseInt(process.env.DB_POOL_SIZE || '10'),
    },
    jwt: {
        secret: process.env.JWT_SECRET,
        expiresIn: process.env.JWT_EXPIRES_IN || '1d',
    },
};
```

### Security Best Practices
- **Never use `eval()`** — it can execute arbitrary code
- **Use `bcrypt` or `scrypt`** for password hashing — never store plain text
- **Validate all incoming data** — use JSON schema validation
- **Set security headers** — use `helmet` middleware
- **Limit request body size** — prevent DoS attacks
- **Use `node:` protocol** for built-in imports — prevents shadowing
- **Run as non-root user** in production
- **Inspect for vulnerable dependencies** — `npm audit`

```javascript
import bcrypt from 'bcrypt';
import helmet from 'helmet';

// Password hashing
const hashedPassword = await bcrypt.hash(password, 12);
const isValid = await bcrypt.compare(inputPassword, hashedPassword);

// Security headers
app.use(helmet());

// Input validation
import { validate } from 'jsonschema';

function validateInput(schema) {
    return (req, res, next) => {
        const result = validate(req.body, schema);
        if (!result.valid) {
            return res.status(400).json({ errors: result.errors });
        }
        next();
    };
}
```

### Logging
- **Use a mature logger** — not `console.log`
- **Log to stdout** — let the platform handle log destinations
- **Include request IDs** for tracing
- **Use structured logging** (JSON format)

```javascript
import pino from 'pino';

const logger = pino({
    level: process.env.LOG_LEVEL || 'info',
    transport: process.env.NODE_ENV === 'development' ? {
        target: 'pino-pretty',
    } : undefined,
});

// Structured logging
logger.info({ userId, action: 'login' }, 'User logged in');
logger.error({ error: error.message, stack: error.stack }, 'Operation failed');
```

### Testing
- **Use the built-in test runner** (`node --test`) or `vitest`
- **Structure tests by AAA pattern** — Arrange, Act, Assert
- **Test all five outcomes** — success, expected error, edge case, null/empty, exception
- **Mock external HTTP services** — don't hit real APIs in tests
- **Use `npm ci`** for CI installs — deterministic, faster

```javascript
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { UserService } from '../src/components/users/users.service.js';

describe('UserService', () => {
    describe('getById', () => {
        test('should return user when found', async () => {
            // Arrange
            const service = new UserService();
            const userId = '123';

            // Act
            const user = await service.getById(userId);

            // Assert
            assert.equal(user.id, userId);
            assert.ok(user.name);
        });

        test('should return null when not found', async () => {
            const service = new UserService();
            const user = await service.getById('nonexistent');
            assert.equal(user, null);
        });
    });
});
```

### Performance
- **Don't block the event loop** — offload CPU-heavy work to worker threads
- **Use streaming** for large data — `node:stream`
- **Prefer native JS methods** over utility libraries like Lodash
- **Use `Promise.all()` for concurrent I/O** — not sequential awaits
- **Utilize all CPU cores** — use `cluster` or `worker_threads`

```javascript
import { Worker } from 'node:worker_threads';

// Offload CPU-heavy work
function heavyComputation(data) {
    return new Promise((resolve, reject) => {
        const worker = new Worker('./worker.js', {
            workerData: data,
        });
        worker.on('message', resolve);
        worker.on('error', reject);
        worker.on('exit', (code) => {
            if (code !== 0) reject(new Error(`Worker exited with code ${code}`));
        });
    });
}
```

---

## Phase 4 — Verification & Build

### Lint and format
```powershell
npx eslint src/ --fix
npx prettier --write src/
```

### Test
```powershell
node --test                    # Built-in test runner
npm test                       # Custom test command
npm run test:coverage          # With coverage
```

### Security audit
```powershell
npm audit                      # Check for vulnerabilities
npm audit fix                  # Auto-fix vulnerabilities
```

### Run
```powershell
node src/index.js              # Run
node --watch src/index.js      # Dev mode with auto-reload
NODE_ENV=production node src/index.js  # Production
```

---

## Phase 5 — Quick Reference

| Practice | Why |
|---|---|
| ES Modules (`import`/`export`) | Modern standard, tree-shakeable |
| `node:` protocol for built-ins | Prevents shadowing, explicit |
| `const`/`let` over `var` | Block scoping |
| `async`/`await` | Readable async code |
| Custom error classes | Structured error handling |
| Component-based structure | Modular, maintainable |
| `helmet` for security headers | Web security defaults |
| `bcrypt`/`scrypt` for passwords | Secure hashing |
| `pino` for logging | Fast, structured logging |
| `npm ci` for CI installs | Deterministic, faster |
| `NODE_ENV=production` | Enables optimizations |
| LTS Node.js version | Stability, security patches |

---

## Rules
- Always detect the environment before suggesting installation.
- Use `run_shell` for all commands — verify each succeeds before continuing.
- Read existing project files before suggesting changes.
- Use ES Modules (`import`/`export`) — not CommonJS (`require`).
- Always use `node:` protocol for built-in module imports.
- Never use `var` — use `const` or `let`.
- Never use `eval()` — it can execute arbitrary code.
- Always handle async errors with `try/catch`.
- Structure by business components — not by technical role.
- Use `NODE_ENV=production` in production environments.
- Run `npm audit` and ESLint after making changes.
- Use an LTS version of Node.js for production.

## Output
1. Environment status report
2. Installation/fix steps (if needed)
3. Project scaffold (if requested)
4. Code with modern Node.js patterns applied
5. Lint, test, and security audit verification