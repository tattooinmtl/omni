---
name: jsx-react
description: >-
  Production React 18/19 JSX codebase starter, Vite, Custom Hooks, Context API, Tailwind/CSS Modules, ESLint React Hooks, Vitest, and harness verification.
---

# JSX & React Codebase Skill

Comprehensive operational guide, starter architecture, best practices, and harness controls for React 18/19 and JSX component engineering.

## 1. Stack Overview & Dependencies
- **Core Library**: React 18 / React 19 (`react`, `react-dom`)
- **Build Tool**: `vite` (`@vitejs/plugin-react`)
- **Routing & State**: `react-router-dom` v6+, TanStack Query (`@tanstack/react-query`), Zustand / Context API
- **Tooling**: `eslint-plugin-react-hooks`, `eslint-plugin-react-refresh`, `vitest`, `@testing-library/react`

## 2. Standard Codebase Structure
```text
react-jsx-app/
├── index.html
├── vite.config.js
├── package.json
├── README.md
├── src/
│   ├── main.jsx
│   ├── App.jsx
│   ├── components/
│   │   └── Card.jsx
│   ├── hooks/
│   │   └── usePipeline.js
│   └── context/
│       └── AppContext.jsx
└── tests/
    └── App.test.jsx
```

## 3. How-To Workflows

### Initialize & Run Local Dev Server
```bash
npm run dev
# Or using Vite directly
npx vite
```

### Build Production Bundle
```bash
npx vite build
```

### Static Analysis & Formatting
```bash
npx eslint src/ --ext .jsx,.js
npx prettier --check src/
```

### Testing & Verification
```bash
npx vitest run
```

## 4. Best Practices & Design Patterns
1. **Component Decomposition**: Keep components small, focused, and pure. Extract complex logic into custom hooks (`useFeature()`).
2. **Key Prop Discipline**: Always pass unique keys (`key={item.id}`) when rendering arrays; never use array index as key when items can be reordered/deleted.
3. **Immutability in State Updates**: Use functional state updates (`setItems(prev => [...prev, newItem])`) to prevent state stale closures.
4. **Custom Hooks Isolation**: Encapsulate async API calls and side-effects inside custom hooks rather than directly in render functions.
5. **Memoization Safety**: Use `useMemo` and `useCallback` deliberately for expensive computations or reference equality in dependency arrays.

## 5. Tips, Tricks & Pitfalls
- **React Hooks Rules**: Never call hooks conditionally inside `if` statements or loops.
- **Strict Mode Double Invocation**: Remember `React.StrictMode` intentionally double-invokes effects in dev to surface side-effect bugs.
- **Uncontrolled vs Controlled Components**: Explicitly manage form input state via `value` and `onChange` or use `useRef` for uncontrolled elements.

## 6. Harness Hooks & Safety Enforcement
- **PreToolUse Guard**: Validate JSX syntax and hook rules before triggering production build.
- **PostToolUse Verification**: Trigger `eslint-plugin-react-hooks` and Vitest component tests automatically.
