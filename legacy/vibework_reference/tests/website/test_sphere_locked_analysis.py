"""Разбор и «близкие направления» остаются внутри выбранной сферы."""

from __future__ import annotations

import sys
from pathlib import Path

_WEBSITE = Path(__file__).resolve().parents[2] / "website"
_BACKEND = _WEBSITE / "backend"
sys.path.insert(0, str(_WEBSITE))
sys.path.insert(0, str(_BACKEND))

from app.api_schemas import Interest, SkillKey  # noqa: E402
from app.career_advisor import DIRECTION_POOLS as ADVISOR_DIRECTION_POOLS  # noqa: E402
from app.career_advisor import pick_directions, rank_mts_tracks  # noqa: E402
from app.api_schemas import DiagnosisPayload, Education  # noqa: E402
from wibe_work.services.career_analysis import (  # noqa: E402
    DIRECTION_POOLS,
    _direction_interest_key,
    _pick_scenario_plans,
    _rank_mts_rows,
    infer_interest_from_test_answers,
)


def test_web_it_maps_to_it_dev_pool() -> None:
    assert _direction_interest_key("IT") == "it_dev"
    assert _direction_interest_key("it_dev") == "it_dev"


def test_infer_keeps_it_dev_when_sphere_selected() -> None:
    profile = {
        "main_sphere": "it_dev",
        "interest_spheres": ["it_dev"],
        "like_to_do": "кодить",
    }
    answers = [{"question_id": 1, "choice": "A"}]
    assert infer_interest_from_test_answers(profile, answers, "IT") == "it_dev"
    assert infer_interest_from_test_answers(profile, answers, "it_dev") == "it_dev"


def test_scenario_plans_stay_in_it_pool() -> None:
    axes = [
        {"key": "structure_mastery", "value_percent": 80},
        {"key": "people_service", "value_percent": 40},
        {"key": "self_insight", "value_percent": 30},
        {"key": "balance_autonomy", "value_percent": 20},
    ]
    out = _pick_scenario_plans("it_dev", axes, 42, [])
    names = [p["name"] for p in out["plans"]]
    pool = DIRECTION_POOLS["it_dev"]
    for n in names:
        clean = n.split(": ", 1)[-1]
        assert clean in pool
        assert "Контроль качества данных" not in n
        assert "юрист" not in n.lower()


def test_mts_rows_for_it_are_direction_pool() -> None:
    profile = {"main_sphere": "it_dev", "interest_spheres": ["it_dev"]}
    axes = [
        {"key": "structure_mastery", "value_percent": 70},
        {"key": "people_service", "value_percent": 40},
        {"key": "self_insight", "value_percent": 35},
        {"key": "balance_autonomy", "value_percent": 25},
    ]
    rows = _rank_mts_rows(profile, {}, "IT", [], axes, limit=6)
    titles = " ".join(r["role_name"] for r in rows).lower()
    assert "юрист" not in titles
    assert "кабель" not in titles
    assert "транспорт" not in titles
    assert "закуп" not in titles
    assert any(k in titles for k in ("backend", "frontend", "devops", "qa", "мобильн", "sql"))


def test_legacy_pick_directions_no_data_quality_adjacent() -> None:
    payload = DiagnosisPayload(
        age=20,
        education=Education.UNIVERSITY,
        interests=[Interest.IT],
        skills=[SkillKey.PROGRAMMING],
        preparation_level="средний",
        motivation="нравится кодить",
        test_answers=[],
    )
    dirs = pick_directions(payload)
    names = [d[1] for d in dirs]
    assert "Контроль качества данных" not in names
    for n in names:
        assert n in ADVISOR_DIRECTION_POOLS[Interest.IT]


def test_legacy_rank_mts_it_no_corporate() -> None:
    rows = rank_mts_tracks(Interest.IT, [SkillKey.PROGRAMMING], None)
    blob = " ".join(r.title for r in rows).lower()
    assert "юрист" not in blob
    assert "кабель" not in blob
    assert "транспорт" not in blob
    assert rows
