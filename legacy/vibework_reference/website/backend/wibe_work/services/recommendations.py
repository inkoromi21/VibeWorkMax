import re
from typing import Any, Dict, List, Optional, Set, Tuple

from wibe_work.services.user_context import (
    education_rank,
    merge_skills_from_profile,
    parse_interest_spheres,
    profile_text,
)

_DIRECTION_KEYWORDS: List[Tuple[str, List[str]]] = [
    (
        "IT / разработка",
        [
            "код",
            "программ",
            "python",
            "java",
            "frontend",
            "backend",
            "devops",
            "данн",
            "машинн",
            "ai",
            "игр",
            "it",
        ],
    ),
    (
        "Аналитика и данные",
        ["аналит", "sql", "excel", "bi", "отчёт", "метрик", "данн"],
    ),
    (
        "Дизайн и креатив",
        ["дизайн", "ui", "ux", "figma", "иллюстр", "креатив", "моушн"],
    ),
    (
        "Маркетинг и продажи",
        ["маркет", "продаж", "smm", "таргет", "реклам", "клиент", "логист"],
    ),
    (
        "Управление и продукт",
        ["продукт", "project", "проект", "менедж", "руковод", "team"],
    ),
    (
        "Инженерия и производство",
        ["инженер", "станок", "производ", "чертеж", "cad", "электрон", "кабель"],
    ),
    (
        "Образование и наука",
        ["препод", "обучен", "наук", "исслед", "университет"],
    ),
    (
        "HR и подбор",
        ["hr", "рекрут", "персонал", "резюме", "соискател"],
    ),
    (
        "Юриспруденция",
        ["юрист", "право", "закон", "договор"],
    ),
    (
        "Финансы и экономика",
        ["финанс", "бухгалт", "эконом", "аудит", "казнач", "бюджет"],
    ),
]

_SPHERE_TO_DIRECTION = {
    "it": "IT / разработка",
    "it_dev": "Разработка",
    "айти": "IT / разработка",
    "data": "Аналитика и данные",
    "marketing": "Маркетинг и продажи",
    "маркетинг": "Маркетинг и продажи",
    "design": "Дизайн и креатив",
    "дизайн": "Дизайн и креатив",
    "creative": "Дизайн и креатив",
    "sales": "Маркетинг и продажи",
    "продажи": "Маркетинг и продажи",
    "logistics": "Маркетинг и продажи",
    "логистика": "Маркетинг и продажи",
    "medicine": "Универсальные роли",
    "медицина": "Универсальные роли",
    "education": "Образование и наука",
    "образование": "Образование и наука",
    "engineering": "Инженерия и производство",
    "mgmt": "Управление и продукт",
    "finance": "Финансы и экономика",
    "hr_edu": "HR и подбор",
    "sport": "Универсальные роли",
    "спорт": "Универсальные роли",
    "finance": "Финансы и экономика",
    "creative": "Дизайн и креатив",
    "logistics": "Маркетинг и продажи",
    "medicine": "Универсальные роли",
    "other": "Универсальные роли",
}

_SPHERE_KEYS_BY_LEN = sorted(_SPHERE_TO_DIRECTION.keys(), key=len, reverse=True)


def _tokenize(text: str) -> Set[str]:
    return {t for t in re.split(r"[^\wёЁа-яА-Яa-zA-Z]+", text.lower()) if len(t) > 2}


def _score_directions(text_blob: str) -> List[Dict[str, Any]]:
    tokens = _tokenize(text_blob)
    scored: List[Tuple[str, float]] = []
    for direction, kws in _DIRECTION_KEYWORDS:
        hits = sum(1 for kw in kws if kw in text_blob.lower() or any(kw in t for t in tokens))
        score = min(1.0, 0.15 * hits + 0.05 * len([k for k in kws if k in text_blob.lower()]))
        if hits:
            scored.append((direction, score))
    scored.sort(key=lambda x: -x[1])
    if not scored:
        return [
            {
                "direction": "Универсальные роли",
                "score": 0.4,
                "reason": "Добавьте интересы и предпочтения — пока слабые сигналы для узкой специализации.",
            }
        ]
    return [
        {
            "direction": d,
            "score": round(min(1.0, s), 2),
            "reason": "Совпадение с вашими интересами и описанием предпочтений.",
        }
        for d, s in scored[:5]
    ]


def _boost_from_spheres(spheres: List[str]) -> str:
    extra: List[str] = []
    for s in spheres:
        low = s.strip().lower()
        if not low:
            continue
        if low in _SPHERE_TO_DIRECTION:
            extra.append(_SPHERE_TO_DIRECTION[low])
            continue
        matched = False
        for key in _SPHERE_KEYS_BY_LEN:
            if key in low:
                extra.append(_SPHERE_TO_DIRECTION[key])
                matched = True
                break
        if not matched:
            extra.append(s)
    return " ".join(extra)


def _direction_for_sphere_id(sphere_id: str) -> Optional[str]:
    k = (sphere_id or "").strip().lower()
    if not k:
        return None
    if k in _SPHERE_TO_DIRECTION:
        return _SPHERE_TO_DIRECTION[k]
    for key in _SPHERE_KEYS_BY_LEN:
        if key in k:
            return _SPHERE_TO_DIRECTION[key]
    return None


def _skill_plan_for_direction(
    direction: str, user_skills_lower: Set[str]
) -> List[Dict[str, Any]]:
    plans: Dict[str, List[str]] = {
        "IT / разработка": [
            "Git",
            "Python или JavaScript",
            "Структуры данных и алгоритмы",
            "Тестирование",
            "Базы данных и SQL",
        ],
        "Аналитика и данные": ["SQL", "Excel / Google Sheets", "Статистика", "Визуализация", "A/B-тесты"],
        "Дизайн и креатив": ["Figma", "Композиция и типографика", "UI-паттерны", "Портфолио"],
        "Маркетинг и продажи": ["Копирайтинг", "Аналитика воронки", "CRM", "Переговоры"],
        "Управление и продукт": ["User stories", "Roadmap", "Приоритизация", "Stakeholder management"],
        "Инженерия и производство": ["Чтение чертежей", "CAD", "Охрана труда", "Контроль качества"],
        "Образование и наука": ["Методики обучения", "Презентации", "Научная грамотность"],
        "HR и подбор": ["Скрининг резюме", "Поиск кандидатов", "Коммуникация с кандидатами", "Excel / ATS"],
        "Юриспруденция": ["Трудовое право", "Договорная работа", "Исследование практики", "Документооборот"],
        "Финансы и экономика": ["Excel", "Бухучёт", "Финансовая отчётность", "1С"],
        "Универсальные роли": ["Коммуникация", "Планирование", "Работа в команде"],
    }
    target_skills = plans.get(direction, ["Коммуникация", "Планирование", "Работа в команде"])
    out: List[Dict[str, Any]] = []
    for i, skill in enumerate(target_skills, start=1):
        have = skill.lower() in user_skills_lower or any(
            skill.lower() in u or u in skill.lower() for u in user_skills_lower
        )
        free_track = None
        if not have and i <= 3:
            free_track = "Бесплатно: документация инструмента, Stepik и открытые курсы по теме (методич. «нет денег на курсы»)."
        actions = (
            ["Закрепить в проекте или пет-проекте"]
            if not have
            else ["Углубить: менторство или production-задачи"]
        )
        if free_track:
            actions.append(free_track)
        out.append(
            {
                "priority": i,
                "skill": skill,
                "status": "есть база" if have else "к развитию",
                "suggested_actions": actions,
            }
        )
    return out


def _first_offer_skills(plan: List[Dict[str, Any]]) -> List[str]:
    need = [p["skill"] for p in plan if p.get("status") == "к развитию"]
    return need[:3]


def _plan_names_from_analysis(analysis: Optional[Dict[str, Any]]) -> List[str]:
    if not analysis:
        return []
    scenarios = analysis.get("scenarios") or {}
    names: List[str] = []
    best = str(scenarios.get("best_plan_name") or "").strip()
    if best:
        names.append(re.sub(r"^План [ABC]:\s*", "", best, flags=re.I).strip())
    for p in scenarios.get("plans") or []:
        n = re.sub(r"^План [ABC]:\s*", "", str(p.get("name") or ""), flags=re.I).strip()
        if n and n not in names:
            names.append(n)
    return names


def _apply_analysis_to_inclinations(
    inclinations: List[Dict[str, Any]],
    analysis: Optional[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """Поднять направления из планов A/B/C теста выше keyword-угадывания по анкете."""
    plan_names = _plan_names_from_analysis(analysis)
    if not plan_names:
        return inclinations
    front: List[Dict[str, Any]] = []
    seen: Set[str] = set()
    for idx, name in enumerate(plan_names):
        scored = _score_directions(name.lower())
        if not scored:
            continue
        direction = scored[0]["direction"]
        if direction in seen:
            continue
        seen.add(direction)
        front.append(
            {
                "direction": direction,
                "score": round(0.97 - idx * 0.04, 2),
                "reason": "Совпадает с планом из теста и разбора.",
            }
        )
    rest = [i for i in inclinations if i.get("direction") not in seen]
    return front + rest


def run_recommendations(
    profile: Dict[str, Any],
    competencies: List[Dict[str, Any]],
    *,
    analysis: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    spheres = parse_interest_spheres(profile)
    main_sphere = profile_text(profile.get("main_sphere"))
    if not spheres and main_sphere:
        spheres = [main_sphere]
    blob_parts = [
        str(profile.get("interests") or ""),
        str(profile.get("like_to_do") or ""),
        str(profile.get("dislike_to_do") or ""),
        str(profile.get("software_skills") or ""),
        str(profile.get("programming_skills") or ""),
        # A specialty can nudge the text matcher, but never excludes a direction.
        profile_text(profile.get("specialty_direction")),
        _boost_from_spheres(spheres),
    ]
    blob = " ".join(blob_parts)
    inclinations = _score_directions(blob)
    inclinations = _apply_analysis_to_inclinations(inclinations, analysis)
    main_dir = _direction_for_sphere_id(main_sphere) if main_sphere else None
    if main_dir:
        inclinations = [
            i for i in inclinations if i.get("direction") != main_dir
        ]
        inclinations.insert(
            0,
            {
                "direction": main_dir,
                "score": 0.92,
                "reason": "Главная сфера из анкеты.",
            },
        )
    top_direction = inclinations[0]["direction"]

    names, _ = merge_skills_from_profile(competencies, profile)
    user_lower = {n.lower() for n in names}

    edu_rank = education_rank(
        profile.get("education_detail") or profile.get("education_level") or profile.get("education")
    )
    edu_note = None
    if edu_rank == 0:
        edu_note = "Укажите уровень образования в профиле — это влияет на отбор вакансий и формальные требования."
    elif edu_rank < 3:
        edu_note = "При выборе направлений учитывайте программы ДПО/бакалавриата для формальных требований работодателей."

    plan = _skill_plan_for_direction(top_direction, user_lower)

    return {
        "professional_inclinations": inclinations,
        "suitable_directions": inclinations[:3],
        "top_professions_preview": inclinations[:3],
        "skill_development_plan": plan,
        "skills_for_first_offer": _first_offer_skills(plan),
        "education_context_note": edu_note,
        "primary_direction": top_direction,
        "methodology_refs": [
            "Сферы интересов (до 5) — как в опроснике Google Sheets",
            "Топ-3 навыка для первого оффера — user story «нет опыта»",
        ],
    }
