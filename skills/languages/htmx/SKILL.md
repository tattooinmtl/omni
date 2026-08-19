---
name: htmx
description: >-
  Production HTMX 1.9+/2.0 codebase starter, Hypermedia-Driven Applications (HDA), hx-attributes, server-driven UI partials, OOP/REST backend integration, and harness verification.
---

# HTMX Codebase & Engineering Skill

Operational guide, architecture starter, best practices, and harness controls for HTMX hypermedia-driven web applications.

## 1. Stack Overview & Dependencies
- **Core Library**: HTMX (CDN script `<script src="https://unpkg.com/htmx.org"></script>` or npm package `htmx.org`)
- **Supported Backend Stacks**: Go (`html/template`), Python (`Jinja2` / `FastAPI`), Node.js (`EJS` / `Handlebars`), PHP (`Twig` / `Blade`), Rust (`askama` / `maud`)
- **Extensions**: `htmx/ext/json-enc.js` (JSON encoding), `htmx/ext/sse.js` (Server-Sent Events), `htmx/ext/ws.js` (WebSockets)

## 2. Standard Codebase Structure
```text
htmx-app/
├── public/
│   ├── index.html
│   └── css/
│       └── app.css
├── templates/
│   ├── layout.html
│   └── partials/
│       ├── item_row.html
│       └── item_list.html
└── server.py / main.go / server.js
```

## 3. How-To Workflows

### Include HTMX & Start Local Server
```html
<script src="https://unpkg.com/htmx.org@1.9.10" integrity="sha384-D1Kt99CQMDuVetoL1lrYwg5t+9QdHe7NLX/SoJYkXDFfX37iInKRy5xLSi8nO7UC" crossorigin="anonymous"></script>
```

### Run Dev Server
```bash
# Serve frontend & partial endpoints
python -m http.server 8000
```

## 4. Best Practices & Design Patterns
1. **Hypermedia-Driven Architecture (HDA)**: Return HTML fragments/partials from server endpoints instead of raw JSON where client-side rendering is unnecessary.
2. **Target & Swap Control**: Explicitly specify target elements (`hx-target="#container"`) and swap strategies (`hx-swap="outerHTML"`, `hx-swap="innerHTML"`, `hx-swap="beforeend"`).
3. **Indicator Feedback**: Use `hx-indicator="#spinner"` to display loading states during asynchronous network requests.
4. **Out-of-Band (OOB) Swaps**: Use `hx-swap-oob="true"` on elements in server responses to update multiple distant parts of the DOM in a single response payload.
5. **Debouncing Search / Input**: Add `hx-trigger="keyup changed delay:300ms"` to search inputs to prevent server request flooding.

## 5. Tips, Tricks & Pitfalls
- **HTTP Response Codes**: HTMX respects HTTP status codes. 200/204 renders or swaps, 4xx/5xx triggers `htmx:responseError` events.
- **CSRF Token Headers**: Pass security CSRF tokens automatically using `document.body.addEventListener('htmx:configRequest', (evt) => evt.detail.headers['X-CSRF-Token'] = token)`.
- **History Management**: Use `hx-push-url="true"` for full page navigation URL updates while keeping SPA speed.

## 6. Harness Hooks & Safety Enforcement
- **PreToolUse Guard**: Validate template partial HTML syntax before registering endpoints.
- **PostToolUse Verification**: Audit DOM swap targets to ensure IDs exist in the root page markup.
