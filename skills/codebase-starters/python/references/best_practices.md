# Python Engineering Reference & Deep Best Practices

## 1. Type Hints & Static Analysis
- Require strict type checking in `pyproject.toml` using `mypy`:
  ```toml
  [tool.mypy]
  python_version = "3.12"
  strict = true
  disallow_untyped_defs = true
  ```
- Use `typing.Protocol` for structural subtyping / duck-typing contracts without explicit inheritance.

## 2. Resource Management & Clean Shutdown
- Always handle `asyncio.CancellationError` in long-running background tasks.
- Register signal handlers for `SIGTERM` and `SIGINT` to allow graceful cleanup.

## 3. Dependency Lockfiles
- Maintain deterministic builds by committing `uv.lock` or `poetry.lock`.
- Audit dependencies using `pip-audit` or `safety`.
