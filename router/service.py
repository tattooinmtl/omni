"""
router/service.py — Omni warm sidecar.

Two jobs, one process:
  1. Intent classification  — local ML (hashing + logistic regression).
                              Falls back to regex heuristics if model not trained yet.
  2. System-prompt trimming — strips the system prompt to ≤8 000 chars before
                              forwarding to local models, same technique as the
                              OpenClaude local-proxy (cuts prefill time ~90%).

Protocol: newline-delimited JSON on stdin/stdout.
  Request:  {"type":"classify","message":"…","history":[…]}
         or {"type":"trim","content":"…","max_chars":8000}
  Response: {"persona":"coding","confidence":0.91}
         or {"content":"…(trimmed)…"}
  Error:    {"error":"…"}

Node keeps this process alive across turns (warm = no per-call startup cost).
"""

from __future__ import annotations

import json
import os
import pickle
import re
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
SIDECAR_DIR = Path(__file__).parent
MODEL_PATH  = SIDECAR_DIR / "model.pkl"
SEED_PATH   = SIDECAR_DIR / "data" / "seed.jsonl"

# ---------------------------------------------------------------------------
# Regex heuristic tiers (fast path — no ML needed for clear-cut turns)
# ---------------------------------------------------------------------------
_CODING_STRONG = re.compile(
    r"""
    \b(fix|bug|error|exception|traceback|refactor|implement|build|compile|
       debug|test|lint|deploy|migrate|patch|diff|commit|rebase|merge|
       dockerfile|webpack|vite|npm|pip|cargo|gradle|cmake|makefile|ci)\b
    | \.(py|js|ts|mjs|rs|go|java|cpp|c|cs|rb|php|sh|sql|yml|yaml|toml|json)\b
    | ```[\w]*\n
    | def\s+\w+\s*\(
    | function\s+\w+\s*\(
    | class\s+\w+[\s:(]
    | import\s+\w
    | from\s+\w+\s+import
    | (File|line)\s+\d+
    """,
    re.IGNORECASE | re.VERBOSE,
)

_ASSISTANT_STRONG = re.compile(
    r"""
    ^(what\s+is|what\s+are|who\s+is|explain|summarize|describe|
       tell\s+me|how\s+do\s+I|can\s+you|write\s+a\s+poem|
       translate|compare|list\s+the|give\s+me\s+(a\s+)?list|
       pros\s+and\s+cons|what'?s\s+the\s+difference)
    """,
    re.IGNORECASE | re.VERBOSE,
)

_CODING_PATHS = re.compile(r'[a-zA-Z0-9_\-]+\.[a-zA-Z]{1,6}(/[^\s]*)?')


def heuristic_classify(message: str) -> tuple[str, float] | None:
    """Return (persona, confidence) when the signal is clear, else None."""
    msg = message.strip()

    # Strong coding signals
    if _CODING_STRONG.search(msg) and len(msg) > 5:
        return ("coding", 0.85)

    # Strong assistant signals — only when no file/path is mentioned
    if _ASSISTANT_STRONG.match(msg) and not _CODING_PATHS.search(msg):
        return ("assistant", 0.80)

    return None


# ---------------------------------------------------------------------------
# ML classifier (sklearn hashing vectoriser + logistic regression)
# ---------------------------------------------------------------------------
_model = None   # loaded once, cached in-process


def _load_model() -> object | None:
    global _model
    if _model is not None:
        return _model
    if not MODEL_PATH.exists():
        return None
    try:
        with MODEL_PATH.open("rb") as f:
            _model = pickle.load(f)
        return _model
    except Exception:
        return None


def ml_classify(message: str) -> tuple[str, float] | None:
    """Return (persona, confidence) from the trained model, or None if unavailable."""
    clf = _load_model()
    if clf is None:
        return None
    try:
        proba = clf.predict_proba([message])[0]
        classes = clf.classes_
        best_i = int(proba.argmax())
        return (classes[best_i], float(proba[best_i]))
    except Exception:
        return None


def classify(message: str, confidence_threshold: float = 0.60) -> dict:
    """Tier-1 heuristics → Tier-2 ML → default coding."""
    # Tier 1: fast regex
    result = heuristic_classify(message)
    if result and result[1] >= confidence_threshold:
        return {"persona": result[0], "confidence": result[1], "method": "heuristic"}

    # Tier 2: local ML model
    result = ml_classify(message)
    if result and result[1] >= confidence_threshold:
        return {"persona": result[0], "confidence": result[1], "method": "ml"}

    # Default: coding (NimAgent's identity)
    return {"persona": "coding", "confidence": 0.50, "method": "default"}


# ---------------------------------------------------------------------------
# System-prompt trimmer (OpenClaude local-proxy technique)
# ---------------------------------------------------------------------------
MAX_CHARS_DEFAULT = 8000


def trim_prompt(content: str, max_chars: int = MAX_CHARS_DEFAULT) -> str:
    if len(content) <= max_chars:
        return content
    # Cut at the last sentence boundary before the limit.
    cut = content.rfind(". ", 0, max_chars)
    trim_point = (cut + 1) if cut > max_chars * 0.6 else max_chars
    return (
        content[:trim_point].rstrip()
        + "\n\n[System prompt condensed for local inference performance.]"
    )


# ---------------------------------------------------------------------------
# Jinja2 template renderer (used for providers with chatTemplate configured)
# ---------------------------------------------------------------------------

def render_template(template_path: str, messages: list, tools=None, **opts) -> dict:
    """Render a Jinja2 chat template with the given messages and tools."""
    try:
        from jinja2 import Environment, FileSystemLoader
    except ImportError:
        return {"error": "jinja2 not installed — run: pip install jinja2>=3.1.0"}

    try:
        tmpl_path = Path(template_path)
        if not tmpl_path.is_absolute():
            # Relative paths resolve from the NimAgent install root (parent of router/)
            tmpl_path = SIDECAR_DIR.parent / template_path
        if not tmpl_path.exists():
            return {"error": f"template not found: {tmpl_path}"}

        env = Environment(
            loader=FileSystemLoader(str(tmpl_path.parent)),
            keep_trailing_newline=True,
        )

        def raise_exception(msg: str):
            raise Exception(msg)

        env.globals["raise_exception"] = raise_exception

        template = env.get_template(tmpl_path.name)
        rendered = template.render(
            messages=messages,
            tools=tools if tools else None,
            add_generation_prompt=opts.get("add_generation_prompt", True),
            add_vision_id=opts.get("add_vision_id", False),
            enable_thinking=opts.get("enable_thinking", True),
            preserve_thinking=opts.get("preserve_thinking", False),
        )
        return {"rendered": rendered}
    except Exception as e:
        return {"error": str(e)}


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------
def handle(line: str) -> dict:
    try:
        req = json.loads(line)
    except json.JSONDecodeError as e:
        return {"error": f"bad JSON: {e}"}

    t = req.get("type")

    if t == "classify":
        msg = req.get("message", "")
        threshold = float(req.get("confidence_threshold", 0.60))
        return classify(msg, threshold)

    if t == "trim":
        content = req.get("content", "")
        max_chars = int(req.get("max_chars", MAX_CHARS_DEFAULT))
        return {"content": trim_prompt(content, max_chars)}

    if t == "render_template":
        template_path = req.get("template_path", "")
        messages = req.get("messages", [])
        tools = req.get("tools")
        opts = req.get("opts", {})
        return render_template(template_path, messages, tools, **opts)

    if t == "ping":
        return {"pong": True}

    return {"error": f"unknown type: {t!r}"}


def main() -> None:
    # Flush stdout after every write so Node sees each response immediately.
    sys.stdout.reconfigure(line_buffering=True)  # type: ignore[attr-defined]

    # Pre-load the model so the first classify call is fast.
    _load_model()

    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        resp = handle(raw)
        print(json.dumps(resp), flush=True)


if __name__ == "__main__":
    main()
