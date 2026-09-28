"""Контекст анкеты для разбора и обучения: школа / СПО / вуз."""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional

from wibe_work.questionnaire_fields import (
    AUDIENCE_CAREER,
    AUDIENCE_SCHOOL,
    SCHOOL_SUBJECT_OPTIONS,
    parse_favorite_subjects,
    questionnaire_audience,
)
from wibe_work.services.aptitude_quiz_grading import compute_quiz_grade, quiz_grade_label
from wibe_work.services.user_context import (
    parse_interest_spheres,
    profile_choice_values,
    profile_text,
)

_SUBJECT_LABELS: Dict[str, str] = {s["id"]: s["label"] for s in SCHOOL_SUBJECT_OPTIONS}

_POST_SCHOOL_GOAL_RU: Dict[str, str] = {
    "after_9_college": "После 9 класса — в колледж (СПО)",
    "after_9_school": "После 9 класса — остаться в 10–11 классе",
    "after_11_university": "После 11 класса — в вуз",
    "after_11_college": "После 11 класса — в колледж (СПО)",
    "undecided": "Пока не решил(а)",
}

_EXAM_FOCUS_RU: Dict[str, str] = {
    "oge_9": "ОГЭ (9 класс)",
    "ege_11": "ЕГЭ (11 класс)",
    "both": "ОГЭ и ЕГЭ впереди",
    "profile_only": "Выбор профиля без экзаменов сейчас",
    "none": "Не готовлюсь к экзаменам сейчас",
}

_STUDY_FORM_RU: Dict[str, str] = {
    "fulltime": "очная",
    "parttime": "заочная",
    "evening": "вечерняя",
    "online": "онлайн",
}

_WORK_FORMAT_RU: Dict[str, str] = {
    "office": "офис",
    "remote": "удалённо",
    "hybrid": "гибрид",
    "any": "не важно",
}

_WORK_SCHEDULE_RU: Dict[str, str] = {
    "weekends": "только выходные",
    "after_classes": "после пар",
    "full_day": "полный день",
    "part_time": "неполный день",
    "flex": "свободный график",
    "project": "проектная работа",
    "any": "не важно",
}

_RELOCATION_RU: Dict[str, str] = {
    "yes": "готов(а)",
    "no": "не готов(а)",
    "maybe": "рассмотрю",
}

_CAREER_GOAL_RU: Dict[str, str] = {
    "internship_or_first_job": "первая работа или стажировка",
    "find_job": "поиск работы",
    "grow_in_field": "развитие в текущем направлении",
    "change_field": "смена направления / профессии",
    "continue_education": "продолжение обучения",
    "undecided": "пока не определился(ась)",
}

_PREP_RU: Dict[str, str] = {
    "weak": "слабая",
    "medium": "средняя",
    "strong": "сильная",
}

_EDUCATION_DETAIL_RU: Dict[str, str] = {
    "school_8_11": "школьник (8–11 кл.)",
    "spo": "студент СПО (колледж)",
    "univ_bachelor": "студент вуза (бакалавр)",
    "univ_master": "студент вуза (магистр)",
    "graduate": "выпускник",
}

# id любимого предмета → подпись в разрыве / обучении
SUBJECT_GAP_LABELS: Dict[str, str] = {
    "math": "Математика (алгебра, логика)",
    "russian": "Русский язык",
    "literature": "Литература",
    "physics": "Физика",
    "chemistry": "Химия",
    "biology": "Биология",
    "informatics": "Информатика / программирование",
    "history": "История",
    "social": "Обществознание",
    "geography": "География",
    "english": "Английский",
    "art": "Искусство / МХК",
    "other": "Другие предметы",
}

_CAREER_RESOURCE_BLOCK = re.compile(
    r"резюме|собеседован|отклик|hh\.ru|ваканс|трудоустройств|job-?сайт",
    re.I,
)


def analysis_mode_for_profile(profile: Dict[str, Any]) -> str:
    """school | vocational | career — режим структуры разбора."""
    grade = compute_quiz_grade(profile)
    if grade == "school":
        return "school"
    if grade == "vocational":
        return "vocational"
    return "career"


def education_grade(profile: Dict[str, Any]) -> str:
    return compute_quiz_grade(profile or {})


def _label(map_: Dict[str, str], key: Any) -> str:
    k = str(key or "").strip().lower()
    return map_.get(k, str(key or "").strip())


def favorite_subjects_labels(profile: Dict[str, Any]) -> List[str]:
    return [_SUBJECT_LABELS.get(sid, sid) for sid in parse_favorite_subjects(profile)]


def school_questionnaire_lines(profile: Dict[str, Any]) -> List[str]:
    lines: List[str] = []
    fav = favorite_subjects_labels(profile)
    if fav:
        lines.append(f"Любимые предметы: {', '.join(fav)}")
    psg = profile_text(profile.get("post_school_goal"))
    if psg:
        lines.append(f"План после школы: {_label(_POST_SCHOOL_GOAL_RU, psg)}")
    ef = profile_text(profile.get("exam_focus"))
    if ef:
        lines.append(f"Подготовка к экзаменам: {_label(_EXAM_FOCUS_RU, ef)}")
    adm = profile_text(profile.get("admission_target"), limit=200)
    if adm:
        lines.append(f"Куда мечтает поступить: {adm[:200]}")
    hw = profile.get("hours_per_week")
    if hw is not None and str(hw).strip() != "":
        lines.append(f"Часов в неделю на подготовку: {hw}")
    avoids = profile_choice_values(profile.get("dislike_to_do"))
    if avoids:
        lines.append(f"Хотел бы избегать: {', '.join(avoids[:5])}")
    preferences = profile_choice_values(profile.get("task_preferences"))
    if preferences:
        lines.append(f"Предпочтительный стиль задач: {', '.join(preferences[:5])}")
    extra = profile_text(profile.get("extra_education"), limit=200)
    if extra:
        lines.append(f"Кружки / олимпиады: {extra[:200]}")
    return lines


def career_questionnaire_lines(profile: Dict[str, Any]) -> List[str]:
    lines: List[str] = []
    specialty = profile_text(profile.get("specialty_direction"), limit=160)
    if specialty:
        lines.append(f"Текущее направление обучения: {specialty}")
    sf = profile_text(profile.get("study_form"))
    if sf:
        lines.append(f"Форма обучения: {_label(_STUDY_FORM_RU, sf)}")
    wf = profile_text(profile.get("work_format_preference") or profile.get("work_format_pref"))
    if wf:
        wfs = wf
        lines.append(f"Формат работы: {_label(_WORK_FORMAT_RU, wfs)}")
    ws = profile_text(profile.get("work_schedule"))
    if ws:
        lines.append(f"График: {_label(_WORK_SCHEDULE_RU, ws)}")
    sal = profile.get("target_salary")
    if sal is not None and str(sal).strip() != "":
        lines.append(f"Целевая зарплата: {sal} ₽/мес")
    relocation = profile_text(profile.get("relocation_ready"))
    if relocation:
        lines.append(f"Переезд: {_label(_RELOCATION_RU, relocation)}")
    career_goal = profile_text(profile.get("career_goal"))
    if career_goal:
        lines.append(f"Ближайшая карьерная цель: {_label(_CAREER_GOAL_RU, career_goal)}")
    preferences = profile_choice_values(profile.get("task_preferences"))
    if preferences:
        lines.append(f"Предпочтительный стиль задач: {', '.join(preferences[:5])}")
    avoids = profile_choice_values(profile.get("dislike_to_do"))
    if avoids:
        lines.append(f"Хотел бы избегать: {', '.join(avoids[:5])}")
    languages = profile_choice_values(profile.get("languages"))
    if languages:
        lines.append(f"Языки: {', '.join(languages[:4])}")
    ir = profile_text(profile.get("internship_ready"))
    if ir:
        lines.append(f"Стажировка: {ir}")
    cp = profile_text(profile.get("career_priority"))
    if cp:
        lines.append(f"Приоритет: {cp}")
    return lines


def build_profile_summary_for_analysis(
    profile: Dict[str, Any],
    interest: str,
    preparation_level: str,
    *,
    profile_extra: Optional[Dict[str, Any]] = None,
) -> str:
    """Полный текст профиля для LLM, чата и персональных советов."""
    from wibe_work.services.user_context import coach_profile_snippet

    p = dict(profile or {})
    if profile_extra:
        for k, v in profile_extra.items():
            if v is not None and k not in p:
                p[k] = v

    grade = education_grade(p)
    aud = questionnaire_audience(profile=p)
    lines: List[str] = []

    base = coach_profile_snippet(p)
    if base:
        lines.append(base)

    edu = _label(_EDUCATION_DETAIL_RU, p.get("education_detail") or p.get("education_level"))
    spheres = parse_interest_spheres(p)
    sphere_txt = ", ".join(spheres) if spheres else (interest or "—")
    prep = _label(_PREP_RU, preparation_level) if preparation_level in _PREP_RU else preparation_level

    lines.append(
        f"Уровень для разбора: {quiz_grade_label(grade)} ({edu or '—'}). "
        f"Сфера теста/разбора: {interest or sphere_txt}. "
        f"Подготовка к цели: {prep}."
    )
    if aud == AUDIENCE_SCHOOL:
        lines.append(
            "Фокус разбора: куда учиться после школы, профильные предметы, ОГЭ/ЕГЭ — не вакансии."
        )
    elif grade == "vocational":
        psg = profile_text(p.get("post_spo_goal"))
        if psg:
            lines.append(
                "План после колледжа: "
                + {
                    "spo_to_university": "в вуз",
                    "spo_to_work": "на работу / стажировку",
                    "undecided": "пока не решил(а)",
                }.get(psg, psg)
            )
        lines.extend(career_questionnaire_lines(p))
        lines.append(
            "Фокус разбора: специальность СПО и развилка «вуз или работа» — не школьные предметы."
        )
    else:
        lines.extend(career_questionnaire_lines(p))
        lines.append(
            "Фокус разбора: роль и вакансии, навыки, стажировка/работа по выбранной сфере."
        )

    return "\n".join(lines)


def analysis_mode_note(analysis_mode: str, education_grade_val: str) -> str:
    mode = (analysis_mode or "").strip().lower()
    if mode == "school" or education_grade_val == "school":
        return (
            "Режим: ШКОЛЬНИК — варианты A/B/C это маршруты обучения (колледж, 11 класс, вуз), "
            "не профессии. Учитывай любимые предметы, план после 9/11 класса и ОГЭ/ЕГЭ из анкеты. "
            "Не предлагай резюме, hh и работу как основное."
        )
    if mode == "vocational" or education_grade_val == "vocational":
        return (
            "Режим: СПО / колледж — варианты A/B/C зависят от поля «После колледжа»: "
            "вуз (бакалавриат, диплом) или работа (практика, стажировка, помощник), "
            "либо оба пути если пока не решил. "
            "Без школьных предметов, ОГЭ/ЕГЭ. Без senior и массового hh, если выбран вуз."
        )
    return (
        "Режим: вуз / выпускник — варианты A/B/C ближе к карьерным трекам, роль и выход на рынок труда. "
        "Без школьных предметов. Учитывай формат работы, зарплату, стажировку из анкеты."
    )


def career_resource_blocked_for_school(resource: Dict[str, Any]) -> bool:
    title = str(resource.get("title") or "")
    desc = str(resource.get("description") or "")
    rid = str(resource.get("id") or "")
    blob = f"{title} {desc} {rid}"
    return bool(_CAREER_RESOURCE_BLOCK.search(blob))
