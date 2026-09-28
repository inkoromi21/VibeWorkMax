"""Теги профессий для вакансий hh.ru и фильтр по сфере."""

from __future__ import annotations

import sys
from pathlib import Path

_REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(_REPO / "website"))
sys.path.insert(0, str(_REPO / "website" / "backend"))

from app.api_schemas import Interest, MockVacancy, EducationLevel, WorkFormat  # noqa: E402
from app.career_advisor import _filter_by_profession, _interest_matches_vacancy  # noqa: E402
from app.hh_client import _infer_profession_tag  # noqa: E402


def _vac(title: str, tag: str) -> MockVacancy:
    return MockVacancy(
        id="x",
        title=title,
        company="Co",
        requirements=[],
        profession_tag=tag,
        level=EducationLevel.JUNIOR,
        city="Москва",
        work_format=WorkFormat.HYBRID,
    )


def test_infer_profession_tag_from_title() -> None:
    assert _infer_profession_tag("Frontend-разработчик", [], Interest.DESIGN) == "IT"
    assert _infer_profession_tag("UX/UI дизайнер", [], Interest.IT) == "дизайн"
    assert _infer_profession_tag("Маркетолог digital", [], Interest.IT) == "маркетинг"
    assert _infer_profession_tag("Случайная роль", [], Interest.ENGINEERING) == "инженерия"


def test_filter_by_sphere_label() -> None:
    items = [
        _vac("Java developer", "IT"),
        _vac("UX дизайнер", "дизайн"),
    ]
    out = _filter_by_profession(items, "Дизайн")
    assert len(out) == 1
    assert "дизайн" in out[0].title.lower() or out[0].profession_tag == "дизайн"


def test_interest_matches_it_tag() -> None:
    v = _vac("Backend dev", "IT")
    assert _interest_matches_vacancy(Interest.DATA_AI, v)
