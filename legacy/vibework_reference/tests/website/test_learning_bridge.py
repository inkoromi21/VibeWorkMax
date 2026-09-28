"""Интеграция каталога обучения в веб-разбор."""

from __future__ import annotations

import sys
from pathlib import Path

_REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(_REPO / "website"))
sys.path.insert(0, str(_REPO / "website" / "backend"))

from app.api_schemas import (
    CareerDirection,
    DiagnosisPayload,
    Education,
    GapAnalysis,
    GapBar,
    Interest,
    PersonalityTestAnswer,
    TestAnswer,
)
from app.career_advisor import pick_directions
from app.learning_bridge import build_learning_pack_for_website


def _minimal_payload() -> DiagnosisPayload:
    return DiagnosisPayload(
        age=18,
        interests=[Interest.IT],
        education=Education.SCHOOL,
        test_answers=[TestAnswer(question_id=i, choice="A") for i in range(1, 11)],
        personality_test_answers=[PersonalityTestAnswer(question_id=i, choice="A") for i in range(1, 13)],
        profile_extra={
            "education_detail": "school_8_11",
            "course_grade": "10 класс",
            "main_sphere": "it_dev",
            "preparation_level": "medium",
        },
        preparation_level="средний",
    )


def test_learning_pack_has_path_and_materials() -> None:
    gap = GapAnalysis(
        headline="test",
        overall_hp=55,
        bars=[GapBar(label="SQL", user_percent=40, target_percent=70, gap_percent=30)],
        closing_skills=["Python"],
    )
    payload = _minimal_payload()
    raw = pick_directions(payload)
    directions = [
        CareerDirection(
            plan_code=code,
            name=name,
            match_score=score,
            rationale=why,
            first_steps=["шаг"],
        )
        for code, name, score, why in raw
    ]
    pack = build_learning_pack_for_website(
        payload,
        directions=directions,
        gap=gap,
        profile_summary="тест",
    )
    lp = pack.get("learning_path_detail") or {}
    assert lp.get("path_id")
    steps = lp.get("steps") or []
    assert len(steps) >= 3
    assert steps[0].get("resources")
    assert pack.get("growth_stages_rich")
    assert pack.get("individual_advice", {}).get("by_plan")
