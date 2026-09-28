import json
import re
from typing import Any, Dict, List, Optional, Tuple

from wibe_work.sqlite_db import get_db

EDUCATION_RANK: Dict[str, int] = {
    "": 0,
    "не указано": 0,
    "основное": 0,
    # Сводное значение из анкеты (maps_education) — должно совпадать с рангом вуза / школы
    "школа": 1,
    "school_8_11": 1,
    "school_9": 1,
    "school_11": 1,
    "вуз": 3,
    "школьник": 1,
    "9 классов": 1,
    "среднее": 1,
    "11 классов": 1,
    "студент спо": 2,
    "spo": 2,
    "среднее специальное": 2,
    "колледж": 2,
    "техникум": 2,
    "неполное высшее": 3,
    "студент вуза (бакалавр)": 3,
    "univ_bachelor": 3,
    "бакалавр": 4,
    "студент вуза (магистр)": 4,
    "univ_master": 4,
    "специалист": 4,
    "магистр": 5,
    "выпускник": 4,
    "graduate": 4,
    "аспирантура": 6,
    "докторантура": 7,
}


def normalize_education(level: Optional[str]) -> str:
    if not level:
        return "не указано"
    return re.sub(r"\s+", " ", str(level).strip().lower())


def education_rank(level: Optional[str]) -> int:
    key = normalize_education(level)
    return EDUCATION_RANK.get(key, 2)


def load_profile(user_id: str) -> Dict[str, Any]:
    """Read the legacy profile with the web snapshot overlaid when it exists.

    The website currently saves its profile in ``vibework_snapshots.profile``.
    Keeping that snapshot as the source of truth here lets server-side consumers
    see the same optional fields as the profile UI without a data migration.
    """
    with get_db() as conn:
        row = conn.execute(
            "SELECT * FROM user_profiles WHERE user_id = ?", (user_id,)
        ).fetchone()
        snapshot_row = conn.execute(
            "SELECT payload_json FROM vibework_snapshots WHERE user_id = ?", (user_id,)
        ).fetchone()

    profile = dict(row) if row else {}
    if not snapshot_row or not snapshot_row["payload_json"]:
        return profile
    try:
        snapshot = json.loads(snapshot_row["payload_json"])
    except (json.JSONDecodeError, TypeError):
        return profile
    snapshot_profile = snapshot.get("profile") if isinstance(snapshot, dict) else None
    if not isinstance(snapshot_profile, dict):
        return profile

    # Older snapshots can be flat; current website snapshots keep profile fields
    # in ``sheet`` and a few compatibility fields at the outer level.
    snapshot_values = {
        key: value for key, value in snapshot_profile.items() if key != "sheet"
    }
    sheet = snapshot_profile.get("sheet")
    if isinstance(sheet, dict):
        snapshot_values.update(sheet)
    profile.update(snapshot_values)

    # Legacy consumers still read education_level. This is an in-memory alias,
    # not a write or a migration: the snapshot's detailed status wins.
    if "education_detail" in snapshot_values:
        profile["education_level"] = snapshot_values["education_detail"]
    elif "education" in snapshot_values:
        profile["education_level"] = snapshot_values["education"]
    return profile


def profile_text(raw: Any, *, limit: int | None = None) -> str:
    """Safely display an optional snapshot value without assuming a string."""
    if raw is None:
        return ""
    if isinstance(raw, dict):
        language = str(raw.get("language") or "").strip()
        level = str(raw.get("level") or "").strip()
        text = f"{language} ({level})" if language and level else language
    elif isinstance(raw, (list, tuple, set)):
        text = ", ".join(profile_text(value) for value in raw if profile_text(value))
    else:
        text = str(raw).strip()
    return text[:limit].strip() if limit else text


def profile_choice_values(raw: Any) -> List[str]:
    """Read legacy delimited choices and the current JSON list format safely."""
    if raw is None:
        return []
    value = raw
    if isinstance(value, str):
        value = value.strip()
        if not value:
            return []
        if value.startswith("["):
            try:
                value = json.loads(value)
            except (json.JSONDecodeError, TypeError):
                pass
    if isinstance(value, (list, tuple, set)):
        values = [profile_text(item) for item in value]
    elif isinstance(value, dict):
        values = [profile_text(value)]
    else:
        values = re.split(r"[,;\n]+", str(value))
    seen: set[str] = set()
    out: List[str] = []
    for item in values:
        text = str(item or "").strip()
        key = text.lower()
        if text and key not in seen:
            seen.add(key)
            out.append(text)
    return out


_PRIORITY_RU = {
    "learning": "обучение и рост",
    "money": "деньги и стабильный доход",
    "balance": "баланс жизни и работы",
}


_PAIN_LABELS: Dict[str, str] = {
    "pain_career": "Не знаю, кем стать",
    "pain_no_exp": "Нет опыта",
    "pain_region": "Мало вакансий в городе",
    "pain_money_courses": "Нет денег на курсы",
    "pain_interview": "Боюсь собеседований",
    "pain_overload": "Слишком много информации",
    "pain_low_confidence": "Кажется, что ничего не умею",
    "pain_gap_skills": "Умею многое, но работу не дают",
}

_WORK_FORMAT_RU = {
    "office": "офис",
    "remote": "удалённо",
    "hybrid": "гибрид",
    "any": "не важно",
}


def coach_profile_snippet(profile: Dict[str, Any]) -> str:
    """Краткий текст для ИИ-чата: поля анкеты."""
    if not profile:
        return ""
    lines: List[str] = []
    age = profile.get("age")
    if age is not None and str(age).strip() != "":
        lines.append(f"Возраст: {age}")
    city = profile_text(profile.get("city"))
    if city:
        lines.append(f"Город: {city}")
    spheres = parse_interest_spheres(profile)
    if spheres:
        lines.append(f"Сферы интересов: {', '.join(spheres)}")
    elif profile_text(profile.get("main_sphere")):
        lines.append(f"Главная сфера: {profile.get('main_sphere')}")
    cg = (profile.get("course_grade") or profile.get("course_or_grade") or "")
    if str(cg).strip():
        lines.append(f"Курс/класс: {cg}")
    edu = profile_text(profile.get("education_detail") or profile.get("education_level"))
    if edu:
        lines.append(f"Образование: {edu}")
    like = profile_text(profile.get("like_to_do"))
    if like:
        lines.append(f"Нравится: {like[:200]}")
    dislike = profile_text(profile.get("dislike_to_do"))
    if dislike:
        lines.append(f"Не нравится: {dislike[:160]}")
    prep_prof = profile_text(profile.get("preparation_level"))
    if prep_prof:
        lines.append(f"Подготовка: {prep_prof}")
    pr = profile_text(profile.get("career_priority")).lower()
    if pr:
        lines.append(f"Приоритет сейчас: {_PRIORITY_RU.get(pr, pr)}")
    pain = profile_text(profile.get("primary_pain"))
    if pain:
        lines.append(f"Главная сложность: {_PAIN_LABELS.get(pain, pain)}")
    from wibe_work.questionnaire_fields import (
        AUDIENCE_CAREER,
        AUDIENCE_SCHOOL,
        questionnaire_audience,
    )
    from wibe_work.services.profile_analysis_context import (
        career_questionnaire_lines,
        school_questionnaire_lines,
    )

    aud = questionnaire_audience(profile=profile)
    if aud == AUDIENCE_SCHOOL:
        lines.extend(school_questionnaire_lines(profile))
    else:
        lines.extend(career_questionnaire_lines(profile))
    return "\n".join(lines)


def load_competencies(user_id: str) -> List[Dict[str, Any]]:
    with get_db() as conn:
        rows = conn.execute(
            "SELECT name, level FROM user_competencies WHERE user_id = ? ORDER BY name",
            (user_id,),
        ).fetchall()
        return [dict(r) for r in rows]


def parse_skills_text(software_skills: Optional[str]) -> List[str]:
    if not software_skills:
        return []
    parts = re.split(r"[,;\n]+", str(software_skills))
    return [p.strip() for p in parts if p.strip()]


def profile_skill_blob(profile: Optional[Dict[str, Any]]) -> Optional[str]:
    if not profile:
        return None
    bits = [
        profile.get("software_skills"),
        profile.get("programming_skills"),
        profile.get("social_media_skills"),
    ]
    joined = ", ".join(str(b).strip() for b in bits if b and str(b).strip())
    return joined or None


def parse_interest_spheres(profile: Dict[str, Any]) -> List[str]:
    raw = profile.get("interest_spheres")
    if not raw:
        return []
    if isinstance(raw, (list, tuple)):
        return [str(x).strip() for x in raw if str(x).strip()]
    s = str(raw).strip()
    if not s:
        return []
    if s.startswith("["):
        try:
            data = json.loads(s)
            if isinstance(data, list):
                return [str(x).strip() for x in data if str(x).strip()]
        except (json.JSONDecodeError, TypeError):
            # Python-repr list: ['a', 'b']
            try:
                fixed = s.replace("'", '"')
                data = json.loads(fixed)
                if isinstance(data, list):
                    return [str(x).strip() for x in data if str(x).strip()]
            except (json.JSONDecodeError, TypeError):
                pass
    return [p.strip().strip("'\"") for p in re.split(r"[,;\n]+", s) if p.strip().strip("'\"[]")]


def merge_skill_sources(
    competencies: List[Dict[str, Any]], software_skills: Optional[str]
) -> Tuple[List[str], Dict[str, int]]:
    """Return display names (stable order) and map lowercase name -> level 1-5."""
    levels: Dict[str, int] = {}
    display_order: List[str] = []
    seen_lower: set = set()

    for c in competencies:
        name = (c.get("name") or "").strip()
        if not name:
            continue
        lv = int(c.get("level") or 3)
        lv = max(1, min(5, lv))
        key = name.lower()
        levels[key] = max(levels.get(key, 0), lv)
        if key not in seen_lower:
            seen_lower.add(key)
            display_order.append(name)

    for raw in parse_skills_text(software_skills):
        key = raw.lower()
        levels.setdefault(key, 3)
        if key not in seen_lower:
            seen_lower.add(key)
            display_order.append(raw.strip())

    return display_order, levels


def merge_skills_from_profile(
    competencies: List[Dict[str, Any]], profile: Dict[str, Any]
) -> Tuple[List[str], Dict[str, int]]:
    blob = profile_skill_blob(profile)
    return merge_skill_sources(competencies, blob)


def normalize_work_format_token(pref: Optional[str]) -> Optional[str]:
    if not pref:
        return None
    t = str(pref).lower()
    if "не важно" in t or "любой" in t:
        return None
    if "удал" in t:
        return "remote"
    if "гибрид" in t:
        return "hybrid"
    if "офис" in t:
        return "office"
    return None


def work_format_compatible(user_pref: Optional[str], job_format: Optional[str]) -> bool:
    j = (job_format or "any").lower().strip()
    if j in ("", "any", "не важно"):
        return True
    u = normalize_work_format_token(user_pref)
    if u is None:
        return True
    if j == u:
        return True
    if j == "hybrid" and u in ("remote", "office"):
        return True
    return False
