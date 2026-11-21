"""JSON-RPC 2.0 over stdio, one JSON message per line (D32, M1.8b).

Methods: initialize, capabilities, call, health, shutdown. Notifications: $/cancel {id}, exit.
The process exits when stdin closes, so it never outlives a host that was killed.
"""

from __future__ import annotations

import json
import sys
import threading
from pathlib import Path
from typing import Any, TextIO, cast

from cinewright_plugin_sdk.plugin import Cancelled, Plugin, PluginError

PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601


class _Server:
    def __init__(self, plugin: Plugin, out: TextIO) -> None:
        self.plugin = plugin
        self.out = out
        self.lock = threading.Lock()
        self.cancels: dict[Any, threading.Event] = {}

    def send(self, message: dict[str, Any]) -> None:
        line = json.dumps({"jsonrpc": "2.0", **message}, ensure_ascii=False)
        with self.lock:
            self.out.write(line + "\n")
            self.out.flush()

    def reply(self, rid: Any, result: Any) -> None:
        self.send({"id": rid, "result": result})

    def error(self, rid: Any, code: int, message: str) -> None:
        self.send({"id": rid, "error": {"code": code, "message": message}})

    def handle(self, line: str) -> bool:
        """Handle one line; False means exit."""
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            self.error(None, PARSE_ERROR, "parse error")
            return True
        if not isinstance(message, dict) or not isinstance(message.get("method"), str):  # type: ignore[union-attr]
            self.error(None, INVALID_REQUEST, "invalid request")
            return True
        msg: dict[str, Any] = message  # type: ignore[assignment]
        method: str = msg["method"]
        rid = msg.get("id")
        params: Any = msg.get("params")
        if method == "exit":
            return False
        if method == "$/cancel":
            event = self.cancels.get(params.get("id") if isinstance(params, dict) else None)  # type: ignore[union-attr]
            if event is not None:
                event.set()
            return True
        if method == "initialize":
            secrets = params.get("secrets", {}) if isinstance(params, dict) else {}  # type: ignore[union-attr]
            work_dir = params.get("workDir") if isinstance(params, dict) else None  # type: ignore[union-attr]
            if isinstance(work_dir, str):
                self.plugin.work_dir = Path(work_dir)
            self.plugin.init(secrets)  # type: ignore[arg-type]
            self.reply(rid, {})
        elif method == "health":
            self.reply(rid, "ok")
        elif method == "capabilities":
            self.reply(rid, self.plugin.capabilities())
        elif method == "shutdown":
            self.plugin.shutdown()
            self.reply(rid, None)
        elif method == "call":
            raw: Any = params.get("request") if isinstance(params, dict) else None  # type: ignore[union-attr]
            request: dict[str, Any] = cast(dict[str, Any], raw) if isinstance(raw, dict) else {}
            event = threading.Event()
            self.cancels[rid] = event
            threading.Thread(target=self.run_call, args=(rid, request, event), daemon=True).start()
        else:
            self.error(rid, METHOD_NOT_FOUND, f"method not found: {method}")
        return True

    def run_call(self, rid: Any, request: dict[str, Any], event: threading.Event) -> None:
        self.plugin._bind(event)  # pyright: ignore[reportPrivateUsage]
        try:
            result = self.plugin.call(str(request.get("method", "")), request.get("params"))
            response: dict[str, Any] = (
                {"ok": False, "error": Cancelled().to_json()}
                if event.is_set()
                else {"ok": True, "result": result}
            )
        except PluginError as error:
            response = {"ok": False, "error": error.to_json()}
        except Exception as error:  # noqa: BLE001 - every failure becomes a typed error
            response = {"ok": False, "error": PluginError("internal", str(error)).to_json()}
        finally:
            self.cancels.pop(rid, None)
        self.reply(rid, response)


def serve(plugin: Plugin, stdin: TextIO | None = None, stdout: TextIO | None = None) -> None:
    """Serve `plugin` over stdio until `exit` or until stdin closes."""
    source = stdin if stdin is not None else sys.stdin
    server = _Server(plugin, stdout if stdout is not None else sys.stdout)
    for line in source:
        if line.strip() and not server.handle(line):
            break
