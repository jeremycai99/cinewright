"""The environment tier A runs the CLI in (M8.3a): no provider keys, and paid plugins refused."""

from __future__ import annotations

import re
from collections.abc import Mapping

# Names that hold credentials: every provider key, token, secret or password.
SECRET = re.compile(r"(?i)(_API_KEY|_KEY_ID|_TOKEN|_SECRET|_PASSWORD|_ACCESS_KEY)$")


def tier_a_env(env: Mapping[str, str]) -> dict[str, str]:
    """`env` without credentials, plus `CINEWRIGHT_FREE_ONLY=1`: the engine refuses any plugin
    whose cost model is not free (a paid provider can never run in tier A)."""
    out = {k: v for k, v in env.items() if not SECRET.search(k)}
    out["CINEWRIGHT_FREE_ONLY"] = "1"
    return out
