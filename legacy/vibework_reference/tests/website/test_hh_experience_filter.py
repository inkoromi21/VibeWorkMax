"""Фильтр опыта вакансий (годы → коды hh.ru)."""

from __future__ import annotations

import sys
from pathlib import Path

_WEBSITE = Path(__file__).resolve().parents[2] / "website"
_BACKEND = _WEBSITE / "backend"
sys.path.insert(0, str(_WEBSITE))
sys.path.insert(0, str(_BACKEND))

from app.api_schemas import EducationLevel, Interest, JobMatchRequest, MockVacancy, WorkFormat  # noqa: E402
from app.career_advisor import filter_vacancy_list  # noqa: E402
from app.hh_client import _experience_params, normalize_job_experience, resolve_match_experience  # noqa: E402
from wibe_work.services.hh_filter import _map_experience  # noqa: E402


def test_normalize_hh_codes() -> None:
    assert normalize_job_experience("between1And3") == "between1And3"
    assert normalize_job_experience("moreThan6") == "moreThan6"
    assert normalize_job_experience("") is None
    assert normalize_job_experience("any") is None


def test_legacy_grade_maps_to_hh() -> None:
    assert normalize_job_experience("джуниор") == "between1And3"
    assert normalize_job_experience("стажер") == "noExperience"


def test_experience_params_single_code() -> None:
    assert _experience_params("between3And6") == [("experience", "between3And6")]


def test_map_experience_second_year_medium() -> None:
    assert (
        _map_experience(
            {
                "education_detail": "univ_bachelor",
                "course_grade": "2 курс",
                "preparation_level": "medium",
            }
        )
        == "noExperience"
    )
    assert (
        _map_experience(
            {
                "education_detail": "univ_bachelor",
                "course_grade": "2 курс",
                "preparation_level": "средний",
            }
        )
        == "noExperience"
    )


def test_resolve_match_uses_profile_when_level_empty() -> None:
    req = JobMatchRequest(
        interests=[Interest.IT],
        level=None,
        education_detail="univ_bachelor",
        course_grade="2 курс",
        preparation_level="средний",
    )
    assert resolve_match_experience(req) == "noExperience"


def test_resolve_match_any_skips_profile() -> None:
    req = JobMatchRequest(
        interests=[Interest.IT],
        level="any",
        education_detail="univ_bachelor",
        course_grade="2 курс",
        preparation_level="средний",
    )
    assert resolve_match_experience(req) is None


def _vac(title: str, level: EducationLevel) -> MockVacancy:
    return MockVacancy(
        id=title,
        title=title,
        company="Co",
        city="Москва",
        level=level,
        work_format=WorkFormat.REMOTE,
        profession_tag="IT",
        requirements=["Python"],
        source_url="https://hh.ru",
    )


def test_filter_drops_senior_for_no_experience() -> None:
    items = [
        _vac("Стажёр Python", EducationLevel.INTERN),
        _vac("Senior Python Developer", EducationLevel.SENIOR),
        _vac("Ведущий разработчик", EducationLevel.MIDDLE),
    ]
    out = filter_vacancy_list(items, None, "noExperience")
    titles = [v.title for v in out]
    assert "Стажёр Python" in titles
    assert "Senior Python Developer" not in titles
    assert "Ведущий разработчик" not in titles
