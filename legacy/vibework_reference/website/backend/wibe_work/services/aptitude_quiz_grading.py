"""Грейд теста: школа / СПО / вуз — по образованию в анкете и при необходимости по возрасту."""

from typing import Any, Dict

from wibe_work.services.user_context import education_rank

_GRADE_LABELS = {
    "school": "Школьный уровень",
    "vocational": "СПО / колледж",
    "university": "Вуз / выпускник",
}

_GRADE_HINTS = {
    "school": "Формулировки для школьников: без «рынка труда» и офисного жаргона.",
    "vocational": "Учёт учебной практики, диплома и первых шагов по специальности.",
    "university": "",
}

# id опции «Уровень образования» в анкете — приоритетнее education_level, если тот не синхронизирован
_EDUCATION_DETAIL_GRADE: Dict[str, str] = {
    "school_9": "school",
    "school_11": "school",
    "school_8_11": "school",
    "school": "school",
    "школа": "school",
    "college": "vocational",
    "college_spo": "vocational",
    "spo": "vocational",
    "technikum": "vocational",
    "колледж": "vocational",
    "univ_bachelor": "university",
    "univ_master": "university",
    "univ_incomplete": "university",
    "graduate": "university",
    "university": "university",
    "university_bachelor": "university",
    "bachelor": "university",
    "master": "university",
    "вуз": "university",
    "высшее": "university",
}

_CANONICAL_DETAIL: Dict[str, str] = {
    "school": "school_8_11",
    "vocational": "spo",
    "university": "univ_bachelor",
}


def normalize_education_detail(profile: Dict[str, Any]) -> str:
    """Канонический education_detail: school_8_11 / spo / univ_bachelor / …"""
    raw = str((profile or {}).get("education_detail") or "").strip().lower()
    if raw in _EDUCATION_DETAIL_GRADE:
        grade = _EDUCATION_DETAIL_GRADE[raw]
        if raw in (
            "school_8_11",
            "school_9",
            "school_11",
            "spo",
            "college_spo",
            "college",
            "technikum",
            "univ_bachelor",
            "univ_master",
            "univ_incomplete",
            "graduate",
        ):
            return raw if raw != "college" else "spo"
        return _CANONICAL_DETAIL.get(grade, raw)

    for key in (
        (profile or {}).get("education_level"),
        (profile or {}).get("education"),
    ):
        k = str(key or "").strip().lower()
        if not k:
            continue
        if k in _EDUCATION_DETAIL_GRADE:
            g = _EDUCATION_DETAIL_GRADE[k]
            return _CANONICAL_DETAIL.get(g, k)
        if "школ" in k:
            return "school_8_11"
        if "колледж" in k or k in ("спо", "spo"):
            return "spo"
        if "вуз" in k or "универ" in k or "бакалав" in k or "магистр" in k:
            return "univ_bachelor"
    return raw


def compute_quiz_grade(profile: Dict[str, Any]) -> str:
    """
    school — 9–11 класс, школьник в анкете.
    vocational — колледж, техникум, СПО.
    university — неполное высшее и выше.
    Если образование не указано — ориентир по возрасту (до 17 / до 21 / далее).
    Значение education «вуз» не должно проигрывать возрасту.
    """
    detail = normalize_education_detail(profile or {})
    if detail:
        g = _EDUCATION_DETAIL_GRADE.get(detail)
        if g:
            return g

    raw = profile.get("education_level") if profile else None
    rank = None
    if raw is not None and str(raw).strip():
        rank = education_rank(raw)

    edu_enum = str((profile or {}).get("education") or "").strip().lower()
    if edu_enum in ("вуз", "university"):
        return "university"
    if edu_enum in ("колледж", "college"):
        return "vocational"
    if edu_enum in ("школа", "school"):
        return "school"

    age_val = (profile or {}).get("age")
    age = None
    if age_val is not None and str(age_val).strip() != "":
        try:
            age = int(age_val)
        except (TypeError, ValueError):
            age = None

    if rank is not None:
        if rank >= 3:
            return "university"
        if rank == 2:
            return "vocational"
        if rank == 1:
            return "school"
        # rank 0 — «не указано» / пусто в анкете; дальше возраст

    if age is not None:
        if age <= 17:
            return "school"
        if age <= 21:
            return "vocational"
        return "university"

    return "university"


def quiz_grade_label(grade: str) -> str:
    return _GRADE_LABELS.get(grade, grade)


def quiz_grade_hint(grade: str) -> str:
    return _GRADE_HINTS.get(grade, "")
