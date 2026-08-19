---
name: python-coding
command: /python
description: Python environment setup, syntax rules, best practices, and project scaffolding.
---

# Python Coding Skill

## Purpose
Guide the user through Python environment detection, installation, project scaffolding, modern Python 3.12+ syntax, typing, best practices, and tooling.

## When to use
Use this skill when the user runs:

/python [subcommand]

Subcommands:
- (none) — Detect Python environment, report status, and offer to fix issues
- new <project-name> — Scaffold a new Python project
- check — Scan current project for env issues and best practice violations
- help — Show this help

---

## Phase 1 — Environment Detection & Installation

### Step 1: Detect existing Python installation
Use `run_shell` to check:
```powershell
python --version
python3 --version
where pip
where uv
where poetry
where ruff
where mypy
```

### Step 2: Report status
- ✅ / ❌ Python (3.12+ recommended; 3.10 reaches EOL Oct 2026)
- ✅ / ❌ pip
- ✅ / ❌ uv (modern package manager — recommended)
- ✅ / ❌ Poetry (alternative package manager)
- ✅ / ❌ Ruff (linter + formatter)
- ✅ / ❌ mypy / pyright (type checker)
- ✅ / ❌ pytest (testing)

### Step 3: Install Python if missing

**Windows:**
```powershell
winget install Python.Python.3.13
# OR use uv to install Python (recommended):
winget install astral-sh.uv
uv python install 3.13
```

**Linux:**
```bash
# Using uv (recommended)
curl -LsSf https://astral.sh/uv/install.sh | sh
uv python install 3.13

# Using system package manager
sudo apt update && sudo apt install python3.13 python3.13-venv python3-pip
```

**macOS:**
```bash
brew install python@3.13
# OR
brew install uv && uv python install 3.13
```

### Step 4: Install uv (modern package manager — recommended)
uv replaces pip + virtualenv + pip-tools + pyenv in a single Rust binary, 10-100x faster.

```powershell
# Windows
winget install astral-sh.uv
# OR
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
```

```bash
# Linux/macOS
curl -LsSf https://astral.sh/uv/install.sh | sh
```

### Step 5: Install useful tools
```powershell
uv tool install ruff        # Linter + formatter (replaces Black, isort, flake8)
uv tool install mypy        # Type checker
uv tool install pytest      # Testing framework
uv tool install pip-audit   # Security vulnerability scanner
```

### Step 6: Verify
```powershell
python --version
uv --version
ruff --version
mypy --version
pytest --version
```

---

## Phase 2 — Project Scaffolding

### Create a new project with uv (recommended)
```powershell
uv init --package my_project
cd my_project
uv add fastapi httpx       # Add dependencies
uv add --dev pytest ruff mypy  # Add dev dependencies
uv run pytest              # Run tests
```

### Standard project structure (src/ layout)
```
my_project/
├── pyproject.toml          # Project metadata (PEP 621)
├── uv.lock                 # Lock file (deterministic builds)
├── README.md
├── src/
│   └── my_project/
│       ├── __init__.py
│       ├── core.py
│       ├── utils.py
│       └── api/
│           ├── __init__.py
│           └── endpoints.py
├── tests/
│   ├── __init__.py
│   ├── test_core.py
│   └── test_utils.py
└── .python-version         # Pins Python version
```

### Minimal pyproject.toml (PEP 621)
```toml
[project]
name = "my_project"
version = "0.1.0"
description = "A production-grade Python app"
requires-python = ">=3.12"
dependencies = [
    "fastapi>=0.115",
    "httpx>=0.28",
]

[dependency-groups]
dev = [
    "pytest>=8.3",
    "ruff>=0.7",
    "mypy>=1.13",
]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.ruff]
line-length = 88
target-version = "py312"

[tool.ruff.lint]
select = ["E", "F", "I", "UP", "B", "SIM", "COM812"]

[tool.mypy]
python_version = "3.12"
strict = true
```

### Alternative: Poetry project
```powershell
poetry new my_project
cd my_project
poetry add fastapi httpx
poetry add --group dev pytest ruff mypy
poetry install
```

---

## Phase 3 — Syntax Rules & Best Practices

### Type Hints (mandatory in modern Python)
- **Type hints are no longer optional** — they are the backbone of the development experience
- **Python 3.14** has deferred evaluation of annotations (PEP 649/749) as default
- **Use `Protocol`** for structural subtyping over inheritance
- **Use PEP 695 generic syntax** (Python 3.12+) — no more `TypeVar` imports

```python
# Old (verbose, still works)
from typing import TypeVar
T = TypeVar("T")
def first(items: list[T]) -> T: ...

# New (PEP 695, Python 3.12+)
def first[T](items: list[T]) -> T: ...

# Protocols over inheritance
from typing import Protocol

class Repository(Protocol):
    def save(self, data: dict) -> bool: ...

# Any class with a save() method is now a Repository — no inheritance needed
```

### Modern Type System
- **Use `|` for unions** (Python 3.10+) — not `Union[...]`
- **Use `X | None`** — not `Optional[X]`
- **Use `list[T]`, `dict[K, V]`** — not `List[T]`, `Dict[K, V]` (built-in generics)
- **Use `Literal`** for exhaustive checking with `match`
- **Use `Never`** (Python 3.11+) — not `NoReturn`

```python
# Modern union syntax
def process(data: str | int | None) -> str: ...

# Built-in generics
def get_items() -> list[dict[str, int]]: ...

# Literal types for exhaustive matching
from typing import Literal

Status = Literal["pending", "active", "closed"]

def handle(status: Status) -> str:
    match status:
        case "pending": return "Waiting"
        case "active": return "Running"
        case "closed": return "Done"
```

### Match Statements (Python 3.10+)
- **Use `match`/`case`** for structural pattern matching
- **Exhaustive matching** with `Literal` types and `Never`
- **Destructuring** in patterns

```python
match command:
    case ("quit",): exit_app()
    case ("move", x, y): move_player(x, y)
    case ("attack", target): attack(target)
    case _: print("Unknown command")

# Pattern matching with classes
match point:
    case Point(x=0, y=0): print("Origin")
    case Point(x=0, y=y): print(f"Y-axis at {y}")
    case Point(x=x, y=0): print(f"X-axis at {x}")
    case Point(x=x, y=y): print(f"Point at {x}, {y}")
```

### Data Classes and Pydantic
- **Use `dataclass`** for simple data containers
- **Use `Pydantic v2`** for validation-heavy models (APIs, config)
- **Use `frozen=True`** for immutable dataclasses

```python
from dataclasses import dataclass, field

@dataclass(frozen=True)
class Point:
    x: float
    y: float

    def distance_from(self, other: Point) -> float:
        return ((self.x - other.x) ** 2 + (self.y - other.y) ** 2) ** 0.5

# Pydantic v2 for API models
from pydantic import BaseModel, Field

class User(BaseModel):
    username: str = Field(..., min_length=3)
    email: str
    age: int = Field(..., ge=18)
```

### Async/Await
- **Use `async`/`await`** for I/O-bound workloads (APIs, DB queries, web servers)
- **Do NOT use async for CPU-bound work** — use multiprocessing or free-threaded Python
- **Use `asyncio.gather()`** for concurrent operations
- **Use `asyncio.run()`** as the entry point

```python
import asyncio
import aiohttp

async def fetch(session: aiohttp.ClientSession, url: str) -> dict:
    async with session.get(url) as resp:
        return await resp.json()

async def main() -> None:
    urls = ["https://api.example.com/data" for _ in range(10)]
    async with aiohttp.ClientSession() as session:
        tasks = [fetch(session, url) for url in urls]
        results = await asyncio.gather(*tasks)
        print(results)

asyncio.run(main())
```

### Error Handling
- **Use specific exceptions** — not bare `except:`
- **Create custom exception hierarchies**
- **Use `try/except/else/finally`** properly
- **Never silently swallow exceptions**

```python
class DomainError(Exception): ...
class ValidationError(DomainError): ...
class NotFoundError(DomainError): ...

def get_user(user_id: int) -> User:
    try:
        user = repository.find(user_id)
    except DatabaseError as e:
        raise DomainError(f"Database error: {e}") from e
    else:
        if user is None:
            raise NotFoundError(f"User {user_id} not found")
        return user
```

### Naming Conventions (PEP 8)
- **Variables and functions**: `snake_case` (e.g., `fetch_user`)
- **Classes**: `PascalCase` (e.g., `HttpClient`)
- **Constants**: `SCREAMING_SNAKE_CASE` (e.g., `MAX_CONNECTIONS`)
- **Private**: `_prefix` (e.g., `_internal_value`)
- **Modules**: `snake_case` (e.g., `user_service.py`)
- **Type aliases**: `PascalCase` (e.g., `UserId = int`)

### Testing with pytest
- **Use `pytest`** for all testing
- **Use parametrized tests** for multiple inputs
- **Use `Hypothesis`** for property-based testing
- **Use `pytest-asyncio`** for async tests
- **Test file naming**: `test_*.py` or `*_test.py`

```python
import pytest
from my_project.core import add

def test_addition():
    assert add(2, 3) == 5

@pytest.mark.parametrize("a,b,result", [(1, 2, 3), (0, 0, 0), (-1, 1, 0)])
def test_param_add(a: int, b: int, result: int):
    assert add(a, b) == result

# Property-based testing with Hypothesis
from hypothesis import given, strategies as st

@given(st.integers(), st.integers())
def test_add_commutative(a: int, b: int):
    assert add(a, b) == add(b, a)
```

### Security Best Practices
- **Pin dependencies** with lock files (`uv.lock` or `poetry.lock`)
- **Scan for vulnerabilities**: `uvx pip-audit`
- **Never use `eval()` or `exec()`** with user input
- **Never hardcode secrets** — use environment variables or secret managers
- **Validate all input** with Pydantic
- **Use `secrets` module** for cryptographic randomness, not `random`

```python
import secrets
import os

# Secure random tokens
token = secrets.token_urlsafe(32)

# Secrets from environment
api_key = os.environ.get("API_KEY")
if not api_key:
    raise ValueError("API_KEY environment variable is required")
```

### Performance
- **Profile before optimizing** — use `cProfile` and `snakeviz`
- **Use generators** for large datasets — lazy evaluation
- **Use list comprehensions** over manual loops
- **Use `__slots__`** for memory-critical classes
- **Consider free-threaded Python (3.13t/3.14t)** for CPU-bound multi-core workloads

```python
# Generator for large datasets
def process_large_file(path: str):
    with open(path) as f:
        for line in f:
            yield process(line)

# List comprehension
squares = [x ** 2 for x in range(100)]

# __slots__ for memory efficiency
class Point:
    __slots__ = ('x', 'y')
    def __init__(self, x: float, y: float):
        self.x = x
        self.y = y
```

### Architecture Patterns
- **Functional Core, Imperative Shell** — business logic is pure, I/O is at the edges
- **Dependency Injection** — don't hardcode database connections inside functions
- **Hexagonal Architecture** (Ports and Adapters) — decouple business logic from infrastructure
- **Use `Protocol`** for interfaces, not abstract base classes

---

## Phase 4 — Verification & Build

### Lint and format
```powershell
ruff format src/          # Format (Black-compatible)
ruff check src/           # Lint
ruff check --fix src/     # Auto-fix safe issues
```

### Type check
```powershell
mypy src/                 # Type checking (aim for strict)
# OR
pyright src/              # Faster alternative
```

### Test
```powershell
pytest                    # Run all tests
pytest --cov=src/         # With coverage
pytest -x                 # Stop on first failure
pytest -k "test_add"      # Run specific tests
```

### Security scan
```powershell
uvx pip-audit             # Check dependencies for vulnerabilities
```

### Run
```powershell
uv run python -m my_project    # Run the project
uv run uvicorn my_project.api:app  # Run ASGI app
```

---

## Phase 5 — Quick Reference

| Practice | Why |
|---|---|
| `uv` for package management | 10-100x faster than pip, deterministic builds |
| `src/` layout | Prevents accidental imports, proper packaging |
| `pyproject.toml` (PEP 621) | Standard project metadata |
| Type hints everywhere | IDE support, static analysis, fewer bugs |
| `Protocol` over inheritance | Structural subtyping, decoupled code |
| PEP 695 generics (3.12+) | Clean inline type parameters |
| `match`/`case` (3.10+) | Structural pattern matching |
| `async`/`await` for I/O | Concurrent I/O operations |
| Ruff (lint + format) | Replaces Black, isort, flake8 — one tool |
| pytest + Hypothesis | Property-based testing finds edge cases |
| `pip-audit` | Dependency vulnerability scanning |
| Functional core, imperative shell | Testable, maintainable architecture |

---

## Rules
- Always detect the environment before suggesting installation.
- Use `run_shell` for all commands — verify each succeeds before continuing.
- Read existing project files before suggesting changes.
- Target Python 3.12+ (3.10 reaches EOL Oct 2026).
- Use `uv` for package management — it's the 2026 standard.
- Always use type hints — they are mandatory in modern Python.
- Use `src/` layout for all new projects.
- Never use `eval()`, `exec()`, or bare `except:`.
- Run Ruff and mypy after making changes.
- Prefer `async`/`await` for I/O-bound workloads, not CPU-bound.
- Use `Protocol` for interfaces, not abstract base classes.

## Output
1. Environment status report
2. Installation/fix steps (if needed)
3. Project scaffold (if requested)
4. Code with modern Python 3.12+ patterns applied
5. Lint, type check, and test verification