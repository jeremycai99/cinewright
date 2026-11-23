"""`cinewright-setup-doc` (M8.5): run `docs/SETUP.md` exactly as written, so it cannot drift.

A runnable block is a fenced ```bash block whose nearest non-blank line above it is a marker
`<!-- setup: <step> -->`. Every runnable block runs in order in one bash process (`set -Eeuo
pipefail`), from the repository root, so variables and functions carry from one block to the next.
Untagged blocks are illustrations and never run. The run fails when a block fails (naming its
step), and before anything runs when the guide has no block for a required step. `--skip` leaves
out steps the caller cannot run (the keyed step on a machine with no key).
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from pathlib import Path

#: The steps the guide must have, in the order a reader meets them (plan M8 Task 5).
REQUIRED_STEPS = (
    "prerequisites",
    "install",
    "images",
    "doctor",
    "fixture",
    "manual",
    "keyed",
)

MARKER = re.compile(r"^<!--\s*setup:\s*([a-z][a-z0-9_-]*)\s*-->\s*$")
FENCE = re.compile(r"^```(\S*)\s*$")


@dataclass(frozen=True)
class Step:
    name: str
    code: str
    #: The 1-based line of the block's opening fence.
    line: int


def parse_guide(text: str) -> list[Step]:
    """The guide's runnable blocks, in order."""
    lines = text.splitlines()
    steps: list[Step] = []
    pending: str | None = None
    i = 0
    while i < len(lines):
        line = lines[i]
        marker = MARKER.match(line)
        fence = FENCE.match(line)
        if marker:
            pending = marker.group(1)
        elif fence:
            start = i
            i += 1
            body: list[str] = []
            while i < len(lines) and not lines[i].startswith("```"):
                body.append(lines[i])
                i += 1
            if pending and fence.group(1) == "bash":
                steps.append(Step(pending, "\n".join(body) + "\n", start + 1))
            pending = None
        elif line.strip():
            pending = None
        i += 1
    return steps


def missing_steps(steps: Iterable[Step], required: Iterable[str]) -> list[str]:
    names = {s.name for s in steps}
    return [r for r in required if r not in names]


def build_script(steps: Iterable[Step], guide_name: str) -> str:
    out = [
        "set -Eeuo pipefail",
        'trap \'rc=$?; echo "setup-doc: step $CINEWRIGHT_SETUP_STEP failed (exit $rc)" >&2;'
        " exit $rc' ERR",
    ]
    for s in steps:
        out.append(f"CINEWRIGHT_SETUP_STEP={s.name}")
        out.append(f"echo '== setup step {s.name} ({guide_name}:{s.line})'")
        out.append(s.code.rstrip("\n"))
    return "\n".join(out) + "\n"


def run_guide(
    guide: Path,
    repo: Path,
    required: Iterable[str] = REQUIRED_STEPS,
    skip: set[str] | None = None,
    env: Mapping[str, str] | None = None,
) -> int:
    """Run the guide's blocks; the exit code of the first failing block, 2 for a bad guide."""
    steps = parse_guide(guide.read_text())
    missing = missing_steps(steps, required)
    if missing:
        for name in missing:
            print(f"setup-doc: {guide.name} has no block for step {name}", file=sys.stderr)
        return 2
    skip = skip or set()
    unknown = sorted(skip - {s.name for s in steps})
    if unknown:
        print(f"setup-doc: cannot skip {', '.join(unknown)}: no such step", file=sys.stderr)
        return 2
    chosen = [s for s in steps if s.name not in skip]
    for name in dict.fromkeys(s.name for s in steps if s.name in skip):
        print(f"== setup step {name}: skipped", flush=True)
    script = build_script(chosen, guide.name)
    done = subprocess.run(["bash", "-c", script], cwd=repo, env=env, check=False)
    return done.returncode


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="cinewright-setup-doc", description="Run the setup guide's code blocks."
    )
    parser.add_argument("--guide", type=Path, default=Path("docs/SETUP.md"))
    parser.add_argument("--repo", type=Path, default=Path("."))
    parser.add_argument("--skip", action="append", default=[], help="a step to leave out")
    parser.add_argument("--list", action="store_true", help="list the steps and run nothing")
    args = parser.parse_args(argv)
    if args.list:
        for s in parse_guide(args.guide.read_text()):
            print(f"{s.name}\t{args.guide}:{s.line}")
        return 0
    return run_guide(args.guide, args.repo, skip=set(args.skip))


if __name__ == "__main__":
    sys.exit(main())
