---
name: web-coding
command: /web
description: HTML, CSS, JavaScript environment setup, syntax rules, best practices, and project scaffolding.
---

# Web Coding Skill (HTML / CSS / JavaScript)

## Purpose
Guide the user through web development environment detection, installation, project scaffolding, modern HTML/CSS/JS best practices, and performance/accessibility standards.

## When to use
Use this skill when the user runs:

/web [subcommand]

Subcommands:
- (none) — Detect web dev environment (Node.js, npm, browser, etc.), report status, offer to fix
- new <project-name> — Scaffold a new web project (vanilla or framework)
- check — Scan current project for issues (lint, a11y, performance)
- help — Show this help

---

## Phase 1 — Environment Detection & Installation

### Step 1: Detect existing installation
Use `run_shell` to check:
```powershell
node --version
npm --version
where npx
```

Also check for alternative package managers and tools:
```powershell
where pnpm
where yarn
where bun
where deno
```

Check for a code editor / browser:
```powershell
where code        # VS Code
where chrome      # Chrome
where firefox     # Firefox
```

### Step 2: Report status
- ✅ / ❌ Node.js (LTS recommended)
- ✅ / ❌ npm
- ✅ / ❌ pnpm (optional, faster)
- ✅ / ❌ VS Code
- ✅ / ❌ Modern browser

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
npm install -g pnpm
npm install -g serve           # Static file server
npm install -g eslint         # Linter
npm install -g prettier        # Formatter
npm install -g typescript      # TypeScript compiler (optional)
npm install -g @anthropic-ai/create-vite  # Vite scaffolding
```

### Step 5: Verify
```powershell
node --version
npm --version
pnpm --version
npx eslint --version
npx prettier --version
```

---

## Phase 2 — Project Scaffolding

### Option A: Vanilla HTML/CSS/JS project
```
my-web-project/
├── index.html
├── css/
│   ├── reset.css
│   └── styles.css
├── js/
│   ├── main.js
│   └── utils.js
├── assets/
│   ├── images/
│   └── fonts/
└── package.json
```

Create with:
```powershell
mkdir my-web-project
cd my-web-project
npm init -y
# Add scripts to package.json:
# "dev": "serve .",
# "build": "parcel build index.html"
```

### Option B: Vite project (modern, fast)
```powershell
npm create vite@latest my-web-project -- --template vanilla
cd my-web-project
npm install
npm run dev
```

Templates: `vanilla`, `vue`, `react`, `preact`, `lit`, `svelte`

### Option C: Framework project
```powershell
# Next.js (React)
npx create-next-app@latest my-project

# Astro (partial hydration, islands)
npm create astro@latest

# SvelteKit
npm create svelte@latest my-project
```

---

## Phase 3 — HTML Best Practices

### Semantic HTML
- **Use semantic elements** — `<header>`, `<nav>`, `<main>`, `<article>`, `<section>`, `<aside>`, `<footer>`
- **Avoid `<div>` soup** — use the right element for the job
- **Use `<dialog>` element** for modals (native, accessible)
- **Use `<details>` / `<summary>`** for accordions (native, no JS needed)
- **Use `<picture>`** for responsive images with modern formats

```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="description" content="Page description">
    <title>Page Title</title>
    <link rel="preload" href="/fonts/main.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="stylesheet" href="/css/styles.css">
</head>
<body>
    <header>
        <nav aria-label="Main navigation">
            <ul>
                <li><a href="/" aria-current="page">Home</a></li>
            </ul>
        </nav>
    </header>
    <main>
        <article>
            <h1>Article Title</h1>
            <p>Content...</p>
        </article>
        <aside aria-label="Sidebar">
            <p>Related content</p>
        </aside>
    </main>
    <footer>
        <p>&copy; 2026</p>
    </footer>
</body>
</html>
```

### Responsive Images
```html
<picture>
    <source srcset="/images/hero.avif" type="image/avif">
    <source srcset="/images/hero.webp" type="image/webp">
    <img src="/images/hero.jpg" alt="Hero image" width="1200" height="600" loading="lazy">
</picture>
```

### Accessibility (a11y)
- **Always include `alt` text** on images
- **Use `aria-label`** when text is not visible
- **Use `aria-current="page"`** for current navigation items
- **Ensure keyboard navigation** works for all interactive elements
- **Use `lang` attribute** on `<html>`
- **Provide `prefers-reduced-motion`** support
- **Maintain color contrast** — WCAG AA minimum (4.5:1 for normal text)

---

## Phase 4 — CSS Best Practices

### Modern CSS Features (2025/2026)
- **CSS Container Queries** — responsive design based on container size, not viewport
- **CSS Subgrid** — nested grids that inherit parent grid
- **CSS Nesting** — native nesting without preprocessors
- **`:has()` selector** — parent selector
- **CSS Custom Properties (variables)** — for theming
- **`color-mix()`** — blend colors in CSS
- **Logical properties** — `margin-inline`, `padding-block` for RTL support

```css
/* CSS Custom Properties */
:root {
    --color-primary: #0066cc;
    --color-text: #1a1a1a;
    --color-bg: #ffffff;
    --spacing-unit: 0.5rem;
    --max-width: 1200px;
}

/* Container Queries */
.card-container {
    container-type: inline-size;
    container-name: card;
}

@container card (min-width: 400px) {
    .card {
        display: grid;
        grid-template-columns: 1fr 2fr;
    }
}

/* Native Nesting */
.navbar {
    padding: 1rem;

    & ul {
        display: flex;
        gap: 1rem;
        list-style: none;
    }

    & a {
        color: var(--color-primary);
        text-decoration: none;

        &:hover {
            text-decoration: underline;
        }
    }
}

/* :has() selector */
form:has(input[type="checkbox"]:checked) {
    border-color: green;
}

/* color-mix() */
.button {
    background: color-mix(in srgb, var(--color-primary) 80%, white);
}

/* prefers-reduced-motion */
@media (prefers-reduced-motion: reduce) {
    * {
        animation-duration: 0.01ms !important;
        transition-duration: 0.01ms !important;
    }
}
```

### CSS Organization
- **Use a reset/normalize** — start from a clean baseline
- **Mobile-first** — base styles for small screens, `min-width` media queries for larger
- **Use logical properties** — `margin-inline`, `padding-block` for internationalization
- **Avoid `!important`** — fix specificity issues instead
- **Use `clamp()`** for fluid typography
- **Prefer CSS Grid and Flexbox** — avoid floats for layout

```css
/* Fluid typography with clamp() */
h1 {
    font-size: clamp(1.5rem, 4vw, 3rem);
}

/* Mobile-first responsive */
.container {
    width: 100%;
    padding: 1rem;
}

@media (min-width: 768px) {
    .container {
        max-width: 720px;
        margin: 0 auto;
    }
}
```

---

## Phase 5 — JavaScript Best Practices

### Modern JavaScript (ES2025+)
- **Use `let` and `const`** — never `var`
- **Use arrow functions** for short callbacks
- **Use template literals** — backticks for string interpolation
- **Use destructuring** for objects and arrays
- **Use `async/await`** over `.then()` chains
- **Use optional chaining `?.`** and nullish coalescing `??`
- **Use ES Modules** — `import`/`export`, not CommonJS `require`
- **Use `Set` methods** — `union()`, `intersection()`, `difference()` (ES2025)
- **Use Iterator Helpers** — `.map()`, `.filter()`, `.take()` with lazy evaluation (ES2025)

```javascript
// ES Modules
import { fetchData } from './api.js';
export function processData(data) { ... }

// Destructuring
const { name, email } = user;
const [first, ...rest] = items;

// Optional chaining and nullish coalescing
const displayName = user?.profile?.name ?? 'Anonymous';

// Async/await
async function loadUser(id) {
    try {
        const response = await fetch(`/api/users/${id}`);
        if (!response.ok) throw new Error('Failed to fetch user');
        return await response.json();
    } catch (error) {
        console.error('Load user failed:', error);
        return null;
    }
}

// ES2025 Set methods
const activeUsers = new Set([1, 2, 3]);
const premiumUsers = new Set([2, 3, 4]);
const activePremium = activeUsers.intersection(premiumUsers); // Set {2, 3}
const allUsers = activeUsers.union(premiumUsers); // Set {1, 2, 3, 4}

// ES2025 Iterator Helpers (lazy evaluation)
function* naturals() {
    let i = 1;
    while (true) yield i++;
}
const result = naturals()
    .filter(x => x % 2 === 0)
    .take(5)
    .map(x => x * 2)
    .toArray(); // [4, 8, 12, 16, 20]
```

### Error Handling
- **Always handle errors** in async code — use `try/catch` with `async/await`
- **Check `response.ok`** before parsing `fetch` responses
- **Use `AbortController`** for cancellable fetch requests
- **Throw typed errors** with meaningful messages

```javascript
// AbortController for cancellable requests
const controller = new AbortController();
const timeoutId = setTimeout(() => controller.abort(), 5000);

try {
    const response = await fetch('/api/data', { signal: controller.signal });
    clearTimeout(timeoutId);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
} catch (error) {
    if (error.name === 'AbortError') {
        console.log('Request timed out');
    }
    throw error;
}
```

### DOM Best Practices
- **Use `querySelector` / `querySelectorAll`** — not `getElementById` etc.
- **Use event delegation** — one listener on a parent, not many on children
- **Use `classList`** — not `className` string manipulation
- **Use `data-*` attributes** for custom data
- **Use Web Components** for reusable elements

```javascript
// Event delegation
document.querySelector('#list').addEventListener('click', (e) => {
    const button = e.target.closest('button');
    if (!button) return;
    const id = button.dataset.id;
    handleAction(id);
});

// Web Component
class UserProfile extends HTMLElement {
    constructor() {
        super();
        this.attachShadow({ mode: 'open' });
    }
    connectedCallback() {
        const user = JSON.parse(this.getAttribute('user-data'));
        this.shadowRoot.innerHTML = `
            <style>
                .profile { border: 1px solid #ccc; padding: 1rem; }
            </style>
            <div class="profile">
                <h2>${user.name}</h2>
                <p>${user.bio}</p>
            </div>
        `;
    }
}
customElements.define('user-profile', UserProfile);
```

### Performance
- **Debounce/throttle** event handlers (scroll, resize, input)
- **Use `requestAnimationFrame`** for visual updates
- **Lazy load images** — `loading="lazy"` attribute
- **Code split** — dynamic `import()` for large dependencies
- **Minimize main thread work** — offload to Web Workers

```javascript
// Debounce
function debounce(fn, delay) {
    let timeoutId;
    return (...args) => {
        clearTimeout(timeoutId);
        timeoutId = setTimeout(() => fn(...args), delay);
    };
}

// Dynamic import (code splitting)
const module = await import('./heavy-module.js');

// Web Worker
const worker = new Worker('data-processor.js', { type: 'module' });
worker.postMessage({ data: largeDataSet });
worker.onmessage = (e) => updateUI(e.data);
```

---

## Phase 6 — Verification & Build

### Lint and format
```powershell
npx eslint . --fix
npx prettier --write .
```

### Build
```powershell
# Vite
npm run build
npm run preview

# Parcel
npx parcel build index.html

# Next.js
npm run build && npm start
```

### Test
```powershell
npm test                    # If configured
npx playwright test         # E2E tests
npx vitest                  # Unit tests
```

### Performance audit
```powershell
npx lighthouse http://localhost:3000 --view
```

---

## Phase 7 — Quick Reference

| Practice | Why |
|---|---|
| Semantic HTML | Accessibility, SEO, readability |
| `prefers-reduced-motion` | Accessibility for motion sensitivity |
| Container Queries | Responsive design based on container, not viewport |
| CSS Custom Properties | Theming, maintainability |
| `let`/`const` over `var` | Block scoping, no hoisting surprises |
| `async/await` | Readable async code |
| Optional chaining `?.` | Safe property access |
| ES Modules | Standard module system |
| Event delegation | Fewer listeners, better performance |
| `loading="lazy"` on images | Defer offscreen images |
| `AbortController` | Cancellable fetch requests |
| Web Components | Framework-agnostic reusable elements |

---

## Rules
- Always detect the environment before suggesting installation.
- Use `run_shell` for all commands — verify each succeeds before continuing.
- Read existing project files before suggesting changes.
- Always use semantic HTML elements over `<div>` when appropriate.
- Always include `alt` text on images and `aria-label` where needed.
- Use modern CSS features (container queries, nesting, custom properties).
- Never use `var` — use `let` or `const`.
- Always handle errors in async code — never leave a Promise unhandled.
- Run ESLint and Prettier after making changes.
- Prefer accessibility-first development — it's a default requirement, not an afterthought.

## Output
1. Environment status report
2. Installation/fix steps (if needed)
3. Project scaffold (if requested)
4. Code with modern best practices applied
5. Lint, build, and test verification