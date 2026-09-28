from typing import Any, Dict, List, Optional

from wibe_work.services import recommendations as rec_mod
from wibe_work.services.user_context import education_rank, merge_skills_from_profile, profile_text


_CAREER_GOAL_ROUTE_FOCUS = {
    "internship_or_first_job": ("Первая работа или стажировка", "Соберите 2–3 учебных кейса и выберите стартовые вакансии или стажировки."),
    "find_job": ("Поиск работы", "Соберите релевантные кейсы, обновите резюме и начните с целевых откликов."),
    "grow_in_field": ("Рост в текущем направлении", "Выберите следующий профессиональный навык и подтвердите его задачей или проектом."),
    "change_field": ("Смена направления", "Сравните смежные роли, пройдите короткую практику и соберите первый кейс в новом направлении."),
    "continue_education": ("Продолжение обучения", "Сопоставьте программы, требования к поступлению и практические проекты по интересующему направлению."),
    "undecided": ("Выбор следующего шага", "Сравните 2–3 близких сценария и сделайте по одному короткому практическому шагу в каждом."),
}


def _stages_for_direction(direction: str) -> List[Dict[str, Any]]:
    templates: Dict[str, List[str]] = {
        "IT / разработка": [
            "Стажёр / junior: базовый стек, code review, мелкие задачи",
            "Middle: самостоятельные фичи, оценка сроков, качество кода",
            "Senior / lead: архитектура, наставничество, влияние на продукт",
        ],
        "Аналитика и данные": [
            "Junior analyst: отчёты, ad-hoc запросы",
            "Product/business analyst: метрики, гипотезы, взаимодействие со стейкхолдерами",
            "Lead: стратегия данных, культура аналитики",
        ],
    }
    lines = templates.get(direction) or [
        "Старт: освоить базовые инструменты отрасли",
        "Рост: ответственность за конечный результат и автономия",
        "Экспертиза: стратегия, наставничество, межфункциональное влияние",
    ]
    return [
        {"order": i + 1, "title": f"Этап {i + 1}", "description": text}
        for i, text in enumerate(lines)
    ]


def _qualification_actions(direction: str, edu_rank: int) -> List[Dict[str, Any]]:
    actions: List[Dict[str, Any]] = [
        {"type": "курс", "title": f"Профильный курс по направлению: {direction}", "horizon": "1–3 мес."},
        {"type": "практика", "title": "Пет-проект или волонтёрская задача с измеримым результатом", "horizon": "1–2 мес."},
        {"type": "сертификация", "title": "Отраслевой сертификат (по выбору работодателей в вашем регионе)", "horizon": "3–6 мес."},
    ]
    if edu_rank < 4:
        actions.insert(
            0,
            {
                "type": "образование",
                "title": "Дополнить формальное образование (бакалавриат/магистратура или ДПО)",
                "horizon": "6–24 мес.",
            },
        )
    return actions


def _week_focus(week: int, direction: str, rec: Dict[str, Any]) -> Dict[str, Any]:
    plan_skills = rec.get("skill_development_plan") or []
    skill_names = [p["skill"] for p in plan_skills[:5]]
    if week <= 4:
        focus = "Фундамент и один инструмент недели"
        tasks = [
            f"Неделя {week}: {skill_names[week - 1] if week <= len(skill_names) else 'базовый навык направления'} — 5–7 ч практики",
            "Зафиксировать результат в профиле (experience_projects)",
        ]
    elif week <= 8:
        focus = "Портфолио и публичный след"
        tasks = [
            f"Неделя {week}: мини-кейс или фрагмент портфолио по {direction}",
            "1 публикация или разбор в сообществе / наставнику",
        ]
    else:
        focus = "Рынок: резюме и отклики"
        tasks = [
            f"Неделя {week}: 5 целевых откликов (в т.ч. entry_level вакансии)",
            "Разбор 2 типовых вопросов собеседования по направлению",
        ]
    return {"week": week, "focus": focus, "tasks": tasks}


def build_12_week_plan(rec: Dict[str, Any]) -> List[Dict[str, Any]]:
    direction = rec.get("primary_direction") or "Универсальные роли"
    return [_week_focus(w, direction, rec) for w in range(1, 13)]


def build_navigator(
    profile: Dict[str, Any],
    competencies: List[Dict[str, Any]],
    target_direction: Optional[str] = None,
) -> Dict[str, Any]:
    rec = rec_mod.run_recommendations(profile, competencies)
    names, levels = merge_skills_from_profile(competencies, profile)
    user_lower = {n.lower() for n in names}

    direction = target_direction or rec.get("primary_direction") or "Универсальные роли"
    if target_direction:
        plan = rec_mod._skill_plan_for_direction(target_direction, user_lower)
        rec = {
            **rec,
            "primary_direction": target_direction,
            "skill_development_plan": plan,
            "skills_for_first_offer": rec_mod._first_offer_skills(plan),
        }

    avg = (
        sum(levels.get(n.lower(), 3) for n in names) / len(names)
        if names
        else 2.5
    )
    edu_r = education_rank(
        profile.get("education_detail") or profile.get("education_level") or profile.get("education")
    )

    path: List[Dict[str, Any]] = [
        {
            "step": 1,
            "focus": "Диагностика и закрытие пробелов в профиле",
            "detail": "Заполните поля опросника: возраст, образование, сферы интересов, soft skills, опыт.",
        },
        {
            "step": 2,
            "focus": f"Углубление в направлении: {direction}",
            "detail": "Выполните недели 1–4 двенадцатинедельного плана.",
        },
        {
            "step": 3,
            "focus": "Рыночная валидация",
            "detail": "Отклики с фильтром формата работы и вакансий без опыта; сверка с матрицей ролей (/career/mts-match/).",
        },
    ]
    goal = profile_text(profile.get("career_goal"))
    goal_focus = _CAREER_GOAL_ROUTE_FOCUS.get(goal)
    if goal_focus:
        path[2] = {"step": 3, "focus": goal_focus[0], "detail": goal_focus[1]}

    return {
        "target_direction": direction,
        "individual_development_path": path,
        "plan_12_weeks": build_12_week_plan(rec),
        "plan_methodology": "Пошаговый горизонт 3 месяца — ответ на «инфо-шум» из продуктовой таблицы",
        "qualification_recommendations": _qualification_actions(direction, edu_r),
        "career_growth_stages": _stages_for_direction(direction),
        "current_skill_snapshot": {
            "skill_count": len(names),
            "average_self_rating": round(avg, 2) if names else None,
        },
    }
