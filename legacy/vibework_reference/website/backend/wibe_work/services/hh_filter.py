import json
import re
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from wibe_work.sqlite_db import get_db
from wibe_work.services.diagnostics import run_diagnostics
from wibe_work.services.recommendations import (
    _direction_for_sphere_id,
    run_recommendations,
)
from wibe_work.services.hh_client import search_vacancies, slim_vacancy_items, suggest_area_id
from wibe_work.services.user_context import (
    load_competencies,
    load_profile,
    merge_skills_from_profile,
    parse_interest_spheres,
    profile_text,
)


def _has_any_skill(profile: Dict[str, Any], competencies: List[Dict[str, Any]]) -> bool:
    if competencies:
        return True
    for k in (
        "software_skills",
        "programming_skills",
        "social_media_skills",
    ):
        if profile.get(k) and str(profile.get(k)).strip():
            return True
    return False


def _has_interests(profile: Dict[str, Any]) -> bool:
    if profile.get("interests") and str(profile["interests"]).strip():
        return True
    if profile.get("like_to_do") and str(profile["like_to_do"]).strip():
        return True
    if parse_interest_spheres(profile):
        return True
    return False


def count_distinct_poll_answers(user_id: str) -> int:
    with get_db() as conn:
        row = conn.execute(
            "SELECT COUNT(DISTINCT question_id) AS c FROM answers WHERE user_id = ?",
            (user_id,),
        ).fetchone()
        return int(row["c"]) if row else 0


def can_finalize_hh_filter(
    user_id: str, force: bool = False
) -> Tuple[bool, str, Dict[str, Any]]:
    if force:
        return True, "force", {}
    profile = load_profile(user_id)
    competencies = load_competencies(user_id)
    diag = run_diagnostics(profile, competencies)
    score = float(diag.get("profile_completeness_score") or 0)
    from wibe_work.config import HH_FINALIZE_MIN_COMPLETENESS, HH_MIN_POLL_ANSWERS

    if score < HH_FINALIZE_MIN_COMPLETENESS:
        return (
            False,
            f"Низкая полнота профиля ({score}); заполните анкету или передайте force=true.",
            {"diagnostics": diag},
        )
    if not _has_interests(profile):
        return False, "Укажите интересы, «что нравится» или сферы interest_spheres.", {
            "diagnostics": diag
        }
    if not _has_any_skill(profile, competencies):
        return (
            False,
            "Добавьте навыки (компетенции или поля программ/кода).",
            {"diagnostics": diag},
        )
    n_ans = count_distinct_poll_answers(user_id)
    if HH_MIN_POLL_ANSWERS > 0 and n_ans < HH_MIN_POLL_ANSWERS:
        return (
            False,
            f"Нужно минимум {HH_MIN_POLL_ANSWERS} ответов в опросах (сейчас {n_ans}).",
            {"diagnostics": diag, "poll_answers_distinct": n_ans},
        )
    return True, "ok", {"diagnostics": diag, "poll_answers_distinct": n_ans}


def _normalize_prep(raw: Any) -> str:
    p = str(raw or "").strip().lower()
    if p in ("weak", "слабый", "слаб"):
        return "weak"
    if p in ("strong", "сильный", "сильн"):
        return "strong"
    if p in ("medium", "средний", "средн", "средняя", "среднее"):
        return "medium"
    return p


def _map_experience(profile: Dict[str, Any]) -> str:
    """Код опыта hh.ru по анкете: курс, подготовка, образование, опыт работы."""
    from wibe_work.services.assessment_routing import parse_course_grade

    pain = profile_text(profile.get("primary_pain"))
    if pain in ("pain_no_exp", "pain_low_confidence"):
        return "noExperience"

    prep = _normalize_prep(profile.get("preparation_level"))
    detail = profile_text(profile.get("education_detail")).lower()
    course_year = parse_course_grade(profile.get("course_grade")).get("course_year")

    if detail in ("school_9", "school_11", "school_8_11", "college", "spo"):
        return "noExperience"

    # Студент вуза / ранние курсы — без сеньорских вакансий
    if detail in ("univ_bachelor", "univ_master") or course_year is not None:
        if course_year is not None and course_year <= 3:
            return "noExperience"
        if prep in ("weak", "medium", ""):
            return "noExperience"
        if course_year is not None and course_year <= 4:
            return "between1And3"

    if prep == "weak":
        return "noExperience"

    off = profile.get("experience_official")
    if off and str(off).strip():
        low = str(off).lower()
        if re.search(r"(более\s*3|от\s*3|[3-9]\s*(год|лет)|1[0-9]\s*(год|лет))", low):
            return "between3And6"
        if re.search(r"([12]\s*(год|лет)|\bгод\b|\bлет\b)", low):
            return "between1And3"
        # Есть текст опыта, но без явных лет — junior-полоса, не senior
        return "between1And3"

    if prep == "strong" and detail == "graduate":
        return "between1And3"

    return "noExperience"


def _map_schedule(profile: Dict[str, Any]) -> Optional[str]:
    pref = profile_text(profile.get("work_format_preference") or profile.get("work_format_pref")).lower()
    if pref in ("remote", "удалённо", "удаленно") or "удал" in pref:
        return "remote"
    if pref in ("hybrid", "гибрид"):
        return "flexible"
    if pref in ("office", "офис"):
        return "fullDay"
    return None


def _map_employment(profile: Dict[str, Any]) -> Optional[str]:
    """
    Частичная занятость на hh.ru сильно режет выдачу (особенно в регионах).
    Передаём только при явном графике «выходные / неполный день», не из hours_per_week.
    """
    sched = profile_text(profile.get("work_schedule")).lower()
    if sched in ("weekends", "part_time", "part-time") or "выходн" in sched or "неполн" in sched or "частич" in sched:
        return "part"
    if sched == "project":
        return "project"
    return None


# Паттерны для извлечения стека из анкеты (не использовать «навыки к первому офферу» — там учебные фразы).
_HH_STACK_PATTERNS: List[Tuple[re.Pattern, str]] = [
    (re.compile(r"\bpython\b", re.I), "Python"),
    (re.compile(r"\bdjango\b|\bflask\b|\bfastapi\b|\bpytorch\b", re.I), "Python"),
    (re.compile(r"\bjavascript\b", re.I), "JavaScript"),
    (re.compile(r"\btypescript\b", re.I), "TypeScript"),
    (re.compile(r"(?<![\w/])js(?![\w/])", re.I), "JavaScript"),
    (re.compile(r"\breact\b", re.I), "React"),
    (re.compile(r"\bvue\.?js\b|\bvue\b", re.I), "Vue"),
    (re.compile(r"\bnode\.?js\b|\bnodejs\b", re.I), "Node.js"),
    (re.compile(r"\bjava\b", re.I), "Java"),
    (re.compile(r"\bc\+\+\b", re.I), "C++"),
    (re.compile(r"\bc#\b", re.I), "C#"),
    (re.compile(r"\bgo\b|\bgolang\b", re.I), "Go"),
    (re.compile(r"\brust\b", re.I), "Rust"),
    (re.compile(r"\bkotlin\b", re.I), "Kotlin"),
    (re.compile(r"\bswift\b", re.I), "Swift"),
    (re.compile(r"\bphp\b", re.I), "PHP"),
    (re.compile(r"\bruby\b", re.I), "Ruby"),
    (re.compile(r"\b1c\b|\b1с\b", re.I), "1С"),
    (re.compile(r"\bsql\b", re.I), "SQL"),
]

_LABEL_PRIORITY: Dict[str, int] = {
    "Python": 100,
    "JavaScript": 95,
    "TypeScript": 92,
    "React": 90,
    "Node.js": 88,
    "Java": 85,
    "C#": 82,
    "C++": 80,
    "Go": 75,
    "Kotlin": 72,
    "Swift": 70,
    "PHP": 65,
    "Ruby": 63,
    "Rust": 60,
    "Vue": 58,
    "SQL": 55,
    "1С": 50,
}

_SPHERE_SLUGS_SKIP = frozenset(
    {
        "it",
        "it_dev",
        "dev",
        "other",
        "any",
        "прочее",
    }
)

# Для IT-выдачи: заголовок должен явно относиться к техролям (отсекает «начинающий сотрудник в ресторан» и т.п.).
_IT_TITLE_PATTERN = re.compile(
    r"(программист|разработчик|developer|devops|frontend|backend|"
    r"fullstack|full-stack|full\s+stack|тестиров|\bqa\b|software|"
    r"mobile|ios|android|1\s*[сc]\b|data\s+engineer|"
    r"java\b|python|golang|kotlin|typescript|\bphp\b|scala|rust|"
    r"\(it\))",
    re.I,
)


def _is_it_search_direction(direction: str) -> bool:
    d = (direction or "").lower()
    return "it" in d or "разработ" in d


def _profile_search_blob(profile: Dict[str, Any], skill_names: List[str]) -> str:
    parts = [
        str(profile.get("programming_skills") or ""),
        str(profile.get("software_skills") or ""),
        str(profile.get("specialty_direction") or ""),
        str(profile.get("interests") or ""),
        str(profile.get("like_to_do") or ""),
        " ".join(skill_names),
    ]
    return " ".join(p for p in parts if p)


def _extract_stack_labels(profile: Dict[str, Any], competencies: List[Dict[str, Any]]) -> List[str]:
    names, _ = merge_skills_from_profile(competencies, profile)
    blob = _profile_search_blob(profile, names)
    seen: set = set()
    hits: List[Tuple[int, str]] = []
    for rx, label in _HH_STACK_PATTERNS:
        if label in seen:
            continue
        if rx.search(blob):
            seen.add(label)
            hits.append((_LABEL_PRIORITY.get(label, 0), label))
    hits.sort(key=lambda x: -x[0])
    return [h[1] for h in hits]


# id сферы в анкете → поисковая фраза на hh.ru
_IT_TRACK_HH_PHRASE: Dict[str, str] = {
    "backend": "backend разработчик",
    "frontend": "frontend разработчик",
    "devops": "devops инженер",
    "data": "аналитик данных SQL",
    "qa": "тестировщик QA",
}


def hh_search_phrase_for_it_track(track: str, stack: List[str]) -> str:
    """Поисковая фраза hh.ru по специализации из теста (не общий «программист»)."""
    tid = (track or "").strip().lower()
    labels = stack[:2] if stack else []
    if tid == "backend":
        for lab in labels:
            ll = lab.lower()
            if ll == "python":
                return "python backend разработчик"
            if ll == "java":
                return "java backend разработчик"
            if ll in ("go", "golang"):
                return "golang backend разработчик"
        return _IT_TRACK_HH_PHRASE["backend"]
    if tid == "frontend":
        for lab in labels:
            if lab.lower() in ("react", "vue", "javascript", "typescript"):
                return f"frontend {lab.lower()} разработчик"
        return _IT_TRACK_HH_PHRASE["frontend"]
    if tid == "data":
        if any(l.lower() == "python" for l in labels):
            return "аналитик данных python"
        return _IT_TRACK_HH_PHRASE["data"]
    return _IT_TRACK_HH_PHRASE.get(tid, "разработчик")


def _load_inferred_profession(user_id: str) -> Optional[Dict[str, Any]]:
    try:
        with get_db() as conn:
            row = conn.execute(
                "SELECT payload_json FROM vibework_snapshots WHERE user_id = ?",
                (user_id,),
            ).fetchone()
        if not row:
            return None
        data = json.loads(row["payload_json"])
        inf = (data.get("scenarios") or {}).get("inferred_profession")
        if isinstance(inf, dict) and inf.get("track_id"):
            return inf
    except (json.JSONDecodeError, TypeError, KeyError):
        pass
    return None


_SPHERE_ID_TO_HH_PHRASE: Dict[str, str] = {
    "it_dev": "backend разработчик",
    "data": "аналитик данных",
    "design": "UX дизайнер",
    "creative": "дизайнер креатив",
    "marketing": "маркетолог",
    "sales": "менеджер по продажам",
    "logistics": "логист",
    "medicine": "медицинский регистратор",
    "education": "преподаватель",
    "engineering": "инженер",
    "mgmt": "менеджер проектов",
    "finance": "финансовый аналитик",
    "hr_edu": "рекрутер HR",
    "sport": "тренер инструктор",
    "other": "стажировка начинающий специалист",
}


def _load_analysis_snapshot(user_id: str) -> Optional[Dict[str, Any]]:
    """Сохранённый разбор после теста."""
    try:
        with get_db() as conn:
            row = conn.execute(
                "SELECT payload_json FROM vibework_snapshots WHERE user_id = ?",
                (user_id,),
            ).fetchone()
        if not row:
            return None
        data = json.loads(row["payload_json"])
        return data if isinstance(data, dict) else None
    except (json.JSONDecodeError, TypeError, KeyError):
        return None


def _load_analysis_best_track(user_id: str) -> Optional[str]:
    """Лучший сценарий из сохранённого разбора (после теста)."""
    data = _load_analysis_snapshot(user_id)
    if not data:
        return None
    scenarios = data.get("scenarios") or {}
    best = str(scenarios.get("best_plan_name") or "").strip()
    if not best:
        plans = scenarios.get("plans") or []
        if plans:
            best = str(plans[0].get("name") or "").strip()
    return re.sub(r"^План [ABC]:\s*", "", best).strip() or None


def _hh_search_phrase(
    direction: str, stack: List[str], spheres: List[str]
) -> str:
    """Короткая строка для поля text на hh.ru (роль + стек), без простыней из анкеты."""
    d = (direction or "").strip()
    dl = d.lower()
    if "it" in d or "разработ" in dl:
        if stack:
            sl = stack[0].lower()
            if sl in ("python", "java", "javascript", "typescript", "go", "kotlin"):
                return f"{sl} разработчик"
            return f"{stack[0]} разработчик"
        return "backend разработчик"
    if "аналит" in dl:
        if "Python" in stack[:2]:
            return "аналитик данных Python"
        if "SQL" in stack[:2]:
            return "аналитик SQL"
        return "аналитик данных"
    if "дизайн" in dl:
        return "UX дизайнер"
    if "маркет" in dl or "продаж" in dl:
        return "маркетолог"
    if "продукт" in dl or "управлен" in dl:
        return "продакт менеджер"
    if "hr" in dl or "подбор" in dl:
        return "рекрутер"
    if "юрис" in dl:
        return "юрист"
    if "инженер" in dl:
        return "инженер"
    if "образован" in dl or "наук" in dl:
        return "преподаватель"
    if "финанс" in dl or "эконом" in dl:
        return "финансовый аналитик"
    if "универсал" in dl:
        return "стажировка начинающий специалист"
    for s in spheres[:3]:
        sid = (s or "").strip().lower()
        phrase = _SPHERE_ID_TO_HH_PHRASE.get(sid)
        if phrase:
            return phrase
        mapped = _direction_for_sphere_id(sid)
        if mapped:
            return _hh_search_phrase(mapped, stack, [])
    return "стажировка начинающий специалист"


def _build_search_text(
    profile: Dict[str, Any],
    rec: Dict[str, Any],
    competencies: List[Dict[str, Any]],
    *,
    user_id: Optional[str] = None,
    search_direction_override: Optional[str] = None,
) -> str:
    stack = _extract_stack_labels(profile, competencies)[:2]
    spheres = parse_interest_spheres(profile)
    if not spheres and (profile.get("main_sphere") or "").strip():
        spheres = [str(profile.get("main_sphere")).strip()]
    direction = (search_direction_override or "").strip() or str(
        rec.get("primary_direction") or ""
    )
    if _is_it_search_direction(direction) and user_id:
        inf = _load_inferred_profession(user_id)
        if inf:
            phrase = str(inf.get("hh_search_phrase") or "").strip()
            if phrase:
                return phrase[:120]
    if not search_direction_override and user_id:
        track = _load_analysis_best_track(user_id)
        if track and len(track) > 3:
            text = re.sub(r"^План [ABC]:\s*", "", track).strip()[:80]
            if stack and _is_it_search_direction(direction):
                sl = stack[0].lower()
                if sl in ("python", "java", "react", "javascript"):
                    return f"{sl} {text}"[:120]
            return re.sub(r"\s+", " ", text).strip()
    text = _hh_search_phrase(direction, stack, spheres)
    text = re.sub(r"\s+", " ", text).strip()
    return text[:120] if text else "стажировка начинающий специалист"


# Как в OpenAPI hh.ru GET /vacancies, параметр experience
HH_EXPERIENCE_API_IDS = frozenset(
    {"noExperience", "between1And3", "between3And6", "moreThan6"}
)

_HH_EXPERIENCE_LABELS: Dict[str, str] = {
    "noExperience": "без опыта",
    "between1And3": "от 1 до 3 лет",
    "between3And6": "от 3 до 6 лет",
    "moreThan6": "более 6 лет",
}


def _experience_display_label(code: Optional[str]) -> str:
    if not code:
        return ""
    return _HH_EXPERIENCE_LABELS.get(str(code), str(code))


def _vacancy_listing_meta(
    params: Dict[str, Any],
    raw: Dict[str, Any],
    items: List[Dict[str, Any]],
    *,
    direction: str = "",
) -> Dict[str, Any]:
    """Статус подбора для UI: есть ли вакансии под уровень / вообще."""
    found_for_level = int(raw.get("found") or 0)
    exp_code = params.get("experience")
    exp_label = _experience_display_label(exp_code) if exp_code else ""
    found_broader: Optional[int] = None

    if items:
        status = "ok"
    elif found_for_level > 0:
        status = (
            "direction_filtered"
            if _is_it_search_direction(direction)
            else "ok"
        )
    elif exp_code:
        broader = dict(params)
        broader.pop("experience", None)
        raw_b = search_vacancies(broader)
        found_broader = int(raw_b.get("found") or 0)
        status = "none_for_level" if found_broader > 0 else "none_total"
    else:
        status = "none_total"

    return {
        "vacancy_listing_status": status,
        "found_for_level": found_for_level,
        "found_broader": found_broader,
        "profile_experience_label": exp_label,
        "profile_experience_code": exp_code or None,
    }


def apply_user_experience_filter(
    params: Dict[str, Any],
    *,
    hh_experience: Optional[str] = None,
    only_entry_level: bool = False,
) -> None:
    """Учитывает фильтр «Опыт» из UI миниаппа (те же значения, что на hh.ru)."""
    if only_entry_level:
        params["experience"] = "noExperience"
        return
    if hh_experience is None:
        return
    s = str(hh_experience).strip()
    if not s or s.lower() == "any":
        params.pop("experience", None)
        return
    if s.lower() == "entry":
        params["experience"] = "noExperience"
        return
    if s in HH_EXPERIENCE_API_IDS:
        params["experience"] = s


def _search_vacancies_relaxed(params: Dict[str, Any]) -> Dict[str, Any]:
    """Если строгие фильтры дали 0 — повтор без employment/schedule/search_field."""
    raw = search_vacancies(params)
    if int(raw.get("found") or 0) > 0:
        return raw
    relaxed = dict(params)
    changed = False
    for key in ("search_field", "employment", "schedule"):
        if key in relaxed:
            relaxed.pop(key, None)
            changed = True
    if not changed:
        return raw
    raw2 = search_vacancies(relaxed)
    if int(raw2.get("found") or 0) > 0:
        return raw2
    return raw


def build_hh_query_params(
    profile: Dict[str, Any],
    rec: Dict[str, Any],
    area_id: Optional[str],
    competencies: Optional[List[Dict[str, Any]]] = None,
    *,
    user_id: Optional[str] = None,
    search_direction_override: Optional[str] = None,
    use_profile_salary: bool = True,
) -> Dict[str, Any]:
    comps = competencies if competencies is not None else []
    text = _build_search_text(
        profile,
        rec,
        comps,
        user_id=user_id,
        search_direction_override=search_direction_override,
    )

    params: Dict[str, Any] = {
        "text": text or "стажер",
        "per_page": 20,
        "page": 0,
        "order_by": "publication_time",
    }
    if area_id:
        params["area"] = area_id
    if use_profile_salary:
        sal = profile.get("target_salary")
        if sal:
            try:
                params["salary"] = int(sal)
                params["only_with_salary"] = "true"
            except (TypeError, ValueError):
                pass
    params["experience"] = _map_experience(profile)
    emp = _map_employment(profile)
    if emp:
        params["employment"] = emp
    sch = _map_schedule(profile)
    if sch:
        params["schedule"] = sch
    # Поиск по всему тексту вакансии (как на hh.ru), IT-роли отсекаем по заголовку ниже.
    return params


def fetch_live_hh_vacancies(
    user_id: str,
    *,
    only_remote: bool = False,
    only_entry_level: bool = False,
    hh_experience: Optional[str] = None,
    min_salary: Optional[int] = None,
    strict_work_format: bool = False,
    page: int = 0,
    per_page: int = 15,
    city_override: Optional[str] = None,
    search_direction: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Поиск на hh.ru по профилю без отдельного шага «зафиксировать фильтр».
    city_override / search_direction — опциональные фильтры из UI миниаппа.
    """
    profile = load_profile(user_id)
    competencies = load_competencies(user_id)
    analysis = _load_analysis_snapshot(user_id)
    rec = run_recommendations(profile, competencies, analysis=analysis)
    sd = (search_direction or "").strip()
    if sd:
        rec = {**rec, "primary_direction": sd}
    city_raw = (city_override or "").strip() or (profile.get("city") or "")
    city = str(city_raw).strip() if city_raw else None
    area_id = suggest_area_id(str(city)) if city else None
    params = build_hh_query_params(
        profile,
        rec,
        area_id,
        competencies,
        user_id=user_id,
        search_direction_override=sd or None,
        use_profile_salary=False,
    )

    if only_remote:
        params["schedule"] = "remote"
    elif strict_work_format:
        sch = _map_schedule(profile)
        if sch:
            params["schedule"] = sch

    apply_user_experience_filter(
        params, hh_experience=hh_experience, only_entry_level=only_entry_level
    )

    if min_salary is not None and min_salary > 0:
        params["salary"] = int(min_salary)
        params["only_with_salary"] = "true"

    params["page"] = max(0, page)
    params["per_page"] = min(50, max(5, per_page))

    raw = _search_vacancies_relaxed(params)
    items = slim_vacancy_items(raw)
    direction = str(rec.get("primary_direction") or "")
    if _is_it_search_direction(direction):
        items = [it for it in items if _IT_TITLE_PATTERN.search(it.get("name") or "")]
    from wibe_work.services.hh_web_link import build_hh_web_search_url

    hh_url = build_hh_web_search_url(
        text=str(params.get("text") or ""),
        city=city,
        only_remote=only_remote,
        only_entry_level=only_entry_level,
        hh_experience=hh_experience or params.get("experience"),
        min_salary=min_salary or params.get("salary"),
        work_format="remote" if only_remote else None,
    )
    listing = _vacancy_listing_meta(
        params, raw, items, direction=direction
    )
    return {
        "source": "hh.ru",
        "found": raw.get("found"),
        "pages": raw.get("pages"),
        "page": raw.get("page"),
        "per_page": raw.get("per_page"),
        "items": items,
        "hh_search_url": hh_url,
        "search_hint": {
            "text": params.get("text"),
            "area_id": area_id,
            "city": city,
            "search_direction": rec.get("primary_direction"),
            "experience": params.get("experience"),
            "schedule": params.get("schedule"),
            "search_field": params.get("search_field"),
            "employment": params.get("employment"),
        },
        **listing,
    }


def build_hh_demo_fallback(
    user_id: str,
    profile: Dict[str, Any],
    *,
    only_remote: bool = False,
    only_entry_level: bool = False,
    hh_experience: Optional[str] = None,
    min_salary: Optional[int] = None,
    city_override: Optional[str] = None,
    search_direction: Optional[str] = None,
    per_page: int = 15,
    notice: Optional[str] = None,
) -> Dict[str, Any]:
    """Демо-ответ и ссылка на hh.ru с тем же запросом, что и живой поиск."""
    from wibe_work.services.hh_web_link import build_hh_web_search_url, demo_hh_items

    competencies = load_competencies(user_id)
    analysis = _load_analysis_snapshot(user_id)
    rec = run_recommendations(profile, competencies, analysis=analysis)
    sd = (search_direction or "").strip()
    if sd:
        rec = {**rec, "primary_direction": sd}
    city_raw = (city_override or "").strip() or (profile.get("city") or "")
    city = str(city_raw).strip() if city_raw else None
    area_id = suggest_area_id(str(city)) if city else None
    params = build_hh_query_params(
        profile,
        rec,
        area_id,
        competencies,
        user_id=user_id,
        search_direction_override=sd or None,
    )
    apply_user_experience_filter(
        params, hh_experience=hh_experience, only_entry_level=only_entry_level
    )
    if only_remote:
        params["schedule"] = "remote"
    if min_salary is not None and min_salary > 0:
        params["salary"] = int(min_salary)
        params["only_with_salary"] = "true"
    hh_url = build_hh_web_search_url(
        text=str(params.get("text") or ""),
        city=city,
        only_remote=only_remote,
        only_entry_level=only_entry_level,
        hh_experience=hh_experience or params.get("experience"),
        min_salary=min_salary or params.get("salary"),
        work_format="remote" if only_remote else None,
    )
    items = demo_hh_items(hh_url)
    direction = str(rec.get("primary_direction") or "")
    listing = _vacancy_listing_meta(
        params,
        {"found": len(items)},
        items,
        direction=direction,
    )
    return {
        "source": "demo",
        "notice": notice
        or "hh.ru API недоступен. Показаны демо-вакансии — откройте поиск на hh.ru по кнопке.",
        "hh_search_url": hh_url,
        "search_hint": {
            "text": params.get("text"),
            "area_id": area_id,
            "city": city,
            "search_direction": rec.get("primary_direction"),
            "experience": params.get("experience"),
            "schedule": params.get("schedule"),
        },
        "found": len(items),
        "pages": 1,
        "page": 0,
        "per_page": per_page,
        "items": items,
        **listing,
    }


def build_filter_bundle(user_id: str) -> Dict[str, Any]:
    profile = load_profile(user_id)
    competencies = load_competencies(user_id)
    analysis = _load_analysis_snapshot(user_id)
    rec = run_recommendations(profile, competencies, analysis=analysis)

    city = profile.get("city")
    area_id = suggest_area_id(str(city)) if city else None
    query_params = build_hh_query_params(
        profile, rec, area_id, competencies, user_id=user_id
    )
    human = {
        "primary_direction": rec.get("primary_direction"),
        "skills_for_first_offer": rec.get("skills_for_first_offer"),
        "city": city,
        "hh_area_id": area_id,
        "experience": query_params.get("experience"),
        "employment": query_params.get("employment"),
        "schedule": query_params.get("schedule"),
        "salary_floor": query_params.get("salary"),
    }
    return {
        "user_id": user_id,
        "query_params": query_params,
        "human_readable": human,
        "built_at": datetime.now(timezone.utc).isoformat(),
    }


def save_user_hh_state(user_id: str, bundle: Dict[str, Any], tests_completed: bool = True):
    now = datetime.now(timezone.utc).isoformat()
    area = bundle.get("human_readable", {}).get("hh_area_id")
    with get_db() as conn:
        conn.execute(
            """INSERT INTO user_hh_state (user_id, tests_completed, tests_completed_at, hh_filter_json, hh_area_id, updated_at)
               VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(user_id) DO UPDATE SET
                 tests_completed = excluded.tests_completed,
                 tests_completed_at = excluded.tests_completed_at,
                 hh_filter_json = excluded.hh_filter_json,
                 hh_area_id = excluded.hh_area_id,
                 updated_at = excluded.updated_at""",
            (
                user_id,
                1 if tests_completed else 0,
                now if tests_completed else None,
                json.dumps(bundle, ensure_ascii=False),
                area,
                now,
            ),
        )
        conn.commit()


def load_user_hh_state(user_id: str) -> Optional[Dict[str, Any]]:
    with get_db() as conn:
        row = conn.execute(
            "SELECT * FROM user_hh_state WHERE user_id = ?", (user_id,)
        ).fetchone()
        if not row:
            return None
        r = dict(row)
        if r.get("hh_filter_json"):
            try:
                r["filter"] = json.loads(r["hh_filter_json"])
            except json.JSONDecodeError:
                r["filter"] = None
        return r


def clear_user_hh_state(user_id: str) -> None:
    with get_db() as conn:
        conn.execute("DELETE FROM user_hh_state WHERE user_id = ?", (user_id,))
        conn.commit()


def regenerate_user_hh_bundle(user_id: str, *, force: bool = True) -> Tuple[bool, str, Dict[str, Any]]:
    """Сбросить сохранённый hh-фильтр и собрать заново из актуальной анкеты."""
    clear_user_hh_state(user_id)
    ok, msg, extra = can_finalize_hh_filter(user_id, force=force)
    if not ok:
        return False, msg, extra or {}
    bundle = build_filter_bundle(user_id)
    save_user_hh_state(user_id, bundle, tests_completed=True)
    out = dict(extra or {})
    out["bundle"] = bundle
    return True, "ok", out
