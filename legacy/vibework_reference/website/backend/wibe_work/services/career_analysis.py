"""Построение результата разбора: метрики для UI + внутренние поля для чата."""

import json
import re
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

from wibe_work.paths import data_file
from wibe_work.services.llm_client import fetch_llm_completion, llm_configured
from wibe_work.services.llm_prompts import (
    build_analysis_user_prompt,
    narrative_conflicts_with_profile,
    narrative_system_for_grade,
    polish_analysis_narrative,
)
from wibe_work.services.aptitude_quiz import get_pro_weights_matrix_for_interest, letter_to_index
from wibe_work.questionnaire_fields import INTEREST_SPHERES
from wibe_work.services.user_context import (
    _PAIN_LABELS,
    _PRIORITY_RU,
    _WORK_FORMAT_RU,
    coach_profile_snippet,
    parse_interest_spheres,
    profile_text,
    profile_skill_blob,
)
from wibe_work.services.user_pain_mapping import align_pains
from wibe_work.services.learning_pack import build_learning_extras
from wibe_work.services.profile_analysis_context import (
    analysis_mode_for_profile,
    build_profile_summary_for_analysis,
)
from wibe_work.services.career_analysis_school import (
    build_school_gap_analysis,
    mock_school_narrative,
    pick_school_path_plans,
    sanitize_school_scenarios,
    scrub_school_narrative,
    school_education_hints,
    school_learning_extras,
    school_pain_first_step,
    school_weekly_roadmap,
    _safe_top_path_for_profile,
)
from wibe_work.services.career_analysis_vocational import (
    build_vocational_gap_analysis,
    mock_vocational_narrative,
    pick_vocational_path_plans,
    sanitize_vocational_scenarios,
    safe_top_path_vocational,
    scrub_vocational_narrative,
    spo_goal_kind,
    vocational_education_hints,
    vocational_learning_extras,
    vocational_pain_first_step,
    vocational_weekly_roadmap,
)

_ANALYSIS_LLM_LOCK = threading.Lock()
_ANALYSIS_LLM_TIMEOUT = 12.0


def _walk_scrub(obj: Any, fn) -> Any:
    if isinstance(obj, str):
        return fn(obj)
    if isinstance(obj, list):
        return [_walk_scrub(x, fn) for x in obj]
    if isinstance(obj, dict):
        return {k: _walk_scrub(v, fn) for k, v in obj.items()}
    return obj


def _block_job_market_copy(mode: str, profile: Dict[str, Any]) -> bool:
    if mode == "school":
        return True
    return mode == "vocational" and spo_goal_kind(profile) == "university"


def _scrub_copy_string(text: str, mode: str, profile: Dict[str, Any]) -> str:
    if not text:
        return text
    if mode == "school":
        return scrub_school_narrative(text, profile, {})
    if mode == "vocational":
        return scrub_vocational_narrative(text, profile, {})
    return re.sub(r"(?i)\bsenior\b", "middle+", text)


def _sanitize_pain_focus(
    pain_focus: Optional[Dict[str, Any]],
    mode: str,
    profile: Dict[str, Any],
) -> Optional[Dict[str, Any]]:
    if not pain_focus:
        return pain_focus
    pid = profile_text(profile.get("primary_pain"))
    if mode == "school":
        school_step = school_pain_first_step(pid) if pid else None
        extra = [
            "Один предмет или кружок на 2 недели — без поиска работы.",
            "Сравните маршруты A/B/C с родителями или школой и зафиксируйте один шаг.",
        ]
        tips = [t for t in ([school_step] if school_step else []) + extra if t][:3]
        pain_focus = {**pain_focus, "tips": tips}
        pain_focus["summary"] = _scrub_copy_string(str(pain_focus.get("summary") or ""), mode, profile)
        return pain_focus
    if mode == "vocational":
        voc_step = vocational_pain_first_step(pid) if pid else None
        goal = spo_goal_kind(profile)
        if goal == "university":
            extra = [
                "Один шаг к вузу на 2 недели: программа, диплом или консультация — не hh.",
                "Сравните A/B/C с куратором специальности.",
            ]
            tips = [t for t in ([voc_step] if voc_step else []) + extra if t][:3]
            pain_focus = {**pain_focus, "tips": tips}
        elif voc_step:
            rest = [
                t
                for t in (pain_focus.get("tips") or [])
                if voc_step not in t and not re.search(r"(?i)senior|сеньор|hh\.?ru", str(t))
            ][:2]
            pain_focus = {**pain_focus, "tips": [voc_step] + rest}
        pain_focus["summary"] = _scrub_copy_string(str(pain_focus.get("summary") or ""), mode, profile)
        pain_focus["tips"] = [
            _scrub_copy_string(str(t), mode, profile) for t in (pain_focus.get("tips") or [])
        ]
    return pain_focus

_SKILL_ORDER = (
    "programming",
    "analytics",
    "communication",
    "design",
    "management",
)
_SKILL_TO_PACK_KEY = {
    "programming": "программирование",
    "analytics": "аналитика",
    "communication": "коммуникации",
    "design": "дизайн",
    "management": "организация_и_управление",
}

_SPHERE_TO_WEBSITE_INTEREST = {
    "it_dev": "IT",
    "data": "данные_и_AI",
    "design": "дизайн",
    "marketing": "маркетинг",
    "sales": "продажи",
    "engineering": "инженерия",
    "mgmt": "бизнес",
    "finance": "финансы_и_контроль",
    "hr_edu": "HR_и_рекрутинг",
    "logistics": "логистика",
    "medicine": "медицина",
    "education": "образование",
    "creative": "дизайн",
    "sport": "спорт",
    "other": "бизнес",
}

_SPHERE_LABELS: Dict[str, str] = {s["id"]: s["label"] for s in INTEREST_SPHERES}

_PREP_LABELS: Dict[str, str] = {
    "weak": "начальный",
    "medium": "средний",
    "strong": "уверенный",
}

_PAIN_FIRST_STEP: Dict[str, str] = {
    "pain_career": "Зафиксируйте 3 гипотезы из сценариев A/B/C и проверьте одну коротким проектом за 2 недели.",
    "pain_no_exp": "Добавьте в резюме один учебный или волонтёрский кейс с цифрой результата — даже без официальной работы.",
    "pain_region": "Сузьте поиск: удалёнка/гибрид и 2–3 города с реальными вакансиями по вашей сфере.",
    "pain_money_courses": "Выберите один бесплатный трек из блока «Обучение» и доведите до артефакта (конспект или мини-проект).",
    "pain_interview": "Три тренировочных ответа на типовые вопросы по сфере — вслух, с таймером 2 минуты.",
    "pain_overload": "Один шаг на эту неделю из этапов роста; остальное — в список «потом».",
    "pain_low_confidence": "Список из 5 навыков из повседневности (школа, хобби, помощь людям) — без сравнения с «идеалом».",
    "pain_gap_skills": "Сопоставьте топ-3 разрыва навыков с одной вакансией мечты и закройте самый узкий за месяц.",
}

_MTS_PATH = data_file("mts_role_matrix.json")


def _load_mts_roles() -> List[Dict[str, Any]]:
    p = Path(_MTS_PATH)
    if not p.is_file():
        return []
    with p.open(encoding="utf-8") as f:
        data = json.load(f)
    return list(data.get("roles") or [])


def _profile_blob(profile: Dict[str, Any], profile_extra: Dict[str, Any]) -> str:
    parts = [json.dumps(profile, ensure_ascii=False), json.dumps(profile_extra, ensure_ascii=False)]
    return " ".join(parts).lower()


def _answer_vector(answers: List[Dict[str, Any]]) -> List[int]:
    out: List[int] = []
    for a in answers:
        ch = a.get("choice") or a.get("choice_id")
        if isinstance(ch, int):
            idx = max(0, min(3, int(ch)))
        else:
            idx = letter_to_index(str(ch))
        out.append(idx)
    return out


def _readiness_percent(vec: List[int], preparation: str) -> int:
    if not vec:
        return 35
    scores = [(v + 1) * 25 for v in vec]
    avg = sum(scores) / len(scores)
    prep_bonus = {"weak": -6, "medium": 0, "strong": 10}.get(preparation, 0)
    return int(max(12, min(100, round(avg * 0.82 + prep_bonus))))


def _build_readiness_insight(
    readiness: int,
    preparation_level: str,
    axes: List[Dict[str, Any]],
    gap: Optional[Dict[str, Any]],
    scenarios: Optional[Dict[str, Any]],
    *,
    analysis_mode: str = "career",
    profile: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Краткое «почему столько» для карточки готовности / ясности маршрута."""
    mode = (analysis_mode or "").strip().lower()
    school = mode == "school"
    vocational = mode == "vocational"
    prep = {"weak": "начальный", "medium": "средний", "strong": "уверенный"}.get(
        preparation_level, "средний"
    )
    pros: List[str] = []
    cons: List[str] = []

    if axes:
        by_val = sorted(axes, key=lambda a: int(a.get("value_percent") or 0), reverse=True)
        for a in by_val[:2]:
            pct = int(a.get("value_percent") or 0)
            if pct >= 55:
                pros.append(f"{a.get('label', 'Ось')}: {pct}%")
        for a in list(reversed(by_val))[:2]:
            pct = int(a.get("value_percent") or 0)
            if pct < 52:
                cons.append(f"{a.get('label', 'Ось')} — {pct}%")

    if gap:
        hp = gap.get("overall_hp")
        if hp is not None and int(hp) >= 68:
            if school:
                pros.append(f"Предметы к маршруту закрыты примерно на {int(hp)}%")
            elif vocational:
                pros.append(f"Навыки специальности закрыты примерно на {int(hp)}%")
            else:
                pros.append(f"Навыки близки к цели (~{int(hp)}%)")
        for label in (gap.get("closing_skills") or [])[:2]:
            cons.append(f"Подтянуть: {label}")

    best = (scenarios or {}).get("best_avg_percent")
    best_name = str((scenarios or {}).get("best_plan_name") or "").strip()
    best_name = re.sub(r"^(Вариант|План)\s+[ABC]:\s*", "", best_name, flags=re.IGNORECASE)
    if best is not None and int(best) >= 58:
        if (school or vocational) and best_name:
            pros.append(f"Ближе всего: «{best_name[:48]}» (~{int(best)}%)")
        elif not school and not vocational:
            pros.append(f"Сценарий плана ~{int(best)}%")

    if school:
        bn = (best_name or "").lower()
        ege_like = any(k in bn for k in ("егэ", "огэ", "11 класс", "10–11", "10-11", "проф"))
        college_like = any(k in bn for k in ("колледж", "спо", "после 9"))
        if readiness < 40:
            if college_like:
                why = (
                    f"{readiness}% — пока не ясно, куда двигаться. "
                    "Выберите один маршрут ниже и 1–2 предмета или колледж на ближайший месяц."
                )
            else:
                why = (
                    f"{readiness}% — пока не ясно, куда двигаться. "
                    "Выберите один маршрут ниже и зафиксируйте предметы к ОГЭ/ЕГЭ на ближайший месяц."
                )
        elif readiness < 55:
            why = (
                f"{readiness}% — сильные стороны уже видны, но выбор после школы ещё размыт. "
                "Уточните предметы и один учебный маршрут."
            )
        elif readiness < 70:
            why = (
                f"{readiness}% — маршрут уже можно брать за основу. "
                "Закрепите 1–2 предмета и один следующий шаг (экзамен или поступление)."
            )
        else:
            if college_like and not ege_like:
                why = (
                    f"{readiness}% — картина ясная. "
                    "Держите выбранные предметы и конкретный колледж/профиль, не распыляйтесь."
                )
            elif ege_like:
                why = (
                    f"{readiness}% — картина ясная. "
                    "Держите предметы и подготовку к ОГЭ/ЕГЭ по выбранному профилю, не распыляйтесь."
                )
            else:
                why = (
                    f"{readiness}% — картина ясная. "
                    "Держите выбранные предметы и учебный маршрут, не распыляйтесь."
                )
        why += f" Уровень подготовки в анкете: {prep}."
        if not pros:
            pros.append("Ответы по тестам и анкете уже дают ориентир, куда смотреть")
        if not cons:
            cons.append(
                "Закрепите один любимый предмет кружком или олимпиадой"
                if readiness >= 60
                else "Выберите один предмет из блока «Где вы сильнее и слабее» на месяц"
            )
    elif vocational:
        goal = None
        if profile:
            try:
                from wibe_work.services.career_analysis_vocational import spo_goal_kind as _spo_goal

                goal = _spo_goal(profile)
            except Exception:
                goal = None
        if readiness < 40:
            if goal == "university":
                why = (
                    f"{readiness}% — путь к вузу ещё не собран. "
                    "Выберите одну программу и один шаг к поступлению на 2–4 недели."
                )
            else:
                why = (
                    f"{readiness}% — следующий шаг ещё размыт. "
                    "Выберите один навык специальности или место практики на 2–4 недели."
                )
        elif readiness < 55:
            why = (
                f"{readiness}% — сильные стороны есть, но практика и фокус по специальности ещё стоит уточнить."
            )
        elif readiness < 70:
            if goal == "university":
                why = (
                    f"{readiness}% — цель «вуз» уже опирается на ответы. "
                    "Закрепите навык специальности и один шаг к поступлению."
                )
            else:
                why = (
                    f"{readiness}% — маршрут уже можно брать за основу. "
                    "Закрепите навык и шаг по практике или стажировке."
                )
        else:
            if goal == "university":
                why = (
                    f"{readiness}% — фокус понятен: держите специальность и подготовку к вузу, без распыления."
                )
            else:
                why = (
                    f"{readiness}% — фокус понятен: держите специальность, кейс и одно место практики."
                )
        why += f" Уровень подготовки в анкете: {prep}."
        if not pros:
            pros.append("Ответы и анкета уже дают ориентир по специальности")
        if not cons:
            cons.append(
                "Закрепите один навык учебным кейсом"
                if readiness >= 60
                else "Выберите один пункт из «Где вы сильнее и слабее» на месяц"
            )
    else:
        if readiness < 40:
            why = (
                f"{readiness}% — старт. "
                "Возьмите один навык и один маленький шаг из плана на 2–4 недели."
            )
        elif readiness < 55:
            why = (
                f"{readiness}% — сильные стороны есть, но узкие места тянут вниз. "
                "Смотрите блок «Где вы сильнее и слабее»."
            )
        elif readiness < 70:
            why = (
                f"{readiness}% — хороший рабочий уровень. "
                "До цели близко: сначала закройте главные разрывы по навыкам."
            )
        else:
            why = (
                f"{readiness}% — база сильная. "
                "Дальше важнее практика и кейсы, а не повтор тестов."
            )
        why += f" Уровень подготовки в анкете: {prep}."
        if not pros:
            pros.append("Пройден полный тест — картина устойчивее разовых ответов")
        if not cons:
            cons.append(
                "Закрепляйте навыки практикой"
                if readiness >= 60
                else "Доберите 1–2 навыка из блока ниже"
            )

    return {"why": why, "pros": pros[:3], "cons": cons[:3]}


_RADAR_META = [
    ("self_insight", "Самопознание"),
    ("people_service", "Люди и служение"),
    ("structure_mastery", "Структура и экспертиза"),
    ("balance_autonomy", "Баланс и жизнь"),
]


def _choice_index(ans: Dict[str, Any]) -> int:
    ch = ans.get("choice") or ans.get("choice_id")
    if isinstance(ch, int):
        return max(0, min(3, int(ch)))
    return letter_to_index(str(ch))


def _proforientation_radar_axes(
    answers: List[Dict[str, Any]],
    interest: str,
    profile: Dict[str, Any] | None = None,
) -> List[Dict[str, Any]]:
    """Веса по question_id; нормализация по достигнутому максимуму на отвеченных вопросах.

    Важно: учитываем и ориентацию, и tech/career. Раньше считался только core_offset+,
    из‑за чего у школьников (ответы в блоке профориентации) все оси залипали на 18%.
    """
    matrix = get_pro_weights_matrix_for_interest(interest, profile=profile)
    by_id = {int(a.get("question_id") or 0): a for a in answers if a}

    answered_qi: List[int] = []
    for qid, ans in by_id.items():
        qi = qid - 1
        if 0 <= qi < len(matrix):
            answered_qi.append(qi)
        # на случай несовпадения нумерации — ищем по порядку, если id вне матрицы
    # Если ответы пришли с id вне 1..len(matrix), сопоставим по порядку появления.
    if not answered_qi and answers and matrix:
        for i, a in enumerate(answers):
            if i < len(matrix) and a:
                answered_qi.append(i)

    totals = [0, 0, 0, 0]
    max_per = [0, 0, 0, 0]
    for qi in answered_qi:
        row = matrix[qi]
        ans = by_id.get(qi + 1)
        if not ans and 0 <= qi < len(answers):
            ans = answers[qi]
        if not ans:
            continue
        idx = _choice_index(ans)
        if idx < 0 or idx >= len(row):
            continue
        w = row[idx]
        for k in range(4):
            totals[k] += int(w[k])
            max_per[k] += max(int(row[j][k]) for j in range(len(row)))

    axes: List[Dict[str, Any]] = []
    for i, (key, label) in enumerate(_RADAR_META):
        denom = max_per[i] or 1
        raw = totals[i]
        if not answered_qi:
            pct = 35
        else:
            ratio = min(1.0, raw / float(denom))
            # Шкала 22–92: даже «слабая» ось читается на графике, сильная — заметно длиннее.
            pct = int(round(22 + ratio * 70))
            pct = max(22, min(92, pct))
        axes.append({"key": key, "label": label, "value_percent": pct})
    return axes


def _radar_axes(vec: List[int]) -> List[Dict[str, Any]]:
    """Fallback: старый паттерн по вектору (короткие тесты, неполные ответы)."""
    if not vec:
        vec = [1, 1, 1, 1]
    chunks = [vec[i::4] for i in range(4)]
    labels = [
        ("analytical", "Аналитика"),
        ("creative", "Креатив"),
        ("social", "Коммуникации"),
        ("execution", "Результат"),
    ]
    axes = []
    for i, (key, label) in enumerate(labels):
        c = chunks[i] if i < len(chunks) and chunks[i] else [1]
        raw = sum(c) / max(1, len(c)) / 3.0
        pct = int(round(max(15, min(95, 30 + raw * 55))))
        axes.append({"key": key, "label": label, "value_percent": pct})
    return axes


# IT: id трека → подпись в разборе и буст к планам A/B/C
_IT_TRACK_LABELS: Dict[str, str] = {
    "backend": "Backend-разработчик",
    "frontend": "Frontend-разработчик",
    "devops": "DevOps / инженер инфраструктуры",
    "data": "Аналитик данных / SQL",
    "qa": "Инженер по тестированию (QA)",
}

_IT_TRACK_PLAN_KEYWORDS: Dict[str, Tuple[str, ...]] = {
    "backend": ("бэкенд", "backend", "api", "сервер", "веб- и бэкенд"),
    "frontend": ("frontend", "интерфейс", "веб-интерфейс", "мобильн"),
    "devops": ("devops", "релиз", "ci/cd", "сопровожд", "инфраструктур"),
    "data": ("данн", "sql", "аналит", "продуктовая аналитика"),
    "qa": ("автотест", "качеств", "qa", "тестирован"),
}

DIRECTION_POOLS: Dict[str, Tuple[str, ...]] = {
    "it_dev": (
        "Backend-разработка (API, сервер, базы данных)",
        "Frontend и веб-интерфейсы",
        "Мобильная разработка",
        "Автотесты и QA",
        "Данные, SQL и продуктовая аналитика",
        "DevOps и CI/CD",
    ),
    "data": (
        "Продуктовая и бизнес-аналитика",
        "Инженерия данных и витрины",
        "ML и рекомендательные системы",
        "Эксперименты и A/B-тесты",
        "Визуализация и отчётность",
        "Качество данных",
    ),
    "design": (
        "UI/UX продуктовых команд",
        "Дизайн-системы и компоненты",
        "Исследования и юзабилити",
        "Графика и бренд-коммуникации",
        "Прототипирование под разработку",
        "Моушн и презентационные форматы",
    ),
    "marketing": (
        "Performance и платный трафик",
        "Контент и SMM",
        "CRM и удержание",
        "Продуктовый маркетинг",
        "Бренд и PR",
        "Аналитика маркетинга",
    ),
    "sales": (
        "B2B-продажи и пресейл",
        "Работа с ключевыми клиентами",
        "Холодные каналы и воронка",
        "Партнёрские программы",
        "Розница и точки контакта",
        "Сопровождение сделок",
    ),
    "engineering": (
        "Производство и технологии",
        "Проектирование и чертежи",
        "Обслуживание и ремонт",
        "Контроль качества",
        "Автоматизация и ПНР",
        "Технический надзор",
    ),
    "medicine": (
        "Клиническая практика и уход",
        "Лабораторная диагностика",
        "Фармация и обеспечение",
        "Документирование и протоколы",
        "Работа с пациентами / командой",
        "Допуски и повышение квалификации",
    ),
    "education": (
        "Преподавание и методика",
        "Работа с детьми / группой",
        "Разработка учебных материалов",
        "Организация занятий и мероприятий",
        "Сопровождение и наставничество",
        "Педагогическая практика",
    ),
    "hr_edu": (
        "Рекрутмент и подбор",
        "Обучение и адаптация",
        "Кадровое администрирование",
        "Внутренние коммуникации",
        "HR-аналитика",
        "Корпоративная культура",
    ),
    "finance": (
        "Финансовый контроль и отчётность",
        "Бюджетирование",
        "Учёт и 1С",
        "Управленческий учёт",
        "Финансовая аналитика",
        "Казначейство и платежи",
    ),
    "logistics": (
        "Склад и запасы",
        "Доставка и маршруты",
        "Планирование поставок",
        "Учёт и WMS",
        "Закупки",
        "Сервисная логистика",
    ),
    "mgmt": (
        "Операции и процессы",
        "Координация проектов",
        "Постановка задач и контроль",
        "Кросс-функциональная работа",
        "Улучшение процессов",
        "Ассистирование руководству",
    ),
    "creative": (
        "Контент и медиапроизводство",
        "Съёмка / монтаж / визуал",
        "Креатив под бренд",
        "Ивенты и продакшн",
        "Портфолио и демо-работы",
        "Смежные форматы (дизайн, копирайт)",
    ),
    "sport": (
        "Тренировки и инструктаж",
        "Организация спортивных мероприятий",
        "Работа с группами / секциями",
        "Методики и планирование занятий",
        "Безопасность и восстановление",
        "Фитнес / адаптивный спорт",
    ),
    "other": (
        "Операции и процессы",
        "Проекты и координация",
        "Коммуникации и сервис",
        "Аналитика и отчётность",
        "Обучение и развитие",
        "Практика по вашей специальности",
    ),
    "default": (
        "Операции и процессы",
        "Проекты и координация",
        "Аналитика и отчётность",
        "Коммуникации и сервис",
        "Обучение и развитие",
        "Практика по вашей специальности",
    ),
}

# Веб-коды Interest / алиасы → ключ пула направлений
_INTEREST_ALIASES: Dict[str, str] = {
    "IT": "it_dev",
    "it": "it_dev",
    "devops": "it_dev",
    "DevOps_и_SRE": "it_dev",
    "данные_и_AI": "data",
    "данные_и_ai": "data",
    "data_ai": "data",
    "дизайн": "design",
    "маркетинг": "marketing",
    "продажи": "sales",
    "инженерия": "engineering",
    "медицина": "medicine",
    "образование": "education",
    "спорт": "sport",
    "бизнес": "mgmt",
    "финансы_и_контроль": "finance",
    "HR_и_рекрутинг": "hr_edu",
    "логистика": "logistics",
    "продукт_и_PMO": "mgmt",
    "общий": "other",
}

ADJACENT_BY_AXIS: Dict[str, Tuple[str, ...]] = {
    "structure_mastery": ("Системность и регламенты", "Метрики и контроль качества"),
    "people_service": ("Клиентский успех", "Координация стейкхолдеров"),
    "self_insight": ("Портфолио и рефлексия", "Карьерные гипотезы"),
    "balance_autonomy": ("Устойчивый ритм и границы", "Гибкий формат работы"),
}


def _direction_interest_key(interest: str) -> str:
    k = (interest or "").strip()
    k = _INTEREST_ALIASES.get(k, _INTEREST_ALIASES.get(k.lower(), k))
    return k if k in DIRECTION_POOLS else "default"


def _normalize_sphere_id(interest: str) -> str:
    """Привести веб-код или id сферы к каноническому sphere id."""
    k = (interest or "").strip()
    if not k:
        return ""
    aliased = _INTEREST_ALIASES.get(k) or _INTEREST_ALIASES.get(k.lower())
    if aliased:
        return aliased
    return k


def _it_track_scores_from_answers(answers: List[Dict[str, Any]]) -> Dict[str, float]:
    """Баллы IT-треков по техническим вопросам 1–10 (IT-опросник)."""
    scores: Dict[str, float] = {
        "backend": 0.0,
        "frontend": 0.0,
        "devops": 0.0,
        "data": 0.0,
        "qa": 0.0,
    }
    for a in answers:
        qid = int(a.get("question_id") or 0)
        if qid < 1 or qid > 10:
            continue
        w = 2.0 if qid <= 5 else 1.0
        letter = _answer_letter(a)
        if qid == 3 and letter == "B":
            scores["data"] += w * 1.4
            scores["frontend"] += w * 0.2
        elif letter == "A":
            if qid <= 2:
                scores["backend"] += w
            elif qid == 3:
                scores["backend"] += w * 0.55
                scores["data"] += w * 0.45
            elif qid in (4, 5):
                scores["backend"] += w * 0.72
                scores["data"] += w * 0.22
            else:
                scores["backend"] += w
        elif letter == "B":
            scores["frontend"] += w
            if qid in (4, 5, 9):
                scores["data"] += w * 0.35
        elif letter == "C":
            scores["backend"] += w * 0.15
            if qid in (2, 4, 5, 9):
                scores["data"] += w * 0.5
        elif letter == "D":
            scores["devops"] += w
            if qid in (1, 2):
                scores["qa"] += w * 0.4
    return scores


def _profile_hints_data_sphere(profile: Dict[str, Any]) -> bool:
    blob = _profile_blob(profile, {}).lower()
    if any(
        k in blob
        for k in (
            "аналит",
            "данн",
            " sql",
            "статистик",
            "дашборд",
            "метрик",
            "excel",
            "bi ",
            "tableau",
            "power bi",
        )
    ):
        return True
    from wibe_work.services.user_context import parse_interest_spheres

    spheres = parse_interest_spheres(profile)
    if "data" in spheres:
        if "it_dev" not in spheres:
            return True
        return spheres.index("data") < spheres.index("it_dev")
    return False


def infer_interest_from_test_answers(
    profile: Dict[str, Any],
    answers: List[Dict[str, Any]],
    stated_interest: str,
) -> str:
    """
    Сфера для разбора: выбранная пользователем сфера приоритетнее эвристик теста.
    IT-техблок может уточнить трек (backend/frontend) только внутри it_dev/data
    или при неопределённой сфере («other») — не уводит медицину/спорт в Backend.
    """
    base = _resolve_effective_interest(profile, stated_interest)
    base = _normalize_sphere_id(base) or base
    from wibe_work.services.user_context import parse_interest_spheres

    spheres = parse_interest_spheres(profile)
    primary_sphere = spheres[0] if spheres else ""
    primary_sphere = _normalize_sphere_id(primary_sphere) or primary_sphere

    _locked = frozenset(DIRECTION_POOLS.keys()) - frozenset({"other", "default"})

    # Явный выбор сферы в анкете / API важнее эвристик теста
    if primary_sphere in _locked:
        return primary_sphere
    if base in _locked:
        return base

    # «Другое» / пусто — общий пул операций, без угона в Backend по техблоку теста
    return base or "other"


def _resolve_effective_interest(profile: Dict[str, Any], interest: str) -> str:
    """Сфера для разбора: явная → main_sphere → первая из анкеты."""
    k = _normalize_sphere_id((interest or "").strip())
    if k in DIRECTION_POOLS:
        return k
    ms = _normalize_sphere_id(str(profile.get("main_sphere") or "").strip())
    if ms in DIRECTION_POOLS:
        return ms
    raw = profile.get("interest_spheres")
    if isinstance(raw, list):
        for item in raw:
            sid = _normalize_sphere_id(str(item).strip())
            if sid in DIRECTION_POOLS:
                return sid
            if sid:
                return sid
    elif isinstance(raw, str) and raw.strip():
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, list):
                for item in parsed:
                    sid = _normalize_sphere_id(str(item).strip())
                    if sid in DIRECTION_POOLS:
                        return sid
                    if sid:
                        return sid
        except (json.JSONDecodeError, TypeError):
            pass
        for part in raw.replace(";", ",").split(","):
            sid = _normalize_sphere_id(part.strip().strip('"').strip("'"))
            if sid in DIRECTION_POOLS:
                return sid
            if sid:
                return sid
    return k or "other"


_CORPORATE_MTS_MARKERS = (
    "закуп",
    "линейно-кабель",
    "кабельн",
    "транспортн",
    "недвижим",
    "юрист",
    "хозяйствен",
    "розничн",
    "административ",
    "сопровождени",
    "рабочих мест",
)


def _title_is_corporate_mts(title: str) -> bool:
    low = (title or "").lower()
    return any(m in low for m in _CORPORATE_MTS_MARKERS)


def _rows_look_like_corporate_mts(rows: List[Dict[str, Any]]) -> bool:
    if not rows:
        return False
    return any(_title_is_corporate_mts(str(r.get("role_name") or "")) for r in rows)


def _rows_match_it_direction_pool(rows: List[Dict[str, Any]]) -> bool:
    if not rows:
        return False
    combined = " ".join(str(r.get("role_name") or "") for r in rows).lower()
    it_kw = ("backend", "бэкенд", "frontend", "devops", "qa", "мобильн", "автотест", "sql")
    return any(k in combined for k in it_kw)


def _should_refresh_mts_matrix(
    profile: Dict[str, Any], interest: str, rows: List[Dict[str, Any]]
) -> bool:
    eff = _normalize_sphere_id(_resolve_effective_interest(profile, interest))
    dk = _direction_interest_key(eff)
    if dk not in _MTS_DIRECTION_INTERESTS and eff not in _MTS_DIRECTION_INTERESTS:
        return False
    if not rows:
        return True
    if _rows_look_like_corporate_mts(rows):
        return True
    if dk == "it_dev" and not _rows_match_it_direction_pool(rows):
        return True
    return False


def _answer_letter(ans: Dict[str, Any]) -> str:
    ch = ans.get("choice") or ans.get("choice_id")
    if isinstance(ch, int):
        return "ABCD"[max(0, min(3, int(ch)))]
    s = str(ch or "A").strip().upper()
    return s[0] if s and s[0] in "ABCD" else "A"


def infer_it_track_from_answers(answers: List[Dict[str, Any]]) -> Optional[str]:
    """По техническим вопросам IT (1–10): трек backend / frontend / data / devops / qa."""
    scores = _it_track_scores_from_answers(answers)
    best = max(scores.items(), key=lambda x: x[1])
    if best[1] < 1.0:
        return None
    if best[0] == "qa" and scores["devops"] >= scores["qa"]:
        return "devops"
    return str(best[0])


def inferred_it_profession(
    interest: str, answers: List[Dict[str, Any]], stack: Optional[List[str]] = None
) -> Optional[Dict[str, Any]]:
    if _direction_interest_key(interest) != "it_dev":
        return None
    track = infer_it_track_from_answers(answers)
    if not track:
        return None
    label = _IT_TRACK_LABELS.get(track, track)
    from wibe_work.services.hh_filter import hh_search_phrase_for_it_track

    return {
        "track_id": track,
        "label": label,
        "hh_search_phrase": hh_search_phrase_for_it_track(track, stack or []),
    }


def _answer_fingerprint(answers: List[Dict[str, Any]]) -> int:
    h = 0
    for a in sorted(answers, key=lambda x: int(x.get("question_id") or 0)):
        ch = a.get("choice") or a.get("choice_id") or "A"
        s = str(ch).upper()[:1]
        if s not in ("A", "B", "C", "D"):
            s = "A"
        qid = int(a.get("question_id") or 0)
        h = (h * 31 + qid * 17 + ord(s)) % (2**31 - 1)
    return int(h)


def _dominant_radar_key(axes: List[Dict[str, Any]]) -> str:
    if not axes:
        return "structure_mastery"
    best = max(axes, key=lambda a: int(a.get("value_percent") or 0))
    return str(best.get("key") or "structure_mastery")


def _score_direction_name(
    name: str,
    dom_axis: str,
    fp: int,
    idx: int,
    *,
    it_track: Optional[str] = None,
) -> int:
    n = name.lower()
    score = 44 + ((fp + idx * 17) % 23) + idx * 3
    if it_track:
        for kw in _IT_TRACK_PLAN_KEYWORDS.get(it_track, ()):
            if kw in n:
                score += 22
                break
    if dom_axis == "structure_mastery":
        score += sum(
            9
            for kw in (
                "данн",
                "sql",
                "python",
                "backend",
                "devops",
                "аналит",
                "систем",
                "контрол",
                "отчёт",
                "процесс",
                "метрик",
                "автотест",
                "релиз",
            )
            if kw in n
        )
    elif dom_axis == "people_service":
        score += sum(
            9
            for kw in (
                "клиент",
                "продаж",
                "поддерж",
                "hr",
                "команд",
                "коммуникац",
                "сервис",
                "презентац",
            )
            if kw in n
        )
    elif dom_axis == "self_insight":
        score += sum(
            9
            for kw in (
                "портфолио",
                "исслед",
                "гипотез",
                "рефлекс",
                "карьер",
                "само",
            )
            if kw in n
        )
    else:
        score += sum(
            8
            for kw in ("баланс", "гибк", "ритм", "удал", "жизн", "устойч")
            if kw in n
        )
    return score


def _pick_scenario_plans(
    interest: str,
    axes: List[Dict[str, Any]],
    fp: int,
    answers: Optional[List[Dict[str, Any]]] = None,
    *,
    it_track_override: Optional[str] = None,
    exclude_track_ids: Optional[Set[str]] = None,
) -> Dict[str, Any]:
    """Три плана A/B/C строго из пула выбранной сферы (без смежных «универсальных» треков)."""
    dk = _direction_interest_key(interest)
    excluded = set(exclude_track_ids or ())
    it_track: Optional[str] = it_track_override
    inferred: Optional[Dict[str, Any]] = None
    if dk == "it_dev" and answers and not it_track:
        from wibe_work.services.role_confirmation import rank_it_track_scores

        for tid, _sc in rank_it_track_scores(answers):
            if tid in excluded:
                continue
            it_track = tid
            inferred = {
                "track_id": tid,
                "label": _IT_TRACK_LABELS.get(tid, tid),
            }
            break
    elif dk == "it_dev" and answers and it_track:
        inferred = {
            "track_id": it_track,
            "label": _IT_TRACK_LABELS.get(it_track, it_track),
        }
    elif dk == "it_dev" and answers and not it_track:
        inferred = inferred_it_profession(interest, answers)
        if inferred and str(inferred.get("track_id") or "") not in excluded:
            it_track = str(inferred.get("track_id") or "")
        else:
            inferred = None
    pool = list(DIRECTION_POOLS.get(dk, DIRECTION_POOLS["default"]))
    # Смежные «портфолио / клиентский успех» только для неопределённой сферы —
    # иначе планы медицины/спорта уезжают в универсальные формулировки.
    if dk in ("other", "default"):
        dom = _dominant_radar_key(axes)
        pool = pool + list(ADJACENT_BY_AXIS.get(dom, ()))
    seen: Set[str] = set()
    uniq: List[str] = []
    for p in pool:
        if p not in seen:
            seen.add(p)
            uniq.append(p)
    from wibe_work.services.role_confirmation import track_from_direction_name

    scored: List[Tuple[float, str]] = []
    for i, n in enumerate(uniq):
        if excluded:
            tid = track_from_direction_name(n)
            if tid and tid in excluded:
                continue
        scored.append((n, _score_direction_name(n, _dominant_radar_key(axes), fp, i, it_track=it_track)))
    scored.sort(key=lambda x: -x[1])
    top = scored[:3]
    fallback = list(DIRECTION_POOLS.get(dk, DIRECTION_POOLS["default"]))
    while len(top) < 3:
        added = False
        for x in fallback:
            if excluded and track_from_direction_name(x) in excluded:
                continue
            if x not in {t[0] for t in top}:
                top.append((x, 52))
                added = True
                break
        if not added:
            break
    codes = ["A", "B", "C"]
    plans = []
    for idx, (name, raw) in enumerate(top[:3]):
        pid = codes[idx]
        match_score = max(47, min(97, raw + (fp % 5) - 2))
        plans.append({"id": pid, "name": f"План {pid}: {name}", "score_percent": match_score})
    best = max(plans, key=lambda p: p["score_percent"])
    out: Dict[str, Any] = {
        "plans": plans,
        "best_plan_id": best["id"],
        "best_plan_name": best["name"],
        "best_avg_percent": best["score_percent"],
        "caption": "согласованность профиля с треками развития (ответы теста + анкета)",
    }
    if inferred:
        out["inferred_profession"] = inferred
    return out


def _mts_tokens(text: str) -> Set[str]:
    return {
        t
        for t in re.split(r"[^\wёЁа-яА-Яa-zA-Z]+", text.lower())
        if len(t) > 2
    }


_SPHERE_INTEREST_TO_MTS_TAG: Dict[str, str] = {
    "it_dev": "IT",
    "IT": "IT",
    "data": "IT",
    "данные_и_AI": "IT",
    "design": "маркетинг",
    "дизайн": "маркетинг",
    "marketing": "маркетинг",
    "sales": "маркетинг",
    "engineering": "инженерия",
    "logistics": "инженерия",
    "finance": "бизнес",
    "mgmt": "бизнес",
    "hr_edu": "бизнес",
    "medicine": "бизнес",
    "education": "бизнес",
    "creative": "маркетинг",
    "sport": "бизнес",
    "other": "бизнес",
}

_MTS_DIRECTION_INTERESTS = frozenset({"it_dev", "data", "design"})


def _infer_mts_profession_tag(title: str) -> str:
    """Тег роли МТС для сопоставления с интересом (как на сайте)."""
    t = title.lower()
    if "аналитик" in t and "ai" in t:
        return "IT"
    if "сопровожден" in t and "рабоч" in t:
        return "IT"
    if "инженер" in t or "линейно-кабель" in t:
        return "инженерия"
    if "маркетинг" in t:
        return "маркетинг"
    if "продавец" in t or "рознич" in t:
        return "маркетинг"
    if "продаж" in t or "развития" in t:
        return "маркетинг"
    if "корпоратив" in t or "клиент" in t:
        return "бизнес"
    if "hr" in t:
        return "бизнес"
    if "юрист" in t:
        return "бизнес"
    if "закуп" in t:
        return "бизнес"
    if "недвижим" in t or ("эксплуатац" in t and "здан" in t):
        return "бизнес"
    if "транспорт" in t:
        return "инженерия"
    if "административн" in t or "хозяйствен" in t:
        return "бизнес"
    return "бизнес"


def _percent_rows_from_scored(
    scored: List[Tuple[float, str]], limit: int
) -> List[Dict[str, Any]]:
    scored.sort(key=lambda x: -x[0])
    top = scored[:limit]
    if not top:
        return []
    mx = top[0][0] if top[0][0] > 0 else 1.0
    rows: List[Dict[str, Any]] = []
    for rank, (sc, title) in enumerate(top):
        pct = int(round(40 + 55 * (sc / mx)))
        pct = max(38, min(97, pct))
        rows.append({"role_name": title, "percent": pct, "rank": rank})
    return rows


def _rank_career_direction_rows(
    interest: str,
    axes: List[Dict[str, Any]],
    fp: int,
    answers: List[Dict[str, Any]],
    limit: int = 6,
    *,
    it_track_override: Optional[str] = None,
    exclude_track_ids: Optional[Set[str]] = None,
) -> List[Dict[str, Any]]:
    """Роли из пула направлений сферы (backend, frontend и т.д.) — по тесту и радару."""
    dk = _direction_interest_key(interest)
    it_track: Optional[str] = it_track_override
    if dk == "it_dev" and not it_track:
        inf = inferred_it_profession(interest, answers)
        if inf:
            it_track = str(inf.get("track_id") or "")
    pool = list(DIRECTION_POOLS.get(dk, DIRECTION_POOLS["default"]))
    if dk == "it_dev" and it_track and it_track in _IT_TRACK_LABELS:
        lead = _IT_TRACK_LABELS[it_track]
        pool = [lead] + [p for p in pool if p != lead]
    dom = _dominant_radar_key(axes)
    if dk != "it_dev":
        for adj in ADJACENT_BY_AXIS.get(dom, ()):
            if adj not in pool:
                pool.append(adj)
    excluded = set(exclude_track_ids or ())
    from wibe_work.services.role_confirmation import track_from_direction_name

    scored: List[Tuple[float, str]] = []
    for i, n in enumerate(pool):
        if excluded:
            tid = track_from_direction_name(n)
            if tid and tid in excluded:
                continue
        sc = float(_score_direction_name(n, dom, fp, i, it_track=it_track))
        if dk == "it_dev" and it_track and i == 0 and n in _IT_TRACK_LABELS.values():
            sc += 12.0
        scored.append((sc, n))
    return _percent_rows_from_scored(scored, limit)


def refresh_mts_matrix_in_snapshot(
    snap: Dict[str, Any],
    profile: Dict[str, Any],
    profile_extra: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Пересчитать роли в сохранённом разборе (старые снимки с матрицей МТС)."""
    interest = str(snap.get("_analysis_interest") or "").strip()
    if not interest:
        interest = _resolve_effective_interest(profile, "")
    rows = list((snap.get("mts_matrix") or {}).get("rows") or [])
    if not _should_refresh_mts_matrix(profile, interest, rows):
        return snap
    answers = list(snap.get("_quiz_answers") or [])
    axes = list((snap.get("style_radar") or {}).get("axes") or [])
    it_track: Optional[str] = None
    inf = (snap.get("scenarios") or {}).get("inferred_profession") or snap.get(
        "inferred_profession"
    )
    if isinstance(inf, dict) and inf.get("track_id"):
        it_track = str(inf["track_id"])
    eff = _normalize_sphere_id(_resolve_effective_interest(profile, interest))
    extra = profile_extra if profile_extra is not None else {}
    dk = _direction_interest_key(eff)
    if dk in _MTS_DIRECTION_INTERESTS:
        new_rows = _rank_career_direction_rows(
            dk, axes, _answer_fingerprint(answers), answers, it_track_override=it_track
        )
    else:
        new_rows = _rank_mts_rows(profile, extra, eff, answers, axes)
    out = dict(snap)
    out["mts_matrix"] = {"rows": new_rows}
    if it_track and dk == "it_dev":
        label = _IT_TRACK_LABELS.get(it_track)
        if label:
            inf_out = dict(inf) if isinstance(inf, dict) else {}
            inf_out.setdefault("track_id", it_track)
            inf_out.setdefault("label", label)
            out["inferred_profession"] = inf_out
            sc = dict(out.get("scenarios") or {})
            sc["inferred_profession"] = inf_out
            out["scenarios"] = sc
    return out


def _rank_mts_rows(
    profile: Dict[str, Any],
    profile_extra: Dict[str, Any],
    interest: str,
    answers: List[Dict[str, Any]],
    axes: List[Dict[str, Any]],
    limit: int = 6,
) -> List[Dict[str, Any]]:
    dom = _dominant_radar_key(axes)
    fp = _answer_fingerprint(answers)
    eff = _normalize_sphere_id(_resolve_effective_interest(profile, interest)) or interest
    dk = _direction_interest_key(eff)

    # IT / data / design — только пул направлений сферы, не корпоративная матрица МТС
    if dk in _MTS_DIRECTION_INTERESTS or eff in _MTS_DIRECTION_INTERESTS:
        return _rank_career_direction_rows(
            dk if dk in _MTS_DIRECTION_INTERESTS else eff, axes, fp, answers, limit
        )

    roles = _load_mts_roles()
    if not roles:
        return _rank_career_direction_rows(eff, axes, fp, answers, limit) or [
            {"role_name": "Стажёр направления", "percent": 72, "rank": 0},
            {"role_name": "Младший специалист", "percent": 58, "rank": 1},
        ]

    blob_parts = [
        _profile_blob(profile, profile_extra),
        interest.lower(),
        str(profile.get("main_sphere") or ""),
        str(profile.get("like_to_do") or ""),
        str(profile.get("programming_skills") or ""),
        str(profile.get("achievements") or ""),
    ]
    user_blob = " ".join(blob_parts).lower()
    user_tokens = _mts_tokens(user_blob)
    user_tag = _SPHERE_INTEREST_TO_MTS_TAG.get(eff, _SPHERE_INTEREST_TO_MTS_TAG.get(dk, "бизнес"))

    scored: List[Tuple[float, str]] = []
    for role in roles:
        title = str(role.get("title") or "Роль")
        if _title_is_corporate_mts(title) and user_tag == "IT":
            continue
        req = " ".join(role.get("requirements") or [])
        duty = " ".join(role.get("duties") or [])
        combined = f"{title} {req} {duty}".lower()
        rt = _mts_tokens(combined)
        overlap = len(user_tokens & rt)
        tag = _infer_mts_profession_tag(title)
        if user_tag == "IT" and tag not in ("IT",):
            continue
        if user_tag != "бизнес" and tag != user_tag and not (
            interest == "design" and tag == "маркетинг"
        ):
            # Жёстко: только роли своей сферы
            if tag != user_tag:
                continue
        sc = 22.0 + min(36.0, overlap * 3.2)

        if tag == user_tag:
            sc += 38.0
        elif interest == "design" and tag == "маркетинг":
            sc += 14.0

        if dom == "structure_mastery":
            if tag in ("IT", "инженерия") or any(
                x in title.lower() for x in ("инженер", "данн", "аналит", "систем", "ai")
            ):
                sc += 12.0
        elif dom == "people_service":
            if any(x in title.lower() for x in ("продаж", "hr", "клиент", "рекрут", "развития")):
                sc += 14.0
        elif dom == "self_insight":
            sc += 5.0
        else:
            sc += 3.0

        if dk == "data" and any(x in combined for x in ("данн", "аналит", "отчёт", "метрик", "excel", "sql")):
            sc += 10.0

        sc += float((fp >> (len(scored) % 7)) % 5)
        scored.append((sc, title))

    rows = _percent_rows_from_scored(scored, limit)
    if not rows or (user_tag == "IT" and _rows_look_like_corporate_mts(rows)):
        return _rank_career_direction_rows(eff, axes, fp, answers, limit)
    return rows


def _behavioral_hint(question_timings_ms: Optional[List[int]]) -> Optional[str]:
    if not question_timings_ms:
        return None
    times = [t for t in question_timings_ms if isinstance(t, int) and t >= 0]
    if len(times) < 3:
        return None
    fast = sum(1 for ms in times if ms < 4000)
    slow = sum(1 for ms in times if ms > 25_000)
    parts: List[str] = []
    if fast >= max(3, len(times) // 4):
        parts.append("Часть ответов дана быстро — возможен импульсивный стиль или высокая уверенность в теме.")
    if slow >= 2:
        parts.append("Есть вдумчивые ответы — склонность к рефлексии; на собеседовании это можно подать как сильную сторону.")
    if not parts:
        parts.append("Темп ответов в целом сбалансирован.")
    return " ".join(parts)


def _clean_scenario_name(name: str) -> str:
    return re.sub(r"^План\s+[ABC]:\s*", "", (name or "").strip(), flags=re.IGNORECASE)


def _axis_plain_explanation(dom: str) -> str:
    return {
        "structure_mastery": "вам близки порядок, логика и разбор задач по шагам",
        "people_service": "важны люди, общение и ощущение пользы другим",
        "self_insight": "вы опираетесь на самопознание и понимание своих мотивов",
        "balance_autonomy": "для вас важны баланс жизни и свобода в решениях",
    }.get(dom, "по ответам виден свой стиль в задачах")


def _mock_ai_narrative(
    profile: Dict[str, Any],
    interest: str,
    preparation_level: str,
    scenarios: Dict[str, Any],
    axes: List[Dict[str, Any]],
    fp: int,
    *,
    readiness_percent: int = 0,
    gap: Optional[Dict[str, Any]] = None,
) -> str:
    """Человеческий портрет без LLM — без ярлыков планов A/B/C."""
    dom = _dominant_radar_key(axes)
    axis_human = _axis_plain_explanation(dom)
    spheres = _sphere_display_labels(profile)
    sphere = ", ".join(spheres[:3]) if spheres else (interest or "ваше направление")
    like = profile_text(profile.get("like_to_do"))
    city = profile_text(profile.get("city"))
    prep = _PREP_LABELS.get((preparation_level or "").strip(), "средний")

    plans = sorted(
        list(scenarios.get("plans") or []),
        key=lambda p: -(int(p.get("score_percent") or 0)),
    )
    best_name = _clean_scenario_name(str(plans[0].get("name") or "")) if plans else ""
    best_l = best_name.lower()

    intro = f"По анкете и тесту у вас сфера: {sphere}."
    if like:
        intro += f" Вы писали, что нравится: {like[:120]}."
    if city:
        intro += f" Город: {city}."
    intro += f" Сильнее других — сторона, где {axis_human}."
    inferred = scenarios.get("inferred_profession") or {}
    inferred_label = str(inferred.get("label") or "").strip()
    if inferred_label:
        intro += f" Сейчас ближе всего: {inferred_label}."
    elif best_name:
        intro += f" Сейчас ближе всего: {best_name}."

    mid = "Вам ближе задачи, где можно опираться на сильные стороны."
    if any(x in best_l for x in ("аналит", "данн", "бэкенд", "разработ", "программ", "it")):
        mid = "Вам ближе задачи с логикой, системами и разбором сложных вещей."
    elif any(x in best_l for x in ("дизайн", "креатив", "контент", "маркетинг")):
        mid = "Вам ближе задачи, где важны идея, форма и то, как это воспринимают люди."
    elif any(x in best_l for x in ("люд", "педагог", "hr", "сервис", "поддерж")):
        mid = "Вам ближе работа рядом с людьми: объяснять, договариваться, помогать."
    closing = list((gap or {}).get("closing_skills") or [])[:2]
    if closing:
        mid += f" Пока слабее выражено: {', '.join(closing)}."

    closings = (
        "Это портрет по текущим ответам, а не ярлык на всю жизнь.",
        f"В анкете подготовка «{prep}» — это про старт, а не про потолок.",
        "Если что-то не про вас — уточните анкету или пройдите ещё один тест.",
    )
    return " ".join((intro, mid, closings[fp % len(closings)]))


def _format_axes_for_llm(axes: List[Dict[str, Any]]) -> str:
    parts: List[str] = []
    for a in axes[:8]:
        lab = str(a.get("label") or a.get("key") or "?")
        pct = a.get("value_percent")
        if pct is not None:
            parts.append(f"{lab}: {pct}%")
    return "; ".join(parts) if parts else "—"


def _analysis_narrative_llm(
    profile_summary: str,
    scenarios: Dict[str, Any],
    *,
    axes: List[Dict[str, Any]],
    readiness_percent: int,
    answers_count: int,
    analysis_mode: str = "career",
    education_grade: str = "university",
    profile: Optional[Dict[str, Any]] = None,
    interest: str = "",
) -> Tuple[str, str, Optional[str]]:
    """(текст, источник llm|mock, notice)."""
    plans = scenarios.get("plans") or []
    plan_line = ", ".join(
        f"{p.get('id')}={p.get('name', '')} (~{p.get('score_percent', '?')}%)"
        for p in plans[:3]
    )
    axes_line = _format_axes_for_llm(axes)
    min_full = 15 if analysis_mode != "school" else 12
    short_quiz = answers_count < min_full
    caveat = ""
    if short_quiz:
        caveat = (
            f"Опрос неполный: только {answers_count} ответов. "
            "Не утверждай высокую точность профиля; используй формулировки «по текущим данным», «предварительно»."
        )
    prompt = build_analysis_user_prompt(
        profile_summary=profile_summary,
        readiness_percent=readiness_percent,
        axes_line=axes_line,
        plan_line=plan_line,
        answers_count=answers_count,
        short_quiz_caveat=caveat,
        analysis_mode=analysis_mode,
        education_grade=education_grade,
    )
    system = narrative_system_for_grade(
        analysis_mode,
        education_grade,
        profile if isinstance(profile, dict) else None,
        interest=interest or "",
    )
    if analysis_mode in ("school", "vocational"):
        return "", "mock", "mode_skip"
    if not llm_configured():
        return "", "mock", None
    got_lock = _ANALYSIS_LLM_LOCK.acquire(blocking=False)
    if not got_lock:
        return "", "mock", "busy"
    try:
        text, notice = fetch_llm_completion(
            prompt,
            max_tokens=1200,
            temperature=0.2,
            system_prompt=system,
            timeout=_ANALYSIS_LLM_TIMEOUT,
        )
    finally:
        _ANALYSIS_LLM_LOCK.release()
    if text:
        polished = polish_analysis_narrative(text)
        if narrative_conflicts_with_profile(
            polished, profile if isinstance(profile, dict) else None
        ):
            return "", "mock", "narrative_sphere_mismatch"
        return polished, "llm", None
    return "", "mock", notice


def _profile_summary_rich(
    profile: Dict[str, Any],
    profile_extra: Dict[str, Any],
    interest: str,
    education: str,
    preparation_level: str,
) -> str:
    """Текст для LLM и чата: анкета по уровню образования + параметры теста."""
    return build_profile_summary_for_analysis(
        profile,
        interest,
        preparation_level,
        profile_extra=profile_extra,
    )


def _resolve_profession_pack(interest: str) -> Any:
    try:
        import sys

        repo = Path(__file__).resolve().parents[4]
        website = repo / "website"
        if website.is_dir() and str(website) not in sys.path:
            sys.path.insert(0, str(website))
        from app.api_schemas import Interest, _INTEREST_ALIASES as _WEB_ALIASES
        from app.profession_packs import resolve_profession_pack

        raw = (interest or "").strip()
        key = _SPHERE_TO_WEBSITE_INTEREST.get(raw)
        if key:
            return resolve_profession_pack(Interest(key))
        # уже веб-код Interest или алиас (IT / медицина / общий)
        aliased = _WEB_ALIASES.get(raw) or _WEB_ALIASES.get(raw.lower())
        if aliased is not None:
            return resolve_profession_pack(aliased)
        try:
            return resolve_profession_pack(Interest(raw))
        except Exception:
            return resolve_profession_pack(Interest.BUSINESS)
    except Exception:
        return None


def _skill_scores(
    profile: Dict[str, Any],
    axes: List[Dict[str, Any]],
    fp: int,
    interest: str,
) -> Dict[str, int]:
    scores = {
        k: 40 + (fp >> (i * 5)) % 14 for i, k in enumerate(_SKILL_ORDER)
    }
    dom = _dominant_radar_key(axes)
    if dom == "structure_mastery":
        scores["programming"] += 12
        scores["analytics"] += 14
    elif dom == "people_service":
        scores["communication"] += 14
        scores["management"] += 10
    elif dom == "self_insight":
        scores["analytics"] += 8
        scores["communication"] += 6
    else:
        scores["management"] += 8

    blob = (profile_skill_blob(profile) or "").lower()
    if any(x in blob for x in ("python", "java", "javascript", "sql", "git", "c++")):
        scores["programming"] = min(94, scores["programming"] + 12)
    if any(x in blob for x in ("excel", "аналит", "data", "bi", "tableau")):
        scores["analytics"] = min(94, scores["analytics"] + 10)
    if any(x in blob for x in ("figma", "дизайн", "photoshop", "ui", "ux")):
        scores["design"] = min(94, scores["design"] + 12)
    if interest in ("sales", "hr_edu", "mgmt", "education"):
        scores["communication"] = min(94, scores["communication"] + 8)

    for k in _SKILL_ORDER:
        scores[k] = max(36, min(94, scores[k]))
    return scores


def _target_for_track(track_name: str) -> Dict[str, int]:
    t = (track_name or "").lower()
    targets = {k: 70 for k in _SKILL_ORDER}
    if any(x in t for x in ("python", "java", "backend", "devops", "sql", "данн")):
        targets["programming"] = 82
        targets["analytics"] = 78
    elif any(x in t for x in ("дизайн", "ux", "ui", "график")):
        targets["design"] = 85
        targets["communication"] = 72
    elif any(x in t for x in ("продаж", "hr", "клиент", "рекрут")):
        targets["communication"] = 84
        targets["management"] = 76
    elif any(x in t for x in ("маркет", "контент", "smm")):
        targets["communication"] = 78
        targets["analytics"] = 75
    return targets


def _build_gap_analysis(
    profile: Dict[str, Any],
    interest: str,
    top_track: str,
    axes: List[Dict[str, Any]],
    fp: int,
) -> Dict[str, Any]:
    pack = _resolve_profession_pack(interest)
    user = _skill_scores(profile, axes, fp, interest)
    target = _target_for_track(top_track)
    labels = (
        dict(pack.gap_bar_labels)
        if pack
        else {
            _SKILL_TO_PACK_KEY[k]: k.replace("_", " ").title()
            for k in _SKILL_ORDER
        }
    )
    headline = pack.gap_headline if pack else "Навыки: где вы уже близко к цели, а где разрыв"
    bars: List[Dict[str, Any]] = []
    closeness: List[int] = []
    for sk in _SKILL_ORDER:
        pack_key = _SKILL_TO_PACK_KEY[sk]
        u = user[sk]
        tg = target.get(sk, 70)
        gap = max(0, tg - u)
        closeness.append(100 - min(100, gap))
        bars.append(
            {
                "label": labels.get(pack_key, sk),
                "user_percent": u,
                "target_percent": min(100, tg),
                "gap_percent": min(100, gap),
            }
        )
    overall = sum(closeness) // max(1, len(closeness))
    weak = sorted(
        ((b["label"], b["gap_percent"]) for b in bars if b["gap_percent"] > 15),
        key=lambda x: -x[1],
    )
    closing = [w[0] for w in weak[:3]]
    if not closing:
        closing = ["Портфолио или учебный кейс", "Обратная связь наставника", "Регулярные отклики"]
    return {
        "headline": headline,
        "overall_hp": overall,
        "bars": bars,
        "closing_skills": closing,
    }


def _sphere_display_labels(profile: Dict[str, Any]) -> List[str]:
    ids = parse_interest_spheres(profile)
    if not ids and (profile.get("main_sphere") or "").strip():
        ids = [str(profile.get("main_sphere")).strip()]
    return [_SPHERE_LABELS.get(s, s) for s in ids if s]


def _profile_skill_hints(profile: Dict[str, Any], limit: int = 4) -> List[str]:
    hints: List[str] = []
    for key in (
        "like_to_do",
        "programming_skills",
        "software_skills",
        "experience_projects",
        "extra_education",
    ):
        raw = profile_text(profile.get(key))
        if not raw:
            continue
        chunk = raw.replace("\n", ", ")[:140]
        if chunk and chunk not in hints:
            hints.append(chunk)
        if len(hints) >= limit:
            break
    return hints


def _pain_context(
    profile: Dict[str, Any],
    *,
    gap: Optional[Dict[str, Any]],
    scenarios: Optional[Dict[str, Any]],
    axes: Optional[List[Dict[str, Any]]],
    readiness_percent: Optional[int],
    top_track: str,
) -> Dict[str, Any]:
    sc = scenarios or {}
    g = gap or {}
    plans = sc.get("plans") or []
    best_name = str(sc.get("best_plan_name") or (plans[0].get("name") if plans else "") or "")
    best_pct = sc.get("best_avg_percent")
    closing = list(g.get("closing_skills") or [])[:3]
    weak_axes: List[str] = []
    strong_axes: List[str] = []
    for a in axes or []:
        lbl = str(a.get("label") or "")
        pct = int(a.get("value_percent") or 0)
        if pct >= 58 and lbl:
            strong_axes.append(f"{lbl} ({pct}%)")
        elif pct < 50 and lbl:
            weak_axes.append(lbl)
    wf_raw = (
        profile.get("work_format_preference")
        or profile.get("work_format_pref")
        or ""
    )
    wf = str(wf_raw).strip()
    pr = profile_text(profile.get("career_priority")).lower()
    return {
        "city": profile_text(profile.get("city")),
        "like": profile_text(profile.get("like_to_do")),
        "dislike": profile_text(profile.get("dislike_to_do")),
        "edu": (
            profile.get("education_detail") or profile.get("education_level") or ""
        ).strip(),
        "course": profile_text(profile.get("course_grade") or profile.get("course_or_grade")),
        "spheres": _sphere_display_labels(profile),
        "prep": _PREP_LABELS.get(
            profile_text(profile.get("preparation_level")), "средний"
        ),
        "work_format": _WORK_FORMAT_RU.get(wf, wf) if wf else "",
        "priority": _PRIORITY_RU.get(pr, pr) if pr else "",
        "salary": profile.get("target_salary"),
        "skill_hints": _profile_skill_hints(profile),
        "readiness": readiness_percent,
        "top_track": (top_track or "").strip(),
        "best_plan": best_name,
        "best_pct": best_pct,
        "closing": closing,
        "gap_hp": g.get("overall_hp"),
        "weak_axes": weak_axes[:2],
        "strong_axes": strong_axes[:2],
    }


def _join_natural(parts: List[str]) -> str:
    clean = [p.strip() for p in parts if p and str(p).strip()]
    if not clean:
        return ""
    if len(clean) == 1:
        return clean[0]
    return clean[0] + " " + " ".join(clean[1:])


def _pain_summary_for(pain_id: str, ctx: Dict[str, Any]) -> str:
    label = _PAIN_LABELS.get(pain_id, "")
    lead = f"В анкете главная сложность — «{label}»."
    bits: List[str] = [lead]

    if ctx["spheres"]:
        bits.append(f"Сферы, которые вы выбрали: {', '.join(ctx['spheres'][:4])}.")
    if ctx["city"]:
        loc = ctx["city"]
        if ctx["work_format"]:
            loc += f", формат работы — {ctx['work_format']}"
        bits.append(f"Локация и условия: {loc}.")
    if ctx["like"]:
        bits.append(f"Вам нравится: {ctx['like'][:160]}.")
    if ctx["readiness"] is not None:
        bits.append(f"По тесту индекс готовности — {ctx['readiness']}%.")
    if ctx["best_plan"] and ctx["best_pct"] is not None:
        bits.append(
            f"Ближе всего сценарий «{ctx['best_plan']}» (~{ctx['best_pct']}%)."
        )
    if ctx["closing"]:
        bits.append(f"Из разрыва навыков в приоритете: {', '.join(ctx['closing'][:2])}.")

    tail = {
        "pain_career": (
            "Это не приговор: опирайтесь на сценарии A/B/C ниже и проверьте одно направление "
            "маленьким делом, а не бесконечным «выбором профессии»."
        ),
        "pain_no_exp": (
            "Опыта в резюме может не быть — но в анкете уже есть зацепки для первого кейса "
            "(учёба, проекты, подработки)."
        ),
        "pain_region": (
            "Вакансий в городе может быть меньше — зато в профиле можно целиться в удалёнку "
            "и смотреть соседние города."
        ),
        "pain_money_courses": (
            "Платные курсы не обязательны: в разделе «Обучение» есть бесплатные треки под вашу сферу."
        ),
        "pain_interview": (
            "Страх собеседований часто сильнее реальных требований — тренируйте ответы по своей сфере, "
            "а не «вообще про работу»."
        ),
        "pain_overload": (
            "Информации много — поэтому ниже план по неделям и этапы роста; берите один шаг, не всё сразу."
        ),
        "pain_low_confidence": (
            "Ощущение «ничего не умею» расходится с данными анкеты и теста: навыки есть, "
            "их нужно назвать вслух и оформить, а не сравнивать себя с чужим идеалом."
        ),
        "pain_gap_skills": (
            "Скорее всего, не «вас не берут», а не совпадает подача с требованиями вакансий — "
            "это видно по разрыву навыков и сценариям плана."
        ),
    }
    bits.append(tail.get(pain_id, ""))
    return _join_natural(bits)


def _pain_tips_for(pain_id: str, ctx: Dict[str, Any]) -> List[str]:
    tips: List[str] = []
    skills = ctx["skill_hints"]
    closing = ctx["closing"]
    like = ctx["like"]
    city = ctx["city"]
    wf = ctx["work_format"]

    if pain_id == "pain_low_confidence":
        if skills:
            tips.append(
                f"Выпишите 5 конкретных дел из вашей жизни по мотивам «{skills[0][:80]}» — "
                "срок, что сделали, кому помогли. Это и есть навыки для резюме."
            )
        elif like:
            tips.append(
                f"Составьте список из 5 задач, связанных с «{like[:80]}», где вы уже что-то умеете — "
                "без сравнения с senior-специалистами."
            )
        if ctx["strong_axes"]:
            tips.append(
                f"Опирайтесь на сильные стороны по тесту: {', '.join(ctx['strong_axes'])}."
            )
        if closing:
            tips.append(
                f"На этой неделе — один маленький шаг по «{closing[0]}», не «стать идеалом за месяц»."
            )
    elif pain_id == "pain_no_exp":
        proj = (skills[2] if len(skills) > 2 else skills[0] if skills else like)
        if proj:
            tips.append(
                f"Оформите один кейс из анкеты ({proj[:90]}): задача → ваши действия → результат в цифрах."
            )
        if ctx["best_plan"]:
            tips.append(
                f"В откликах укажите цель «{ctx['best_plan'][:60]}» и 2–3 навыка из раздела «Разрыв навыков»."
            )
        if wf or city:
            tips.append(
                f"В «Вакансиях» включите фильтр: {wf or 'удобный формат'}"
                + (f", город {city}" if city else "")
                + ", уровень «без опыта» / стажировка."
            )
    elif pain_id == "pain_career":
        if ctx["best_plan"]:
            tips.append(
                f"Выберите для проверки сценарий «{ctx['best_plan'][:70]}» — "
                "2 недели мини-проекта или стажировки, потом сравните ощущения."
            )
        if ctx["spheres"]:
            tips.append(
                f"Сузьте выбор до 2 сфер: {', '.join(ctx['spheres'][:2])} — остальное в «потом»."
            )
        tips.append("Запишите, что из «нравится» и «не нравится» в анкете важнее денег vs обучения — это ваш фильтр.")
    elif pain_id == "pain_region":
        if wf:
            tips.append(f"Ищите вакансии с форматом «{wf}» — вы сами так указали в анкете.")
        if city:
            tips.append(
                f"Добавьте 2–3 города рядом с {city} или удалённые позиции по сфере "
                f"{', '.join(ctx['spheres'][:2]) or 'из анкеты'}."
            )
    elif pain_id == "pain_money_courses":
        track = ctx["top_track"] or (ctx["spheres"][0] if ctx["spheres"] else "ваше направление")
        tips.append(
            f"В «Обучение» откройте бесплатный трек под {track} — одна неделя, один артефакт (конспект или мини-проект)."
        )
        if closing:
            tips.append(f"Параллельно закройте один пункт разрыва: {closing[0]}.")
    elif pain_id == "pain_interview":
        sphere = ", ".join(ctx["spheres"][:2]) or ctx["top_track"] or "вашей сфере"
        tips.append(
            f"Три ответа вслух (по 2 мин) на типовые вопросы по {sphere} — опирайтесь на «{like[:60]}»"
            if like
            else f"Три ответа вслух (по 2 мин) на типовые вопросы по {sphere}."
        )
        if ctx["weak_axes"]:
            tips.append(
                f"Подготовьте пример по слабой оси теста: {ctx['weak_axes'][0]} — один кейс из учёбы или хобби."
            )
    elif pain_id == "pain_overload":
        tips.append("На эту неделю — только первый пункт из «Этапов роста» ниже; остальное в заметку «потом».")
        if closing:
            tips.append(f"Из разрыва навыков — один фокус: {closing[0]}.")
    elif pain_id == "pain_gap_skills":
        if closing:
            tips.append(
                f"Откройте одну вакансию мечты и сравните с разрывом: начните с «{closing[0]}» на 3–4 недели."
            )
        if ctx["best_pct"] is not None:
            tips.append(
                f"Сценарий плана уже ~{ctx['best_pct']}% — упакуйте это в резюме и сопроводительное, а не добавляйте новые курсы."
            )
        if skills:
            tips.append(f"В резюме явно перечислите: {skills[0][:100]}.")

    if not tips:
        tips.append(_PAIN_LABELS.get(pain_id, "Сделайте один шаг из плана ниже на этой неделе."))
    if ctx["priority"] and len(tips) < 3:
        tips.append(f"Учитывайте приоритет из анкеты — сейчас для вас важнее: {ctx['priority']}.")
    return [t for t in tips if t][:3]


def _pain_focus(
    profile: Dict[str, Any],
    *,
    gap: Optional[Dict[str, Any]] = None,
    scenarios: Optional[Dict[str, Any]] = None,
    axes: Optional[List[Dict[str, Any]]] = None,
    readiness_percent: Optional[int] = None,
    top_track: str = "",
) -> Optional[Dict[str, Any]]:
    pain_id = profile_text(profile.get("primary_pain"))
    if pain_id and pain_id in _PAIN_LABELS:
        ctx = _pain_context(
            profile,
            gap=gap,
            scenarios=scenarios,
            axes=axes,
            readiness_percent=readiness_percent,
            top_track=top_track,
        )
        return {
            "pain_id": pain_id,
            "label": _PAIN_LABELS[pain_id],
            "summary": _pain_summary_for(pain_id, ctx),
            "tips": _pain_tips_for(pain_id, ctx),
        }
    aligned = align_pains(profile)
    matched = aligned.get("matched_pains") or []
    if not matched:
        return None
    m = matched[0]
    inferred = {
        "Я не знаю, кем стать": "pain_career",
        "У меня нет опыта, меня никуда не возьмут": "pain_no_exp",
        "Я из маленького города": "pain_region",
        "У меня нет денег на курсы": "pain_money_courses",
        "Я боюсь собеседований": "pain_interview",
        "Слишком много информации, не знаю с чего начать": "pain_overload",
        "Я ничего не умею": "pain_low_confidence",
        "Всё умею, но работу не дают": "pain_gap_skills",
    }.get(str(m.get("pain") or ""))
    if inferred:
        ctx = _pain_context(
            profile,
            gap=gap,
            scenarios=scenarios,
            axes=axes,
            readiness_percent=readiness_percent,
            top_track=top_track,
        )
        return {
            "pain_id": inferred,
            "label": _PAIN_LABELS[inferred],
            "summary": _pain_summary_for(inferred, ctx),
            "tips": _pain_tips_for(inferred, ctx),
        }
    return {
        "pain_id": None,
        "label": str(m.get("pain") or ""),
        "summary": (
            "По тексту анкеты мы видим эту сложность — ниже шаги с опорой на ваши ответы и разбор теста."
        ),
        "tips": _pain_tips_for("pain_overload", _pain_context(
            profile,
            gap=gap,
            scenarios=scenarios,
            axes=axes,
            readiness_percent=readiness_percent,
            top_track=top_track,
        )),
    }


def _week_mini_plan(
    week_range: str,
    learn: str,
    practice: str,
    outcome: str,
) -> Dict[str, str]:
    """Мини-план на блок недель: изучи → потренируй → в итоге."""
    return {
        "week_range": week_range,
        "learn": learn,
        "practice": practice,
        "outcome": outcome,
    }


def _weekly_roadmap(
    top_track: str,
    interest: str,
    *,
    preparation: str = "medium",
) -> List[Dict[str, Any]]:
    pack = _resolve_profession_pack(interest)
    pk = pack.key if pack else "tech"
    low = (top_track or "").lower()
    direction = (top_track or "").strip() or "ваше направление"
    prep = preparation if preparation in ("weak", "medium", "strong") else "medium"

    if pk == "tech" and any(x in low for x in ("python", "java", "данн", "sql", "backend", "devops", "frontend")):
        if prep == "weak":
            return [
                _week_mini_plan(
                    "Недели 1–2",
                    learn="Поставьте рабочее окружение: редактор, Git, первый репозиторий — без этого дальше будет путаница.",
                    practice="Пройдите вводный модуль по языку или SQL: 5–7 коротких задач, по 20–30 минут в день.",
                    outcome="Поймёте, как устроен обычный день разработчика, и перестанете бояться «сломать» проект.",
                ),
                _week_mini_plan(
                    "Недели 3–4",
                    learn="Соберите самый простой мини-проект по теме «"
                    + direction
                    + "» — главное, чтобы он был доведён до конца.",
                    practice="Напишите черновик резюме: три пункта «что сделал» под вакансии, которые смотрели в начале.",
                    outcome="Появится один кейс для портфолио и понятная история для первого отклика.",
                ),
            ]
        if prep == "strong":
            return [
                _week_mini_plan(
                    "Недели 1–2",
                    learn="Сверьте 5 вакансий по «" + direction + "» и выпишите, какие навыки повторяются чаще всего.",
                    practice="Сделайте pet-проект или доработайте учебный — с фокусом на один навык из разрыва.",
                    outcome="Резюме и портфолио будут бить в реальный спрос, а не в абстрактное «я учусь».",
                ),
                _week_mini_plan(
                    "Недели 3–4",
                    learn="Оформите проект: README, скрин или демо — чтобы рекрутеру было что открыть за 30 секунд.",
                    practice="Отправьте 3–5 точечных откликов с коротким сопроводительным под конкретную вакансию.",
                    outcome="Начнёте получать обратную связь с рынка и поймёте, что докрутить дальше.",
                ),
            ]
        return [
            _week_mini_plan(
                "Недели 1–2",
                learn="Разберитесь с Git и окружением: коммиты, ветки, запуск проекта локально.",
                practice="Закрепите основы языка или SQL — 5–10 задач, без марафона на десятки часов.",
                outcome="Будет привычный рабочий ритм: учиться → сразу применять → фиксировать результат.",
            ),
            _week_mini_plan(
                "Недели 3–4",
                learn="Соберите мини-проект по «" + direction + "» — пусть простой, но законченный.",
                practice="Обновите резюме и напишите сопроводительное под одну реальную вакансию.",
                outcome="Сможете откликнуться с примером работы, а не только с желанием «войти в IT».",
            ),
        ]

    if pk == "design" or "дизайн" in low or "ux" in low:
        return [
            _week_mini_plan(
                "Недели 1–2",
                learn="Освойте Figma на уровне auto-layout и компонентов — это база для любого UI.",
                practice="Сделайте редизайн одного экрана приложения или сайта, который вам нравится.",
                outcome="Появится первая работа, которую не стыдно положить в портфолио.",
            ),
            _week_mini_plan(
                "Недели 3–4",
                learn="Опишите мини-кейс: задача → что сделали → чем помогло пользователю (хотя бы в учебной форме).",
                practice="Соберите 2–3 работы в одном файле или на Behance/Dribbble с коротким контекстом.",
                outcome="Портфолио начнёт отвечать на вопрос «а что вы умеете на практике?», а не только «смотрите картинки».",
            ),
        ]

    if pk == "marketing":
        return [
            _week_mini_plan(
                "Недели 1–2",
                learn="Разберитесь, как устроена воронка и какие метрики смотрят в «" + direction + "».",
                practice="Сделайте один учебный креатив или пост — с гипотезой «кому и зачем это».",
                outcome="Поймёте язык маркетинга на примере, а не по сухой теории.",
            ),
            _week_mini_plan(
                "Недели 3–4",
                learn="Соберите мини-отчёт: что запускали, какие цифры (пусть учебные), что бы улучшили.",
                practice="Подготовьте 3–5 откликов или стажировок с кейсом в сопроводительном.",
                outcome="В резюме появится история с цифрами — это сильно отличает от «просто интересуюсь SMM».",
            ),
        ]

    if pk == "sales":
        return [
            _week_mini_plan(
                "Недели 1–2",
                learn="Изучите продукт сферы и типовые возражения — 5–10 реальных диалогов из интервью или кейсов.",
                practice="Отработайте 10–15 учебных звонков или переписок по скрипту, вслух или с другом.",
                outcome="Снизится страх «что сказать клиенту» и появится базовая уверенность в разговоре.",
            ),
            _week_mini_plan(
                "Недели 3–4",
                learn="Разберите один продукт, который хотите продавать: кому, какая выгода, чем отличается.",
                practice="Сделайте 5 целевых откликов или питчей — с одной конкретной компанией в фокусе.",
                outcome="Сможете показать работодателю, что понимаете продукт, а не только «умею звонить».",
            ),
        ]

    if pk in ("office_finance", "hr", "legal"):
        return [
            _week_mini_plan(
                "Недели 1–2",
                learn="Разберите типовые регламенты и шаблоны в «" + direction + "» — что делают каждый день.",
                practice="Пройдите учебный кейс в таблицах или документе: сверка, заявка, карточка кандидата.",
                outcome="Поймёте ритм работы и перестанете воспринимать сферу как набор непонятных аббревиатур.",
            ),
            _week_mini_plan(
                "Недели 3–4",
                learn="Оформите один законченный кейс с выводом: что проверили, что нашли, что предложили.",
                practice="Обновите резюме под 3 вакансии и попросите обратную связь у знакомого из сферы.",
                outcome="Будет готовый пример для собеседования: «вот задача — вот как я её решал».",
            ),
        ]

    # Универсальный мини-план (по умолчанию)
    if prep == "weak":
        learn_12 = (
            "Откройте 5 вакансий по «" + direction + "» и выпишите: что от вас просят чаще всего."
        )
        practice_12 = (
            "Выберите один бесплатный вводный курс или урок — 20–30 минут в день, без перегруза."
        )
    else:
        learn_12 = (
            "Посмотрите рынок: 5 вакансий-ориентиров по «" + direction + "» и список повторяющихся навыков."
        )
        practice_12 = (
            "Освойте один главный инструмент сферы на учебной задаче — 2–3 часа в неделю для старта хватит."
        )
    return [
        _week_mini_plan(
            "Недели 1–2",
            learn=learn_12,
            practice=practice_12,
            outcome="Станет ясно, куда целиться, и вы перестанете учить всё подряд без связи с работой.",
        ),
        _week_mini_plan(
            "Недели 3–4",
            learn="Сделайте учебный кейс или мини-проект — то, что можно описать в резюме одним абзацом.",
            practice="Соберите резюме и короткое сопроводительное под одну реальную вакансию из первых двух недель.",
            outcome="Сможете откликнуться не «в пустоту», а с примером и понятной историей о себе.",
        ),
    ]


def _learning_cards(interest: str, preparation: str) -> List[Dict[str, Any]]:
    sid = _normalize_sphere_id(interest) or (interest or "").strip()
    base: Dict[str, List[Dict[str, Any]]] = {
        "it_dev": [
            {
                "title": "Основы Python",
                "url": "https://stepik.org",
                "kind": "курс",
                "description": "Синтаксис, типы, циклы и простые задачи — база для кода, автоматизации и аналитики.",
            },
            {
                "title": "Git для начинающих",
                "url": "https://learngitbranching.js.org/?locale=ru",
                "kind": "симулятор",
                "description": "Ветки, merge и rebase наглядно: без установки, в игровой форме.",
            },
        ],
        "data": [
            {
                "title": "SQL интерактив",
                "url": "https://sql-academy.org",
                "kind": "практика",
                "description": "Пишите запросы в браузере, с подсказками — удобно с нуля и для отборов в данных.",
            },
            {
                "title": "Kaggle Learn",
                "url": "https://www.kaggle.com/learn",
                "kind": "курс",
                "description": "Короткие треки по Python, SQL и ML; часть материалов на английском.",
            },
        ],
        "design": [
            {
                "title": "Figma Learn",
                "url": "https://help.figma.com",
                "kind": "документация",
                "description": "Официальные разделы про компоненты, автолейаут и прототипирование.",
            },
            {
                "title": "UX-тренажёр",
                "url": "https://lawsofux.com",
                "kind": "гайд",
                "description": "Короткие принципы UX карточками — подходит для насмотренности и языка интерфейсов.",
            },
        ],
        "marketing": [
            {
                "title": "Маркетинг: основы воронки",
                "url": "https://www.skillfactory.ru/blog",
                "kind": "ориентир",
                "description": "Каналы, метрики и гипотезы — язык performance и контента.",
            },
        ],
        "sales": [
            {
                "title": "Переговоры и воронка продаж",
                "url": "https://www.hh.ru",
                "kind": "ориентир",
                "description": "Ищите стажировки и первые роли в продажах / аккаунтинге по вашей сфере.",
            },
        ],
        "engineering": [
            {
                "title": "Практика и нормы по специальности",
                "url": "https://www.hh.ru",
                "kind": "ориентир",
                "description": "Стажировки на производстве и в проектных бюро — главный вход в инженерию.",
            },
        ],
        "medicine": [
            {
                "title": "Клиническая практика и допуски",
                "url": "https://www.hh.ru",
                "kind": "ориентир",
                "description": "Смотрите стажировки младшего медперсонала / лаборантов — без ухода в IT-стек.",
            },
        ],
        "education": [
            {
                "title": "Педагогическая практика",
                "url": "https://www.hh.ru",
                "kind": "ориентир",
                "description": "Ищите роли помощника педагога / воспитателя и методические курсы по профилю.",
            },
        ],
        "sport": [
            {
                "title": "Инструктаж и практика на секции",
                "url": "https://www.hh.ru",
                "kind": "ориентир",
                "description": "Стажировки инструктора / помощника тренера — основной вход в спорт и фитнес.",
            },
        ],
        "finance": [
            {
                "title": "Excel и учёт для старта",
                "url": "https://www.hh.ru",
                "kind": "ориентир",
                "description": "Стажировки помощника бухгалтера / финансиста и учебные кейсы закрытия месяца.",
            },
        ],
        "hr_edu": [
            {
                "title": "Рекрутмент и адаптация",
                "url": "https://www.hh.ru",
                "kind": "ориентир",
                "description": "Ищите стажировки в HR и учебные разборы резюме / интервью.",
            },
        ],
        "logistics": [
            {
                "title": "Склад и поставки",
                "url": "https://www.hh.ru",
                "kind": "ориентир",
                "description": "Стажировки логиста / диспетчера и практика учёта поставок.",
            },
        ],
        "mgmt": [
            {
                "title": "Координация проектов",
                "url": "https://www.hh.ru",
                "kind": "ориентир",
                "description": "Роли ассистента менеджера и мини-проекты от начала до конца.",
            },
        ],
        "creative": [
            {
                "title": "Портфолио и медиапрактика",
                "url": "https://www.hh.ru",
                "kind": "ориентир",
                "description": "Учебные заказы, выставки и демо-работы по творческому направлению.",
            },
        ],
        "other": [
            {
                "title": "Практика по вашей сфере",
                "url": "https://www.hh.ru",
                "kind": "ориентир",
                "description": "Смотрите стажировки и первые роли по специальности — без ухода в чужой стек.",
            },
        ],
        "default": [
            {
                "title": "Практика по вашей сфере",
                "url": "https://www.hh.ru",
                "kind": "ориентир",
                "description": "Смотрите стажировки и первые роли по специальности — без ухода в чужой стек.",
            },
        ],
    }
    cards = list(base.get(sid) or base.get("default") or [])
    if preparation == "weak":
        cards.insert(
            0,
            {
                "title": "Ориентиры по ценностям в работе",
                "url": "https://www.mindtools.com/pages/article/career-anchors.htm",
                "kind": "статья",
                "description": "Что для вас опора в работе — экспертиза, люди, стабильность, вызов; помогает сузить направление.",
            },
        )
    return cards


def _advice_blocks(
    scenarios: Dict[str, Any],
    preparation: str,
    profile: Dict[str, Any],
    gap: Dict[str, Any],
) -> Dict[str, Any]:
    plans = scenarios.get("plans") or []
    closing = gap.get("closing_skills") or []
    priority = closing[:3] if closing else ["самопознание", "карьерные ценности", "резюме и отклики"]
    pain_id = profile_text(profile.get("primary_pain"))
    pain_step = _PAIN_FIRST_STEP.get(pain_id) if pain_id else None
    out = {}
    for p in plans:
        pid = p.get("id", "A")
        steps = [
            "Трио самоисследования: сильные стороны, текущие интересы, готовность решать запросы других людей (не только «для себя»)",
            "Зафиксируйте карьерные ценности (якоря Шейна): что в работе для вас опора — служение, экспертиза, управление или баланс с жизнью",
            "Резюме: структура и примеры (видео/статьи) или поддержка карьерного консультанта; попросите близких назвать ваши сильные стороны",
            "Сопоставьте тип среды (по Голланду) и комфорт в команде: общение vs регламент, логика vs отношения, план vs гибкость",
        ]
        if pain_step:
            steps.insert(0, pain_step)
        if preparation == "weak":
            steps.insert(0, "Начните с короткого вводного курса или чеклиста по направлению 10–15 ч")
        out[pid] = {
            "title": p.get("name", "План"),
            "steps": steps,
            "priority_skills": priority,
        }
    return {"by_plan": out}


def build_analysis_result(
    profile: Dict[str, Any],
    profile_extra: Dict[str, Any],
    interest: str,
    education: str,
    preparation_level: str,
    answers: List[Dict[str, Any]],
    question_timings_ms: Optional[List[int]] = None,
) -> Dict[str, Any]:
    vec = _answer_vector(answers)
    readiness_vec = _readiness_percent(vec, preparation_level)
    min_for_axes = 5
    if profile:
        from wibe_work.services.assessment_bundle import get_assessment_bundle

        b = get_assessment_bundle(profile, interest)
        tech_n = int(b.get("technical_count") or 0)
        career_n = int(b.get("career_count") or b.get("personality_count") or 0)
        orient_n = int(b.get("orientation_count") or 0)
        # Школьники часто отвечают только блок ориентации — его тоже достаточно для радара.
        min_for_axes = 5 if orient_n else max(5, (tech_n + career_n) // 2 or 5)
    fp = _answer_fingerprint(answers)
    eff_interest = infer_interest_from_test_answers(profile, answers, interest)
    mode = analysis_mode_for_profile(profile)

    if len(answers) >= min_for_axes:
        axes = _proforientation_radar_axes(answers, eff_interest, profile=profile)
        axis_avg = sum(a["value_percent"] for a in axes) / max(1, len(axes))
        readiness = int(max(12, min(100, round(0.35 * readiness_vec + 0.65 * axis_avg))))
    else:
        axes = _radar_axes(vec)
        readiness = readiness_vec

    if mode == "school":
        scenarios = sanitize_school_scenarios(
            profile,
            pick_school_path_plans(profile, eff_interest, axes, fp),
            eff_interest,
            axes,
            fp,
        )
        plans = scenarios.get("plans") or []
        top_track = str(scenarios.get("best_plan_name") or (plans[0].get("name") if plans else interest))
        top_track = _safe_top_path_for_profile(profile, top_track, eff_interest, scenarios)
        gap = build_school_gap_analysis(
            profile,
            eff_interest,
            top_track,
            axes,
            fp,
            preparation_level=preparation_level,
        )
        # Ясность маршрута: радар + лучший вариант A/B/C + предметная готовность + анкета.
        axis_avg = sum(int(a.get("value_percent") or 0) for a in axes) / max(1, len(axes))
        best_sc = int(scenarios.get("best_avg_percent") or 55)
        gap_hp = int(gap.get("overall_hp") or 55)
        prep_bonus = {"weak": 8, "medium": 18, "strong": 28}.get(preparation_level, 16)
        readiness = int(
            max(
                18,
                min(
                    94,
                    round(
                        0.30 * axis_avg
                        + 0.30 * best_sc
                        + 0.25 * gap_hp
                        + 0.15 * (prep_bonus + readiness_vec * 0.35)
                    ),
                ),
            )
        )
        mts_matrix = school_education_hints(profile, eff_interest, scenarios)
        profile_summary_pre = _profile_summary_rich(
            profile, profile_extra, interest, education, preparation_level
        )
        learn_x = school_learning_extras(
            profile=profile,
            interest=interest,
            preparation_level=preparation_level,
            scenarios=scenarios,
            gap=gap,
            profile_summary=profile_summary_pre,
            user_id=str(profile.get("_user_id") or "") or None,
            eff_interest=eff_interest,
        )
        weekly = school_weekly_roadmap(profile, top_track, eff_interest, scenarios)
    elif mode == "vocational":
        scenarios = sanitize_vocational_scenarios(
            profile,
            pick_vocational_path_plans(profile, eff_interest, axes, fp),
            eff_interest,
            axes,
            fp,
        )
        plans = scenarios.get("plans") or []
        top_track = str(scenarios.get("best_plan_name") or (plans[0].get("name") if plans else interest))
        top_track = safe_top_path_vocational(profile, top_track, eff_interest, scenarios)
        gap = build_vocational_gap_analysis(
            profile,
            eff_interest,
            top_track,
            axes,
            fp,
            preparation_level=preparation_level,
        )
        axis_avg = sum(int(a.get("value_percent") or 0) for a in axes) / max(1, len(axes))
        best_sc = int(scenarios.get("best_avg_percent") or 55)
        gap_hp = int(gap.get("overall_hp") or 55)
        prep_bonus = {"weak": 8, "medium": 18, "strong": 28}.get(preparation_level, 16)
        readiness = int(
            max(
                18,
                min(
                    94,
                    round(
                        0.28 * axis_avg
                        + 0.30 * best_sc
                        + 0.27 * gap_hp
                        + 0.15 * (prep_bonus + readiness_vec * 0.35)
                    ),
                ),
            )
        )
        mts_matrix = vocational_education_hints(profile, eff_interest, scenarios)
        profile_summary_pre = _profile_summary_rich(
            profile, profile_extra, interest, education, preparation_level
        )
        learn_x = vocational_learning_extras(
            profile=profile,
            interest=interest,
            preparation_level=preparation_level,
            scenarios=scenarios,
            gap=gap,
            profile_summary=profile_summary_pre,
            user_id=str(profile.get("_user_id") or "") or None,
            eff_interest=eff_interest,
            axes=axes,
            answers=answers,
        )
        weekly = vocational_weekly_roadmap(profile, top_track, eff_interest, scenarios)
    else:
        scenarios = _pick_scenario_plans(eff_interest, axes, fp, answers)
        plans = scenarios.get("plans") or []
        top_track = str(scenarios.get("best_plan_name") or (plans[0].get("name") if plans else interest))
        top_track = re.sub(r"^План [ABC]:\s*", "", top_track).strip() or interest
        gap = _build_gap_analysis(profile, interest, top_track, axes, fp)
        mts_matrix = {"rows": _rank_mts_rows(profile, profile_extra, eff_interest, answers, axes)}
        profile_summary_pre = _profile_summary_rich(
            profile, profile_extra, interest, education, preparation_level
        )
        learn_x = build_learning_extras(
            profile=profile,
            interest=interest,
            preparation_level=preparation_level,
            scenarios=scenarios,
            gap=gap,
            profile_summary=profile_summary_pre,
            user_id=str(profile.get("_user_id") or "") or None,
            eff_interest=eff_interest,
            axes=axes,
            answers=answers,
        )
        weekly = _weekly_roadmap(top_track, interest, preparation=preparation_level)

    learning = learn_x.get("learning") or _learning_cards(eff_interest, preparation_level)
    learning_path = learn_x.get("learning_path")
    learning_path_detail = learn_x.get("learning_path_detail")
    advice = learn_x.get("individual_advice")
    stages = learn_x.get("growth_stages")
    growth_stages_rich = learn_x.get("growth_stages_rich")
    assessment_signals = learn_x.get("assessment_signals")
    pain_focus = _pain_focus(
        profile,
        gap=gap,
        scenarios=scenarios,
        axes=axes,
        readiness_percent=readiness,
        top_track=top_track,
    )
    pain_focus = _sanitize_pain_focus(pain_focus, mode, profile)

    profile_summary = profile_summary_pre
    directions_hint = ", ".join(
        f"{p['id']}: {p.get('name', '')} (~{p['score_percent']}%)"
        for p in scenarios.get("plans", [])
    )
    from wibe_work.services.profile_analysis_context import education_grade as profile_education_grade

    llm_text, narr_src, narr_notice = _analysis_narrative_llm(
        profile_summary,
        scenarios,
        axes=axes,
        readiness_percent=readiness,
        answers_count=len(answers),
        analysis_mode=mode,
        education_grade=profile_education_grade(profile),
        profile=profile,
        interest=eff_interest,
    )
    if llm_text.strip():
        narrative = llm_text.strip()
        ai_narrative_source = "llm"
        ai_narrative_notice = None
    else:
        if mode == "school":
            narrative = mock_school_narrative(
                profile,
                eff_interest,
                scenarios,
                axes,
                fp,
                readiness_percent=readiness,
                gap=gap,
            )
        elif mode == "vocational":
            narrative = mock_vocational_narrative(
                profile,
                eff_interest,
                scenarios,
                axes,
                fp,
                readiness_percent=readiness,
                gap=gap,
            )
        else:
            narrative = _mock_ai_narrative(
                profile,
                interest,
                preparation_level,
                scenarios,
                axes,
                fp,
                readiness_percent=readiness,
                gap=gap,
            )
        ai_narrative_source = "mock"
        ai_narrative_notice = None
    if mode == "school":
        narrative = scrub_school_narrative(narrative, profile, scenarios)
    elif mode == "vocational":
        narrative = scrub_vocational_narrative(narrative, profile, scenarios)
    else:
        try:
            from wibe_work.services.llm_prompts import scrub_portrait_plan_jargon

            narrative = scrub_portrait_plan_jargon(narrative) or narrative
        except Exception:
            pass
    if _block_job_market_copy(mode, profile) or mode == "vocational":
        _fn = lambda s: _scrub_copy_string(s, mode, profile)
        advice = _walk_scrub(advice, _fn)
        stages = _walk_scrub(stages, _fn)
        growth_stages_rich = _walk_scrub(growth_stages_rich, _fn)
        weekly = _walk_scrub(weekly, _fn)
        learning = _walk_scrub(learning, _fn)
        learning_path = _walk_scrub(learning_path, _fn)
        learning_path_detail = _walk_scrub(learning_path_detail, _fn)
    behavioral = _behavioral_hint(question_timings_ms)
    readiness_insight = _build_readiness_insight(
        readiness,
        preparation_level,
        axes,
        gap,
        scenarios,
        analysis_mode=mode,
        profile=profile,
    )

    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

    return {
        "analyzed_at": now,
        "readiness": {
            "value_percent": readiness,
            "segments": [
                {"from": 0, "to": 20, "color": "#e11d48"},
                {"from": 20, "to": 40, "color": "#f97316"},
                {"from": 40, "to": 60, "color": "#eab308"},
                {"from": 60, "to": 80, "color": "#84cc16"},
                {"from": 80, "to": 100, "color": "#22c55e"},
            ],
            **readiness_insight,
        },
        "style_radar": {"axes": axes},
        "analysis_mode": mode,
        "scenarios": scenarios,
        "mts_matrix": mts_matrix,
        "learning": learning,
        "learning_path": learning_path,
        "learning_path_detail": learning_path_detail,
        "individual_advice": advice,
        "growth_stages": stages,
        "growth_stages_rich": growth_stages_rich,
        "assessment_signals": assessment_signals,
        "gap_analysis": gap,
        "pain_focus": pain_focus,
        "weekly_roadmap": weekly,
        "behavioral_hint": behavioral,
        "ai_narrative": narrative,
        "ai_narrative_source": ai_narrative_source,
        "ai_narrative_notice": ai_narrative_notice,
        # внутреннее для чата
        "profile_summary": profile_summary,
        "directions_hint": directions_hint,
        "narrative": narrative,
        "_timings_note": question_timings_ms,
        "_analysis_interest": eff_interest,
        "_quiz_answers": answers,
    }


def public_analysis_payload(full: Dict[str, Any]) -> Dict[str, Any]:
    """Только то, что видит пользователь в разделе разбора (с учётом подтверждения роли)."""
    from wibe_work.services.role_confirmation import public_analysis_payload as _pub

    return _pub(full)
