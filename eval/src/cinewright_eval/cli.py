"""`cinewright-eval`: benchmark tooling. Subcommands `cas-export` (A.1) and `tier-a` (M8.3a)."""

from __future__ import annotations

import argparse
import json
import os
import shlex
import sys
from pathlib import Path

from cinewright_eval.cas_export import ExportError, export
from cinewright_eval.tier_a import TierAOptions, run_tier_a


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="cinewright-eval")
    sub = parser.add_subparsers(dest="command", required=True)
    cas = sub.add_parser(
        "cas-export", help="write a project's CAS objects as flat files named by hex"
    )
    cas.add_argument("project", type=Path)
    cas.add_argument("--to", required=True, type=Path)
    tier = sub.add_parser("tier-a", help="render and grade the alpha fixtures (M8.3a)")
    tier.add_argument("--fixture", action="append", default=[], help="only this fixture id")
    tier.add_argument("--runner-class", default="linux-amd64")
    tier.add_argument("--out", type=Path, default=Path("tier-a-report"))
    tier.add_argument("--update-expected", action="store_true")
    tier.add_argument(
        "--cache", type=Path, default=None, help="render caches (default: <root>/.tier-a-cache)"
    )
    tier.add_argument("--root", type=Path, default=Path.cwd(), help="the repository root")
    tier.add_argument(
        "--cli",
        default=os.environ.get("CINEWRIGHT_CLI"),
        help="the cinewright command (default: node <root>/cli/dist/bin.js)",
    )
    args = parser.parse_args(argv)
    if args.command == "tier-a":
        root = args.root.resolve()
        cli = shlex.split(args.cli) if args.cli else ["node", str(root / "cli" / "dist" / "bin.js")]
        return run_tier_a(
            TierAOptions(
                root=root,
                cli=cli,
                out=args.out,
                cache=args.cache or root / ".tier-a-cache",
                runner_class=args.runner_class,
                fixtures=args.fixture,
                update_expected=args.update_expected,
            )
        )
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
