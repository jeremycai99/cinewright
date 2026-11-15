"""The Python side of the plugin contract v0 (D32, M1.8b)."""

from __future__ import annotations

import threading
from typing import Any

ERROR_CODES = (
    "invalid_request",
    "unsupported",
    "timeout",
    "cancelled",
    "rate_limited",
    "provider_error",
    "internal",
)


class PluginError(Exception):
    """A typed plugin error; `serve` turns it into `{ok: false, error}`."""

    def __init__(self, code: str, message: str, retryable: bool = False) -> None:
        if code not in ERROR_CODES:
            raise ValueError(f"unknown plugin error code {code!r}")
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable

    def to_json(self) -> dict[str, Any]:
        return {"code": self.code, "message": self.message, "retryable": self.retryable}


class Cancelled(PluginError):
    """Raised by `check_cancelled` when the host cancels the current call."""

    def __init__(self) -> None:
        super().__init__("cancelled", "cancelled", retryable=True)


class Plugin:
    """Override `capabilities` and `call`; call `check_cancelled()` often in long work."""

    _local = threading.local()

    def init(self, secrets: dict[str, str]) -> None:
        """Called once before any call, with the secrets the manifest declares."""

    def capabilities(self) -> list[str]:
        raise NotImplementedError

    def call(self, method: str, params: Any) -> Any:
        raise NotImplementedError

    def shutdown(self) -> None:
        """Called once before the process exits."""

    def cancelled(self) -> bool:
        """True when the host cancelled the call running on this thread."""
        event: threading.Event | None = getattr(self._local, "event", None)
        return event is not None and event.is_set()

    def check_cancelled(self) -> None:
        if self.cancelled():
            raise Cancelled()

    def _bind(self, event: threading.Event) -> None:
        self._local.event = event
