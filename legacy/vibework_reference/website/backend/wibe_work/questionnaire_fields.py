"""Схема анкеты VibeWork (блоки из продуктовой таблицы + поля БД ProfileData)."""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

# Сферы для мультивыбора (до 5) — id совпадают с тестом и hh-подбором
# id сферы анкеты → значение Interest в веб-API (тест, разбор, вакансии)
SPHERE_TO_WEB_INTEREST: Dict[str, str] = {
    "it_dev": "IT",
    "marketing": "маркетинг",
    "design": "дизайн",
    "sales": "продажи",
    "logistics": "логистика",
    "medicine": "медицина",
    "education": "образование",
    "engineering": "инженерия",
    "creative": "дизайн",
    "sport": "спорт",
    "data": "данные_и_AI",
    "mgmt": "бизнес",
    "finance": "финансы_и_контроль",
    "hr_edu": "HR_и_рекрутинг",
    "other": "общий",
}


def sphere_to_web_interest(sphere_id: str) -> str:
    return SPHERE_TO_WEB_INTEREST.get((sphere_id or "").strip(), "общий")


# Короткие подписи (одна строка в сетке) — сверху; длинные — внизу.
INTEREST_SPHERES: List[Dict[str, str]] = [
    {"id": "it_dev", "label": "Разработка"},
    {"id": "marketing", "label": "Маркетинг"},
    {"id": "design", "label": "Дизайн"},
    {"id": "sales", "label": "Продажи"},
    {"id": "logistics", "label": "Логистика"},
    {"id": "medicine", "label": "Медицина"},
    {"id": "education", "label": "Образование"},
    {"id": "creative", "label": "Творчество"},
    {"id": "sport", "label": "Спорт"},
    {"id": "finance", "label": "Финансы"},
    {"id": "hr_edu", "label": "HR и обучение"},
    {"id": "other", "label": "Другое"},
    {"id": "engineering", "label": "Рабочие специальности"},
    {"id": "data", "label": "Данные и аналитика"},
    {"id": "mgmt", "label": "Менеджмент и проекты"},
]

AUDIENCE_SCHOOL = "school"
AUDIENCE_VOCATIONAL = "vocational"
AUDIENCE_CAREER = "career"

_SCHOOL_EDUCATION_IDS = frozenset({"school_8_11", "school_9", "school_11"})
_VOCATIONAL_EDUCATION_IDS = frozenset({"spo", "college", "college_spo", "technikum"})

# Школьные предметы (id совпадают с school_subject_resources.SUBJECT_LINKS)
SCHOOL_SUBJECT_OPTIONS: List[Dict[str, str]] = [
    {"id": "math", "label": "Математика"},
    {"id": "russian", "label": "Русский язык"},
    {"id": "literature", "label": "Литература"},
    {"id": "physics", "label": "Физика"},
    {"id": "chemistry", "label": "Химия"},
    {"id": "biology", "label": "Биология"},
    {"id": "informatics", "label": "Информатика"},
    {"id": "history", "label": "История"},
    {"id": "social", "label": "Обществознание"},
    {"id": "geography", "label": "География"},
    {"id": "english", "label": "Английский"},
    {"id": "art", "label": "Искусство / МХК"},
    {"id": "other", "label": "Другое"},
]

# Базовый onboarding одинаков для школы, СПО, вуза и выпускников. Остальные
# ответы остаются в схеме и snapshot как необязательные сигналы для разбора.
COMPLETION_ANY_OF: List[List[str]] = [["interest_spheres", "main_sphere"]]
_BASIC_COMPLETION: Dict[str, Any] = {
    "required": ["age", "city", "education_detail", "like_to_do"],
    "required_unless_education_detail": {
        "course_grade": ["graduate"],
    },
    "any_of": list(COMPLETION_ANY_OF),
}

COMPLETION_BY_AUDIENCE: Dict[str, Dict[str, Any]] = {
    AUDIENCE_SCHOOL: dict(_BASIC_COMPLETION),
    AUDIENCE_VOCATIONAL: dict(_BASIC_COMPLETION),
    AUDIENCE_CAREER: dict(_BASIC_COMPLETION),
}

# Обратная совместимость
COMPLETION_REQUIRED: List[str] = COMPLETION_BY_AUDIENCE[AUDIENCE_CAREER]["required"]

# Группы сфер для показа полей анкеты (как в тесте)
SPHERE_GROUPS: Dict[str, Tuple[str, ...]] = {
    "tech": ("it_dev", "data", "engineering"),
    "creative": ("design", "creative", "marketing"),
    "people": ("sales", "hr_edu", "education"),
    "health": ("medicine",),
    "business": ("mgmt", "finance", "logistics", "sport"),
    "general": ("other",),
}

# Доп. правила полей: видимость и подписи по сферам (мержатся в схему)
FIELD_SPHERE_RULES: Dict[str, Dict[str, Any]] = {
    "programming_skills": {"only_sphere_groups": ["tech"]},
    "social_media_skills": {"only_sphere_groups": ["creative"]},
    "software_skills": {
        "label_by_group": {
            "tech": {
                "label": "Программы и инструменты",
                "placeholder": "IDE, Git, Docker, Python, SQL…",
            },
            "creative": {
                "label": "Дизайн и контент-инструменты",
                "placeholder": "Figma, Photoshop, CapCut, Notion…",
            },
            "health": {
                "label": "Медицинские системы и инструменты",
                "placeholder": "ЭМК, лабораторные системы, справочники…",
            },
            "people": {
                "label": "Рабочие программы",
                "placeholder": "Office, CRM, сервисы для общения с клиентами…",
            },
            "business": {
                "label": "Инструменты учёта и аналитики",
                "placeholder": "Excel, 1С, ERP, BI…",
            },
            "general": {
                "label": "Программы и инструменты",
                "placeholder": "Чем пользуетесь в учёбе или на практике…",
            },
        },
    },
    "experience_projects": {
        "label_by_group": {
            "tech": {
                "label": "Учебные и IT-проекты",
                "placeholder": "Сайт, приложение, хакатон, GitHub…",
            },
            "creative": {
                "label": "Портфолио и творческие работы",
                "placeholder": "Макеты, рилсы, дизайн, выставки…",
            },
            "health": {
                "label": "Практика, стажировки, клинические кейсы",
                "placeholder": "Стажировка в поликлинике, симуляции, волонтёрство…",
            },
            "people": {
                "label": "Проекты с людьми",
                "placeholder": "Волонтёрство, наставничество, мероприятия…",
            },
            "business": {
                "label": "Проекты и инициативы",
                "placeholder": "Кейс, стажировка, учебный бизнес-проект…",
            },
            "general": {
                "label": "Учебные и личные проекты",
                "placeholder": "Кружок, конкурс, свой проект…",
            },
        },
    },
    "has_resume_portfolio": {
        "label_by_group": {
            "creative": {"label": "Есть портфолио / кейсы"},
            "health": {"label": "Есть практика / стажировки в профиле"},
            "tech": {"label": "Есть резюме / GitHub / портфолио"},
        },
    },
    "internship_ready": {
        "label_by_group": {
            "health": {"label": "Готовность к практике / стажировке"},
        },
    },
    "extra_education": {
        "label_by_group": {
            "health": {
                "label": "Дополнительное обучение",
                "placeholder": "Курсы, симуляции, конференции по медицине…",
            },
        },
    },
}


def _sphere_groups_for_ids(sphere_ids: List[str]) -> set[str]:
    groups: set[str] = set()
    for sid in sphere_ids:
        for gname, members in SPHERE_GROUPS.items():
            if sid in members:
                groups.add(gname)
                break
    return groups


def _field_visible_for_spheres(field: Dict[str, Any], sphere_ids: List[str]) -> bool:
    only_spheres = field.get("only_spheres")
    only_groups = field.get("only_sphere_groups")
    skip_spheres = tuple(field.get("skip_spheres") or ())
    skip_groups = tuple(field.get("skip_sphere_groups") or ())
    if not sphere_ids:
        if only_spheres or only_groups:
            return False
        return True
    if only_spheres and not set(sphere_ids) & set(only_spheres):
        return False
    if skip_spheres and set(sphere_ids) & set(skip_spheres):
        return False
    groups = _sphere_groups_for_ids(sphere_ids)
    if only_groups and not groups & set(only_groups):
        return False
    if skip_groups and groups & set(skip_groups):
        return False
    return True


def _resolve_field_for_spheres(
    field: Dict[str, Any], sphere_ids: List[str]
) -> Dict[str, Any]:
    out = dict(field)
    by_sphere = field.get("label_by_sphere") or {}
    for sid in sphere_ids:
        patch = by_sphere.get(sid)
        if patch:
            out.update(patch)
            return out
    by_group = field.get("label_by_group") or {}
    for sid in sphere_ids:
        g = next(
            (gn for gn, mem in SPHERE_GROUPS.items() if sid in mem),
            "general",
        )
        patch = by_group.get(g)
        if patch:
            out.update(patch)
            return out
    if not sphere_ids and by_group.get("general"):
        out.update(by_group["general"])
    return out


def _enrich_field(field: Dict[str, Any]) -> Dict[str, Any]:
    rules = FIELD_SPHERE_RULES.get(field.get("id") or "")
    if not rules:
        return field
    merged = {**field, **rules}
    return merged


def questionnaire_audience(
    education_detail: Any = None, profile: Optional[Dict[str, Any]] = None
) -> str:
    """Школа / СПО / вуз — разные обязательные поля и тон разбора."""
    detail = education_detail
    if detail is None and profile:
        detail = profile.get("education_detail") or profile.get("education_level")
    d = str(detail or "").strip().lower()
    if d in _SCHOOL_EDUCATION_IDS:
        return AUDIENCE_SCHOOL
    if d in _VOCATIONAL_EDUCATION_IDS:
        return AUDIENCE_VOCATIONAL
    return AUDIENCE_CAREER


def _normalize_audience_list(audience: Any) -> List[str]:
    if audience is None:
        return [AUDIENCE_SCHOOL, AUDIENCE_VOCATIONAL, AUDIENCE_CAREER]
    if isinstance(audience, str):
        return [audience]
    return list(audience)


def _field_visible_for_audience(field: Dict[str, Any], audience: str) -> bool:
    return audience in _normalize_audience_list(field.get("audience"))


def _section_visible_for_audience(section: Dict[str, Any], audience: str) -> bool:
    return audience in _normalize_audience_list(section.get("audience"))


def resolve_profile_schema(
    schema: Dict[str, Any],
    audience: str,
    profile: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Схема анкеты: уровень образования + видимые поля по сферам интересов."""
    from wibe_work.services.user_context import parse_interest_spheres

    completions = schema.get("completions") or {}
    comp = completions.get(audience) or schema.get("completion") or {}
    sphere_ids: List[str] = []
    if profile:
        sphere_ids = parse_interest_spheres(profile)
        if not sphere_ids and (profile.get("main_sphere") or "").strip():
            sphere_ids = [str(profile.get("main_sphere")).strip()]
    sections_out: List[Dict[str, Any]] = []
    for sec in schema.get("sections") or []:
        if not _section_visible_for_audience(sec, audience):
            continue
        fields: List[Dict[str, Any]] = []
        for f in sec.get("fields") or []:
            if not _field_visible_for_audience(f, audience):
                continue
            if not _field_visible_for_spheres(f, sphere_ids):
                continue
            fields.append(_resolve_field_for_spheres(f, sphere_ids))
        if not fields:
            continue
        sections_out.append({**sec, "fields": fields})
    return {
        **schema,
        "audience": audience,
        "completion": comp,
        "sections": sections_out,
    }


def parse_favorite_subjects(profile: Dict[str, Any]) -> List[str]:
    if not profile:
        return []
    raw = profile.get("favorite_subjects")
    if raw is None or raw == "":
        return []
    if isinstance(raw, list):
        return [str(x).strip() for x in raw if str(x).strip()]
    s = str(raw).strip()
    if not s:
        return []
    if s.startswith("["):
        import json

        try:
            arr = json.loads(s)
            if isinstance(arr, list):
                return [str(x).strip() for x in arr if str(x).strip()]
        except json.JSONDecodeError:
            pass
    return [p.strip() for p in s.split(",") if p.strip()]


def normalize_profile_for_completion(profile: Dict[str, Any]) -> Dict[str, Any]:
    """Свести legacy-поля к id из схемы v2 перед проверкой заполненности."""
    p = dict(profile or {})
    if not (p.get("course_grade") or "").strip() and p.get("course_or_grade") not in (None, ""):
        p["course_grade"] = str(p["course_or_grade"]).strip()
    if not (p.get("work_format_preference") or "").strip():
        wfp = p.get("work_format_pref")
        if isinstance(wfp, list) and wfp:
            p["work_format_preference"] = str(wfp[0]).strip()
        elif isinstance(wfp, str) and wfp.strip():
            part = wfp.split(",")[0].strip()
            if part:
                p["work_format_preference"] = part
    if not (p.get("education_detail") or "").strip():
        _edu_ru = {
            "школа": "school_8_11",
            "колледж": "spo",
            "вуз": "univ_bachelor",
        }
        for raw in (p.get("education_level"), p.get("education")):
            if raw is None or not str(raw).strip():
                continue
            key = str(raw).strip().lower()
            if key in _edu_ru:
                p["education_detail"] = _edu_ru[key]
                break
            if "_" in str(raw):
                p["education_detail"] = str(raw).strip()
                break
    if not (p.get("like_to_do") or "").strip() and (p.get("interests") or "").strip():
        p["like_to_do"] = str(p["interests"]).strip()
    return p


def _value_filled(value: Any) -> bool:
    if value is None or value == "":
        return False
    if isinstance(value, (int, float)):
        return not (isinstance(value, float) and value != value)
    if isinstance(value, str):
        return bool(value.strip())
    return True


def profile_field_filled(profile: Dict[str, Any], field_id: str) -> bool:
    from wibe_work.services.user_context import parse_interest_spheres

    if not profile:
        return False
    if field_id == "favorite_subjects":
        return bool(parse_favorite_subjects(profile))
    if field_id == "interest_spheres":
        return bool(parse_interest_spheres(profile) or (profile.get("main_sphere") or "").strip())
    if field_id == "course_grade":
        return _value_filled(profile.get("course_grade")) or _value_filled(profile.get("course_or_grade"))
    if field_id == "work_format_preference":
        return _value_filled(profile.get("work_format_preference")) or _value_filled(profile.get("work_format_pref"))
    if field_id == "education_detail":
        return _value_filled(profile.get("education_detail")) or _value_filled(profile.get("education_level"))
    if field_id == "like_to_do":
        return _value_filled(profile.get("like_to_do")) or _value_filled(profile.get("interests"))
    return _value_filled(profile.get(field_id))


def is_profile_complete(profile: Dict[str, Any]) -> bool:
    p = normalize_profile_for_completion(profile)
    aud = questionnaire_audience(profile=p)
    comp = COMPLETION_BY_AUDIENCE.get(aud, COMPLETION_BY_AUDIENCE[AUDIENCE_CAREER])
    for fid in comp.get("required") or []:
        if not profile_field_filled(p, fid):
            return False
    detail = str(p.get("education_detail") or "").strip().lower()
    for fid, skipped_for in (comp.get("required_unless_education_detail") or {}).items():
        if detail not in {str(v).strip().lower() for v in (skipped_for or [])}:
            if not profile_field_filled(p, fid):
                return False
    for group in comp.get("any_of") or []:
        if not any(profile_field_filled(p, fid) for fid in group):
            return False
    return True


def _base_section_fields(sphere_opts: List[Dict[str, str]]) -> List[Dict[str, Any]]:
    return [
        {
            "id": "age",
            "type": "number",
            "label": "Возраст",
            "placeholder": "17",
            "min": 14,
            "max": 25,
            "required": True,
            "audience": [AUDIENCE_SCHOOL, AUDIENCE_VOCATIONAL, AUDIENCE_CAREER],
        },
        {
            "id": "city",
            "type": "text",
            "label": "Город",
            "placeholder": "Москва, Казань…",
            "required": True,
            "audience": [AUDIENCE_SCHOOL, AUDIENCE_VOCATIONAL, AUDIENCE_CAREER],
        },
        {
            "id": "education_detail",
            "type": "select",
            "label": "Уровень образования",
            "required": True,
            "audience": [AUDIENCE_SCHOOL, AUDIENCE_VOCATIONAL, AUDIENCE_CAREER],
            "options": [
                {
                    "id": "school_8_11",
                    "label": "Школьник (8–11 кл.)",
                    "maps_education": "школа",
                },
                {"id": "spo", "label": "Студент СПО", "maps_education": "колледж"},
                {
                    "id": "univ_bachelor",
                    "label": "Студент вуза (бакалавр)",
                    "maps_education": "вуз",
                },
                {
                    "id": "univ_master",
                    "label": "Студент вуза (магистр)",
                    "maps_education": "вуз",
                },
                {"id": "graduate", "label": "Выпускник", "maps_education": "вуз"},
            ],
        },
        {
            "id": "course_grade",
            "type": "text",
            "label": "Класс / курс",
            "placeholder": "10 класс, 2 курс…",
            "required": True,
            "hide_for_education_detail": ["graduate"],
            "audience": [AUDIENCE_SCHOOL, AUDIENCE_VOCATIONAL, AUDIENCE_CAREER],
        },
        {
            "id": "study_form",
            "type": "select",
            "label": "Форма обучения",
            "required": False,
            "audience": [AUDIENCE_VOCATIONAL, AUDIENCE_CAREER],
            "options": [
                {"id": "fulltime", "label": "Очная"},
                {"id": "parttime", "label": "Заочная"},
                {"id": "evening", "label": "Вечерняя"},
                {"id": "online", "label": "Онлайн"},
            ],
        },
        {
            "id": "education_level",
            "type": "hidden",
            "label": "",
            "sync_from": "education_detail",
            "audience": [AUDIENCE_SCHOOL, AUDIENCE_VOCATIONAL, AUDIENCE_CAREER],
        },
    ]


def get_profile_schema() -> Dict[str, Any]:
    sphere_opts = [{"id": s["id"], "label": s["label"]} for s in INTEREST_SPHERES]
    subject_opts = [{"id": s["id"], "label": s["label"]} for s in SCHOOL_SUBJECT_OPTIONS]

    return {
        "version": 3,
        "wizard": True,
        "interest_spheres": INTEREST_SPHERES,
        "school_subjects": SCHOOL_SUBJECT_OPTIONS,
        "sphere_groups": {k: list(v) for k, v in SPHERE_GROUPS.items()},
        "sphere_to_web_interest": dict(SPHERE_TO_WEB_INTEREST),
        "completions": {k: dict(v) for k, v in COMPLETION_BY_AUDIENCE.items()},
        "completion": dict(COMPLETION_BY_AUDIENCE[AUDIENCE_CAREER]),
        "sections": [
            {
                "id": "base",
                "theme": "Личные данные",
                "title": "Базовые данные",
                "audience": [AUDIENCE_SCHOOL, AUDIENCE_VOCATIONAL, AUDIENCE_CAREER],
                "fields": _base_section_fields(sphere_opts),
            },
            {
                "id": "pain_school",
                "theme": "Ваша ситуация",
                "title": "Что сейчас больше всего мешает?",
                "optional": True,
                "audience": [AUDIENCE_SCHOOL],
                "fields": [
                    {
                        "id": "primary_pain",
                        "type": "radio",
                        "label": "",
                        "required": False,
                        "options": [
                            {
                                "id": "pain_school_direction",
                                "label": "Не знаю, куда поступать после школы",
                            },
                            {
                                "id": "pain_school_subjects",
                                "label": "Сложно выбрать профильные предметы",
                            },
                            {
                                "id": "pain_school_exams",
                                "label": "Тревожусь из-за ОГЭ / ЕГЭ",
                            },
                            {
                                "id": "pain_school_grades",
                                "label": "Не хватает баллов или слабые оценки",
                            },
                            {
                                "id": "pain_school_overload",
                                "label": "Слишком много советов и курсов",
                            },
                            {
                                "id": "pain_school_parents",
                                "label": "Давление родителей / не совпадаем в выборе",
                            },
                            {
                                "id": "pain_school_confidence",
                                "label": "Кажется, что я хуже одноклассников",
                            },
                        ],
                    },
                ],
            },
            {
                "id": "pain",
                "theme": "Ваша ситуация",
                "title": "Что сейчас больше всего мешает?",
                "optional": True,
                "audience": [AUDIENCE_CAREER],
                "fields": [
                    {
                        "id": "primary_pain",
                        "type": "radio",
                        "label": "",
                        "required": False,
                        "options": [
                            {"id": "pain_career", "label": "Не знаю, кем стать"},
                            {"id": "pain_no_exp", "label": "Нет опыта — не возьмут"},
                            {"id": "pain_region", "label": "Мало вакансий в моём городе"},
                            {"id": "pain_money_courses", "label": "Нет денег на курсы"},
                            {"id": "pain_interview", "label": "Боюсь собеседований"},
                            {"id": "pain_overload", "label": "Слишком много информации"},
                            {"id": "pain_low_confidence", "label": "Кажется, что ничего не умею"},
                            {"id": "pain_gap_skills", "label": "Умею многое, но работу не дают"},
                        ],
                    },
                ],
            },
            {
                "id": "pain_vocational",
                "theme": "Ваша ситуация",
                "title": "Что сейчас больше всего мешает?",
                "optional": True,
                "audience": [AUDIENCE_VOCATIONAL],
                "fields": [
                    {
                        "id": "primary_pain",
                        "type": "radio",
                        "label": "",
                        "required": False,
                        "options": [
                            {
                                "id": "pain_voc_direction",
                                "label": "Не знаю, вуз или работа после колледжа",
                            },
                            {
                                "id": "pain_voc_specialty",
                                "label": "Сложно понять, куда углублять специальность",
                            },
                            {
                                "id": "pain_voc_practice",
                                "label": "Мало практики по специальности",
                            },
                            {
                                "id": "pain_voc_diploma",
                                "label": "Не вижу, как диплом связан с планами",
                            },
                            {
                                "id": "pain_voc_overload",
                                "label": "Слишком много советов и курсов",
                            },
                            {
                                "id": "pain_voc_confidence",
                                "label": "Кажется, что я отстаю от группы",
                            },
                            {
                                "id": "pain_voc_family",
                                "label": "Давление семьи / не совпадаем в выборе",
                            },
                        ],
                    },
                ],
            },
            {
                "id": "school_interests",
                "theme": "Интересы",
                "title": "Интересы и любимые предметы",
                "audience": [AUDIENCE_SCHOOL],
                "fields": [
                    {
                        "id": "interest_spheres",
                        "type": "multiselect",
                        "label": "Сферы, которые вам близки (до 5)",
                        "max_select": 5,
                        "required": True,
                        "options": sphere_opts,
                    },
                    {
                        "id": "favorite_subjects",
                        "type": "multiselect",
                        "label": "Любимые школьные предметы (до 6)",
                        "max_select": 6,
                        "required": False,
                        "options": subject_opts,
                        "help": "Поможет подобрать профиль, ОГЭ/ЕГЭ и направления поступления.",
                    },
                    {
                        "id": "like_to_do",
                        "type": "textarea",
                        "label": "Чем нравится заниматься вне уроков",
                        "placeholder": "Робототехника, рисование, спорт, волонтёрство…",
                        "required": True,
                    },
                    {
                        "id": "dislike_to_do",
                        "type": "textarea",
                        "label": "Что в школе даётся тяжелее всего",
                        "placeholder": "Например: публичные выступления, химия…",
                    },
                ],
            },
            {
                "id": "school_path",
                "theme": "Поступление",
                "title": "Планы после школы",
                "audience": [AUDIENCE_SCHOOL],
                "fields": [
                    {
                        "id": "post_school_goal",
                        "type": "select",
                        "label": "Главный план после 9 или 11 класса",
                        "required": False,
                        "options": [
                            {
                                "id": "after_9_college",
                                "label": "После 9 класса — в колледж (СПО)",
                            },
                            {
                                "id": "after_9_school",
                                "label": "После 9 класса — остаться в 10–11 классе",
                            },
                            {
                                "id": "after_11_university",
                                "label": "После 11 класса — в вуз",
                            },
                            {
                                "id": "after_11_college",
                                "label": "После 11 класса — в колледж (СПО)",
                            },
                            {"id": "undecided", "label": "Пока не решил(а)"},
                        ],
                    },
                    {
                        "id": "admission_target",
                        "type": "text",
                        "label": "Куда мечтаете поступить (необязательно)",
                        "placeholder": "Например: МГТУ, колледж дизайна, медицинский…",
                    },
                    {
                        "id": "exam_focus",
                        "type": "select",
                        "label": "Что готовите сейчас",
                        "required": False,
                        "options": [
                            {"id": "oge_9", "label": "ОГЭ (9 класс)"},
                            {"id": "ege_11", "label": "ЕГЭ (11 класс)"},
                            {"id": "both", "label": "И ОГЭ, и ЕГЭ впереди"},
                            {
                                "id": "profile_only",
                                "label": "Пока без экзаменов — выбираю профиль",
                            },
                            {"id": "none", "label": "Не готовлюсь к экзаменам сейчас"},
                        ],
                    },
                ],
            },
            {
                "id": "school_prep",
                "theme": "Подготовка",
                "title": "Подготовка к поступлению",
                "audience": [AUDIENCE_SCHOOL],
                "fields": [
                    {
                        "id": "hours_per_week",
                        "type": "number",
                        "label": "Часов в неделю на подготовку (уроки, репетитор, кружки)",
                        "placeholder": "5, 10, 15",
                        "min": 0,
                        "max": 60,
                        "required": False,
                    },
                    {
                        "id": "preparation_level",
                        "type": "select",
                        "label": "Как оцениваете готовность к поступлению",
                        "options": [
                            {"id": "weak", "label": "Слабая — только начинаю"},
                            {"id": "medium", "label": "Средняя — есть база"},
                            {"id": "strong", "label": "Сильная — уверенно"},
                        ],
                    },
                    {
                        "id": "extra_education",
                        "type": "textarea",
                        "label": "Кружки, олимпиады, курсы",
                        "placeholder": "Фокус на информатику, олимпиада по математике…",
                    },
                ],
            },
            {
                "id": "school_activities",
                "theme": "Опыт",
                "title": "Проекты и достижения",
                "optional": True,
                "audience": [AUDIENCE_SCHOOL],
                "fields": [
                    _enrich_field(
                        {
                            "id": "experience_projects",
                            "type": "textarea",
                            "label": "Проекты и хобби",
                            "placeholder": "Кружок, олимпиада, волонтёрство…",
                        }
                    ),
                    {
                        "id": "achievements",
                        "type": "textarea",
                        "label": "Достижения",
                        "placeholder": "Олимпиады, грамоты, сертификаты…",
                    },
                    {
                        "id": "experience_volunteer",
                        "type": "textarea",
                        "label": "Волонтёрство и активности",
                    },
                ],
            },
            {
                "id": "interests",
                "theme": "Предпочтения",
                "title": "Интересы и склонности",
                "audience": [AUDIENCE_VOCATIONAL, AUDIENCE_CAREER],
                "fields": [
                    {
                        "id": "interest_spheres",
                        "type": "multiselect",
                        "label": "Сферы интересов (до 5)",
                        "max_select": 5,
                        "required": True,
                        "options": sphere_opts,
                    },
                    {
                        "id": "like_to_do",
                        "type": "textarea",
                        "label": "Чем нравится заниматься",
                        "placeholder": "Собирать ПК, рисовать, вести соцсети, помогать людям…",
                        "required": True,
                    },
                    {
                        "id": "dislike_to_do",
                        "type": "textarea",
                        "label": "Что не нравится делать",
                        "placeholder": "Холодные звонки, сидеть без движения, считать цифры…",
                    },
                    {
                        "id": "work_format_preference",
                        "type": "select",
                        "label": "Предпочитаемый формат работы",
                        "required": False,
                        "audience": [AUDIENCE_CAREER],
                        "options": [
                            {"id": "office", "label": "В офисе"},
                            {"id": "remote", "label": "Удалённо"},
                            {"id": "hybrid", "label": "Гибрид"},
                            {"id": "any", "label": "Не важно"},
                        ],
                    },
                    {
                        "id": "relocation_ready",
                        "type": "select",
                        "label": "Готовность к переезду",
                        "audience": [AUDIENCE_CAREER],
                        "options": [
                            {"id": "yes", "label": "Да"},
                            {"id": "no", "label": "Нет"},
                            {"id": "big_cities", "label": "Только в крупные города"},
                        ],
                    },
                    {
                        "id": "work_schedule",
                        "type": "select",
                        "label": "График работы",
                        "required": False,
                        "audience": [AUDIENCE_CAREER],
                        "options": [
                            {"id": "weekends", "label": "Только выходные"},
                            {"id": "after_classes", "label": "После пар"},
                            {"id": "full_day", "label": "Полный день"},
                            {"id": "flex", "label": "Свободный график"},
                        ],
                    },
                ],
            },
            {
                "id": "skills_hard",
                "theme": "Навыки",
                "title": "Навыки (профессиональные)",
                "optional": True,
                "audience": [AUDIENCE_VOCATIONAL, AUDIENCE_CAREER],
                "fields": [
                    _enrich_field(
                        {
                            "id": "software_skills",
                            "type": "textarea",
                            "label": "Программы и инструменты",
                            "placeholder": "Excel, Figma, Python, Canva — и уровень 1–5 при желании",
                        }
                    ),
                    {
                        "id": "languages",
                        "type": "text",
                        "label": "Иностранные языки",
                        "placeholder": "English B1, Deutsch A2…",
                    },
                    _enrich_field(
                        {
                            "id": "programming_skills",
                            "type": "textarea",
                            "label": "Программирование",
                            "placeholder": "HTML/CSS, Python…",
                        }
                    ),
                    _enrich_field(
                        {
                            "id": "social_media_skills",
                            "type": "textarea",
                            "label": "Соцсети и digital",
                            "placeholder": "Сообщество, таргет, SMM…",
                        }
                    ),
                    _enrich_field(
                        {
                            "id": "extra_education",
                            "type": "textarea",
                            "label": "Дополнительное обучение",
                            "placeholder": "Курсы, школы, олимпиады…",
                        }
                    ),
                ],
            },
            {
                "id": "skills_soft",
                "theme": "Личные качества",
                "title": "Личные качества (1–5)",
                "optional": True,
                "audience": [AUDIENCE_VOCATIONAL, AUDIENCE_CAREER],
                "fields": [
                    {
                        "id": "soft_communication",
                        "type": "scale",
                        "label": "Коммуникабельность",
                        "scale_min": 1,
                        "scale_max": 5,
                        "default": 3,
                    },
                    {
                        "id": "soft_teamwork",
                        "type": "scale",
                        "label": "Работа в команде",
                        "scale_min": 1,
                        "scale_max": 5,
                        "default": 3,
                    },
                    {
                        "id": "soft_organization",
                        "type": "scale",
                        "label": "Самоорганизация",
                        "scale_min": 1,
                        "scale_max": 5,
                        "default": 3,
                    },
                    {
                        "id": "soft_stress",
                        "type": "scale",
                        "label": "Стрессоустойчивость",
                        "scale_min": 1,
                        "scale_max": 5,
                        "default": 3,
                    },
                    {
                        "id": "soft_creativity",
                        "type": "scale",
                        "label": "Креативность",
                        "scale_min": 1,
                        "scale_max": 5,
                        "default": 3,
                    },
                    {
                        "id": "soft_analytical",
                        "type": "scale",
                        "label": "Аналитическое мышление",
                        "scale_min": 1,
                        "scale_max": 5,
                        "default": 3,
                    },
                ],
            },
            {
                "id": "experience",
                "theme": "Опыт",
                "title": "Опыт",
                "optional": True,
                "audience": [AUDIENCE_VOCATIONAL, AUDIENCE_CAREER],
                "fields": [
                    {
                        "id": "experience_official",
                        "type": "textarea",
                        "label": "Официальная работа",
                        "placeholder": "Должность, срок…",
                    },
                    {
                        "id": "experience_side",
                        "type": "textarea",
                        "label": "Подработки / фриланс",
                        "placeholder": "Курьер, Kwork…",
                    },
                    {
                        "id": "experience_volunteer",
                        "type": "textarea",
                        "label": "Волонтёрство",
                    },
                    _enrich_field(
                        {
                            "id": "experience_projects",
                            "type": "textarea",
                            "label": "Личные проекты",
                            "placeholder": "Канал, сайт, хакатон…",
                        }
                    ),
                    {
                        "id": "achievements",
                        "type": "textarea",
                        "label": "Достижения",
                        "placeholder": "Олимпиады, сертификаты…",
                    },
                ],
            },
            {
                "id": "spo_path",
                "theme": "После колледжа",
                "title": "Куда дальше после СПО",
                "audience": [AUDIENCE_VOCATIONAL],
                "fields": [
                    {
                        "id": "post_spo_goal",
                        "type": "select",
                        "label": "Главный план после колледжа",
                        "required": False,
                        "help": "Разбор подстроится: поступление в вуз или первые шаги на работу.",
                        "options": [
                            {
                                "id": "spo_to_university",
                                "label": "После колледжа — в вуз",
                            },
                            {
                                "id": "spo_to_work",
                                "label": "После колледжа — на работу / стажировку",
                            },
                            {"id": "undecided", "label": "Пока не решил(а)"},
                        ],
                    },
                ],
            },
            {
                "id": "goals_vocational",
                "theme": "Цели",
                "title": "Учёба и практика",
                "audience": [AUDIENCE_VOCATIONAL],
                "fields": [
                    {
                        "id": "hours_per_week",
                        "type": "number",
                        "label": "Свободных часов в неделю на учёбу и диплом",
                        "placeholder": "10, 20, 40",
                        "min": 0,
                        "max": 80,
                        "required": False,
                    },
                    _enrich_field(
                        {
                            "id": "internship_ready",
                            "type": "select",
                            "label": "Готовность к практике по специальности",
                            "options": [
                                {"id": "yes", "label": "Да"},
                                {"id": "no", "label": "Нет"},
                                {"id": "paid_only", "label": "Только оплачиваемая"},
                            ],
                        }
                    ),
                    {
                        "id": "career_priority",
                        "type": "select",
                        "label": "Что сейчас важнее",
                        "options": [
                            {"id": "learning", "label": "Учёба и диплом"},
                            {"id": "practice", "label": "Практика по специальности"},
                            {"id": "balance", "label": "Баланс учёбы и жизни"},
                        ],
                    },
                ],
            },
            {
                "id": "goals",
                "theme": "Цели",
                "title": "Цели и работа",
                "audience": [AUDIENCE_CAREER],
                "fields": [
                    {
                        "id": "target_salary",
                        "type": "number",
                        "label": "Целевой доход (₽/мес)",
                        "placeholder": "30000",
                        "min": 0,
                        "max": 500000,
                        "required": False,
                    },
                    _enrich_field(
                        {
                            "id": "internship_ready",
                            "type": "select",
                            "label": "Готовность к стажировке",
                            "options": [
                            {"id": "yes", "label": "Да"},
                            {"id": "no", "label": "Нет"},
                            {"id": "paid_only", "label": "Только оплачиваемая"},
                        ],
                        }
                    ),
                    {
                        "id": "hours_per_week",
                        "type": "number",
                        "label": "Свободных часов в неделю на работу и учёбу",
                        "placeholder": "10, 20, 40",
                        "min": 0,
                        "max": 80,
                        "required": False,
                    },
                    _enrich_field(
                        {
                            "id": "has_resume_portfolio",
                            "type": "select",
                            "label": "Есть резюме / портфолио",
                            "options": [
                                {"id": "yes", "label": "Да"},
                                {"id": "no", "label": "Нет"},
                            ],
                        }
                    ),
                    {
                        "id": "career_priority",
                        "type": "select",
                        "label": "Что сейчас важнее",
                        "options": [
                            {"id": "learning", "label": "Обучение и рост"},
                            {"id": "money", "label": "Деньги и стабильный доход"},
                            {"id": "balance", "label": "Баланс жизни и работы"},
                        ],
                    },
                ],
            },
            {
                "id": "extra",
                "theme": "Дополнительно",
                "title": "Дополнительно",
                "optional": True,
                "audience": [AUDIENCE_VOCATIONAL, AUDIENCE_CAREER],
                "fields": [
                    {
                        "id": "preparation_level",
                        "type": "select",
                        "label": "Уровень подготовки к профессии",
                        "options": [
                            {"id": "weak", "label": "Слабый — только начинаю"},
                            {"id": "medium", "label": "Средний — есть база"},
                            {"id": "strong", "label": "Сильный — уверенно"},
                        ],
                    },
                    {
                        "id": "motivation_ai",
                        "type": "textarea",
                        "label": "Почему выбрали это направление",
                        "placeholder": "Коротко, до 500 символов",
                        "max_length": 500,
                    },
                ],
            },
        ],
    }
