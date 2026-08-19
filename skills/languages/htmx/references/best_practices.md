# HTMX Engineering Reference & Deep Best Practices

## 1. Response Partial Isolation
- Design backend routes to return lightweight HTML fragments when `HX-Request` header is present.

## 2. Event Hooks
- Intercept HTMX events in JS: `document.body.addEventListener('htmx:afterSwap', (e) => { ... })`.
