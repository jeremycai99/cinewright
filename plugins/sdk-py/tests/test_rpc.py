"""The Python plugin SDK's JSON-RPC framing, against the stub plugin as a real subprocess."""

import json
import subprocess
import sys
from pathlib import Path
from typing import Any

STUB = Path(__file__).parent / "fixtures" / "stub_plugin" / "plugin.py"


def _exchange(lines: list[str]) -> list[dict[str, Any]]:
    proc = subprocess.run(
        [sys.executable, str(STUB)],
        input="".join(line + "\n" for line in lines),
        capture_output=True,
        text=True,
        timeout=20,
        check=False,
    )
    assert proc.returncode == 0, proc.stderr
    return [json.loads(line) for line in proc.stdout.splitlines()]


def _req(rid: int, method: str, params: Any = None) -> str:
    return json.dumps({"jsonrpc": "2.0", "id": rid, "method": method, "params": params})


def test_framing_round_trip() -> None:
    out = _exchange(
        [_req(1, "initialize", {"secrets": {}}), _req(2, "capabilities"), _req(3, "health")]
    )
    assert out == [
        {"jsonrpc": "2.0", "id": 1, "result": {}},
        {"jsonrpc": "2.0", "id": 2, "result": ["add", "echo", "sleep"]},
        {"jsonrpc": "2.0", "id": 3, "result": "ok"},
    ]


def test_call_returns_a_plugin_response() -> None:
    out = _exchange(
        [_req(1, "call", {"request": {"id": "r", "method": "add", "params": {"a": 2, "b": 3}}})]
    )
    assert out == [{"jsonrpc": "2.0", "id": 1, "result": {"ok": True, "result": 5}}]


def test_a_plugin_error_is_typed() -> None:
    out = _exchange(
        [_req(1, "call", {"request": {"id": "r", "method": "add", "params": {"a": "2"}}})]
    )
    error = out[0]["result"]["error"]
    assert out[0]["result"]["ok"] is False
    assert error == {
        "code": "invalid_request",
        "message": "add needs numbers a and b",
        "retryable": False,
    }


def test_unknown_method_returns_method_not_found() -> None:
    out = _exchange([_req(7, "frobnicate")])
    assert out[0]["id"] == 7
    assert out[0]["error"]["code"] == -32601


def test_malformed_line_returns_parse_error() -> None:
    out = _exchange(["{not json"])
    assert out == [
        {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "parse error"}}
    ]


def test_exits_when_stdin_closes() -> None:
    proc = subprocess.run(
        [sys.executable, str(STUB)],
        input="",
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )
    assert proc.returncode == 0
