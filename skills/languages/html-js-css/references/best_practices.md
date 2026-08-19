# Web Frontend Engineering Reference & Deep Best Practices

## 1. Web Accessibility (WCAG 2.1 AA)
- Provide sufficient color contrast ratios (≥ 4.5:1 for normal text).
- Ensure focus states are visible for keyboard navigation (`:focus-visible`).

## 2. CSS Architecture
- Avoid deeply nested selectors (`.card .title p span`).
- Use CSS container queries (`@container`) for component-level responsiveness.

## 3. Security
- Sanitize dynamic innerHTML to prevent XSS attacks.
- Set Content Security Policy (CSP) headers in host config.
