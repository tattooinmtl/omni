# JSX & React Engineering Reference & Deep Best Practices

## 1. Performance Optimization
- Wrap heavy components with `React.memo()`.
- Use `useCallback` for event handler references passed down to memoized children.

## 2. Server Components (RSC) vs Client Components
- Mark client components with `'use client'` at file top when using Next.js 14+ / Remix / Waku.
