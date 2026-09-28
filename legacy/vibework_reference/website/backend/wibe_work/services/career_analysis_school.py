"""Разбор для школьников: куда идти учиться и что подтянуть, без карьерных треков."""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional, Set, Tuple

from wibe_work.questionnaire_fields import INTEREST_SPHERES, parse_favorite_subjects
from wibe_work.services.profile_analysis_context import (
    SUBJECT_GAP_LABELS,
    analysis_mode_for_profile,
    favorite_subjects_labels,
)
from wibe_work.services.assessment_routing import parse_course_grade, resolve_assessment_track
from wibe_work.services.user_context import parse_interest_spheres

_SPHERE_LABELS: Dict[str, str] = {s["id"]: s["label"] for s in INTEREST_SPHERES}

# Варианты «куда идти» по сфере (не профессии на рынке труда)
_SCHOOL_PATH_POOLS: Dict[str, Tuple[str, ...]] = {
    "it_dev": (
        "Колледж / СПО: программирование и IT",
        "11 класс + профильная информатика и ЕГЭ",
        "Техникум с отраслевой специальностью (IT, связь, автоматизация)",
        "Университет через 2–3 года: прикладная информатика / IT",
        "Кружки, олимпиады и проекты — проверить интерес до поступления",
    ),
    "data": (
        "Колледж: аналитика, экономика, IT",
        "11 класс: математика + информатика (профиль)",
        "СПО с упором на данные и отчётность",
        "Университет: прикладная математика / аналитика",
    ),
    "design": (
        "Колледж: дизайн, графика, мультимедиа",
        "11 класс: искусство / информатика + творческий проект",
        "Училище / колледж прикладного искусства",
        "Вуз: дизайн, архитектура, медиа",
    ),
    "marketing": (
        "Колледж: маркетинг, реклама, SMM",
        "11 класс: обществознание + проекты (контент, исследования)",
        "СПО: коммерция, маркетинг",
        "Вуз: маркетинг, менеджмент, медиа",
    ),
    "sales": (
        "Колледж: торговля, менеджмент, сервис",
        "11 класс + курсы переговоров / волонтёрство",
        "СПО: продажи и обслуживание",
        "Вуз: экономика, менеджмент",
    ),
    "engineering": (
        "Техникум / колледж: рабочие и инженерные специальности",
        "11 класс: физика + математика",
        "Профессионалитет / колледж по отрасли",
        "Вуз: инженерные направления",
    ),
    "education": (
        "Колледж / СПО: педагогика, дошкольное образование",
        "11 класс: гуманитарный профиль (история, обществознание, литература)",
        "Педагогический колледж или вуз",
        "Кружки и волонтёрство с детьми — проверить интерес к обучению других",
    ),
    "medicine": (
        "Колледж: сестринское дело, фармация или лаб. диагностика",
        "11 класс: биология + химия (профиль) и ЕГЭ",
        "Вуз позже: медицина / биология / химия — через колледж или 11 класс",
    ),
    "hr_edu": (
        "Колледж: кадровое дело, педагогика",
        "11 класс: обществознание + психология (факультатив)",
        "Вуз: управление персоналом, педагогика",
    ),
    "logistics": (
        "Колледж: логистика, склад, транспорт",
        "11 класс: математика + обществознание",
        "СПО: организация перевозок / снабжение",
        "Вуз: логистика, менеджмент цепочек поставок",
    ),
    "finance": (
        "Колледж: экономика, бухгалтерия, финансы",
        "11 класс: математика + обществознание (профиль)",
        "СПО: учёт и экономика",
        "Вуз: экономика, финансы, менеджмент",
    ),
    "creative": (
        "Колледж: медиа, фото, контент, прикладное искусство",
        "11 класс: творческий профиль + проекты",
        "Кружки и конкурсы — проверить интерес до поступления",
        "Вуз: медиа, журналистика, творческие направления",
    ),
    "sport": (
        "Колледж: спорт, фитнес, инструктор",
        "11 класс + спортивная секция / разряд",
        "СПО: физическая культура, адаптивный спорт",
        "Вуз: физкультура, спорт, педагогика спорта",
    ),
    "mgmt": (
        "Колледж: менеджмент, сервис, администрирование",
        "11 класс: обществознание + проекты / волонтёрство",
        "СПО: управление и организация",
        "Вуз: менеджмент, государственное управление",
    ),
    "other": (
        "Колледж (СПО) по выбранной сфере",
        "11 класс — уточнить профильные предметы и ОГЭ/ЕГЭ",
        "Кружок или олимпиада — проверить интерес",
        "Вуз — после осознанного выбора сферы",
    ),
    "default": (
        "Колледж (СПО) по выбранной сфере",
        "11 класс — уточнить профильные предметы",
        "Кружок или олимпиада — проверить интерес",
        "Вуз — после осознанного выбора сферы",
    ),
}

# Предметы/навыки для «разрыва» у школьника (не job skills)
_SCHOOL_GAP_BY_INTEREST: Dict[str, List[Tuple[str, str]]] = {
    "it_dev": [
        ("math", "Математика (алгебра, логика)"),
        ("informatics", "Информатика / программирование"),
        ("english", "Английский"),
        ("project", "Олимпиада / кружок по информатике"),
        ("career_choice", "Профориентация и выбор после 9/11"),
        ("exams", "Подготовка к ОГЭ / ЕГЭ"),
    ],
    "data": [
        ("math", "Математика"),
        ("informatics", "Информатика / Excel"),
        ("english", "Английский"),
        ("project", "Исследовательский мини-проект"),
        ("career_choice", "Выбор колледжа / вуза"),
        ("exams", "Подготовка к ОГЭ / ЕГЭ"),
    ],
    "design": [
        ("art", "Рисунок и композиция"),
        ("digital", "Цифровые инструменты (по возможности)"),
        ("project", "Творческий мини-проект / конкурс"),
        ("english", "Английский"),
        ("career_choice", "Куда поступать"),
        ("exams", "Подготовка к ОГЭ / ЕГЭ по профилю"),
    ],
    "education": [
        ("history", "История"),
        ("social", "Обществознание"),
        ("literature", "Литература / русский"),
        ("practice", "Кружок, волонтёрство, работа с детьми"),
        ("career_choice", "Выбор педагогического колледжа / профиля"),
        ("exams", "Подготовка к ОГЭ / ЕГЭ"),
    ],
    "engineering": [
        ("math", "Математика"),
        ("physics", "Физика"),
        ("practice", "Кружок, мастерская, технический проект"),
        ("informatics", "Информатика (чертежи, моделирование)"),
        ("career_choice", "Выбор техникума / колледжа по отрасли"),
        ("exams", "Подготовка к ОГЭ / ЕГЭ"),
    ],
    "medicine": [
        ("biology", "Биология"),
        ("chemistry", "Химия"),
        ("exams", "Подготовка к ОГЭ / ЕГЭ / вступительным"),
        ("career_choice", "Выбор медколледжа / профиля"),
        ("english", "Английский"),
    ],
    "hr_edu": [
        ("social", "Обществознание"),
        ("practice", "Практика общения и организации"),
        ("career_choice", "Куда поступать"),
        ("english", "Английский"),
        ("exams", "Подготовка к ОГЭ / ЕГЭ"),
    ],
    "marketing": [
        ("social", "Обществознание"),
        ("practice", "Контент-проект / исследование"),
        ("english", "Английский"),
        ("career_choice", "Куда поступать"),
        ("exams", "Подготовка к ОГЭ / ЕГЭ"),
    ],
    "sales": [
        ("social", "Обществознание"),
        ("practice", "Коммуникация: проекты, волонтёрство, мероприятия"),
        ("english", "Английский"),
        ("career_choice", "Куда поступать"),
        ("exams", "Подготовка к ОГЭ / ЕГЭ"),
    ],
    "logistics": [
        ("math", "Математика"),
        ("social", "Обществознание"),
        ("practice", "Организация / учёт (школьные проекты)"),
        ("career_choice", "Куда поступать"),
        ("exams", "Подготовка к ОГЭ / ЕГЭ"),
    ],
    "finance": [
        ("math", "Математика"),
        ("social", "Обществознание / экономика"),
        ("practice", "Учебный мини-проект с цифрами"),
        ("english", "Английский"),
        ("career_choice", "Куда поступать"),
        ("exams", "Подготовка к ОГЭ / ЕГЭ"),
    ],
    "creative": [
        ("art", "Творческий предмет / студия"),
        ("project", "Творческий мини-проект / конкурс"),
        ("english", "Английский"),
        ("career_choice", "Куда поступать"),
        ("exams", "Подготовка к ОГЭ / ЕГЭ по профилю"),
    ],
    "sport": [
        ("practice", "Секция / разряд / соревнования"),
        ("biology", "Биология (по возможности)"),
        ("career_choice", "Куда поступать"),
        ("exams", "Подготовка к ОГЭ / ЕГЭ"),
        ("english", "Английский"),
    ],
    "mgmt": [
        ("social", "Обществознание"),
        ("practice", "Организация мероприятий / проектов"),
        ("english", "Английский"),
        ("career_choice", "Куда поступать"),
        ("exams", "Подготовка к ОГЭ / ЕГЭ"),
    ],
    "other": [
        ("core_subjects", "Профильные предметы в школе"),
        ("practice", "Кружок или проект по интересу"),
        ("english", "Английский"),
        ("orientation", "Профориентация"),
        ("exams", "Подготовка к ОГЭ / ЕГЭ"),
    ],
    "default": [
        ("core_subjects", "Профильные предметы в школе"),
        ("practice", "Кружок или проект"),
        ("english", "Английский"),
        ("orientation", "Профориентация"),
        ("exams", "Подготовка к ОГЭ / ЕГЭ"),
    ],
}

_SCHOOL_PAIN_STEPS: Dict[str, str] = {
    "pain_school_direction": "Запишите 3 варианта «куда идти» из сценариев A/B/C и обсудите с родителями или классным — один шаг на 2 недели.",
    "pain_school_subjects": "Сопоставьте любимые предметы из анкеты с требованиями колледжа/вуза мечты — выберите один предмет для углубления на месяц.",
    "pain_school_exams": "Один предмет из блока «Обучение» и 2 короткие тренировки в неделю — без попытки закрыть всё сразу.",
    "pain_school_grades": "Начните с предмета, где уже есть интерес (из любимых) — репетитор или бесплатный курс из подборки.",
    "pain_school_parents": "Покажите родителям сценарии A/B/C из разбора — зафиксируйте один компромиссный вариант на пробу.",
    "pain_school_confidence": "Список из 5 дел из школы и хобби, где вы справились — это ваши сильные стороны.",
    "pain_career": "Запишите 3 варианта «куда идти» из сценариев A/B/C и обсудите с родителями или классным — один шаг на 2 недели.",
    "pain_no_exp": "Опыт для школьника — это проекты, кружки, олимпиады: оформите один кейс в 5 строк (что делали → результат).",
    "pain_region": "Смотрите колледжи и вузы в своём городе и соседних — плюс дистанционные программы по вашей сфере.",
    "pain_money_courses": "Бесплатные курсы и олимпиады из блока «Обучение» — один трек на месяц, без покупки дорогих пакетов.",
    "pain_interview": "Пока рано про собеседования на работу — полезнее пробное поступление и день открытых дверей в колледже.",
    "pain_overload": "Один шаг из плана на неделю: один предмет или один вариант поступления, не всё сразу.",
    "pain_low_confidence": "Список из 5 дел из школы и хобби, где вы справились — это ваши сильные стороны, не сравнение с взрослыми.",
    "pain_gap_skills": "Сопоставьте «разрыв предметов» с требованиями колледжа мечты — начните с одного предмета на месяц.",
}


def _interest_key(interest: str) -> str:
    k = (interest or "").strip()
    return k if k in _SCHOOL_PATH_POOLS else "default"


def _dominant_radar_key(axes: List[Dict[str, Any]]) -> str:
    if not axes:
        return "structure_mastery"
    best = max(axes, key=lambda a: int(a.get("value_percent") or 0))
    return str(best.get("key") or "structure_mastery")


def _score_path(name: str, dom: str, fp: int, idx: int) -> int:
    low = name.lower()
    base = 58 + (fp % 11) - (idx * 2)
    if dom == "structure_mastery" and any(x in low for x in ("матем", "информ", "техник", "it", "данн", "инженер")):
        base += 8
    if dom == "people_service" and any(
        x in low for x in ("педагог", "образ", "сервис", "соци", "гуманит", "истор", "кадр")
    ):
        base += 6
    if dom == "self_insight" and "профор" in low:
        base += 5
    if "11 класс" in low or "егэ" in low:
        base += 4
    return base


_SUBJECT_PATH_KEYWORDS: Dict[str, Tuple[str, ...]] = {
    "informatics": ("информ", "программ", "it", "айти", "данн"),
    "math": ("матем", "инженер", "данн", "it"),
    "physics": ("физик", "инженер", "техник"),
    "history": ("истор", "гуманит", "обществ", "педагог", "образ"),
    "social": ("обществ", "педагог", "образ", "гуманит", "кадр"),
    "literature": ("литерат", "гуманит", "педагог"),
    "biology": ("биолог", "мед", "сестрин", "фармац"),
    "chemistry": ("хими", "мед", "фармац", "лаборат"),
    "art": ("дизайн", "искусств", "график", "медиа"),
    "english": ("англий", "гуманит", "педагог", "лингвист"),
}


def _boost_score_for_favorite_subjects(name: str, fav_ids: Set[str]) -> int:
    if not fav_ids:
        return 0
    low = name.lower()
    boost = 0
    for sid in fav_ids:
        kws = _SUBJECT_PATH_KEYWORDS.get(sid, ())
        if any(k in low for k in kws):
            boost += 9
    return min(boost, 18)


# Только явная медицина/сестринское — не цепляем случайные «мед» внутри других слов.
_MED_PATH_RE = re.compile(
    r"(?:мед(?:колледж|ицин|сестр)|сестрин|фармац|лаб\.?\s*диагност|лабораторн\w*\s+диагност)",
    re.I,
)
_AFTER_9_RE = re.compile(r"после\s*9", re.I)


def _path_family(name: str) -> str:
    """Ключ для удаления почти одинаковых маршрутов."""
    low = (name or "").lower()
    # «вуз позже … через колледж» — это вуз, не второй медколледж.
    if low.startswith("вуз") or "вуз позже" in low or low.startswith("университет"):
        return "uni:" + ("med" if _MED_PATH_RE.search(low) else re.sub(r"\W+", " ", low)[:28].strip())
    # «колледж или вуз» — один тип маршрута, не два разных.
    if "колледж" in low and "вуз" in low:
        if _MED_PATH_RE.search(low):
            return "med_college"
        if any(k in low for k in ("педагог", "дошкол", "учитель")):
            return "college_education"
        return "college_or_uni:" + re.sub(r"\W+", " ", low)[:28].strip()
    if any(k in low for k in ("вуз", "университет")):
        return "uni:" + ("med" if _MED_PATH_RE.search(low) else re.sub(r"\W+", " ", low)[:28].strip())
    if _MED_PATH_RE.search(low) and any(k in low for k in ("колледж", "спо", "техникум")):
        return "med_college"
    if "остаться в школе" in low or (
        re.search(r"10\s*[–\-]\s*11|11\s*класс", low) and "колледж" not in low and "вуз" not in low
    ):
        return "stay_school_profile"
    if any(k in low for k in ("педагог", "дошкол", "учитель")) and "колледж" in low:
        return "college_education"
    if any(k in low for k in ("программ", "it", "информ")) and any(
        k in low for k in ("колледж", "спо", "техникум")
    ):
        return "college_it"
    if any(k in low for k in ("колледж", "спо", "техникум")):
        return "college:" + re.sub(r"\W+", " ", low)[:36].strip()
    if any(k in low for k in ("круж", "олимпиад", "волонт", "проект", "проверить интерес")):
        return "explore_practice"
    return "other:" + re.sub(r"\W+", " ", low)[:48].strip()


def _normalize_path_for_track(name: str, track: str) -> Optional[str]:
    """Подправить формулировку под класс; None — выкинуть маршрут."""
    raw = (name or "").strip()
    if not raw:
        return None
    low = raw.lower()

    # 10–11 класс: «после 9» уже не про них.
    if track == "school_senior":
        if _AFTER_9_RE.search(low):
            return None
        return raw

    # 8–9 класс: не пишем так, будто человек уже в 11-м.
    if track in ("school_grade9", "school_early"):
        if _AFTER_9_RE.search(low) and re.search(r"10\s*[–\-]\s*11|профильн", low):
            return "Остаться в школе: 10–11 класс с профилем по сфере"
        if _AFTER_9_RE.search(low) and any(k in low for k in ("колледж", "спо")):
            return "Колледж (СПО) сразу после 9 класса по вашей сфере"
        if raw.startswith("11 класс:"):
            rest = raw.split(":", 1)[1].strip()
            rest = re.sub(r"\s*\(профиль\)\s*", " ", rest)
            rest = re.sub(r"\s+и\s+егэ\s*$", "", rest, flags=re.I)
            rest = re.sub(r"\s+", " ", rest).strip(" ,;")
            return f"Остаться в школе: 10–11 с профилем ({rest})"
        if raw.startswith("11 класс +") or raw.startswith("11 класс+"):
            rest = re.sub(r"^11\s*класс\s*\+\s*", "", raw, flags=re.I).strip()
            return f"Остаться в школе: 10–11 + {rest}"
        if "через 2–3 года" in low or "университет через" in low:
            return None  # рано для 8–9 класса как основной маршрут
        return raw

    return raw


def _dedupe_school_paths(paths: List[str]) -> List[str]:
    seen: Set[str] = set()
    out: List[str] = []
    for p in paths:
        fam = _path_family(p)
        if fam in seen:
            continue
        seen.add(fam)
        out.append(p)
    return out


def _school_pool_keys_for_profile(profile: Dict[str, Any], interest: str) -> List[str]:
    """Пулы маршрутов: выбранные сферы; предметы — только если сфера не задана явно."""
    spheres = set(parse_interest_spheres(profile))
    keys: List[str] = []
    dk = _interest_key(interest)
    # Медицину не подмешиваем, пока её нет в сферах анкеты.
    if dk != "default" and (dk != "medicine" or "medicine" in spheres):
        keys.append(dk)
    for sid in spheres:
        if sid in _SCHOOL_PATH_POOLS and sid not in keys:
            if sid == "medicine" and "medicine" not in spheres:
                continue
            keys.append(sid)
    # Эвристика по предметам только для «другой»/пустой сферы —
    # иначе математика тащит IT в спорт, финансы, педагогику.
    explicit = bool(spheres - {"other"})
    if not explicit and (not keys or keys == ["other"] or keys == ["default"]):
        fav = set(parse_favorite_subjects(profile))
        if "informatics" in fav and "it_dev" not in keys:
            keys.append("it_dev")
        elif fav & {"math"} and "it_dev" not in keys and "data" not in keys:
            keys.append("data")
        if fav & {"history", "social", "literature"} and "education" not in keys:
            keys.append("education")
        if fav & {"art"} and "design" not in keys:
            keys.append("design")
        if fav & {"physics"} and "engineering" not in keys:
            keys.append("engineering")
        if fav & {"biology", "chemistry"} and "medicine" in spheres and "medicine" not in keys:
            keys.append("medicine")
    keys = [k for k in keys if k != "medicine" or "medicine" in spheres]
    return keys or ["default"]


_GOAL_PATH_KEYWORDS: Dict[str, Tuple[str, ...]] = {
    "after_9_college": ("колледж", "спо", "после 9"),
    "after_9_school": ("остаться в школе", "10–11", "профиль"),
    "after_11_university": ("вуз", "11 класс", "егэ"),
    "after_11_college": ("колледж", "спо"),
    "undecided": ("профор", "уточнить", "проверить интерес"),
}


def _boost_score_for_post_school_goal(name: str, goal: str) -> int:
    kws = _GOAL_PATH_KEYWORDS.get((goal or "").strip(), ())
    low = name.lower()
    return 10 if any(k in low for k in kws) else 0


def _path_conflicts_exclusions(
    path_name: str,
    *,
    exclude_subject_ids: Set[str],
    exclude_sphere_ids: Set[str],
) -> bool:
    low = path_name.lower()
    if "informatics" in exclude_subject_ids and any(
        k in low for k in ("информ", "программ", "it ", " айти")
    ):
        return True
    if "math" in exclude_subject_ids and "матем" in low:
        return True
    if exclude_sphere_ids & {"it_dev", "data"} and any(
        k in low for k in ("it", "информ", "программ", "данн", "аналит")
    ):
        return True
    return False


def pick_school_path_plans(
    profile: Dict[str, Any],
    interest: str,
    axes: List[Dict[str, Any]],
    fp: int,
    *,
    exclude_sphere_ids: Optional[Set[str]] = None,
    exclude_subject_ids: Optional[Set[str]] = None,
) -> Dict[str, Any]:
    """Три маршрута A/B/C: куда учиться, не кем работать."""
    ex_sp = set(exclude_sphere_ids or ())
    ex_sub = set(exclude_subject_ids or ())
    pool_keys = [k for k in _school_pool_keys_for_profile(profile, interest) if k not in ex_sp]
    if not pool_keys:
        pool_keys = ["default"]
    pool: List[str] = []
    for pk in pool_keys:
        pool.extend(list(_SCHOOL_PATH_POOLS.get(pk, ())))
    # Не тащим медмаршруты, если медицины нет в сферах анкеты.
    spheres = set(parse_interest_spheres(profile))
    if "medicine" not in spheres:
        pool = [p for p in pool if not _MED_PATH_RE.search(p)]
        pool_keys = [k for k in pool_keys if k != "medicine"]

    track = resolve_assessment_track(profile)
    normalized: List[str] = []
    for p in pool:
        np = _normalize_path_for_track(p, track)
        if np:
            normalized.append(np)
    pool = normalized

    if track == "school_grade9":
        families = {_path_family(p) for p in pool}
        if "stay_school_profile" not in families:
            pool.append("Остаться в школе: 10–11 класс с профилем по сфере")
        if not any("колледж" in p.lower() or "спо" in p.lower() for p in pool):
            pool.append("Колледж (СПО) сразу после 9 класса по вашей сфере")
    elif track == "school_early":
        pool = [
            p
            for p in pool
            if "егэ" not in p.lower() and "вуз позже" not in p.lower()
        ]
        pool.append("Пока в школе: усилить любимые предметы и кружок по сфере")
        pool.append("К 9 классу: сравнить колледж и 10–11 с профилем")

    goal = str(profile.get("post_school_goal") or "").strip()
    fav_ids = set(parse_favorite_subjects(profile))
    dom = _dominant_radar_key(axes)
    pool = _dedupe_school_paths(pool)

    filtered: List[str] = []
    for p in pool:
        if _path_conflicts_exclusions(
            p, exclude_subject_ids=ex_sub, exclude_sphere_ids=ex_sp
        ):
            continue
        filtered.append(p)
    if not filtered:
        filtered = [
            p
            for p in (
                _normalize_path_for_track(x, track) or ""
                for x in _SCHOOL_PATH_POOLS["default"]
            )
            if p
            and not _path_conflicts_exclusions(
                p, exclude_subject_ids=ex_sub, exclude_sphere_ids=ex_sp
            )
        ]
        filtered = _dedupe_school_paths(filtered) or [
            "Уточнить маршрут с профориентологом или классным"
        ]

    scored = [
        (
            n,
            _score_path(n, dom, fp, i)
            + _boost_score_for_post_school_goal(n, goal)
            + _boost_score_for_favorite_subjects(n, fav_ids),
        )
        for i, n in enumerate(filtered)
    ]
    scored.sort(key=lambda x: -x[1])
    # Разнообразие семейств в топ-3: не три «колледжа» подряд.
    picked: List[Tuple[str, int]] = []
    used_fam: Set[str] = set()
    for name, raw in scored:
        fam = _path_family(name)
        if fam in used_fam and len(picked) < 2:
            continue
        if fam in used_fam:
            continue
        used_fam.add(fam)
        picked.append((name, raw))
        if len(picked) >= 3:
            break
    if len(picked) < 3:
        for name, raw in scored:
            if any(name == p[0] for p in picked):
                continue
            picked.append((name, raw))
            if len(picked) >= 3:
                break

    codes = ["A", "B", "C"]
    plans = []
    for idx, (name, raw) in enumerate(picked[:3]):
        pid = codes[idx]
        pct = max(47, min(96, raw))
        plans.append({"id": pid, "name": f"Вариант {pid}: {name}", "score_percent": pct})
    while len(plans) < 3:
        filler = (
            "Кружок или проект по сфере — проверить интерес до выбора колледжа"
            if track in ("school_grade9", "school_early")
            else "День открытых дверей в колледже или вузе по сфере"
        )
        plans.append(
            {
                "id": codes[len(plans)],
                "name": f"Вариант {codes[len(plans)]}: {filler}",
                "score_percent": 48,
            }
        )
    best = max(plans, key=lambda p: p["score_percent"])
    if not spheres and profile.get("main_sphere"):
        spheres = {str(profile.get("main_sphere")).strip()}
    sphere_lbl = ", ".join(_SPHERE_LABELS.get(s, s) for s in list(spheres)[:2]) or "ваши интересы"
    return {
        "plans": plans,
        "best_plan_id": best["id"],
        "best_plan_name": best["name"],
        "best_avg_percent": best["score_percent"],
        "caption": "согласованность с маршрутами обучения (школа → колледж / 11 класс / вуз)",
        "focus_label": f"Сфера интересов: {sphere_lbl}. Дальше — куда учиться и что подтянуть.",
    }


_VAGUE_GAP_LABELS = {
    "Профильные предметы в школе",
    "Профильные предметы",
    "Профориентация",
    "Подготовка к экзаменам / вступительным",
}


def build_school_gap_analysis(
    profile: Dict[str, Any],
    interest: str,
    top_path: str,
    axes: List[Dict[str, Any]],
    fp: int,
    *,
    exclude_subject_ids: Optional[Set[str]] = None,
    preparation_level: str = "",
) -> Dict[str, Any]:
    """«Разрыв» по предметам и подготовке, не по навыкам вакансии."""
    ex_sub = set(exclude_subject_ids or ())
    spheres = set(parse_interest_spheres(profile))
    pool_keys = _school_pool_keys_for_profile(profile, interest)
    path_hint = re.sub(r"^Вариант\s+[ABC]:\s*", "", (top_path or "").strip(), flags=re.IGNORECASE)
    if path_hint and _MED_PATH_RE.search(path_hint) and "medicine" not in spheres:
        path_hint = ""
    if path_hint:
        path_low_hint = path_hint.lower()
        matched = None
        for pk in pool_keys:
            for sample in _SCHOOL_PATH_POOLS.get(pk, ()):
                if sample.lower() in path_low_hint or path_low_hint in sample.lower():
                    matched = pk
                    break
            if matched:
                break
        if matched:
            pool_keys = [matched] + [k for k in pool_keys if k != matched]
    # Предметы: любимые + пул лучшего маршрута (не свалка всех сфер сразу).
    focus_keys = (pool_keys[:1] if path_hint else pool_keys[:2]) or ["default"]

    subjects: List[Tuple[str, str]] = []
    existing_labels: Set[str] = set()
    existing_ids: Set[str] = set()

    def _add(sk: str, lab: str) -> None:
        if sk in ex_sub or lab in existing_labels or sk in existing_ids:
            return
        subjects.append((sk, lab))
        existing_labels.add(lab)
        existing_ids.add(sk)

    for sid in parse_favorite_subjects(profile):
        label = SUBJECT_GAP_LABELS.get(sid)
        if label:
            _add(sid, label)

    for pk in focus_keys:
        for sk, lab in _SCHOOL_GAP_BY_INTEREST.get(pk, ()):
            if pk == "medicine" and "medicine" not in spheres:
                continue
            _add(sk, lab)

    if len(subjects) < 4:
        for sk, lab in _SCHOOL_GAP_BY_INTEREST["default"]:
            _add(sk, lab)

    exam = str(profile.get("exam_focus") or "").strip()
    if exam in ("oge_9", "both"):
        _add("exams_oge", "Подготовка к ОГЭ")
    if exam in ("ege_11", "both"):
        _add("exams_ege", "Подготовка к ЕГЭ")

    subjects = subjects[:8]
    prep = (preparation_level or str(profile.get("preparation_level") or profile.get("prep_level") or "")).strip()
    prep_base = {"weak": 44, "medium": 58, "strong": 72}.get(prep, 56)
    # Иногда уровень подготовки приходит только снаружи — подхватим из осей.
    if prep not in ("weak", "medium", "strong") and axes:
        avg_ax = sum(int(a.get("value_percent") or 0) for a in axes) / max(1, len(axes))
        prep_base = 44 if avg_ax < 40 else 58 if avg_ax < 62 else 70

    axis_by = {str(a.get("key") or ""): int(a.get("value_percent") or 0) for a in (axes or [])}
    dom = _dominant_radar_key(axes)
    fav_ids = set(parse_favorite_subjects(profile))
    fav_labels = set(favorite_subjects_labels(profile))
    path_low = (path_hint or "").lower()

    def _subject_user_pct(sk: str, label: str) -> int:
        score = float(prep_base)
        jitter = ((sum(ord(c) for c in sk) * 17 + (fp % 97)) % 11) - 5  # −5…+5, не подряд
        score += jitter

        if sk in fav_ids or label in fav_labels:
            score += 16
        if sk in ("practice", "project", "portfolio"):
            score -= 10
        if sk in ("career_choice", "orientation"):
            score = 0.45 * score + 0.55 * axis_by.get("self_insight", 48)
        if sk in ("exams", "exams_ege", "exams_oge"):
            score -= 6 if prep != "strong" else 2
        if sk == "english":
            score -= 4
        if sk in ("math", "physics", "informatics") and dom == "structure_mastery":
            score += 8
        if sk in ("history", "social", "literature", "practice") and dom == "people_service":
            score += 7
        # Предмет ближе к выбранному маршруту — чуть выше «текущий» уровень интереса.
        for sid, kws in _SUBJECT_PATH_KEYWORDS.items():
            if sid == sk or (SUBJECT_GAP_LABELS.get(sid) == label):
                if path_low and any(k in path_low for k in kws):
                    score += 4
                break
        return int(max(30, min(90, round(score))))

    def _subject_target_pct(sk: str, label: str, user_pct: int) -> int:
        target = 84
        if sk in fav_ids or label in fav_labels:
            target = 92
        if sk in ("practice", "project"):
            target = 78
        if sk in ("career_choice", "orientation"):
            target = 88
        if sk in ("exams", "exams_ege", "exams_oge"):
            target = 90
        # Маршрутные предметы — выше планка.
        for sid, kws in _SUBJECT_PATH_KEYWORDS.items():
            if sid == sk or (SUBJECT_GAP_LABELS.get(sid) == label):
                if path_low and any(k in path_low for k in kws):
                    target = max(target, 90)
                break
        return int(max(user_pct + 8, min(100, target)))

    bars: List[Dict[str, Any]] = []
    closeness: List[int] = []
    for _sk, label in subjects:
        user_pct = _subject_user_pct(_sk, label)
        target_pct = _subject_target_pct(_sk, label, user_pct)
        gap_pct = max(0, target_pct - user_pct)
        closeness.append(100 - min(100, gap_pct))
        bars.append(
            {
                "label": label,
                "user_percent": user_pct,
                "target_percent": target_pct,
                "gap_percent": gap_pct,
            }
        )
    overall = sum(closeness) // max(1, len(closeness)) if closeness else 50
    path_clean = path_hint

    stem_path = any(
        k in path_low
        for k in ("информ", "программ", "it", "матем", "физик", "инженер", "техник", "данн")
    )
    hum_path = any(
        k in path_low for k in ("истор", "гуманит", "педагог", "обществ", "литерат", "образ")
    )
    med_path = bool(_MED_PATH_RE.search(path_low)) if path_low else False

    def _closing_rank(item: Tuple[str, int, int]) -> Tuple[int, int, int, int, int]:
        """Слабее = низкий текущий уровень и большой разрыв; любимые сильные предметы не в топ."""
        label, gap_pct, user_pct = item
        lab_l = label.lower()
        vague = 1 if label in _VAGUE_GAP_LABELS else 0
        is_fav = 1 if (label in fav_labels or any(sid in fav_ids and SUBJECT_GAP_LABELS.get(sid) == label for sid in fav_ids)) else 0
        # Уже сильный любимый предмет не называем «слабым», если есть другие зоны.
        strong_fav = 1 if is_fav and user_pct >= 68 else 0
        mismatch = 0
        if path_low:
            if stem_path and not hum_path and any(k in lab_l for k in ("истор", "литерат", "обществ")):
                mismatch = 1
            if hum_path and not stem_path and any(k in lab_l for k in ("физик", "инженер", "программ")):
                mismatch = 1
            if not med_path and "medicine" not in spheres and any(k in lab_l for k in ("биолог", "хими")):
                mismatch = 1
        # Сортировка: не mismatch → не strong_fav → ниже user → больше gap → не vague
        return (mismatch, strong_fav, user_pct, -gap_pct, vague)

    weak = sorted(
        (
            (b["label"], int(b["gap_percent"]), int(b["user_percent"]))
            for b in bars
            if int(b["gap_percent"]) > 12
        ),
        key=_closing_rank,
    )
    closing = [w[0] for w in weak if _closing_rank(w)[0] == 0 and _closing_rank(w)[1] == 0][:3]
    if len(closing) < 2:
        closing = [w[0] for w in weak if _closing_rank(w)[0] == 0][:3]
    if len(closing) < 2:
        closing = [w[0] for w in weak[:3]]
    if not closing:
        closing = [b["label"] for b in bars[:3]] or [
            "Любимый предмет из анкеты",
            "Кружок или олимпиада",
            "Подготовка к ОГЭ / ЕГЭ",
        ]

    headline = "Предметы и навыки: где вы уже близко к маршруту, а где разрыв"
    if path_clean:
        headline = f"Сравнение с маршрутом «{path_clean[:60]}»: где вы уже близко, а где разрыв"
    return {
        "headline": headline,
        "overall_hp": overall,
        "bars": bars,
        "closing_skills": closing,
    }


def school_education_hints(
    profile: Dict[str, Any],
    interest: str,
    scenarios: Dict[str, Any],
) -> Dict[str, Any]:
    """Вместо матрицы вакансий — подсказки по типам учебных заведений."""
    plans = scenarios.get("plans") or []
    rows: List[Dict[str, Any]] = []
    for p in plans[:3]:
        name = re.sub(r"^Вариант\s+[ABC]:\s*", "", str(p.get("name") or ""), flags=re.IGNORECASE)
        rows.append(
            {
                "role_name": name,
                "match_percent": int(p.get("score_percent") or 50),
                "education_type": True,
            }
        )
    city = (profile.get("city") or "").strip()
    caption = "Варианты куда идти учиться"
    if city:
        caption += f" — уточните программы в {city} и соседних городах"
    return {"rows": rows, "caption": caption, "school_mode": True}


def _safe_top_path_for_profile(
    profile: Dict[str, Any],
    top_path: str,
    interest: str,
    scenarios: Optional[Dict[str, Any]] = None,
) -> str:
    """Маршрут для текстов плана: без медицины, если её нет в анкете."""
    path = re.sub(r"^Вариант\s+[ABC]:\s*", "", (top_path or "").strip(), flags=re.IGNORECASE)
    spheres = set(parse_interest_spheres(profile))
    if path and not (_MED_PATH_RE.search(path) and "medicine" not in spheres):
        if not (_AFTER_9_RE.search(path) and resolve_assessment_track(profile) == "school_senior"):
            return path[:70]

    for p in (scenarios or {}).get("plans") or []:
        name = re.sub(r"^Вариант\s+[ABC]:\s*", "", str(p.get("name") or ""), flags=re.IGNORECASE).strip()
        if not name:
            continue
        if _MED_PATH_RE.search(name) and "medicine" not in spheres:
            continue
        if _AFTER_9_RE.search(name) and resolve_assessment_track(profile) == "school_senior":
            continue
        return name[:70]

    fav = set(parse_favorite_subjects(profile))
    dk = _interest_key(interest)
    if "informatics" in fav or dk == "it_dev":
        return "11 класс / колледж с упором на информатику"
    if fav & {"history", "social", "literature"} or dk == "education":
        return "гуманитарный профиль или педагогический колледж"
    if fav & {"physics", "math"} or dk == "engineering":
        return "технический колледж или профиль физика + математика"
    if "medicine" in spheres:
        return "медколледж или 10–11 с биологией и химией"
    lbl = _SPHERE_LABELS.get(dk) or _SPHERE_LABELS.get(next(iter(spheres), ""), "ваша сфера")
    return f"маршрут по сфере «{lbl}»"


def school_weekly_roadmap(
    profile: Dict[str, Any],
    top_path: str,
    interest: str,
    scenarios: Optional[Dict[str, Any]] = None,
) -> List[Dict[str, Any]]:
    """План на 4 недели: конкретные шаги под класс, предметы и маршрут."""
    path = _safe_top_path_for_profile(profile, top_path, interest, scenarios)
    track = resolve_assessment_track(profile)
    goal = str(profile.get("post_school_goal") or "").strip()
    exam = str(profile.get("exam_focus") or "").strip()
    fav = favorite_subjects_labels(profile)
    fav_txt = ", ".join(fav[:3]) if fav else ""
    city = (profile.get("city") or "").strip()
    alt_names = []
    for p in (scenarios or {}).get("plans") or []:
        n = re.sub(r"^Вариант\s+[ABC]:\s*", "", str(p.get("name") or ""), flags=re.IGNORECASE).strip()
        if n and n != path and n not in alt_names:
            alt_names.append(n)
    alt_short = alt_names[0][:48] if alt_names else ""

    # --- Недели 1–2: выбор и сверка ---
    if track in ("school_grade9", "school_early"):
        w1_learn = (
            f"Сравните два пути: колледж после 9 или 10–11 класс — "
            f"на примере «{path}»"
            + (f" и «{alt_short}»" if alt_short else "")
            + "."
        )
        w1_practice = (
            "Обсудите с классным или родителями один выбранный путь на ближайший год."
        )
    elif goal == "after_11_university":
        w1_learn = (
            f"Сверьте требования 2 вузов/колледжей к маршруту «{path}»: "
            "какие предметы и экзамены нужны."
        )
        w1_practice = (
            f"По любимым предметам ({fav_txt}) отметьте, что уже тянете, а что подтянуть к ЕГЭ."
            if fav_txt
            else "Выпишите 2–3 предмета, без которых выбранный маршрут нереален."
        )
    elif goal == "after_11_college":
        w1_learn = f"Найдите 2 колледжа по маршруту «{path}» и список вступительных."
        w1_practice = (
            f"Сопоставьте программы с сильными предметами: {fav_txt}."
            if fav_txt
            else "Запишите плюсы колледжа vs вуз для себя на одной странице."
        )
    else:
        w1_learn = (
            f"Уточните маршрут «{path}»: колледж, 11 класс или вуз — "
            "что ближе по срокам и предметам."
        )
        w1_practice = (
            f"Опирайтесь на любимые предметы ({fav_txt}): какой путь их использует сильнее."
            if fav_txt
            else "Запишите, какие школьные предметы даются легче — это опора для профиля."
        )

    if city and "колледж" in path.lower():
        w1_learn += f" Смотрите программы в {city} и соседних городах."

    w1_outcome = (
        f"Выбран один рабочий вариант на месяц: «{path}»"
        + (f" (запасной — «{alt_short}»)" if alt_short else "")
        + "."
    )

    # --- Недели 3–4: действие ---
    if "колледж" in path.lower() or "спо" in path.lower() or "техникум" in path.lower():
        w2_learn = (
            f"Откройте сайт или день открытых дверей по «{path}» — "
            "выпишите 3 требования к поступлению."
        )
    elif "вуз" in path.lower():
        w2_learn = (
            f"На сайте вуза по направлению «{path}» найдите список ЕГЭ и проходной ориентир."
        )
    else:
        w2_learn = (
            f"Уточните профильные предметы для «{path}» в своей школе "
            "или на сайте колледжа/вуза-ориентира."
        )

    if fav_txt:
        main_subj = fav[0]
        w2_practice = (
            f"Один конкретный шаг по «{main_subj}»: кружок, проект, олимпиада или "
            f"{'тренажёр ЕГЭ' if exam in ('ege_11', 'both') else 'тренажёр ОГЭ' if exam in ('oge_9', 'both') else '2 коротких занятия'} "
            "— 3–5 часов за две недели."
        )
    else:
        w2_practice = (
            "Один мини-шаг по выбранному маршруту: кружок, проект или пробный курс — "
            "3–5 часов за две недели."
        )

    if exam in ("oge_9", "ege_11", "both") and fav_txt:
        exam_name = "ЕГЭ" if exam in ("ege_11", "both") else "ОГЭ"
        w2_learn += f" Закрепите «{fav[0]}» в тренажёре {exam_name} — один раздел."

    w2_outcome = (
        f"Есть следующий шаг по «{path}» и предмету"
        + (f" «{fav[0]}»" if fav else "")
        + " — без распыления на всё сразу."
    )

    return [
        {
            "period": "Недели 1–2",
            "learn": w1_learn,
            "practice": w1_practice,
            "outcome": w1_outcome,
        },
        {
            "period": "Недели 3–4",
            "learn": w2_learn,
            "practice": w2_practice,
            "outcome": w2_outcome,
        },
    ]


def sanitize_school_scenarios(
    profile: Dict[str, Any],
    scenarios: Dict[str, Any],
    interest: str,
    axes: List[Dict[str, Any]],
    fp: int,
) -> Dict[str, Any]:
    """Если в A/B/C просочилась медицина без сферы — пересобрать маршруты."""
    spheres = set(parse_interest_spheres(profile))
    if "medicine" in spheres:
        return scenarios
    plans = list((scenarios or {}).get("plans") or [])
    if not any(_MED_PATH_RE.search(str(p.get("name") or "")) for p in plans):
        return scenarios
    return pick_school_path_plans(profile, interest, axes, fp)


def build_school_individual_advice(
    profile: Dict[str, Any],
    scenarios: Dict[str, Any],
    gap: Dict[str, Any],
    interest: str,
) -> Dict[str, Any]:
    """Советы для школьника: учёба и выбор маршрута, без резюме и работодателей."""
    fav = favorite_subjects_labels(profile)
    closing = [str(x) for x in ((gap or {}).get("closing_skills") or []) if x][:3]
    focus_subj = closing[0] if closing else (fav[0] if fav else "предмет из блока «Что подтянуть»")
    fav_txt = ", ".join(fav[:3])
    exam = str(profile.get("exam_focus") or "").strip()
    exam_bit = ""
    if exam in ("ege_11", "both"):
        exam_bit = " Если готовитесь к ЕГЭ — один раздел в тренажёре, не все предметы сразу."
    elif exam in ("oge_9",):
        exam_bit = " Если готовитесь к ОГЭ — один раздел в тренажёре, без гонки."

    by_plan: Dict[str, Any] = {}
    for p in (scenarios.get("plans") or [])[:3]:
        pid = str(p.get("id") or "A")
        raw_name = re.sub(
            r"^Вариант\s+[ABC]:\s*",
            "",
            str(p.get("name") or ""),
            flags=re.IGNORECASE,
        ).strip()
        name = _safe_top_path_for_profile(profile, raw_name, interest, scenarios)
        intro = (
            "Здесь собраны шаги по выбору учёбы и подготовке к поступлению. "
            "Это про школу, колледж и предметы — не про поиск работы."
        )
        start_steps = [
            (
                "Сравните этот вариант с тем, что вам действительно нравится"
                + (f" ({fav_txt})" if fav_txt else "")
                + ", и решите, стоит ли рассмотреть другое направление."
            ),
            f"На 2 недели возьмите один фокус: «{focus_subj}» — занятия или кружок, без списка из десяти дел.",
            "Обсудите выбор с родителями или классным: не «на всю жизнь», а на ближайший год.",
        ]
        month_steps = [
            "Найдите подходящую программу на сайте колледжа или вуза и выпишите 2–3 требования к поступлению.",
            "Один понятный результат: мини-проект, олимпиада или раздел в тренажёре"
            + (f" по «{focus_subj}»" if focus_subj else "")
            + "."
            + exam_bit,
        ]
        by_plan[pid] = {
            "title": name,
            "intro": intro,
            "steps": start_steps,
            "sections": [
                {"title": "На этой неделе", "steps": start_steps},
                {"title": "За месяц", "steps": month_steps},
            ],
            "source": "school",
        }

    if not by_plan:
        by_plan["A"] = {
            "title": "Уточнить маршрут",
            "intro": "Пока маршрут не зафиксирован — начните с любимого предмета и одного варианта поступления.",
            "steps": [
                "Выберите один предмет из анкеты и занимайтесь им 3–5 часов за две недели.",
                "Сравните колледж и 10–11 класс для вашей сферы — плюсы и минусы на одной странице.",
            ],
            "sections": [
                {
                    "title": "С чего начать",
                    "steps": [
                        "Выберите один предмет из анкеты и занимайтесь им 3–5 часов за две недели.",
                        "Сравните колледж и 10–11 класс для вашей сферы — плюсы и минусы на одной странице.",
                    ],
                }
            ],
            "source": "school",
        }
    return {"by_plan": by_plan, "source": "school"}


def mock_school_narrative(
    profile: Dict[str, Any],
    interest: str,
    scenarios: Dict[str, Any],
    axes: List[Dict[str, Any]],
    fp: int,
    *,
    readiness_percent: int = 0,
    gap: Optional[Dict[str, Any]] = None,
) -> str:
    spheres = parse_interest_spheres(profile)
    if not spheres and profile.get("main_sphere"):
        spheres = [str(profile.get("main_sphere")).strip()]
    sphere = ", ".join(_SPHERE_LABELS.get(s, s) for s in spheres[:2]) or "ваши интересы"
    course = (profile.get("course_grade") or profile.get("course_or_grade") or "").strip()
    city = (profile.get("city") or "").strip()
    fav = favorite_subjects_labels(profile)

    plans = sorted(
        list(scenarios.get("plans") or []),
        key=lambda p: -(int(p.get("score_percent") or 0)),
    )
    best_raw = ""
    if plans:
        best_raw = _safe_top_path_for_profile(
            profile,
            re.sub(r"^Вариант\s+[ABC]:\s*", "", str(plans[0].get("name") or ""), flags=re.IGNORECASE),
            interest,
            scenarios,
        )

    dom = ""
    if axes:
        key = _dominant_radar_key(axes)
        dom = {
            "structure_mastery": "вам близки порядок, логика и разбор задач по шагам",
            "people_service": "важны люди, общение и ощущение пользы другим",
            "self_insight": "вы опираетесь на самопознание и понимание своих мотивов",
            "balance_autonomy": "для вас важны баланс и свобода в решениях",
        }.get(key, "у вас уже читается свой стиль в учёбе")

    parts: List[str] = []
    head = f"Вы школьник, интересы: {sphere}."
    if course:
        head += f" Класс/курс: {course}."
    if city:
        head += f" Город: {city[:1].upper() + city[1:]}."
    if fav:
        head += f" В анкете сильнее всего отмечены: {', '.join(fav[:3])}."
    head += " Сейчас важнее понять себя в учёбе, а не искать «работу мечты»."
    parts.append(head)

    mid = ""
    if dom:
        mid = f"По ответам видно, что {dom}."
    best_l = (best_raw or "").lower()
    if "колледж" in best_l or "спо" in best_l:
        mid += " Вам ближе прикладная учёба и более быстрый вход в практику, чем долгий школьный марафон."
    elif "универ" in best_l or "вуз" in best_l or "бакалавр" in best_l:
        mid += " Вам ближе длинная академическая траектория: углублять предметы и целиться в вуз."
    elif "информат" in best_l or "it" in best_l or "программ" in best_l or "егэ" in best_l:
        mid += " Вам ближе школа с сильным уклоном в информатику и точные предметы."
    elif best_raw:
        mid += " Вам ближе среда, где можно углублять любимые предметы без лишней спешки."
    else:
        mid += " Картина пока складывается: опирайтесь на то, что реально нравится в учёбе."
    closing = list((gap or {}).get("closing_skills") or [])[:2]
    if closing:
        mid += f" Пока слабее чувствуется: {', '.join(closing)} — это не приговор, а зона роста."
    parts.append(mid.strip())

    tips = (
        "Это портрет по текущим ответам, а не ярлык на всю жизнь.",
        "Если что-то в описании не про вас — уточните анкету или пройдите ещё один тест.",
        "Сравните направления по любимым предметам, формату учёбы и требованиям к поступлению.",
    )
    parts.append(tips[fp % len(tips)])
    return " ".join(parts)


def school_learning_extras(
    *,
    profile: dict[str, Any],
    interest: str,
    preparation_level: str,
    scenarios: dict[str, Any],
    gap: dict[str, Any],
    profile_summary: str = "",
    user_id: str | None = None,
    eff_interest: str | None = None,
    exclude_subject_ids: Optional[Set[str]] = None,
) -> dict[str, Any]:
    """Обучение и советы для школьника — без карьерного каталога и советов работодателю."""
    from wibe_work.services.learning.growth_stages import build_growth_stages
    from wibe_work.services.school_subject_resources import (
        build_school_curated_learning_cards,
        build_school_learning_path_payload,
        merge_school_cards_with_catalog,
    )

    eff = (eff_interest or interest or "other").strip() or "other"
    best = _safe_top_path_for_profile(
        profile,
        str(scenarios.get("best_plan_name") or ""),
        eff,
        scenarios,
    )
    advice = build_school_individual_advice(profile, scenarios, gap, eff)
    curated_cards = build_school_curated_learning_cards(
        profile,
        eff,
        gap,
        exclude_subject_ids=set(exclude_subject_ids or ()),
        top_path=best,
    )
    school_lp = build_school_learning_path_payload(
        user_id=user_id,
        profile=profile,
        interest=eff,
        preparation_level=preparation_level,
        scenarios=scenarios,
        gap=gap,
        exclude_subject_ids=set(exclude_subject_ids or ()),
    )
    # Заголовок пути — только безопасный маршрут
    if isinstance(school_lp, dict) and best:
        school_lp = dict(school_lp)
        school_lp["title"] = f"Школьный путь: {best[:70]}"

    readiness = int(gap.get("overall_hp") or 50)
    stages = build_growth_stages(
        interest=interest,
        eff_interest=eff,
        preparation_level=preparation_level,
        readiness_percent=readiness,
        profile=profile,
        gap=gap,
        scenarios=scenarios,
        individual_advice=advice,
        learning_path=school_lp,
        force_school=True,
    )
    return {
        "learning": merge_school_cards_with_catalog(curated_cards, [], max_total=12),
        "learning_path": school_lp,
        "learning_path_detail": school_lp,
        "individual_advice": advice,
        "growth_stages": stages,
        "growth_stages_rich": stages,
    }


def scrub_school_narrative(text: str, profile: Dict[str, Any], scenarios: Dict[str, Any]) -> str:
    """Убрать из текста бред: медицина без сферы, советы работодателю, жаргон планов."""
    raw = (text or "").strip()
    if not raw:
        return raw
    try:
        from wibe_work.services.llm_prompts import scrub_portrait_plan_jargon

        raw = scrub_portrait_plan_jargon(raw) or raw
    except Exception:
        pass
    spheres = set(parse_interest_spheres(profile))
    out = raw
    if "medicine" not in spheres:
        # Обрываем предложения про мед/сестринское, если их нет в маршрутах.
        plans_blob = " ".join(str(p.get("name") or "") for p in (scenarios.get("plans") or []))
        if not _MED_PATH_RE.search(plans_blob):
            out = re.sub(
                r"[^.!?]*\b(?:мед(?:колледж|ицин\w*)|сестрин\w*|фармац\w*|лаб\.?\s*диагност\w*)[^.!?]*[.!?]?",
                " ",
                out,
                flags=re.I,
            )
            out = re.sub(r"\s{2,}", " ", out).strip()
    for pat, repl in (
        (r"(?i)\bработодател\w*\b", "поступлением"),
        (r"(?i)\bрезюме\b", "список достижений в школе"),
        (r"(?i)\bотклик\w*\b", "заявки в колледж"),
        (r"(?i)\bсобеседован\w*\b", "собеседование при поступлении"),
        (r"(?i)\bваканс\w*\b", "программы обучения"),
        (r"(?i)\bhh\.?ru\b", "сайты колледжей"),
    ):
        out = re.sub(pat, repl, out)
    out = re.sub(r"\s{2,}", " ", out).strip()
    return out or raw


def school_pain_first_step(pain_id: str) -> Optional[str]:
    return _SCHOOL_PAIN_STEPS.get(pain_id)
