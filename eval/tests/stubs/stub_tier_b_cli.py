"""A stub `cinewright` for the tier B harness tests (M8.3b).

`STUB_TIER_B` maps a brief id to its outcome: `ok` (default), `paused`, `provider`, `findings`.
`STUB_COST` is each run's spend in USD. Every call is appended to `STUB_LOG` as JSON, with the
cassette folder it saw, so tests can check that runs never share one.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path


def project_of(args: list[str]) -> Path:
    return Path(args[args.index("--project") + 1])


def main() -> int:
    args = sys.argv[1:]
    log = os.environ.get("STUB_LOG")
    if log:
        with open(log, "a") as f:
            f.write(
                json.dumps({"args": args, "cassettes": os.environ.get("CINEWRIGHT_CASSETTES")})
                + "\n"
            )
    outcomes = json.loads(os.environ.get("STUB_TIER_B", "{}"))
    cmd = args[0]
    if cmd == "init":
        project = Path(args[1])
        project.mkdir(parents=True)
        brief_id = args[args.index("--id") + 1]
        pack = args[args.index("--pack") + 1]
        (project / "cinewright.json").write_text(json.dumps({"id": brief_id, "pack": pack}))
        return 0
    project = project_of(args)
    doc = json.loads((project / "cinewright.json").read_text())
    outcome = outcomes.get(doc["id"], "ok")
    if cmd in ("patch", "review"):
        print(json.dumps({"ok": True}))
        return 0
    if cmd == "render":
        if outcome == "paused":
            print(json.dumps({"status": "paused", "pause": {"kind": "human", "id": "writer"}}))
            return 11
        if outcome == "provider":
            print("provider down", file=sys.stderr)
            return 9
        reports = project / ".cinewright" / "cache" / "reports"
        reports.mkdir(parents=True)
        score = 4 if doc["pack"] == "neutral" else 3
        (reports / "r.json").write_text(
            json.dumps(
                {
                    "measured": {
                        "vision.evaluated": 1,
                        "vision.legibility.s01.sh01": score,
                        "vision.legibility.s01.sh02": score + 1,
                    }
                }
            )
        )
        print(json.dumps({"status": "done", "run": "run_1"}))
        return 0
    if cmd == "export":
        if outcome == "findings":
            print(
                json.dumps(
                    {
                        "status": "blocked",
                        "findings": [{"id": "f_000000000001", "rule": "layout.overflow"}],
                    }
                )
            )
            return 10
        print(
            json.dumps(
                {"status": "exported", "deliverables": {"web": {"sha256": "sha256:" + "b" * 64}}}
            )
        )
        return 0
    if cmd == "status":
        print(
            json.dumps(
                {
                    "cost": {"spent_usd": float(os.environ.get("STUB_COST", "0.5"))},
                    "findings": {"escalated": 0},
                }
            )
        )
        return 0
    print(f"stub: unknown command {cmd}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
