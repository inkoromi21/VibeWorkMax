import json
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Set

from wibe_work.sqlite_db import get_db
from wibe_work.services.user_context import (
    education_rank,
    merge_skills_from_profile,
    normalize_education,
    work_format_compatible,
)


def _parse_posted_at(raw: Optional[str]) -> Optional[datetime]:
    if not raw:
        return None
    try:
        if raw.endswith("Z"):
            return datetime.fromisoformat(raw.replace("Z", "+00:00"))
        return datetime.fromisoformat(raw)
    except ValueError:
        return None


def _freshness_days(posted_at: Optional[str], now: datetime) -> Optional[int]:
    dt = _parse_posted_at(posted_at)
    if not dt:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return max(0, (now - dt).days)


def _age_ok(age: Optional[int], min_age: Optional[int], max_age: Optional[int]) -> bool:
    if age is None:
        return True
    if min_age is not None and age < min_age:
        return False
    if max_age is not None and age > max_age:
        return False
    return True


def _education_ok(user_level: Optional[str], min_education: Optional[str]) -> bool:
    if not min_education:
        return True
    have = education_rank(user_level)
    if have == 0:
        return True
    need = education_rank(min_education)
    return have >= need


def _skill_overlap(
    required: List[str], user_levels: Dict[str, int], user_names_lower: Set[str]
) -> float:
    if not required:
        return 0.5
    hits = 0
    for req in required:
        r = req.strip().lower()
        if not r:
            continue
        if r in user_names_lower:
            hits += 1
            continue
        for u in user_names_lower:
            if r in u or u in r:
                hits += 0.7
                break
    return min(1.0, hits / len(required))


def _salary_ok(
    job_from: Optional[int],
    job_to: Optional[int],
    user_min: Optional[int],
) -> bool:
    if user_min is None:
        return True
    if job_from is None and job_to is None:
        return True
    top = job_to or job_from or 0
    return top >= user_min


def match_jobs_for_user(
    user_id: str,
    profile: Dict[str, Any],
    competencies: List[Dict[str, Any]],
    max_age_days: int = 120,
    only_remote: bool = False,
    only_entry_level: bool = False,
    min_salary: Optional[int] = None,
    strict_work_format: bool = False,
) -> Dict[str, Any]:
    age = profile.get("age")
    edu = profile.get("education_level")
    names, levels = merge_skills_from_profile(competencies, profile)
    user_lower = set(levels.keys()) | {n.lower() for n in names}
    user_pref = profile.get("work_format_preference")
    salary_floor = min_salary

    now = datetime.now(timezone.utc)
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM job_vacancies WHERE is_active = 1 ORDER BY posted_at DESC"
        ).fetchall()
        vacancies = [dict(r) for r in rows]

    results: List[Dict[str, Any]] = []
    for v in vacancies:
        req_skills: List[str] = []
        if v.get("required_skills"):
            try:
                req_skills = json.loads(v["required_skills"])
            except (json.JSONDecodeError, TypeError):
                req_skills = []
        min_age = v.get("min_age")
        max_age_v = v.get("max_age")
        min_edu = v.get("min_education")
        posted = v.get("posted_at")
        days_old = _freshness_days(posted, now)
        wf = v.get("work_format")
        entry = int(v.get("entry_level") or 0)
        s_from = v.get("salary_from")
        s_to = v.get("salary_to")

        if days_old is not None and days_old > max_age_days:
            continue
        if not _age_ok(age, min_age, max_age_v):
            continue
        if not _education_ok(edu, min_edu):
            continue
        if only_remote and wf:
            wfl = str(wf).lower()
            if "remote" not in wfl and "удал" not in wfl:
                continue
        if only_entry_level and entry != 1:
            continue
        if not _salary_ok(
            int(s_from) if s_from is not None else None,
            int(s_to) if s_to is not None else None,
            int(salary_floor) if salary_floor is not None else None,
        ):
            continue
        if strict_work_format and wf and not work_format_compatible(user_pref, wf):
            continue

        skill_match = _skill_overlap(req_skills, levels, user_lower)
        freshness_score = 1.0 if days_old is None else max(0.0, 1.0 - (days_old / max_age_days))
        entry_boost = 0.08 if entry == 1 else 0.0

        combined = round(
            min(1.0, 0.5 * skill_match + 0.35 * freshness_score + entry_boost),
            3,
        )
        results.append(
            {
                "id": v["id"],
                "title": v["title"],
                "company": v.get("company"),
                "description": v.get("description"),
                "required_skills": req_skills,
                "min_education": min_edu,
                "age_range": {"min": min_age, "max": max_age_v},
                "posted_at": posted,
                "days_since_posted": days_old,
                "work_format": wf,
                "entry_level": bool(entry),
                "salary_from": s_from,
                "salary_to": s_to,
                "free_resources_hint": v.get("free_resources_hint"),
                "relevance": {
                    "skill_match_score": round(skill_match, 3),
                    "freshness_score": round(freshness_score, 3),
                    "combined_score": combined,
                },
            }
        )

    results.sort(key=lambda x: -x["relevance"]["combined_score"])
    return {
        "user_id": user_id,
        "filters_applied": {
            "max_listing_age_days": max_age_days,
            "user_age": age,
            "user_education": normalize_education(edu),
            "only_remote": only_remote,
            "only_entry_level": only_entry_level,
            "min_salary": min_salary,
            "strict_work_format": strict_work_format,
        },
        "vacancies": results,
    }
