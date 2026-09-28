"""Сигналы из анкеты и теста для строгого подбора курсов и материалов."""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional, Tuple

from wibe_work.services.assessment_routing import track_meta, uses_job_search_assessment

# Сфера → трек по умолчанию, если тест не дал IT-technical track
_SPHERE_DEFAULT_TRACK: Dict[str, Optional[str]] = {
    "it_dev": None,
    "data": "data",
    "design": "design",
    "creative": "design",
    "marketing": "marketing",
    "sales": "marketing",
    "mgmt": "pm",
    "finance": "data",
    "hr_edu": None,
    "logistics": None,
    "medicine": None,
    "education": None,
    "engineering": None,
    "sport": None,
    "other": None,
}

# Ключевые слова плана → track (общий с personalized_advice)
_TRACK_HINTS: List[Tuple[str, Tuple[str, ...]]] = [
    ("devops", ("devops", "релиз", "инфраструкт", "docker", "kubernetes", "ci/cd")),
    ("backend", ("backend", "бэкенд", "python", "api", "сервер", "fastapi")),
    ("frontend", ("frontend", "фронт", "javascript", "вёрст", "react", "html")),
    ("data", ("data", "аналит", "sql", "pandas", "ml", "данн")),
    ("design", ("design", "дизайн", "ux", "ui", "figma")),
    ("marketing", ("маркет", "smm", "digital", "реклам", "crm")),
    ("qa", ("qa", "тест", "quality")),
    ("pm", ("продукт", "product", "agile", "scrum", "менедж", "проект")),
]


def infer_track_from_plan_name(plan_name: str) -> Optional[str]:
    low = (plan_name or "").lower()
    for track, kws in _TRACK_HINTS:
        if any(k in low for k in kws):
            return track
    return None


def _clean_plan_name(name: str) -> str:
    return re.sub(r"^(?:план|вариант)\s+[abc]:\s*", "", (name or ""), flags=re.I).strip()


def _dominant_axis(axes: List[Dict[str, Any]]) -> str:
    if not axes:
        return "structure_mastery"
    best = max(axes, key=lambda a: int(a.get("value_percent") or 0))
    return str(best.get("key") or "structure_mastery")


def _priority_skills(gap: Dict[str, Any]) -> List[str]:
    closing = gap.get("closing_skills") or []
    if closing:
        return [str(x).lower() for x in closing[:6]]
    out: List[str] = []
    for bar in gap.get("bars") or []:
        lab = bar.get("label") or bar.get("key")
        if lab:
            out.append(str(lab).lower())
    return out[:6]


def resolve_learning_track(
    *,
    sphere: str,
    scenarios: Optional[Dict[str, Any]],
    answers: Optional[List[Dict[str, Any]]],
    axes: Optional[List[Dict[str, Any]]],
) -> Tuple[Optional[str], str]:
    """
    Трек обучения: technical IT → лучший план A/B/C → дефолт сферы.
    Возвращает (track_id, source).
    """
    scenarios = scenarios or {}
    sphere = (sphere or "other").strip()

    inf = scenarios.get("inferred_profession") or {}
    tid = inf.get("track_id")
    if tid:
        return str(tid), "inferred_profession"

    if sphere == "it_dev" and answers:
        from wibe_work.services.career_analysis import infer_it_track_from_answers

        t = infer_it_track_from_answers(answers)
        if t:
            return t, "it_technical_answers"

    best = _clean_plan_name(str(scenarios.get("best_plan_name") or ""))
    plans = scenarios.get("plans") or []
    if not best and plans:
        best = _clean_plan_name(str(plans[0].get("name") or ""))
    if best:
        t = infer_track_from_plan_name(best)
        if t:
            return t, "best_scenario_plan"

    default = _SPHERE_DEFAULT_TRACK.get(sphere)
    if default:
        return default, "sphere_default"

    dom = _dominant_axis(axes or [])
    if dom == "people_service" and sphere in ("marketing", "sales"):
        return "marketing", "dominant_axis"
    if dom == "structure_mastery" and sphere == "data":
        return "data", "dominant_axis"

    return None, "none"


def build_assessment_signals(
    *,
    profile: Dict[str, Any],
    interest: str,
    preparation_level: str,
    scenarios: Optional[Dict[str, Any]] = None,
    gap: Optional[Dict[str, Any]] = None,
    axes: Optional[List[Dict[str, Any]]] = None,
    answers: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    """Единый контракт: сфера, трек, навыки и мета для learning/advice."""
    from wibe_work.services.career_analysis import _resolve_effective_interest

    scenarios = scenarios or {}
    gap = gap or {}
    sphere = _resolve_effective_interest(profile, interest)
    track, track_source = resolve_learning_track(
        sphere=sphere,
        scenarios=scenarios,
        answers=answers,
        axes=axes,
    )
    best = _clean_plan_name(str(scenarios.get("best_plan_name") or ""))
    if not best:
        plans = scenarios.get("plans") or []
        if plans:
            best = _clean_plan_name(str(plans[0].get("name") or ""))

    meta = track_meta(profile)
    prep = preparation_level if preparation_level in ("weak", "medium", "strong") else "medium"
    from wibe_work.services.profile_analysis_context import (
        analysis_mode_for_profile,
        education_grade,
    )

    grade = education_grade(profile)
    mode = analysis_mode_for_profile(profile)

    return {
        "sphere": sphere,
        "track": track,
        "track_source": track_source,
        "preparation_level": prep,
        "dominant_axis": _dominant_axis(axes or []),
        "priority_skills": _priority_skills(gap),
        "best_plan_name": best,
        "assessment_track": meta.get("track_id"),
        "uses_job_search": uses_job_search_assessment(profile),
        "education_grade": grade,
        "analysis_mode": mode,
        "catalog_min_score": 6 if mode == "school" else 8,
    }


def resource_match_score(
    resource: Dict[str, Any],
    signals: Dict[str, Any],
) -> int:
    """0 = не показывать; чем выше — тем ближе к разбору."""
    sphere = str(signals.get("sphere") or "other")
    track = (signals.get("track") or "").strip().lower()
    prep = str(signals.get("preparation_level") or "medium")
    priority = [str(s).lower() for s in (signals.get("priority_skills") or [])]

    spheres = resource.get("spheres") or []
    tracks = [str(t).lower() for t in (resource.get("tracks") or [])]
    skills = " ".join(str(s) for s in (resource.get("skills") or [])).lower()
    title = str(resource.get("title") or "").lower()
    rid = str(resource.get("id") or "").lower()

    if spheres:
        if sphere in spheres:
            score = 12
        elif sphere == "other" and len(spheres) >= 4:
            score = 5
        else:
            return 0
    else:
        score = 3

    if track:
        if tracks:
            if track in tracks:
                score += 18
            else:
                return 0
        elif track in title or track in skills or track in rid:
            score += 8

    for sk in priority:
        if len(sk) > 2 and (sk in skills or sk in title or sk.replace(" ", "_") in rid):
            score += 5

    level = str(resource.get("level") or "")
    if prep == "weak" and level == "beginner":
        score += 3
    if prep == "strong" and level == "intermediate":
        score += 2

    return score


def resource_allowed(resource: Dict[str, Any], signals: Dict[str, Any]) -> bool:
    from wibe_work.services.profile_analysis_context import career_resource_blocked_for_school

    if signals.get("analysis_mode") == "school":
        if career_resource_blocked_for_school(resource):
            return False
    min_score = int(signals.get("catalog_min_score") or 8)
    return resource_match_score(resource, signals) >= min_score
