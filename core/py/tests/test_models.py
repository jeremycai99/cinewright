"""Every valid schema fixture parses into the generated models and serializes back unchanged."""

import json
from pathlib import Path

import pytest
from pydantic import BaseModel, ValidationError

from cinewright_ir import models

FIXTURES = Path(__file__).resolve().parents[2] / "test" / "fixtures" / "schema"

# Fixture directory -> the generated model its documents parse into.
MODELS: dict[str, type[BaseModel]] = {
    "asset": models.Asset,
    "cast": models.CastMember,
    "delivery-profile": models.DeliveryProfile,
    "project": models.Project,
    "script": models.Script,
    "sequence": models.Sequence,
}


def _valid_cases() -> list[tuple[str, Path]]:
    return [
        (directory, path)
        for directory in sorted(MODELS)
        for path in sorted((FIXTURES / directory / "valid").glob("*.json"))
    ]


def test_every_fixture_directory_has_a_model() -> None:
    directories = {p.name for p in FIXTURES.iterdir() if p.is_dir()}
    assert directories <= set(MODELS)


@pytest.mark.parametrize(("directory", "path"), _valid_cases(), ids=lambda v: str(v))
def test_valid_fixture_round_trips(directory: str, path: Path) -> None:
    data = json.loads(path.read_text(encoding="utf-8"))
    model = MODELS[directory].model_validate(data)
    assert model.model_dump(mode="json", by_alias=True, exclude_unset=True) == data


def test_unknown_property_is_rejected() -> None:
    path = FIXTURES / "project" / "invalid" / "unknown-property.json"
    with pytest.raises(ValidationError):
        models.Project.model_validate(json.loads(path.read_text(encoding="utf-8")))
