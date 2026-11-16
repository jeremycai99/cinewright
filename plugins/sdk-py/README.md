# cinewright-plugin-sdk

Write a Cinewright plugin in Python (D32, M1.8b). The host starts it as a child process and speaks JSON-RPC 2.0 on its stdio, one JSON message per line. stderr is the plugin's log.

```python
from typing import Any
from cinewright_plugin_sdk import Plugin, PluginError, serve

class MyPlugin(Plugin):
    def capabilities(self) -> list[str]:
        return ["describe"]

    def call(self, method: str, params: Any) -> Any:
        if method != "describe":
            raise PluginError("unsupported", f"no method {method}")
        for chunk in range(10):
            self.check_cancelled()     # raises Cancelled when the host cancels this call
            ...
        return {"ok": "done"}

if __name__ == "__main__":
    serve(MyPlugin())
```

- **Manifest:** `runtime: { "kind": "subprocess", "command": ["python", "plugin.py"] }`. The manifest schema is in `plugins/sdk-ts/schema/`.
- **Methods:** `initialize`, `capabilities`, `call`, `health` and `shutdown`. Notifications: `$/cancel {id}` and `exit`.
- **Errors:** `call` returns a value or raises `PluginError(code, message, retryable)`. Any other exception becomes an `internal` error.
- **Exit:** the process exits when stdin closes, so it never outlives a host that was killed.
- **Timeouts:** the host gives each call a timeout. On expiry it sends `$/cancel`, waits one second, then kills the process.
- **Environment:** the host passes only `PATH` and the secrets the manifest declares.

Standard library only.
