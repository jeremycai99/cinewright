"""`cinewright-eval`: benchmark tooling: `cas-export` (A.1), `tier-a` (M8.3a), `baseline` (M6.2),
`briefs` and `snapshot` (M8.2)."""

from __future__ import annotations

import argparse
import json
import os
import shlex
import sys
from pathlib import Path

from cinewright_eval.baseline import check, load_runs, record
from cinewright_eval.briefs import check as check_briefs
from cinewright_eval.briefs import init_project
from cinewright_eval.cas_export import ExportError, export
from cinewright_eval.snapshot import SnapshotError, snapshot
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
    base = sub.add_parser("baseline", help="record or check a vision baseline (M6.2)")
    base_sub = base.add_subparsers(dest="action", required=True)
    rec = base_sub.add_parser("record", help="a baseline from run files")
    rec.add_argument("runs", nargs="+", type=Path)
    rec.add_argument("--pins", required=True, type=Path, help="JSON of the pinned versions (D36)")
    rec.add_argument("--floor", type=int, default=2)
    rec.add_argument("--out", required=True, type=Path)
    chk = base_sub.add_parser("check", help="runs against a baseline's thresholds")
    chk.add_argument("runs", nargs="+", type=Path)
    chk.add_argument("--against", required=True, type=Path)
    briefs = sub.add_parser("briefs", help="check the benchmark briefs or make a project for one")
    briefs_sub = briefs.add_subparsers(dest="action", required=True)
    bcheck = briefs_sub.add_parser("check", help="validate every brief and the coverage rules")
    bcheck.add_argument("--root", type=Path, default=Path.cwd())
    binit = briefs_sub.add_parser("init", help="a project for one brief")
    binit.add_argument("id")
    binit.add_argument("--to", required=True, type=Path)
    binit.add_argument("--pack", default=None)
    binit.add_argument("--root", type=Path, default=Path.cwd())
    binit.add_argument("--cli", default=os.environ.get("CINEWRIGHT_CLI"))
    snap = sub.add_parser("snapshot", help="freeze a clean tier B run as a tier A fixture")
    snap.add_argument("project", type=Path)
    snap.add_argument("--as", dest="fixture", required=True)
    snap.add_argument("--root", type=Path, default=Path.cwd())
    args = parser.parse_args(argv)
    if args.command == "briefs":
        root = args.root.resolve()
        if args.action == "check":
            errors, table = check_briefs(root)
            print(table)
            for e in errors:
                print(f"cinewright-eval briefs: {e}", file=sys.stderr)
            return 1 if errors else 0
        cli = shlex.split(args.cli) if args.cli else ["node", str(root / "cli" / "dist" / "bin.js")]
        return init_project(root, args.id, args.to, cli, args.pack)
    if args.command == "snapshot":
        try:
            folder = snapshot(args.project.resolve(), args.fixture, args.root.resolve())
        except SnapshotError as error:
            print(f"cinewright-eval snapshot: {error}", file=sys.stderr)
            return 1
        print(folder)
        return 0
    if args.command == "baseline":
        runs = load_runs(args.runs)
        if args.action == "record":
            doc = record(runs, json.loads(args.pins.read_text()), args.floor)
            args.out.parent.mkdir(parents=True, exist_ok=True)
            args.out.write_text(json.dumps(doc, indent=2, sort_keys=True) + "\n")
            return 0
        rows = check(runs, json.loads(args.against.read_text()))
        for row in rows:
            print(json.dumps(row))
        return 0 if rows and all(r["pass"] for r in rows) else 1
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
