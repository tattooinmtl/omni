---
name: python
description: >-
  Production codebase starter, best practices, package management (uv/poetry/pip), async IO, typing, testing (pytest), and harness lifecycle hooks for Python 3.12+.
---

# Python Codebase & Engineering Skill

Comprehensive operational guide, starter architecture, best practices, and harness controls for Python engineering.

## 1. Stack Overview & Dependencies
- **Runtime**: Python 3.12+ (CPython / PyPy)
- **Package & Environment Managers**: `uv` (recommended for ultra-fast resolution), `poetry`, or `pip` + `venv`.
- **Core Dependencies**:
  - `pydantic` v2 (data modeling & validation)
  - `fastapi` / `httpx` (async web & HTTP client)
  - `pytest`, `pytest-asyncio`, `pytest-cov` (testing harness)
  - `ruff` (fast linting & formatting)
  - `mypy` (strict static type analysis)

## 2. Standard Codebase Structure
```text
python-service/
├── pyproject.toml
├── README.md
├── src/
│   └── app/
│       ├── __init__.py
│       ├── main.py
│       ├── config.py
│       ├── models/
│       │   └── domain.py
│       └── services/
│           └── processor.py
└── tests/
    ├── __init__.py
    ├── conftest.py
    └── test_processor.py
```

## 3. How-To Workflows

### Setup Environment & Dependencies
```bash
# Using uv
uv venv
source .venv/bin/activate  # Or .venv\Scripts\activate on Windows
uv pip install -e ".[dev]"
```

### Formatting & Linting
```bash
# Check formatting and lint errors
ruff check src/ tests/
ruff format --check src/ tests/

# Auto-fix formatting and linting
ruff format src/ tests/
ruff check --fix src/ tests/
```

### Static Type Checking
```bash
mypy src/ --strict
```

### Testing & Verification
```bash
pytest --cov=src --cov-report=term-missing -vv
```

## 4. Best Practices & Design Patterns
1. **Strict Type Annotations**: Always annotate function arguments and return types. Avoid raw `Any`; use `Union`, `Optional`, or TypeVars.
2. **Pydantic v2 Models**: Use `BaseModel` with explicit field validation and `model_config = ConfigDict(frozen=True)` for immutable domain entities.
3. **Async / Non-Blocking IO**: Use `async` for IO-bound work (`httpx.AsyncClient`, `aiofiles`). Avoid blocking operations inside event loops.
4. **Structured Error Handling**: Define domain exceptions inheriting from a root `AppBaseException`. Never swallow exceptions silently with empty `except: pass`.
5. **Context Managers**: Use `asynccontextmanager` / `@contextmanager` for resources (db connections, file handles, sockets) to guarantee cleanup.

## 5. Tips, Tricks & Pitfalls
- **GIL & Concurrency**: Use `asyncio` for IO-bound concurrency and `ProcessPoolExecutor` or `multiprocessing` for CPU-bound computation.
- **Mutable Default Arguments**: Never use `def fn(items=[])`. Use `def fn(items: list[str] | None = None)`.
- **Import Side Effects**: Keep module imports free of execution side-effects (e.g. database connection attempts upon import).

## 6. Harness Hooks & Safety Enforcement
- **PreToolUse Guard**: Block unverified `pip install` without virtualenv activation.
- **PostToolUse Verification**: Automatically run `ruff check` and `pytest` after file edits.
