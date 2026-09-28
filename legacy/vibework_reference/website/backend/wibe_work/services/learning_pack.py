"""Общая сборка обучения для разбора (сайт и миниапп)."""

from __future__ import annotations

from typing import Any

from wibe_work.services.learning.assessment_signals import build_assessment_signals
from wibe_work.services.learning.engine import build_learning_for_analysis
from wibe_work.services.learning.growth_stages import build_growth_stages
from wibe_work.services.learning.personalized_advice import build_individual_advice

_PREP_RU_TO_EN = {"слабый": "weak", "средний": "medium", "сильный": "strong"}


def normalize_preparation_level(level: str) -> str:
    s = (level or "medium").strip().lower()
    if s in ("weak", "medium", "strong"):
        return s
    return _PREP_RU_TO_EN.get(s, "medium")


def build_learning_extras(
    *,
    profile: dict[str, Any],
    interest: str,
    preparation_level: str,
    scenarios: dict[str, Any],
    gap: dict[str, Any],
    profile_summary: str = "",
    user_id: str | None = None,
    eff_interest: str | None = None,
    axes: list[dict[str, Any]] | None = None,
    answers: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Каталог, путь, советы и этапы роста — единый контракт для веба и миниаппа."""
    prep = normalize_preparation_level(preparation_level)
    eff = (eff_interest or interest or "other").strip() or "other"
    readiness = int(gap.get("overall_hp") or 50)
    signals = build_assessment_signals(
        profile=profile,
        interest=eff,
        preparation_level=prep,
        scenarios=scenarios,
        gap=gap,
        axes=axes,
        answers=answers,
    )

    pack = build_learning_for_analysis(
        user_id=user_id,
        profile=profile,
        interest=eff,
        preparation_level=prep,
        scenarios=scenarios,
        gap=gap,
        axes=axes,
        answers=answers,
        assessment_signals=signals,
    )
    learning_path = pack.get("learning_path") or {}
    advice = build_individual_advice(
        scenarios=scenarios,
        preparation_level=prep,
        profile=profile,
        gap=gap,
        interest=eff,
        learning_path=learning_path,
        profile_summary=profile_summary,
        user_id=user_id,
        assessment_signals=signals,
    )
    stages = build_growth_stages(
        interest=interest,
        eff_interest=eff,
        preparation_level=prep,
        readiness_percent=readiness,
        profile=profile,
        gap=gap,
        scenarios=scenarios,
        individual_advice=advice,
        learning_path=learning_path,
    )
    cards = pack.get("learning") or []
    return {
        "learning": cards,
        "learning_path": learning_path,
        "learning_path_detail": learning_path,
        "individual_advice": advice,
        "growth_stages": stages,
        "growth_stages_rich": stages,
        "assessment_signals": signals,
    }
