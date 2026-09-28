"""Этапы роста: понятный план с привязкой к советам и пути обучения."""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Set, Tuple

from wibe_work.services.learning.personalized_advice import (
    _human_skill_label,
    _infer_track_from_plan,
    _material_card,
    _pick_materials,
    _plan_label,
    _pool_materials,
    _priority_skills,
)


def _prep_label(preparation: str) -> str:
    return {
        "weak": "начальный",
        "medium": "средний",
        "strong": "уверенный",
    }.get(preparation, "средний")


def _readiness_intro(
    readiness_percent: int,
    preparation: str,
    *,
    school: bool = False,
    vocational: bool = False,
) -> str:
    prep = _prep_label(preparation)
    if school:
        if readiness_percent < 35:
            return (
                f"Ясность маршрута около {readiness_percent}% — нормальный старт ({prep} уровень). "
                "Сравните варианты A/B/C и выберите один предмет или колледж на ближайшие 2–4 недели."
            )
        if readiness_percent < 60:
            return (
                f"Ясность маршрута около {readiness_percent}% ({prep} уровень). "
                "Закройте 1–2 предмета из блока «Что подтянуть» и уточните, куда идти после 9/11."
            )
        return (
            f"Маршрут уже понятнее (~{readiness_percent}%). "
            "Держите фокус на предметах и конкретном колледже/профиле, без распыления."
        )
    if vocational:
        if readiness_percent < 35:
            return (
                f"Готовность к шагу в профессию около {readiness_percent}% — нормальный старт ({prep}). "
                "Сравните варианты A/B/C и выберите один навык или место практики на 2–4 недели."
            )
        if readiness_percent < 60:
            return (
                f"Готовность около {readiness_percent}% ({prep} уровень). "
                "Закройте 1–2 пункта из «Что подтянуть» и уточните практику/стажировку."
            )
        return (
            f"База уже заметна (~{readiness_percent}%). "
            "Держите фокус на специальности, кейсе и одном месте практики."
        )
    if readiness_percent < 35:
        return (
            f"Сейчас готовность около {readiness_percent}% — это нормальный старт ({prep} уровень). "
            "Двигайтесь маленькими шагами: один фокус в неделю, без попытки закрыть всё сразу."
        )
    if readiness_percent < 60:
        return (
            f"Готовность около {readiness_percent}% ({prep} уровень). "
            "На этом этапе важно закрыть пару приоритетных пунктов из разбора "
            "и сделать один понятный результат — конспект, задачу или пункт в резюме."
        )
    return (
        f"Готовность около {readiness_percent}% — база уже заметна. "
        "Можно быстрее переходить к практике и откликам, если нет дыр в ключевых навыках."
    )


def _best_plan_block(
    advice: Optional[Dict[str, Any]],
    scenarios: Dict[str, Any],
) -> Tuple[str, Dict[str, Any]]:
    by = (advice or {}).get("by_plan") or {}
    pid = str(scenarios.get("best_plan_id") or "A")
    block = by.get(pid) or by.get("A") or {}
    return pid, block if isinstance(block, dict) else {}


def _plan_step(label: str, text: str) -> Dict[str, str]:
    return {"label": label, "text": text}


def _advice_lines(block: Dict[str, Any], limit: int = 2) -> List[str]:
    """Короткие формулировки из индивидуальных советов (секции или шаги)."""
    out: List[str] = []
    for sec in block.get("sections") or []:
        if not isinstance(sec, dict):
            continue
        for st in sec.get("steps") or []:
            if isinstance(st, dict):
                t = str(st.get("text") or "").strip()
                if t:
                    out.append(t[:220])
            if len(out) >= limit:
                return out
    for st in block.get("steps") or []:
        if isinstance(st, str) and st.strip():
            out.append(st.strip()[:220])
        elif isinstance(st, dict):
            t = str(st.get("text") or "").strip()
            if t:
                out.append(t[:220])
        if len(out) >= limit:
            break
    return out


def _materials_from_steps(path_steps: List[Dict[str, Any]], *, limit: int = 4) -> List[Dict[str, Any]]:
    seen: Set[str] = set()
    out: List[Dict[str, Any]] = []
    for step in path_steps:
        for res in step.get("resources") or []:
            url = (res.get("url") or "").strip()
            if not url or url == "#" or url in seen:
                continue
            seen.add(url)
            card = _material_card(res)
            card["path_step"] = step.get("title")
            out.append(card)
            if len(out) >= limit:
                return out
    return out


def _path_steps_slice(
    learning_path: Optional[Dict[str, Any]],
    stage_index: int,
) -> List[Dict[str, Any]]:
    steps = list(learning_path.get("steps") or []) if learning_path else []
    if not steps:
        return []
    n = len(steps)
    if stage_index == 1:
        return steps[: max(1, (n + 2) // 3)]
    if stage_index == 2:
        a = max(1, (n + 2) // 3)
        b = max(a + 1, (2 * n + 2) // 3)
        return steps[a:b]
    a = max(1, (2 * n + 2) // 3)
    return steps[a:]


def _merge_materials(*groups: List[Dict[str, Any]], limit: int = 5) -> List[Dict[str, Any]]:
    seen: Set[str] = set()
    out: List[Dict[str, Any]] = []
    for group in groups:
        for m in group:
            url = (m.get("url") or "").strip()
            if url and url not in seen:
                seen.add(url)
                out.append(m)
            if len(out) >= limit:
                return out
    return out


def _path_route(path_steps: List[Dict[str, Any]]) -> str:
    titles = [str(s.get("title") or "").strip() for s in path_steps if s.get("title")]
    return " → ".join(titles[:4]) if titles else ""


def build_growth_stages(
    *,
    interest: str,
    eff_interest: str,
    preparation_level: str,
    readiness_percent: int,
    profile: Dict[str, Any],
    gap: Dict[str, Any],
    scenarios: Dict[str, Any],
    individual_advice: Optional[Dict[str, Any]],
    learning_path: Optional[Dict[str, Any]],
    force_school: bool = False,
    force_vocational: bool = False,
) -> List[Dict[str, Any]]:
    """Три этапа: вводный текст, пошаговый план, чеклист, материалы."""
    from wibe_work.services.profile_analysis_context import analysis_mode_for_profile

    mode = analysis_mode_for_profile(profile)
    school = force_school or mode == "school"
    vocational = (not school) and (force_vocational or mode == "vocational")
    priority = [_human_skill_label(s) for s in _priority_skills(gap)]
    top_skills = ", ".join(priority[:3])
    plan_id, plan_block = _best_plan_block(individual_advice, scenarios)
    plan_name = _plan_label(
        next(
            (p for p in (scenarios.get("plans") or []) if str(p.get("id")) == plan_id),
            {"name": scenarios.get("best_plan_name") or f"План {plan_id}"},
        )
    )
    track = _infer_track_from_plan(plan_name)
    pool = _pool_materials(
        sphere=eff_interest,
        track=track,
        preparation=preparation_level,
        learning_path=learning_path,
    )
    used_urls: Set[str] = set()
    intro_base = _readiness_intro(
        readiness_percent,
        preparation_level,
        school=school,
        vocational=vocational,
    )
    advice_lines = _advice_lines(plan_block, limit=2)
    like = (profile.get("like_to_do") or "").strip()[:80]

    s1_path = _path_steps_slice(learning_path, 1)
    s1_titles = [str(s.get("title") or "") for s in s1_path if s.get("title")]
    first_path = s1_titles[0] if s1_titles else (
        "первый материал из блока «Обучение»"
        if school or vocational
        else "первый шаг из пути обучения"
    )
    s1_mats = _merge_materials(
        _materials_from_steps(s1_path, limit=3),
        _pick_materials(
            pool,
            keywords=(
                "курс",
                "intro",
                "roadmap",
                "основ",
                track or ("школ" if school else "практик" if vocational else "карьер"),
            ),
            limit=2,
            used_urls=used_urls,
            track=track,
        ),
        limit=4,
    )

    if school:
        s1_plan: List[Dict[str, str]] = [
            _plan_step(
                "Сверьте интересы",
                "Выпишите 3 сильные стороны из школы и хобби — и 1–2 предмета, "
                "которые реально тянете, а не «надо бы».",
            ),
            _plan_step(
                "Сверьте с маршрутом",
                f"Сравните вариант «{plan_name}» с блоком «Что подтянуть»"
                + (f" ({top_skills})" if top_skills else "")
                + ". Выберите один предмет или кружок на месяц — не пять сразу.",
            ),
            _plan_step(
                "Начните обучение",
                f"Пройдите «{first_path}» или один материал из списка — "
                "с коротким итогом: что поняли и что сделали.",
            ),
        ]
        if preparation_level == "weak":
            s1_plan[2] = _plan_step(
                "Начните с базы",
                f"20–30 минут в день по предмету к маршруту «{plan_name}». "
                f"Цель этапа: закрыть 1–2 пункта ({top_skills or 'предмет из анкеты'}).",
            )
    elif vocational:
        s1_plan = [
            _plan_step(
                "Сверьте сильные стороны",
                "Выпишите 3–5 сильных сторон из учёбы, практики и проектов — "
                "что уже получается, а не «надо бы когда-нибудь».",
            ),
            _plan_step(
                "Сверьте с маршрутом",
                f"Сравните «{plan_name}» с блоком «Что подтянуть»"
                + (f" ({top_skills})" if top_skills else "")
                + ". Один навык или место практики на месяц — не пять сразу.",
            ),
            _plan_step(
                "Начните с практики",
                f"Пройдите «{first_path}» или один материал — "
                "с коротким итогом: что сделали руками.",
            ),
        ]
        if preparation_level == "weak":
            s1_plan[2] = _plan_step(
                "Начните с базы",
                f"20–30 минут в день по навыку к «{plan_name}». "
                f"Цель: закрыть 1–2 пункта ({top_skills or 'навык специальности'}).",
            )
    else:
        s1_plan = [
            _plan_step(
                "Поймите себя",
                "Выпишите 5 сильных сторон — из учёбы, проектов, хобби, помощи людям. "
                "Отметьте, от чего появляется энергия, а что «надо», но не тянет.",
            ),
            _plan_step(
                "Сверьте с направлением",
                f"Посмотрите на направление «{plan_name}» и пункты из разбора"
                + (f" ({top_skills})" if top_skills else "")
                + ". Решите, что подтянуть в первую очередь — один пункт, не пять.",
            ),
            _plan_step(
                "Начните обучение",
                f"Пройдите «{first_path}» из пути ниже или один материал из списка — "
                "с коротким итогом: что поняли и что сделали руками.",
            ),
        ]
        if preparation_level == "weak":
            s1_plan[2] = _plan_step(
                "Начните с базы",
                f"Возьмите вводный курс или урок по «{plan_name}» — 20–30 минут в день. "
                f"Цель этапа: закрыть 1–2 приоритетных пункта ({top_skills or 'база по сфере'}).",
            )
    if advice_lines:
        s1_plan.append(_plan_step("Из ваших советов", advice_lines[0][:200]))

    if school:
        s1_intro = intro_base + f" Этап 1 — уточнение маршрута «{plan_name}»."
    elif vocational:
        s1_intro = intro_base + f" Этап 1 — фокус по специальности «{plan_name}»."
    else:
        s1_intro = intro_base + f" Этап 1 — подготовка к «{plan_name}» (план {plan_id})."
    if like:
        s1_intro += f" В анкете: «{like}» — можно опереться на это при выборе задач."

    horizon_1 = "3–5 недель" if preparation_level == "weak" else "2–4 недели"

    # --- Этап 2 ---
    s2_path = _path_steps_slice(learning_path, 2)
    s2_mats = _merge_materials(
        _materials_from_steps(s2_path, limit=4),
        _pick_materials(
            pool,
            keywords=(
                ("практик", "олимпиад", "кружок", "проект", track or "")
                if school
                else ("практик", "стажир", "портфолио", "кейс", track or "")
                if vocational
                else ("практик", "exercism", "git", "stepik", track or "")
            ),
            limit=2,
            used_urls=used_urls,
            track=track,
        ),
        limit=5,
    )
    s2_advice = _advice_lines(plan_block, limit=3)
    if school:
        s2_plan = [
            _plan_step(
                "Подтяните предметы",
                f"Фокус: {top_skills or 'предметы из блока «Что подтянуть»'}. "
                "3 коротких занятия или один мини-проект по выбранному предмету.",
            ),
            _plan_step(
                "Соберите доказательства интереса",
                f"Под маршрут «{plan_name}»: кружок, проект, олимпиада или волонтёрство — "
                "в 5 строк: что делали → чему научились.",
            ),
            _plan_step(
                "Сверьте с поступлением",
                "Откройте сайт колледжа/профиля мечты: какие предметы и экзамены нужны — "
                "сопоставьте с вашим списком.",
            ),
        ]
    elif vocational:
        s2_plan = [
            _plan_step(
                "Подтяните навыки специальности",
                f"Фокус: {top_skills or 'пункты из «Что подтянуть»'}. "
                "3 коротких занятия или один учебный мини-кейс.",
            ),
            _plan_step(
                "Соберите учебный кейс",
                f"Под «{plan_name}»: практика или проект — в 5–8 строк: "
                "что делали → чему научились → что показать.",
            ),
            _plan_step(
                "Черновик для стажировки",
                "Короткое резюме студента: 3 пункта с практики/учёбы — без претензии на senior.",
            ),
        ]
    else:
        s2_plan = [
            _plan_step(
                "Закройте разрыв",
                f"Потренируйтесь в навыках: {top_skills or 'по вашей сфере'}. "
                "Минимум 3 маленькие задачи или один учебный мини-кейс.",
            ),
            _plan_step(
                "Соберите резюме",
                f"Черновик под «{plan_name}»: три пункта «что сделал» с фактом или цифрой. "
                "Можно попросить близких назвать ваши сильные стороны — часто видят то, что вы сами не замечаете.",
            ),
            _plan_step(
                "Закрепите практикой",
                "Pet-проект, репозиторий на GitHub или учебный кейс — что можно показать ссылкой.",
            ),
        ]
        if preparation_level == "strong":
            s2_plan[2] = _plan_step(
                "Углубите практику",
                "Pet-проект или вклад в open-source сильнее ещё одного курса на вашем уровне.",
            )
        elif preparation_level == "medium":
            s2_plan[2] = _plan_step(
                "Ритм практики",
                "Одна практическая задача в неделю (код, Git, макет — по сфере) + фиксация в конспекте.",
            )
    if len(s2_advice) > 1:
        s2_plan.append(_plan_step("Подсказка из советов", s2_advice[1][:200]))

    # --- Этап 3 ---
    s3_path = _path_steps_slice(learning_path, 3)
    s3_mats = _merge_materials(
        _materials_from_steps(s3_path, limit=4),
        _pick_materials(
            pool,
            keywords=(
                ("колледж", "день открытых", "поступлен", "егэ", "огэ", track or "")
                if school
                else ("стажир", "практик", "junior", "портфолио", track or "")
                if vocational
                else ("portfolio", "github", "ваканс", "отклик", track or "")
            ),
            limit=2,
            used_urls=used_urls,
            track=track,
        ),
        limit=5,
    )
    s3_advice = _advice_lines(plan_block, limit=3)
    if school:
        s3_plan = [
            _plan_step(
                "Проверьте маршрут вживую",
                f"День открытых дверей, пробное занятие или разговор с студентом по «{plan_name}» — "
                "один контакт, не бесконечный поиск.",
            ),
            _plan_step(
                "Сверьте предметы с требованиями",
                f"Сопоставьте требования поступления с фокусом: {top_skills or 'список из разбора'}.",
            ),
            _plan_step(
                "Зафиксируйте план на семестр",
                "Один маршрут + один предмет/кружок + дата обсуждения с родителями или классным.",
            ),
        ]
    elif vocational:
        s3_plan = [
            _plan_step(
                "Выйдите на практику",
                f"Один контакт по «{plan_name}»: куратор, наставник или место стажировки — "
                "не массовая рассылка.",
            ),
            _plan_step(
                "Сверьте требования",
                f"Сопоставьте требования стажировки/практики с фокусом: "
                f"{top_skills or 'список из разбора'}.",
            ),
            _plan_step(
                "Зафиксируйте план на семестр",
                "Один маршрут + один навык + дата разговора с куратором практики.",
            ),
        ]
    else:
        apply_hint = (
            "8–12 точечных откликов и 2–3 разговора с работодателями."
            if readiness_percent >= 55
            else "5 целевых откликов: после каждого — что спросили и что подтянуть, без массовой рассылки."
        )
        s3_plan = [
            _plan_step(
                "Выходите на рынок",
                f"Откликайтесь под «{plan_name}» — с сопроводительным под конкретную вакансию. {apply_hint}",
            ),
            _plan_step(
                "Сверяйте с вакансиями",
                f"Сравнивайте требования с вашими навыками: {top_skills or 'список из разбора'}.",
            ),
            _plan_step(
                "Докрутите портфолио",
                "Обновите кейс или проект с этапа 2 по обратной связи с откликов и собеседований.",
            ),
        ]
    if s3_advice:
        s3_plan.append(_plan_step("Из ваших советов", s3_advice[-1][:200]))

    def _stage(
        *,
        stage: int,
        title: str,
        subtitle: str,
        intro: str,
        horizon: str,
        focus_tags: List[str],
        plan: List[Dict[str, str]],
        checklist: List[str],
        when_next: str,
        path_steps: List[Dict[str, Any]],
        materials: List[Dict[str, Any]],
        continues_from: Optional[str] = None,
        advice_refs: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        route = _path_route(path_steps)
        return {
            "stage": stage,
            "title": title,
            "subtitle": subtitle,
            "intro": intro,
            "body": intro,
            "horizon": horizon,
            "focus_tags": focus_tags,
            "plan": plan,
            "checklist": checklist,
            "milestones": checklist,
            "when_next": when_next,
            "path_route": route,
            "path_steps": [str(s.get("title") or "") for s in path_steps if s.get("title")][:4],
            "readiness_percent": readiness_percent,
            "preparation_level": preparation_level,
            "priority_skills": priority[:3],
            "linked_plan_id": plan_id,
            "advice_refs": advice_refs or [],
            "materials": materials,
            "continues_from": continues_from,
        }

    if school:
        return [
            _stage(
                stage=1,
                title="Уточните маршрут и базу",
                subtitle=f"К «{plan_name}»",
                intro=s1_intro,
                horizon=horizon_1,
                focus_tags=["Старт", _prep_label(preparation_level).capitalize()],
                plan=s1_plan[:4],
                checklist=[
                    "3 сильные стороны из школы/хобби",
                    "Выбран один предмет или кружок на месяц",
                    f"Пройден «{first_path}» или один материал из списка",
                ],
                when_next=(
                    "Когда понятно, какой маршрут ближе, и есть первый результат по предмету "
                    f"({first_path})."
                ),
                path_steps=s1_path,
                materials=s1_mats,
                advice_refs=advice_lines[:1],
            ),
            _stage(
                stage=2,
                title="Предметы и пробный опыт",
                subtitle=f"Подтягиваем: {top_skills[:50] or 'предметы из разбора'}",
                intro=(
                    f"Этап 2 — закрепить маршрут «{plan_name}» через предметы и мини-опыт "
                    "(кружок, проект, олимпиада)."
                ),
                horizon="2–6 недель",
                focus_tags=["Предметы", "Практика"],
                plan=s2_plan[:4],
                checklist=[
                    f"1–2 предмета к маршруту «{plan_name}»",
                    "Мини-кейс: кружок / проект / олимпиада в 5 строк",
                    "Список требований колледжа/профиля мечты",
                ],
                when_next="Когда есть понятный предметный фокус и один пробный опыт по маршруту.",
                path_steps=s2_path,
                materials=s2_mats,
                continues_from="С этапа 1: интересы → один предмет на месяц",
                advice_refs=s2_advice[:2],
            ),
            _stage(
                stage=3,
                title="Проверка поступления",
                subtitle=f"Колледж / профиль · {plan_name[:40]}",
                intro=(
                    f"Этап 3 — проверить «{plan_name}» вживую: день открытых дверей, "
                    "требования к экзаменам и разговор с родителями или школой."
                ),
                horizon="1–3 месяца",
                focus_tags=["Поступление", "Выбор"],
                plan=s3_plan[:4],
                checklist=[
                    "Один контакт с колледжем/профилем (день открытых или консультация)",
                    "Предметы сопоставлены с требованиями поступления",
                    "План на семестр: маршрут + предмет + дата обсуждения",
                ],
                when_next="Когда выбран один маршрут и понятно, что сдавать/подтягивать дальше.",
                path_steps=s3_path,
                materials=s3_mats,
                continues_from="С этапа 2: предметы и опыт → проверка поступления",
                advice_refs=s3_advice[-1:] if s3_advice else [],
            ),
        ]

    if vocational:
        return [
            _stage(
                stage=1,
                title="Уточните фокус по специальности",
                subtitle=f"К «{plan_name}»",
                intro=s1_intro,
                horizon=horizon_1,
                focus_tags=["Старт", _prep_label(preparation_level).capitalize()],
                plan=s1_plan[:4],
                checklist=[
                    "3–5 сильных сторон из учёбы и практики",
                    "Выбран один навык или место практики на месяц",
                    f"Пройден «{first_path}» или один материал из списка",
                ],
                when_next=(
                    "Когда понятен фокус и есть первый результат по специальности "
                    f"({first_path})."
                ),
                path_steps=s1_path,
                materials=s1_mats,
                advice_refs=advice_lines[:1],
            ),
            _stage(
                stage=2,
                title="Практика и учебный кейс",
                subtitle=f"Подтягиваем: {top_skills[:50] or 'навыки из разбора'}",
                intro=(
                    f"Этап 2 — закрепить «{plan_name}» через практику и кейс, "
                    "который можно показать на стажировке."
                ),
                horizon="2–6 недель",
                focus_tags=["Практика", "Кейс"],
                plan=s2_plan[:4],
                checklist=[
                    f"1–2 навыка к маршруту «{plan_name}»",
                    "Учебный кейс в 5–8 строк",
                    "Черновик резюме студента (3 пункта)",
                ],
                when_next="Когда есть кейс и понятный следующий шаг по практике.",
                path_steps=s2_path,
                materials=s2_mats,
                continues_from="С этапа 1: фокус → практика и кейс",
                advice_refs=s2_advice[:2],
            ),
            _stage(
                stage=3,
                title="Практика и стажировка",
                subtitle=f"Выход · {plan_name[:40]}",
                intro=(
                    f"Этап 3 — проверить «{plan_name}» вживую: практика, стажировка "
                    "или разговор с куратором."
                ),
                horizon="1–3 месяца",
                focus_tags=["Стажировка", "Практика"],
                plan=s3_plan[:4],
                checklist=[
                    "Один контакт по практике/стажировке",
                    "Требования сопоставлены с навыками из разбора",
                    "План на семестр: маршрут + навык + дата с куратором",
                ],
                when_next="Когда есть место практики/стажировки или чёткий список, что докрутить.",
                path_steps=s3_path,
                materials=s3_mats,
                continues_from="С этапа 2: кейс → практика и стажировка",
                advice_refs=s3_advice[-1:] if s3_advice else [],
            ),
        ]

    return [
        _stage(
            stage=1,
            title="Разберитесь с собой и заложите базу",
            subtitle=f"К «{plan_name}» · план {plan_id}",
            intro=s1_intro,
            horizon=horizon_1,
            focus_tags=["Старт", _prep_label(preparation_level).capitalize()],
            plan=s1_plan[:4],
            checklist=[
                "5 сильных сторон — с примерами из жизни",
                "Коротко: что для вас важно в работе (рост, стабильность, творчество…)",
                f"Пройден «{first_path}» или один материал из списка ниже",
            ],
            when_next=(
                "Когда понятно, что вас мотивирует, и есть первый результат обучения "
                f"({first_path})."
            ),
            path_steps=s1_path,
            materials=s1_mats,
            advice_refs=advice_lines[:1],
        ),
        _stage(
            stage=2,
            title="Практика и резюме",
            subtitle=f"Подтягиваем: {top_skills[:50] or 'пункты из разбора'}",
            intro=(
                f"Этап 2 — из «кто я» к «что могу показать работодателю» по направлению «{plan_name}». "
                "Опирайтесь на сильные стороны с этапа 1 в формулировках резюме."
            ),
            horizon="2–6 недель",
            focus_tags=["Практика", "Резюме"],
            plan=s2_plan[:4],
            checklist=[
                f"Черновик резюме под «{plan_name}»",
                "3 достижения с фактом или цифрой",
                "Артефакт практики: репозиторий, кейс или макет",
            ],
            when_next="Когда резюме можно показать наставнику или другу, и есть ссылка на работу (GitHub, Behance, документ).",
            path_steps=s2_path,
            materials=s2_mats,
            continues_from="С этапа 1: сильные стороны и ценности → три пункта в резюме",
            advice_refs=s2_advice[:2],
        ),
        _stage(
            stage=3,
            title="Рынок и закрепление направления",
            subtitle=f"Отклики · {plan_name[:40]}",
            intro=(
                f"Этап 3 — проверка «{plan_name}» на реальном рынке. "
                "Резюме и практика с этапа 2 — основа для откликов."
            ),
            horizon="1–3 месяца",
            focus_tags=["Отклики", "Собеседования"],
            plan=s3_plan[:4],
            checklist=[
                "5–12 целевых откликов (по уровню готовности)",
                "2–3 разговора с работодателем или на стажировку",
                "Портфолио обновлено по обратной связи",
            ],
            when_next="Когда есть стажировка, оффер или чёткий список навыков, которые докрутить дальше.",
            path_steps=s3_path,
            materials=s3_mats,
            continues_from="С этапа 2: резюме + практика → точечные отклики",
            advice_refs=s3_advice[-1:] if s3_advice else [],
        ),
    ]
