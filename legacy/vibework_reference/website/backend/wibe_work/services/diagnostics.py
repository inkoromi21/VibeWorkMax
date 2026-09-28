from typing import Any, Dict, List

from wibe_work.services.user_context import (
    merge_skills_from_profile,
    normalize_education,
    parse_interest_spheres,
)


def _basic_data_block(profile: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "age": profile.get("age"),
        "interests": profile.get("interests"),
        "interest_spheres": parse_interest_spheres(profile),
        "education_level": profile.get("education_level"),
        "course_or_grade": profile.get("course_or_grade"),
        "city": profile.get("city"),
        "work_format_preference": profile.get("work_format_preference"),
        "work_schedule": profile.get("work_schedule"),
        "target_salary": profile.get("target_salary"),
        "internship_ready": profile.get("internship_ready"),
        "hours_per_week": profile.get("hours_per_week"),
        "career_priority": profile.get("career_priority"),
    }


def _soft_skills_block(profile: Dict[str, Any]) -> Dict[str, Any]:
    keys = [
        ("soft_communication", "коммуникабельность"),
        ("soft_teamwork", "работа в команде"),
        ("soft_organization", "самоорганизация"),
        ("soft_stress", "стрессоустойчивость"),
        ("soft_creativity", "креативность"),
        ("soft_analytical", "аналитическое мышление"),
    ]
    out: Dict[str, Any] = {}
    filled = 0
    for col, label in keys:
        v = profile.get(col)
        if v is not None:
            try:
                iv = int(v)
                if 1 <= iv <= 5:
                    out[label] = iv
                    filled += 1
            except (TypeError, ValueError):
                pass
    return {
        "scores": out,
        "filled_count": filled,
        "methodology_note": "Шкалы 1–5 по методологии опросника (см. таблицу полей профиля).",
    }


def _analyze_skills(
    profile: Dict[str, Any], competencies: List[Dict[str, Any]]
) -> Dict[str, Any]:
    names, levels = merge_skills_from_profile(competencies, profile)
    everyday = []
    for field, label in [
        ("experience_projects", "проекты"),
        ("experience_volunteer", "волонтёрство"),
        ("experience_side", "подработки"),
        ("achievements", "достижения"),
    ]:
        val = profile.get(field)
        if val and str(val).strip():
            everyday.append(f"{label}: есть описание — учитывайте как опыт в резюме.")

    if not names:
        notes = [
            "Добавьте навыки: блок «Компетенции» или поля «Программирование», SMM в профиле.",
        ]
        notes.extend(everyday)
        return {
            "registered_skills": [],
            "skill_count": 0,
            "average_level": None,
            "everyday_evidence_hints": everyday,
            "notes": notes,
        }
    avg = sum(levels.get(n.lower(), 3) for n in names) / len(names)
    strong = [n for n in names if levels.get(n.lower(), 0) >= 4]
    weak = [n for n in names if levels.get(n.lower(), 5) <= 2]
    return {
        "registered_skills": [{"name": n, "level": levels.get(n.lower(), 3)} for n in names],
        "skill_count": len(names),
        "average_level": round(avg, 2),
        "strengths": strong,
        "growth_areas": weak,
        "everyday_evidence_hints": everyday,
        "notes": [],
    }


def run_diagnostics(
    profile: Dict[str, Any], competencies: List[Dict[str, Any]]
) -> Dict[str, Any]:
    gaps: List[str] = []
    if profile.get("age") is None:
        gaps.append("Не указан возраст — нужен для подбора вакансий и этапов развития.")
    age = profile.get("age")
    if age is not None:
        try:
            ai = int(age)
            if ai < 14 or ai > 30:
                gaps.append(
                    "Возраст вне фокуса продукта 14–30 лет (по методич. опросника); данные всё равно учитываются."
                )
        except (TypeError, ValueError):
            pass
    if not profile.get("interests") and not parse_interest_spheres(profile):
        gaps.append("Интересы не заполнены — укажите текстом или сферы (interest_spheres).")
    edu = normalize_education(profile.get("education_level"))
    if edu in ("", "не указано"):
        gaps.append("Уровень образования не указан.")
    skills = _analyze_skills(profile, competencies)
    completeness = max(0.0, 1.0 - 0.15 * len(gaps))
    if skills["skill_count"] == 0:
        completeness *= 0.85
    if _soft_skills_block(profile)["filled_count"] == 0:
        completeness *= 0.95

    return {
        "basic_data": _basic_data_block(profile),
        "soft_skills_self_rating": _soft_skills_block(profile),
        "skills_analysis": skills,
        "experience_fields": {
            "official": profile.get("experience_official"),
            "side": profile.get("experience_side"),
            "volunteer": profile.get("experience_volunteer"),
            "projects": profile.get("experience_projects"),
        },
        "data_gaps": gaps,
        "profile_completeness_score": round(completeness, 2),
    }
