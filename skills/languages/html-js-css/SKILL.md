---
name: html-js-css
description: >-
  Production web frontend trilogy (HTML5 semantic structure, modern Vanilla CSS with CSS variables/Flexbox/Grid/glassmorphism, ES Next Javascript), accessibility (a11y), responsive design, and harness verification.
---

# Web Frontend Trilogy (HTML5, Vanilla CSS, JS) Skill

Comprehensive operational guide, starter architecture, best practices, and harness controls for web frontend engineering without external heavy framework lock-in.

## 1. Stack Overview & Dependencies
- **Core Triad**: HTML5 (Semantic Markup), Vanilla CSS3 (Custom Properties & Modern Layouts), ES2024 Javascript (Vanilla Modules)
- **Dev Tools & Tooling**:
  - `vite` or `light-server` / `live-server` (Zero-config dev server)
  - `stylelint` (CSS linting)
  - `eslint` (JS linting)
  - `html-validate` (HTML validator)
  - Google Lighthouse & Accessibility CLI

## 2. Standard Codebase Structure
```text
web-frontend/
├── index.html
├── favicon.ico
├── css/
│   ├── main.css
│   ├── variables.css
│   └── components.css
├── js/
│   ├── app.js
│   ├── components/
│   └── utils/
└── assets/
    └── images/
```

## 3. How-To Workflows

### Serve Local Dev Server
```bash
# Using Vite
npx vite .

# Or using simple static server
npx serve .
```

### Formatting & Linting
```bash
# Lint JS, CSS, and HTML
npx eslint js/
npx stylelint "css/**/*.css"
npx html-validate index.html
```

### Production Build / Bundling
```bash
npx vite build
```

## 4. Best Practices & Design Patterns
1. **Semantic HTML5**: Use `<header>`, `<nav>`, `<main>`, `<article>`, `<section>`, `<footer>`. Ensure `alt` tags on images and proper `aria-*` attributes.
2. **CSS Custom Properties (Variables)**: Define design system tokens (`--primary-color`, `--bg-dark`, `--spacing-md`, `--radius-lg`) at `:root`.
3. **Responsive Grid & Flexbox**: Mobile-first media queries (`@media (min-width: 768px)`). Avoid hardcoded container pixel widths.
4. **Modern Glassmorphism & Animations**: Use `backdrop-filter: blur()`, CSS transitions (`transition: all 0.3s ease`), and GPU-accelerated transforms.
5. **ES Modules (`type="module"`)**: Import/export modular JS functions cleanly without polluting `window` global namespace.

## 5. Tips, Tricks & Pitfalls
- **DOM Mutation Safety**: Use `querySelector` safely; check element presence before binding listeners.
- **Event Delegation**: Attach listeners to parent containers for dynamic child items instead of rebinding per item.
- **Performance**: Use `loading="lazy"` on images, `defer` or `type="module"` on scripts, and preconnect font hosts.

## 6. Harness Hooks & Safety Enforcement
- **PreToolUse Guard**: Validate CSS syntax before injection.
- **PostToolUse Verification**: Run `html-validate` and Lighthouse CLI audits automatically.
