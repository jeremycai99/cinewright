"""A stand-in for `cinewright render --json` in the tier A harness's tests.

Reads the scenario from `$STUB_SCENARIO` (JSON): `{ "<project folder name>": { "code": int,
"deliverables": { "<id>": { "sha256", "framemd5", "pcm_sha256", "findings": [...] } },
"steps": [{ "id", "hit" }], "stderr": str } }`. Writes each deliverable's critique report into the
project and prints the render report. Records the environment it saw in `$STUB_ENV_OUT`.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

RULES = ["audio.loudness", "captions.sync", "layout.overflow", "stt.mismatch"]


def main() -> int:
    args = sys.argv[1:]
    project = Path(args[args.index("--project") + 1])
    Path(os.environ["STUB_ENV_OUT"]).write_text(json.dumps(dict(os.environ)))
    scenario = json.loads(Path(os.environ["STUB_SCENARIO"]).read_text())[project.name]
    deliverables = {}
    for d, spec in scenario.get("deliverables", {}).items():
        report = project / ".cinewright" / "cache" / "reports" / f"{d}.json"
        report.parent.mkdir(parents=True, exist_ok=True)
        critique = {
            "deliverable": d,
            "revision": 3,
            "critics": [
                {
                    "id": "critic_layout",
                    "version": "0.1.0",
                    "baseline": {"settings": "sha256:aa", "hyperframes": "0.9.58"},
                },
                {"id": "clearance", "version": "0.1.0"},
            ],
            "findings": spec.get("findings", []),
            "rules": RULES,
            "measured": {},
        }
        report.write_text(json.dumps(critique))
        deliverables[d] = {
            "file": str(project / f"{d}.mp4"),
            "sha256": spec["sha256"],
            "framemd5": spec["framemd5"],
            "pcm_sha256": spec["pcm_sha256"],
            "critique": {"file": str(report), "findings": spec.get("findings", [])},
        }
    if scenario.get("stderr"):
        print(scenario["stderr"], file=sys.stderr)
    code = scenario.get("code", 0)
    if code in (0, 10):
        status = "findings" if code == 10 else "ok"
        print(
            json.dumps(
                {
                    "status": status,
                    "revision": 3,
                    "steps": scenario.get("steps", []),
                    "deliverables": deliverables,
                    "findings": [],
                    "until": "critique",
                }
            )
        )
    else:
        print(
            json.dumps(
                {
                    "status": "error",
                    "kind": "provider",
                    "step": "narrate:b01.l01",
                    "message": scenario.get("stderr", ""),
                }
            )
        )
    return code


if __name__ == "__main__":
    sys.exit(main())
