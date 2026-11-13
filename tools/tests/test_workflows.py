from pathlib import Path

from cinewright_tools.workflows import check_workflows, required_checks

FIX = Path(__file__).parent / "fixtures" / "workflows"
REPO = Path(__file__).resolve().parents[2]


def test_clean_workflows_pass() -> None:
    assert check_workflows(FIX / "clean", {"ts"}) == []


def test_rejects_pull_request_target() -> None:
    assert check_workflows(FIX / "prt", set()) == ["prt.yml: uses pull_request_target"]


def test_requires_top_level_permissions() -> None:
    assert check_workflows(FIX / "noperms", set()) == ["noperms.yml: no top-level permissions"]


def test_rejects_write_on_pull_request() -> None:
    assert check_workflows(FIX / "prwrite", set()) == [
        "prwrite.yml: job build requests packages: write on pull_request"
    ]


def test_required_check_must_exist_on_pull_request() -> None:
    assert check_workflows(FIX / "clean", {"ts", "lint"}) == [
        "required check 'lint' is not a pull_request job"
    ]


def test_required_job_must_not_use_secrets() -> None:
    assert check_workflows(FIX / "secret", {"ts"}) == [
        "secret.yml: required job ts references secrets"
    ]


def test_required_checks_read_from_ruleset() -> None:
    assert required_checks(REPO / ".github/rulesets/main.json") == {
        "ts",
        "py",
        "boundaries",
        "workflow-safety",
    }
