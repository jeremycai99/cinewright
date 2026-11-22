"""Workflow safety check (M0.3): fork PRs run the required checks with no secrets.

Rules:

1. No workflow uses ``pull_request_target``.
2. Every workflow sets top-level ``permissions``.
3. A workflow triggered by ``pull_request`` requests no ``write`` permission anywhere.
4. Every required check is the check name (job ``name``, else job id) of a job in a
   workflow triggered by ``pull_request``.
5. Required jobs reference no secrets.
6. A workflow that spends money (tier B, or one that references a provider key) is never
   triggered by ``pull_request`` (M8.3b).
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import cast

import yaml

type Mapping = dict[object, object]


def required_checks(ruleset_path: Path) -> set[str]:
    """Status-check contexts required by a GitHub ruleset JSON file."""
    ruleset = cast(dict[str, object], json.loads(ruleset_path.read_text(encoding="utf-8")))
    contexts: set[str] = set()
    for rule in cast(list[dict[str, object]], ruleset.get("rules", [])):
        if rule.get("type") != "required_status_checks":
            continue
        params = cast(dict[str, object], rule.get("parameters", {}))
        for check in cast(list[dict[str, object]], params.get("required_status_checks", [])):
            contexts.add(str(check["context"]))
    return contexts


def check_workflows(workflow_dir: Path, required: set[str]) -> list[str]:
    """Human-readable problems with the workflows in ``workflow_dir``, sorted."""
    problems: list[str] = []
    pr_check_names: set[str] = set()
    files = sorted([*workflow_dir.glob("*.yml"), *workflow_dir.glob("*.yaml")])
    for path in files:
        name = path.name
        loaded: object = yaml.safe_load(path.read_text(encoding="utf-8"))
        if not isinstance(loaded, dict):
            problems.append(f"{name}: not a workflow mapping")
            continue
        workflow = cast(Mapping, loaded)
        triggers = _triggers(workflow)
        on_pr = "pull_request" in triggers
        text = path.read_text(encoding="utf-8")
        spends = name.startswith("tier-b") or any(
            f"secrets.{key}" in text for key in ("ANTHROPIC_API_KEY", "ELEVENLABS_API_KEY")
        )
        if on_pr and spends:
            problems.append(f"{name}: spends money on pull_request")
        if "pull_request_target" in triggers:
            problems.append(f"{name}: uses pull_request_target")
        if "permissions" not in workflow:
            problems.append(f"{name}: no top-level permissions")
        elif on_pr:
            for scope in _write_scopes(workflow["permissions"]):
                problems.append(f"{name}: requests {scope} on pull_request")
        jobs_obj = workflow.get("jobs")
        jobs = cast(Mapping, jobs_obj) if isinstance(jobs_obj, dict) else {}
        for job_id, job_obj in jobs.items():
            job = cast(Mapping, job_obj) if isinstance(job_obj, dict) else {}
            check_name = str(job.get("name", job_id))
            if on_pr:
                pr_check_names.add(check_name)
                for scope in _write_scopes(job.get("permissions")):
                    problems.append(f"{name}: job {job_id} requests {scope} on pull_request")
                if check_name in required and _references_secrets(job):
                    problems.append(f"{name}: required job {job_id} references secrets")
    for check in sorted(required - pr_check_names):
        problems.append(f"required check '{check}' is not a pull_request job")
    return sorted(problems)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="cinewright-check-workflows",
        description="Check that workflows are safe for fork PRs and run every required check.",
    )
    parser.add_argument("workflow_dir", type=Path)
    parser.add_argument("ruleset", type=Path)
    args = parser.parse_args(argv)
    problems = check_workflows(args.workflow_dir, required_checks(args.ruleset))
    for problem in problems:
        print(problem)
    return 1 if problems else 0


def _triggers(workflow: Mapping) -> set[str]:
    # YAML 1.1 parses the bare key `on` as the boolean True.
    on = workflow.get("on", workflow.get(True))
    if isinstance(on, str):
        return {on}
    if isinstance(on, list):
        return {str(item) for item in cast(list[object], on)}
    if isinstance(on, dict):
        return {str(key) for key in cast(Mapping, on)}
    return set()


def _write_scopes(permissions: object) -> list[str]:
    if permissions == "write-all":
        return ["write-all"]
    if isinstance(permissions, dict):
        return [
            f"{scope}: write"
            for scope, level in cast(Mapping, permissions).items()
            if level == "write"
        ]
    return []


def _references_secrets(node: object) -> bool:
    if isinstance(node, str):
        return "secrets." in node
    if isinstance(node, dict):
        mapping = cast(Mapping, node)
        return "secrets" in mapping or any(_references_secrets(v) for v in mapping.values())
    if isinstance(node, list):
        return any(_references_secrets(v) for v in cast(list[object], node))
    return False


if __name__ == "__main__":
    sys.exit(main())
