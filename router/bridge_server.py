"""
router/bridge_server.py — NimTools bridge server.

Exposes hermes-agent's tool registry over newline-delimited JSON on
stdin/stdout, branded as NimTools.  Node's src/bridge.mjs talks to this
process the same way src/router.mjs talks to service.py.

Protocol:
  Request:  {"type":"list"}
         or {"type":"schema","tool":"web_search"}
         or {"type":"call","tool":"web_search","args":{"query":"…"}}
         or {"type":"ping"}
  Response: {"tools":[{"name":"…","description":"…"},...]}
         or {"schema":{...}}            -- full JSON schema for one tool
         or {"result":"…"}             -- stringified tool output
         or {"pong":true}
  Error:    {"error":"…"}

The hermes registry is imported lazily on first use so startup is instant
(no tool modules imported until the first real call).
"""

from __future__ import annotations

import json
import sys
import os
from pathlib import Path

HERMES_ROOT = Path(os.environ.get("OMNI_HERMES_ROOT", r"C:\hermes-agent"))

# ---------------------------------------------------------------------------
# Lazy hermes registry access
# ---------------------------------------------------------------------------
_registry = None
_tools_loaded = False


def _ensure_registry():
    global _registry, _tools_loaded
    if _registry is not None:
        return _registry

    if not HERMES_ROOT.exists():
        raise RuntimeError(
            f"hermes-agent not found at {HERMES_ROOT}. "
            "Set OMNI_HERMES_ROOT env var to point at your hermes-agent directory."
        )

    # Add hermes to sys.path so its imports resolve.
    hermes_str = str(HERMES_ROOT)
    if hermes_str not in sys.path:
        sys.path.insert(0, hermes_str)

    from tools.registry import registry, discover_builtin_tools  # type: ignore

    if not _tools_loaded:
        discover_builtin_tools()
        _tools_loaded = True

    _registry = registry
    return registry


# ---------------------------------------------------------------------------
# Handlers
# ---------------------------------------------------------------------------

def handle_list() -> dict:
    reg = _ensure_registry()
    tools = []
    for entry in reg.get_all_entries():
        schema = entry.schema or {}
        tools.append({
            "name": entry.name,
            "description": schema.get("description", ""),
            "toolset": entry.toolset or "general",
        })
    return {"tools": tools}


def handle_schema(tool_name: str) -> dict:
    reg = _ensure_registry()
    entry = reg.get_entry(tool_name)
    if not entry:
        return {"error": f"unknown NimTool: {tool_name!r}"}
    return {"schema": entry.schema or {}}


def handle_call(tool_name: str, args: dict) -> dict:
    reg = _ensure_registry()
    result = reg.execute(tool_name, args)
    # registry.execute() always returns a string (JSON-encoded or plain text).
    if not isinstance(result, str):
        result = json.dumps(result)
    return {"result": result}


def handle(line: str) -> dict:
    try:
        req = json.loads(line)
    except json.JSONDecodeError as e:
        return {"error": f"bad JSON: {e}"}

    t = req.get("type")

    if t == "ping":
        return {"pong": True}

    if t == "list":
        try:
            return handle_list()
        except Exception as e:
            return {"error": str(e)}

    if t == "schema":
        tool = req.get("tool", "")
        if not tool:
            return {"error": "missing 'tool' field"}
        try:
            return handle_schema(tool)
        except Exception as e:
            return {"error": str(e)}

    if t == "call":
        tool = req.get("tool", "")
        args = req.get("args", {})
        if not tool:
            return {"error": "missing 'tool' field"}
        if not isinstance(args, dict):
            try:
                args = json.loads(args)
            except Exception:
                args = {}
        try:
            return handle_call(tool, args)
        except Exception as e:
            return {"error": str(e)}

    return {"error": f"unknown type: {t!r}"}


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

def main() -> None:
    sys.stdout.reconfigure(line_buffering=True)  # type: ignore[attr-defined]

    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        resp = handle(raw)
        print(json.dumps(resp), flush=True)


if __name__ == "__main__":
    main()
