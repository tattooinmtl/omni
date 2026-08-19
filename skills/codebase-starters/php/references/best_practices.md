# PHP Engineering Reference & Deep Best Practices

## 1. Static Analysis at Level 8
- Configure PHPStan `phpstan.neon`:
  ```neon
  parameters:
      level: 8
      paths:
          - src
  ```

## 2. Security & Input Sanitization
- Never trust superglobals (`$_POST`, `$_GET`); filter via `filter_input()`.
- Enforce strict CORS and Session Cookie `SameSite=Strict` settings.
