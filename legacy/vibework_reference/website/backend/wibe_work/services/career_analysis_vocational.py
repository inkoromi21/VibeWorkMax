"""Разбор для студентов СПО / колледжа: специальность, практика, первые шаги — без школьных предметов."""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional, Set, Tuple

from wibe_work.questionnaire_fields import INTEREST_SPHERES
from wibe_work.services.user_context import parse_interest_spheres

_SPHERE_LABELS: Dict[str, str] = {s["id"]: s["label"] for s in INTEREST_SPHERES}

# spo_to_university | spo_to_work | undecided
_SPO_UNI = frozenset(
    {"spo_to_university", "to_university", "university", "вуз", "after_spo_university"}
)
_SPO_WORK = frozenset(
    {"spo_to_work", "to_work", "work", "работа", "after_spo_work", "job"}
)


def spo_goal_kind(profile: Optional[Dict[str, Any]]) -> str:
    """university | work | undecided — развилка СПО."""
    g = str((profile or {}).get("post_spo_goal") or "").strip().lower()
    if g in _SPO_UNI:
        return "university"
    if g in _SPO_WORK:
        return "work"
    return "undecided"

# Маршруты по сфере: куда расти в учёбе и на практике (не школьные профили).
_VOC_PATH_POOLS: Dict[str, Tuple[str, ...]] = {
    "it_dev": (
        "Углубить специальность: программирование / веб / администрирование",
        "Практика или стажировка в IT-компании / на кафедре",
        "Учебный проект в портфолио + практика по специальности",
        "Смежный трек: тестирование, поддержка или данные",
    ),
    "data": (
        "Углубить аналитику и Excel/SQL по специальности",
        "Практика: отчёты, витрины, учебный кейс с данными",
        "Стажировка аналитика / помощника в отделе",
        "Доп. курсы по визуализации и работе с таблицами",
    ),
    "design": (
        "Углубить дизайн по специальности + портфолио 3–5 работ",
        "Практика в студии / на реальном учебном заказе",
        "Стажировка junior-дизайнера или помощника",
        "Смежный трек: контент, вёрстка, бренд-материалы",
    ),
    "marketing": (
        "Углубить маркетинг / SMM / контент по специальности",
        "Практика: ведение учебного проекта или аккаунта",
        "Стажировка в отделе маркетинга",
        "Смежный трек: продажи или аналитика рекламы",
    ),
    "sales": (
        "Углубить продажи и сервис по специальности",
        "Практика: переговоры, CRM, учебные сделки",
        "Стажировка / подработка в продажах",
        "Смежный трек: маркетинг или работа с клиентами",
    ),
    "engineering": (
        "Углубить рабочую / инженерную специальность на практике",
        "Производственная практика или мастерская",
        "Стажировка / помощник на предприятии",
        "Смежный трек: чертежи, обслуживание, контроль качества",
    ),
    "medicine": (
        "Углубить медспециальность: практика и клинические навыки",
        "Практика в медучреждении / симуляции",
        "Стажировка младшего медперсонала / лаборанта",
        "Смежный трек: фармация, диагностика, уход",
    ),
    "education": (
        "Углубить педагогическую специальность",
        "Практика с детьми / в учебной группе",
        "Стажировка помощника воспитателя / педагога",
        "Смежный трек: методика, организация мероприятий",
    ),
    "hr_edu": (
        "Углубить HR / обучение персонала",
        "Практика: подбор, адаптация, учебные кейсы",
        "Стажировка в HR или учебном центре",
        "Смежный трек: коммуникации и организация",
    ),
    "finance": (
        "Углубить финансы / учёт по специальности",
        "Практика: Excel, 1С, учебные отчёты",
        "Стажировка помощника бухгалтера / финансиста",
        "Смежный трек: аналитика или контроль",
    ),
    "logistics": (
        "Углубить логистику и складские процессы",
        "Практика на складе / в отделе поставок",
        "Стажировка логиста / диспетчера",
        "Смежный трек: закупки или учёт",
    ),
    "mgmt": (
        "Углубить управление проектами и процессами",
        "Практика: координация учебного или реального мини-проекта",
        "Стажировка ассистента менеджера",
        "Смежный трек: операции или коммуникации",
    ),
    "creative": (
        "Углубить творческую специальность + портфолио",
        "Практика: заказ, выставка, контент-проект",
        "Стажировка / ассистент в творческой команде",
        "Смежный трек: дизайн или медиа",
    ),
    "sport": (
        "Углубить спортивную / фитнес-специальность",
        "Практика: тренировки, мероприятия, инструктаж",
        "Стажировка инструктора / помощника тренера",
        "Смежный трек: организация спортивных событий",
    ),
    "other": (
        "Углубить текущую специальность на практике",
        "Производственная практика или стажировка по профилю",
        "Учебный кейс по специальности + практика",
        "Смежный трек рядом с вашей сферой",
    ),
    "default": (
        "Углубить текущую специальность на практике",
        "Производственная практика или стажировка по профилю",
        "Учебный кейс по специальности + практика",
        "Смежный трек в вашей сфере интересов",
    ),
}

# Разрыв: навыки студента СПО (не школьные предметы).
_VOC_GAP_BY_INTEREST: Dict[str, List[Tuple[str, str]]] = {
    "it_dev": [
        ("tools", "Инструменты специальности (Git, IDE, языки)"),
        ("practice", "Практика / учебный проект"),
        ("portfolio", "Портфолио или GitHub"),
        ("soft", "Коммуникация и работа в команде"),
        ("internship", "Готовность к стажировке / junior"),
    ],
    "data": [
        ("tools", "Excel / SQL / отчёты"),
        ("practice", "Учебный кейс с данными"),
        ("soft", "Понятные выводы для заказчика"),
        ("internship", "Готовность к стажировке аналитика"),
        ("english", "Английский для документации"),
    ],
    "design": [
        ("tools", "Figma и дизайн-инструменты"),
        ("portfolio", "Портфолио (3–5 работ)"),
        ("practice", "Реальный или учебный заказ"),
        ("soft", "Презентация решений"),
        ("internship", "Готовность к стажировке"),
    ],
    "marketing": [
        ("tools", "Контент / рекламные инструменты"),
        ("practice", "Учебный маркетинг-проект"),
        ("soft", "Тексты и коммуникация"),
        ("internship", "Готовность к стажировке"),
        ("analytics", "Базовая аналитика результатов"),
    ],
    "sales": [
        ("soft", "Переговоры и сервис"),
        ("tools", "CRM и учёт клиентов"),
        ("practice", "Практика продаж / учебные сделки"),
        ("internship", "Готовность к стажировке"),
    ],
    "engineering": [
        ("tools", "Инструменты и техника по специальности"),
        ("practice", "Производственная практика"),
        ("safety", "Техника безопасности и качество"),
        ("soft", "Работа в бригаде / с наставником"),
        ("internship", "Готовность к работе помощником"),
    ],
    "medicine": [
        ("practice", "Клиническая / учебная практика"),
        ("tools", "Профильные процедуры и системы"),
        ("soft", "Общение с пациентами / командой"),
        ("internship", "Готовность к стажировке"),
        ("exams", "Допуски и аттестация по специальности"),
    ],
    "education": [
        ("practice", "Практика с детьми / группой"),
        ("soft", "Методика и коммуникация"),
        ("tools", "Планы занятий / материалы"),
        ("internship", "Готовность к стажировке педагога"),
    ],
    "hr_edu": [
        ("soft", "Коммуникация и этика"),
        ("practice", "Учебные кейсы подбора / обучения"),
        ("tools", "HR-инструменты и документы"),
        ("internship", "Готовность к стажировке в HR"),
    ],
    "finance": [
        ("tools", "Excel / 1С / учёт"),
        ("practice", "Учебные отчёты и проводки"),
        ("soft", "Аккуратность и дедлайны"),
        ("internship", "Готовность к стажировке"),
    ],
    "logistics": [
        ("tools", "Учёт поставок / складские системы"),
        ("practice", "Практика на складе / в логистике"),
        ("soft", "Координация и ответственность"),
        ("internship", "Готовность к стажировке"),
    ],
    "mgmt": [
        ("soft", "Координация и постановка задач"),
        ("practice", "Мини-проект от начала до конца"),
        ("tools", "Планирование и трекеры"),
        ("internship", "Готовность к роли ассистента"),
    ],
    "creative": [
        ("portfolio", "Портфолио / демо работ"),
        ("practice", "Заказ или творческий проект"),
        ("tools", "Инструменты по направлению"),
        ("internship", "Готовность к стажировке"),
    ],
    "sport": [
        ("practice", "Практика тренировок / мероприятий"),
        ("soft", "Инструктаж и безопасность"),
        ("tools", "Методики и планирование занятий"),
        ("internship", "Готовность к роли помощника тренера"),
    ],
    "other": [
        ("practice", "Практика по специальности"),
        ("tools", "Инструменты специальности"),
        ("soft", "Коммуникация и ответственность"),
        ("internship", "Готовность к стажировке"),
        ("portfolio", "Учебный кейс по специальности"),
    ],
    "default": [
        ("practice", "Практика по специальности"),
        ("tools", "Инструменты специальности"),
        ("soft", "Коммуникация и ответственность"),
        ("internship", "Готовность к стажировке"),
        ("portfolio", "Учебный кейс по специальности"),
    ],
}

_MED_PATH_RE = re.compile(
    r"(?:мед(?:колледж|ицин|сестр)|сестрин|фармац|клиническ|лаб\.?\s*диагност)",
    re.I,
)

_SCHOOLISH_RE = re.compile(
    r"любим\w*\s+предмет|огэ|егэ|после\s*9|10\s*[–\-]\s*11\s*класс|школьн\w*\s+предмет",
    re.I,
)


def _interest_key(interest: str) -> str:
    k = (interest or "").strip()
    return k if k in _VOC_PATH_POOLS else "default"


def _pool_keys(profile: Dict[str, Any], interest: str) -> List[str]:
    spheres = set(parse_interest_spheres(profile))
    keys: List[str] = []
    dk = _interest_key(interest)
    if dk != "default" and (dk != "medicine" or "medicine" in spheres):
        keys.append(dk)
    for sid in spheres:
        if sid in _VOC_PATH_POOLS and sid not in keys:
            if sid == "medicine" and "medicine" not in spheres:
                continue
            keys.append(sid)
    keys = [k for k in keys if k != "medicine" or "medicine" in spheres]
    return keys or ["default"]


def _dominant_radar_key(axes: List[Dict[str, Any]]) -> str:
    if not axes:
        return "structure_mastery"
    best = max(axes, key=lambda a: int(a.get("value_percent") or 0))
    return str(best.get("key") or "structure_mastery")


def _goal_path_pool(
    profile: Dict[str, Any],
    interest: str,
    sphere_lbl: str,
) -> Optional[List[str]]:
    """Если задана развилка вуз/работа — три разных семейства путей."""
    goal = spo_goal_kind(profile)
    course = str(profile.get("course_grade") or profile.get("course_or_grade") or "").strip()
    like = str(profile.get("like_to_do") or "").strip()[:70]
    city = str(profile.get("city") or "").strip()
    course_bit = f" ({course})" if course else ""
    like_bit = f" с опорой на «{like}»" if like else ""
    if goal == "university":
        return [
            f"Бакалавриат по профилю «{sphere_lbl}»{course_bit}",
            f"Смежная программа вуза рядом со специальностью «{sphere_lbl}»",
            f"Диплом и вступительные{like_bit} — один фокус на месяц",
        ]
    if goal == "work":
        city_bit = f" в {city}" if city else ""
        return [
            f"Практика или стажировка по «{sphere_lbl}»{city_bit}",
            f"Углубить специальность: {sphere_lbl}{like_bit}",
            f"Первая рабочая роль / помощник по «{sphere_lbl}»",
        ]
    # undecided: показать развилку, а не угадывать junior
    return [
        f"После колледжа — в вуз по «{sphere_lbl}»",
        f"После колледжа — на работу или стажировку по «{sphere_lbl}»{(' (' + city + ')') if city else ''}",
        "Месяц проверить оба пути: диплом + одна практика",
    ]


def _score_path(name: str, dom: str, fp: int, idx: int, goal: str = "undecided") -> int:
    low = name.lower()
    base = 58 + (fp % 11) - (idx * 2)
    if dom == "structure_mastery" and any(
        x in low for x in ("углубить", "инструмент", "проект", "специальн", "данн", "инженер", "диплом")
    ):
        base += 7
    if dom == "people_service" and any(
        x in low for x in ("практик", "стажир", "клиент", "педагог", "сервис", "команд")
    ):
        base += 6
    if goal == "university":
        if any(x in low for x in ("вуз", "бакалавр", "поступлен", "диплом")):
            base += 10
        if any(x in low for x in ("ваканс", "отклик", "junior")):
            base -= 12
    elif goal == "work":
        if "стажир" in low or "практик" in low or "помощник" in low or "роль" in low:
            base += 8
        if "вуз" in low or "бакалавр" in low:
            base -= 4
    else:
        if "после колледжа" in low or "проверить оба" in low:
            base += 8
    if "стажир" in low or "практик" in low:
        base += 3
    if "портфолио" in low or "кейс" in low:
        base += 3
    return base


def _path_family(name: str) -> str:
    low = (name or "").lower()
    if "смежн" in low:
        return "adjacent"
    if "диплом" in low:
        return "diploma"
    if "вуз" in low or "бакалавр" in low or "поступлен" in low:
        return "university"
    if "стажир" in low or "junior" in low or "помощник" in low:
        return "internship"
    if "практик" in low or "производств" in low:
        return "practice"
    if "портфолио" in low or "отклик" in low or "кейс" in low:
        return "portfolio_market"
    if "углубить" in low or "специальн" in low:
        return "deepen"
    return "other:" + re.sub(r"\W+", " ", low)[:40].strip()


def _dedupe(paths: List[str]) -> List[str]:
    seen: Set[str] = set()
    out: List[str] = []
    for p in paths:
        fam = _path_family(p)
        if fam in seen:
            continue
        seen.add(fam)
        out.append(p)
    return out


def pick_vocational_path_plans(
    profile: Dict[str, Any],
    interest: str,
    axes: List[Dict[str, Any]],
    fp: int,
    *,
    exclude_sphere_ids: Optional[Set[str]] = None,
) -> Dict[str, Any]:
    """Три варианта A/B/C: вуз / работа / развилка — по post_spo_goal."""
    goal = spo_goal_kind(profile)
    ex_sp = set(exclude_sphere_ids or ())
    pool_keys = [k for k in _pool_keys(profile, interest) if k not in ex_sp]
    if not pool_keys:
        pool_keys = ["default"]
    spheres = set(parse_interest_spheres(profile))
    sphere_lbl = ", ".join(_SPHERE_LABELS.get(s, s) for s in list(spheres)[:2]) or "ваша сфера"
    goal_pool = _goal_path_pool(profile, interest, sphere_lbl)
    pool: List[str] = list(goal_pool or [])
    if goal == "work" or not pool:
        for pk in pool_keys:
            pool.extend(list(_VOC_PATH_POOLS.get(pk, ())))
    if "medicine" not in spheres:
        pool = [p for p in pool if not _MED_PATH_RE.search(p)]
        pool_keys = [k for k in pool_keys if k != "medicine"]
    pool = _dedupe(pool)
    if not pool:
        pool = list(goal_pool or _VOC_PATH_POOLS["default"])

    dom = _dominant_radar_key(axes)
    scored = [(_score_path(n, dom, fp, i, goal), n) for i, n in enumerate(pool)]
    scored.sort(key=lambda x: -x[0])

    picked: List[Tuple[int, str]] = []
    used_fam: Set[str] = set()
    for raw, name in scored:
        fam = _path_family(name)
        if fam in used_fam and len(picked) < 2:
            continue
        if fam in used_fam:
            continue
        used_fam.add(fam)
        picked.append((raw, name))
        if len(picked) >= 3:
            break
    if len(picked) < 3:
        for raw, name in scored:
            if any(name == p[1] for p in picked):
                continue
            picked.append((raw, name))
            if len(picked) >= 3:
                break

    codes = ["A", "B", "C"]
    plans = []
    for idx, (raw, name) in enumerate(picked[:3]):
        pid = codes[idx]
        plans.append(
            {
                "id": pid,
                "name": f"Вариант {pid}: {name}",
                "score_percent": max(48, min(96, raw)),
            }
        )
    pads = {
        "university": (
            "Бакалавриат по специальности",
            "Смежная программа вуза",
            "Диплом и вступительные — один фокус на месяц",
        ),
        "work": (
            "Практика по специальности",
            "Стажировка или роль помощника",
            "Учебный кейс по специальности",
        ),
        "undecided": (
            "После колледжа — в вуз",
            "После колледжа — на практику",
            "Месяц сравнить оба пути",
        ),
    }.get(goal, ("Практика по специальности", "Учебный кейс", "Смежный трек"))
    while len(plans) < 3:
        idx = len(plans)
        plans.append(
            {
                "id": codes[idx],
                "name": f"Вариант {codes[idx]}: {pads[idx]}",
                "score_percent": 50,
            }
        )
    best = max(plans, key=lambda p: p["score_percent"])
    sphere_lbl = ", ".join(_SPHERE_LABELS.get(s, s) for s in list(spheres)[:2]) or "ваша сфера"
    if goal == "university":
        caption = "согласованность с поступлением в вуз после колледжа"
        focus = f"Сфера: {sphere_lbl}. Дальше — бакалавриат и диплом."
    elif goal == "work":
        caption = "согласованность с первым местом: практика → стажировка → помощник"
        focus = f"Сфера: {sphere_lbl}. Дальше — практика и первые рабочие шаги."
    else:
        caption = "развилка после колледжа: вуз или работа — сравните A и B"
        focus = f"Сфера: {sphere_lbl}. Сначала выберите: вуз или работа, не оба сразу."
    return {
        "plans": plans,
        "best_plan_id": best["id"],
        "best_plan_name": best["name"],
        "best_avg_percent": best["score_percent"],
        "caption": caption,
        "focus_label": focus,
        "vocational_mode": True,
        "spo_goal": goal,
    }


def sanitize_vocational_scenarios(
    profile: Dict[str, Any],
    scenarios: Dict[str, Any],
    interest: str,
    axes: List[Dict[str, Any]],
    fp: int,
) -> Dict[str, Any]:
    spheres = set(parse_interest_spheres(profile))
    plans = list((scenarios or {}).get("plans") or [])
    blob = " ".join(str(p.get("name") or "") for p in plans)
    if "medicine" not in spheres and _MED_PATH_RE.search(blob):
        return pick_vocational_path_plans(profile, interest, axes, fp)
    if _SCHOOLISH_RE.search(blob):
        return pick_vocational_path_plans(profile, interest, axes, fp)
    return scenarios


def safe_top_path_vocational(
    profile: Dict[str, Any],
    top_path: str,
    interest: str,
    scenarios: Optional[Dict[str, Any]] = None,
) -> str:
    path = re.sub(r"^Вариант\s+[ABC]:\s*", "", (top_path or "").strip(), flags=re.IGNORECASE)
    path = re.sub(r"^План\s+[ABC]:\s*", "", path, flags=re.IGNORECASE).strip()
    spheres = set(parse_interest_spheres(profile))
    if path and not (_MED_PATH_RE.search(path) and "medicine" not in spheres):
        if not _SCHOOLISH_RE.search(path):
            return path[:80]
    for p in (scenarios or {}).get("plans") or []:
        name = re.sub(r"^Вариант\s+[ABC]:\s*", "", str(p.get("name") or ""), flags=re.IGNORECASE).strip()
        if not name:
            continue
        if _MED_PATH_RE.search(name) and "medicine" not in spheres:
            continue
        if _SCHOOLISH_RE.search(name):
            continue
        return name[:80]
    dk = _interest_key(interest)
    lbl = _SPHERE_LABELS.get(dk) or _SPHERE_LABELS.get(next(iter(spheres), ""), "ваша сфера")
    return f"практика и рост по специальности («{lbl}»)"


def build_vocational_gap_analysis(
    profile: Dict[str, Any],
    interest: str,
    top_path: str,
    axes: List[Dict[str, Any]],
    fp: int,
    *,
    preparation_level: str = "",
) -> Dict[str, Any]:
    """Разрыв по навыкам специальности и практике — без школьных предметов."""
    spheres = set(parse_interest_spheres(profile))
    keys = _pool_keys(profile, interest)
    path_hint = safe_top_path_vocational(profile, top_path, interest)
    goal = spo_goal_kind(profile)
    # Сфера из анкеты важнее «interest» с API — иначе медицина получает IT/GitHub.
    if "medicine" in spheres:
        focus = ["medicine"]
    else:
        sphere_focus = [s for s in spheres if s in _VOC_GAP_BY_INTEREST]
        focus = sphere_focus[:1] or keys[:1] or ["default"]
    if "medicine" not in spheres:
        focus = [k for k in focus if k != "medicine"] or ["default"]

    subjects: List[Tuple[str, str]] = []
    seen: Set[str] = set()

    def _relabel(sk: str, lab: str) -> str:
        if goal != "university":
            return lab
        # Цель «вуз»: без junior/GitHub — про поступление и учебный задел.
        low = lab.lower()
        if "github" in low or (sk == "portfolio" and "портфолио" in low):
            return "Учебный проект / задел для поступления"
        if "junior" in low or "стажировк" in low:
            return "Готовность к поступлению / вступительным"
        return lab

    def _add(sk: str, lab: str) -> None:
        lab = _relabel(sk, lab)
        if sk in seen or lab in seen:
            return
        subjects.append((sk, lab))
        seen.add(sk)
        seen.add(lab)

    for pk in focus:
        for sk, lab in _VOC_GAP_BY_INTEREST.get(pk, ()):
            if pk == "medicine" and "medicine" not in spheres:
                continue
            _add(sk, lab)
    if len(subjects) < 4:
        for sk, lab in _VOC_GAP_BY_INTEREST["default"]:
            _add(sk, lab)
    subjects = subjects[:7]

    prep = (preparation_level or str(profile.get("preparation_level") or "")).strip()
    prep_base = {"weak": 42, "medium": 58, "strong": 74}.get(prep, 56)
    if prep not in ("weak", "medium", "strong") and axes:
        avg_ax = sum(int(a.get("value_percent") or 0) for a in axes) / max(1, len(axes))
        prep_base = 42 if avg_ax < 40 else 58 if avg_ax < 62 else 72

    axis_by = {str(a.get("key") or ""): int(a.get("value_percent") or 0) for a in (axes or [])}
    has_practice = bool(
        (profile.get("experience_projects") or "").strip()
        or (profile.get("extra_education") or "").strip()
    )
    has_tools = bool(
        (profile.get("programming_skills") or "").strip()
        or (profile.get("software_skills") or "").strip()
    )
    path_low = path_hint.lower()

    bars: List[Dict[str, Any]] = []
    closeness: List[int] = []
    for sk, label in subjects:
        score = float(prep_base) + (((sum(ord(c) for c in sk) * 13 + fp % 89) % 9) - 4)
        if sk in ("practice", "internship") and has_practice:
            score += 14
        if sk in ("tools", "portfolio") and has_tools:
            score += 12
        if sk == "soft":
            score = 0.55 * score + 0.45 * axis_by.get("people_service", 50)
        if sk == "internship":
            score -= 6 if prep != "strong" else 0
        if any(k in path_low for k in ("стажир", "практик")) and sk in ("practice", "internship"):
            score += 4
        user_pct = int(max(28, min(90, round(score))))
        target = 86
        if sk in ("practice", "internship"):
            target = 88
        if sk == "portfolio":
            target = 84
        gap_pct = max(0, target - user_pct)
        closeness.append(100 - min(100, gap_pct))
        bars.append(
            {
                "label": label,
                "user_percent": user_pct,
                "target_percent": target,
                "gap_percent": gap_pct,
            }
        )
    overall = sum(closeness) // max(1, len(closeness)) if closeness else 50
    weak = sorted(
        ((b["label"], b["gap_percent"]) for b in bars if b["gap_percent"] > 12),
        key=lambda x: -x[1],
    )
    closing = [w[0] for w in weak[:3]] or [b["label"] for b in bars[:3]]
    # Жёстко убрать школьные формулировки, если вдруг попали.
    closing = [c for c in closing if not _SCHOOLISH_RE.search(c)][:3] or closing[:3]

    headline = "Специальность и практика: где вы уже близко к маршруту, а где разрыв"
    if path_hint:
        headline = f"Сравнение с маршрутом «{path_hint[:58]}»: где вы уже близко, а где разрыв"
    return {
        "headline": headline,
        "overall_hp": overall,
        "bars": bars,
        "closing_skills": closing,
    }


def vocational_education_hints(
    profile: Dict[str, Any],
    interest: str,
    scenarios: Dict[str, Any],
) -> Dict[str, Any]:
    plans = scenarios.get("plans") or []
    rows: List[Dict[str, Any]] = []
    for p in plans[:3]:
        name = re.sub(r"^Вариант\s+[ABC]:\s*", "", str(p.get("name") or ""), flags=re.IGNORECASE)
        rows.append(
            {
                "title": name[:90],
                "match_percent": int(p.get("score_percent") or 0),
                "education_type": "vocational",
                "hint": "Маршрут в колледже и на практике.",
            }
        )
    city = (profile.get("city") or "").strip()
    caption = "Куда расти в учёбе и на практике"
    if city:
        caption += f" — смотрите стажировки и практику в {city}"
    return {"rows": rows, "caption": caption, "vocational_mode": True}


def vocational_weekly_roadmap(
    profile: Dict[str, Any],
    top_path: str,
    interest: str,
    scenarios: Optional[Dict[str, Any]] = None,
) -> List[Dict[str, Any]]:
    path = safe_top_path_vocational(profile, top_path, interest, scenarios)
    city = (profile.get("city") or "").strip()
    like = (profile.get("like_to_do") or "").strip()[:80]
    closing_hint = like or "навык из блока «Что подтянуть»"
    goal = spo_goal_kind(profile)

    if goal == "university":
        w1_learn = "Сравните программы бакалавриата с тем, чему вы уже учитесь в колледже."
        w1_practice = f"Один фокус на 2 недели: {closing_hint} — предмет или раздел диплома."
        if city:
            w1_learn += f" Посмотрите 1–2 вуза в {city} или с заочным форматом."
        w2_learn = "Соберите аргументы для поступления: оценки, практика и 5–8 строк о том, что вы уже умеете."
        w2_practice = "Один контакт: приёмная комиссия, день открытых дверей или куратор специальности."
        out1 = "Выбрано одно направление поступления, которое вы проверяете в течение месяца."
        out2 = "Есть следующий шаг по поступлению — без распыления на рынок труда."
    elif goal == "work":
        w1_learn = "Сравните интересующие рабочие задачи с вашей специальностью и расписанием практики на семестр."
        w1_practice = f"Один фокус на 2 недели: {closing_hint} — без списка из десяти дел."
        if city:
            w1_learn += f" Посмотрите 1–2 места практики/стажировки в {city}."
        w2_learn = "Соберите короткий учебный кейс: что сделали и чему научились — достаточно 5–8 строк."
        w2_practice = (
            "Один контакт: куратор практики, наставник или день открытых дверей у потенциального места стажировки."
        )
        out1 = "Выбрана одна рабочая гипотеза, которую вы проверяете в течение месяца."
        out2 = "Есть кейс и следующий шаг по практике/стажировке — без распыления."
    else:
        w1_learn = "Сравните два пути на бумаге: вуз vs работа — плюсы, сроки, что уже даёт колледж."
        w1_practice = "За неделю поговорите с куратором и сделайте один небольшой шаг: поработайте над дипломом или попробуйте практическую задачу."
        w2_learn = "Не выбирайте оба сразу: зафиксируйте гипотезу на месяц."
        w2_practice = closing_hint
        out1 = "Понятно, чем отличаются вуз и работа после колледжа."
        out2 = "Сделан пробный шаг в сторону учёбы или работы."

    return [
        {
            "period": "Недели 1–2",
            "learn": w1_learn,
            "practice": w1_practice,
            "outcome": out1,
        },
        {
            "period": "Недели 3–4",
            "learn": w2_learn,
            "practice": w2_practice,
            "outcome": out2,
        },
    ]


def build_vocational_individual_advice(
    profile: Dict[str, Any],
    scenarios: Dict[str, Any],
    gap: Dict[str, Any],
    interest: str,
) -> Dict[str, Any]:
    closing = [str(x) for x in ((gap or {}).get("closing_skills") or []) if x][:3]
    focus = closing[0] if closing else "практика по специальности"
    like = (profile.get("like_to_do") or "").strip()[:100]
    goal = spo_goal_kind(profile)
    by_plan: Dict[str, Any] = {}
    for p in (scenarios.get("plans") or [])[:3]:
        pid = str(p.get("id") or "A")
        name = safe_top_path_vocational(
            profile, str(p.get("name") or ""), interest, scenarios
        )
        if goal == "university":
            start = [
                "Сравните программы бакалавриата с тем, чему вы уже учитесь в колледже"
                + (f", и с вашими интересами ({like})" if like else "")
                + ".",
                f"На 2 недели один фокус: «{focus}» — диплом или предмет, не вакансии.",
                "Обсудите с куратором: какие вузы берут выпускников вашей специальности.",
            ]
            month = [
                "Соберите короткое портфолио или подготовьте часть дипломной работы для поступления.",
                "Один день открытых дверей или консультация приёмной комиссии.",
            ]
            intro = (
                "Этот вариант — про поступление после колледжа. "
                "Без ОГЭ и без гонки за senior-вакансиями."
            )
        elif goal == "work":
            start = [
                "Сравните интересующие рабочие задачи с тем, что уже даёт ваша специальность"
                + (f" и с тем, что нравится делать ({like})" if like else "")
                + ".",
                f"На 2 недели один фокус: «{focus}» — занятия или практика, без гонки за всем сразу.",
                "Обсудите с куратором или наставником: что реально успеть в этом семестре.",
            ]
            month = [
                "Оформите один учебный кейс, который можно показать на стажировке.",
                "Найдите 1–2 места практики/стажировки и уточните требования к кандидату.",
            ]
            intro = (
                "Этот вариант — про практику и первые рабочие шаги. "
                "Без школьных предметов и без гонки за senior-вакансиями."
            )
        else:
            start = [
                "Запишите, что сейчас кажется вам ближе: продолжить учёбу или попробовать выйти на работу.",
                "Один разговор с куратором: куда обычно идут выпускники вашей группы.",
                f"В ближайшие две недели сделайте один небольшой шаг, чтобы подтянуть навык: {focus}.",
            ]
            month = [
                "Не ведите оба пути параллельно весь год — выберите гипотезу на месяц.",
                "Вернитесь к полю «После колледжа» в профиле, когда станет яснее.",
            ]
            intro = "Сначала определитесь, что вам ближе после колледжа — продолжить учёбу или выйти на работу. Затем уточняйте детали."
        by_plan[pid] = {
            "title": name,
            "intro": intro,
            "steps": start,
            "sections": [
                {"title": "На этой неделе", "steps": start},
                {"title": "За месяц", "steps": month},
            ],
            "source": "vocational",
        }
    if not by_plan:
        by_plan["A"] = {
            "title": "Уточнить фокус по специальности",
            "intro": "Начните с практики и одного навыка специальности на 2–4 недели.",
            "steps": [
                "Выберите один навык из разбора и занимайтесь им 3–5 часов за две недели.",
                "Запишите требования к практике/стажировке на вашей специальности.",
            ],
            "sections": [
                {
                    "title": "С чего начать",
                    "steps": [
                        "Выберите один навык из разбора и занимайтесь им 3–5 часов за две недели.",
                        "Запишите требования к практике/стажировке на вашей специальности.",
                    ],
                }
            ],
            "source": "vocational",
        }
    return {"by_plan": by_plan, "source": "vocational"}


def mock_vocational_narrative(
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
    sphere = ", ".join(_SPHERE_LABELS.get(s, s) for s in spheres[:2]) or "ваша сфера"
    course = (profile.get("course_grade") or profile.get("course_or_grade") or "").strip()
    city = (profile.get("city") or "").strip()
    goal = spo_goal_kind(profile)
    parts: List[str] = []
    head = f"Вы студент колледжа (СПО), интересы: {sphere}."
    if course:
        head += f" Курс: {course}."
    if city:
        head += f" Город: {city[:1].upper() + city[1:] if city else city}."
    if goal == "university":
        head += " После колледжа вам ближе продолжить учёбу в вузе — углублять специальность, а не сразу выходить на работу."
    elif goal == "work":
        head += " После колледжа вам ближе практика и первый рабочий опыт по специальности."
    else:
        head += " Пока можно держать оба горизонта: и дальше учиться, и пробовать практику — без давления выбрать сразу."
    parts.append(head)

    mid = "По ответам видно, какой стиль задач вам ближе."
    if axes:
        try:
            best = max(axes, key=lambda a: int(a.get("value_percent") or 0))
            lab = str(best.get("label") or "").strip()
            if lab:
                mid = f"В задачах сильнее всего читается: {lab}."
        except Exception:
            pass
    closing = list((gap or {}).get("closing_skills") or [])[:2]
    if closing:
        mid += f" Пока слабее: {', '.join(closing)}."
    parts.append(mid)

    tips = (
        "Это портрет по текущим ответам, а не ярлык на всю жизнь.",
        "Если описание не про вас — уточните цель после колледжа в профиле.",
        "Сравните направления по задачам, которые вам интересны, и навыкам, которые уже есть.",
    )
    parts.append(tips[fp % len(tips)])
    return " ".join(parts)


def scrub_vocational_narrative(text: str, profile: Dict[str, Any], scenarios: Dict[str, Any]) -> str:
    raw = (text or "").strip()
    if not raw:
        return raw
    try:
        from wibe_work.services.llm_prompts import scrub_portrait_plan_jargon

        raw = scrub_portrait_plan_jargon(raw) or raw
    except Exception:
        pass
    out = raw
    spheres = set(parse_interest_spheres(profile))
    plans_blob = " ".join(str(p.get("name") or "") for p in (scenarios.get("plans") or []))
    if "medicine" not in spheres and not _MED_PATH_RE.search(plans_blob):
        out = re.sub(
            r"[^.!?]*\b(?:мед(?:колледж|ицин\w*)|сестрин\w*|фармац\w*)[^.!?]*[.!?]?",
            " ",
            out,
            flags=re.I,
        )
    # Убираем явно школьные советы из LLM, не ломая нормальные фразы.
    out = re.sub(r"(?i)любим\w*\s+предмет\w*", "сильные стороны по специальности", out)
    out = re.sub(r"(?i)\bогэ\b|\bегэ\b", "аттестация", out)
    if spo_goal_kind(profile) == "university":
        for pat, repl in (
            (r"(?i)рынок\s+ваканс\w*", "выход на работу"),
            (r"(?i)\bрезюме\b", "пакет для поступления"),
            (r"(?i)\bотклик\w*\b", "заявки в вуз"),
            (r"(?i)\bваканс\w*\b", "программы вуза"),
            (r"(?i)\bhh\.?ru\b", "сайты вузов"),
            (r"(?i)\bсобеседован\w*\b", "вступительное собеседование"),
            (r"(?i)\bsenior\b|\bсеньор\b", "первый курс вуза"),
            (r"(?i)\bgithub\b", "учебный проект"),
            (r"(?i)\bjunior\b|\bджуниор\b", "первый курс"),
        ):
            out = re.sub(pat, repl, out)
    else:
        out = re.sub(r"(?i)\bsenior\b|\bсеньор\b", "помощник / стажёр", out)
    out = re.sub(r"\s{2,}", " ", out).strip()
    return out or raw


def vocational_learning_extras(
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
    """Обучение и советы для СПО — каталог материалов + студенческие советы/этапы."""
    from wibe_work.services.learning.assessment_signals import build_assessment_signals
    from wibe_work.services.learning.growth_stages import build_growth_stages
    from wibe_work.services.learning_pack import normalize_preparation_level

    prep = normalize_preparation_level(preparation_level)
    eff = (eff_interest or interest or "other").strip() or "other"
    advice = build_vocational_individual_advice(profile, scenarios, gap, eff)
    signals = build_assessment_signals(
        profile=profile,
        interest=eff,
        preparation_level=prep,
        scenarios=scenarios,
        gap=gap,
        axes=axes,
        answers=answers,
    )
    pack = {"learning": [], "learning_path": {}}
    learning_path = pack.get("learning_path") or {}
    readiness = int(gap.get("overall_hp") or 50)
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
        force_vocational=True,
    )
    return {
        "learning": pack.get("learning") or [],
        "learning_path": learning_path,
        "learning_path_detail": learning_path,
        "individual_advice": advice,
        "growth_stages": stages,
        "growth_stages_rich": stages,
        "assessment_signals": signals,
    }


def vocational_pain_first_step(pain_id: str) -> Optional[str]:
    steps = {
        "pain_career": "Выберите один вариант A/B/C по специальности и один шаг практики на 2 недели.",
        "pain_no_exp": "Опыт для студента — практика и учебный кейс: оформите один в 5–8 строк.",
        "pain_interview": "К собеседованию на стажировку: 3 факта «что делал на практике» + один кейс.",
        "pain_gap_skills": "Возьмите один пункт из «Что подтянуть» — 3–5 часов за две недели.",
        "pain_overload": "Один фокус на неделю: практика или один навык специальности.",
        "pain_voc_direction": "Отметьте в профиле вуз или работу и сравните A/B/C — один шаг на 2 недели.",
        "pain_voc_specialty": "Выберите один навык специальности из разбора и 3–5 часов на него за две недели.",
        "pain_voc_practice": "Одна практика или учебный кейс в 5–8 строк — этого достаточно, чтобы сдвинуться.",
        "pain_voc_diploma": "Сопоставьте тему диплома с выбранным маршрутом A/B/C — один раздел на месяц.",
        "pain_voc_overload": "Один фокус на неделю: практика или один навык специальности.",
        "pain_voc_confidence": "Список из 5 дел с практики и учёбы, где вы справились — это ваша база.",
        "pain_voc_family": "Покажите семье сценарии A/B/C и зафиксируйте один компромисс на месяц.",
        "pain_money_courses": "Сначала бесплатная практика и кейс по специальности — без дорогих пакетов «с нуля».",
        "pain_low_confidence": "Список из 5 дел с практики и учёбы, где вы справились — это ваша база.",
    }
    return steps.get((pain_id or "").strip())
