"""The conformance stub, in Python: echo, add, a cancellable sleep, hang (ignores cancel),
fail_loud (writes its secret to stderr, then fails) and work_dir (where the host put files)."""

import sys
import time
from typing import Any

from cinewright_plugin_sdk import Plugin, PluginError, serve


class Stub(Plugin):
    secrets: dict[str, str] = {}

    def init(self, secrets: dict[str, str]) -> None:
        self.secrets = secrets

    def capabilities(self) -> list[str]:
        return ["add", "echo", "sleep"]

    def call(self, method: str, params: Any) -> Any:
        if method == "echo":
            return params
        if method == "add":
            if not isinstance(params, dict):
                raise PluginError("invalid_request", "add needs numbers a and b")
            a = params.get("a")  # type: ignore[union-attr]
            b = params.get("b")  # type: ignore[union-attr]
            if not isinstance(a, int | float) or not isinstance(b, int | float):
                raise PluginError("invalid_request", "add needs numbers a and b")
            return a + b
        if method == "sleep":
            end = time.monotonic() + float(params.get("ms", 0)) / 1000  # type: ignore[union-attr]
            while time.monotonic() < end:
                self.check_cancelled()
                time.sleep(0.01)
            return "slept"
        if method == "hang":
            while True:
                time.sleep(1)
        if method == "fail_loud":
            print(f"provider rejected token {self.secrets.get('STUB_TOKEN', '')}", file=sys.stderr)
            sys.stderr.flush()
            raise PluginError("provider_error", "the provider failed")
        if method == "work_dir":
            return str(self.work_dir)
        raise PluginError("unsupported", f"no method {method}")


if __name__ == "__main__":
    serve(Stub())
