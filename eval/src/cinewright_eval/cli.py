"""`cinewright-eval`: benchmark tooling. Subcommand `cas-export <project> --to <dir>`."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from cinewright_eval.cas_export import ExportError, export


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="cinewright-eval")
    sub = parser.add_subparsers(dest="command", required=True)
    cas = sub.add_parser(
        "cas-export", help="write a project's CAS objects as flat files named by hex"
    )
    cas.add_argument("project", type=Path)
    cas.add_argument("--to", required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        exported = export(args.project, args.to)
    except ExportError as error:
        print(f"cinewright-eval cas-export: {error}", file=sys.stderr)
        return 1
    for item in exported:
        print(json.dumps({"hash": item.hash, "bytes": item.bytes, "role": item.role}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
