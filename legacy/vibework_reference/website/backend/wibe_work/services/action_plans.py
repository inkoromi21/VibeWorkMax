"""Календарный план по запросу: разбор JSON LLM, даты, запасной план без модели."""

from __future__ import annotations

import json
import re
import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Any, Literal

HORIZON_MIN = 7
HORIZON_MAX = 180
STAGES_MIN = 4
STAGES_MAX = 12
DEFAULT_HORIZON_DAYS = 28
HISTORY_MAX = 3

_FENCE_RE = re.compile(r"```(?:json)?\s*([\s\S]*?)```", re.I)
_DAYS_RE = re.compile(r"(\d+)\s*(?:дн(?:я|ей)?|день)", re.I)
_WEEKS_RE = re.compile(r"(\d+)\s*недел", re.I)
_MONTHS_RE = re.compile(r"(\d+)\s*месяц", re.I)
_ONE_MONTH_RE = re.compile(r"(?:на\s+)?месяц", re.I)
_HALF_YEAR_RE = re.compile(r"полгода", re.I)
_REMARKS_REWRITE_RE = re.compile(
    r"не\s+хоч|не\s+нрав|не\s+хочу|без\s+англий|не\s+учить|убери|не\s+нужен",
    re.I,
)


def analysis_looks_valid(analysis: Any) -> bool:
    if not isinstance(analysis, dict) or not analysis:
        return False
    return bool(
        analysis.get("ai_narrative")
        or analysis.get("profile_summary")
        or analysis.get("analysis_mode")
        or analysis.get("directions")
        or analysis.get("weekly_roadmap")
    )


def infer_horizon_days(user_request: str, default: int = DEFAULT_HORIZON_DAYS) -> int:
    text = (user_request or "").strip()
    if _HALF_YEAR_RE.search(text):
        return _clamp_horizon(180)
    m = _MONTHS_RE.search(text)
    if m:
        return _clamp_horizon(int(m.group(1)) * 30)
    if _MONTHS_RE.search(text) is None and _ONE_MONTH_RE.search(text):
        return _clamp_horizon(30)
    m = _WEEKS_RE.search(text)
    if m:
        return _clamp_horizon(int(m.group(1)) * 7)
    m = _DAYS_RE.search(text)
    if m:
        return _clamp_horizon(int(m.group(1)))
    return _clamp_horizon(default)


def _clamp_horizon(days: int) -> int:
    return max(HORIZON_MIN, min(HORIZON_MAX, int(days)))


def parse_plan_llm_json(raw: str | None) -> dict[str, Any] | None:
    text = (raw or "").strip()
    if not text:
        return None
    m = _FENCE_RE.search(text)
    if m:
        text = m.group(1).strip()
    start = text.find("{")
    end = text.rfind("}")
    if start >= 0 and end > start:
        text = text[start : end + 1]
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return None
    if not isinstance(data, dict):
        return None
    stages = data.get("stages")
    if not isinstance(stages, list) or not stages:
        return None
    return data


def plan_created_date(created_at: datetime) -> date:
    if created_at.tzinfo is None:
        created_at = created_at.replace(tzinfo=timezone.utc)
    try:
        from zoneinfo import ZoneInfo

        return created_at.astimezone(ZoneInfo("Europe/Moscow")).date()
    except Exception:
        return created_at.date()


def stamp_stage_dates(
    stages: list[dict[str, Any]],
    *,
    created_at: datetime,
    horizon_days: int,
) -> list[dict[str, Any]]:
    start = plan_created_date(created_at)
    horizon = _clamp_horizon(horizon_days)
    n = len(stages)
    fallback = [max(1, round(horizon * (i + 1) / max(n, 1))) for i in range(n)]
    prev = 0
    out: list[dict[str, Any]] = []
    for i, raw in enumerate(stages[:STAGES_MAX]):
        title = str(raw.get("title") or "").strip() or f"Этап {i + 1}"
        details = str(raw.get("details") or raw.get("description") or "").strip()
        try:
            offset = int(raw.get("offset_days"))
        except (TypeError, ValueError):
            offset = fallback[i]
        offset = max(prev + 1, min(horizon, offset))
        prev = offset
        due = start + timedelta(days=offset)
        sid = str(raw.get("id") or "").strip() or f"st-{uuid.uuid4().hex[:10]}"
        out.append(
            {
                "id": sid,
                "title": title[:180],
                "details": details[:600],
                "offset_days": offset,
                "due_date": due.isoformat(),
                "completed": bool(raw.get("completed")),
                "completed_at": raw.get("completed_at") if raw.get("completed") else None,
            }
        )
    return out


def assemble_action_plan(
    *,
    user_request: str,
    parsed: dict[str, Any],
    created_at: datetime,
    source: Literal["llm", "mock"] = "llm",
    notice: str | None = None,
    inferred_horizon: int | None = None,
) -> dict[str, Any]:
    horizon = inferred_horizon or infer_horizon_days(user_request)
    try:
        llm_h = int(parsed.get("horizon_days"))
        if HORIZON_MIN <= llm_h <= HORIZON_MAX:
            horizon = llm_h
    except (TypeError, ValueError):
        pass
    raw_stages = parsed.get("stages") if isinstance(parsed.get("stages"), list) else []
    if len(raw_stages) < STAGES_MIN:
        have = {str(s.get("title") or "").strip().lower() for s in raw_stages if isinstance(s, dict)}
        for pad in _generic_stages(str(parsed.get("analysis_mode") or "career"), horizon):
            if pad["title"].lower() in have:
                continue
            raw_stages.append(pad)
            if len(raw_stages) >= STAGES_MIN:
                break
    stages = stamp_stage_dates(raw_stages, created_at=created_at, horizon_days=horizon)
    created_iso = _iso(created_at)
    title = str(parsed.get("title") or "").strip() or _default_title(user_request)
    explanation = str(parsed.get("explanation") or "").strip()
    return {
        "id": f"plan-{uuid.uuid4().hex[:12]}",
        "title": title[:120],
        "user_request": (user_request or "").strip()[:2000],
        "created_at": created_iso,
        "horizon_days": horizon,
        "stages": stages,
        "source": source,
        "notice": notice,
        "explanation": explanation[:2500],
        "test_insight": None,
        "test_id": None,
        "test_title": None,
    }


def remarks_force_full_rewrite(user_request: str, remarks: list[str] | None) -> bool:
    blob = " ".join([user_request or ""] + [str(x) for x in (remarks or []) if str(x).strip()])
    return bool(_REMARKS_REWRITE_RE.search(blob)) or bool(remarks)


def mock_plan_from_analysis(
    analysis: dict[str, Any],
    user_request: str,
    created_at: datetime,
    *,
    notice: str | None = None,
    remarks: list[str] | None = None,
    rewrite: bool = False,
    continue_plan: bool = False,
    completed_stages: list[dict[str, Any]] | None = None,
    profile_extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    horizon = infer_horizon_days(user_request)
    stages_src: list[dict[str, Any]] = []
    skip_weekly = rewrite or continue_plan or remarks_force_full_rewrite(user_request, remarks)
    if continue_plan:
        stages_src = mock_continue_stages(
            analysis,
            profile_extra=profile_extra,
            completed_stages=completed_stages,
            today=plan_created_date(created_at),
            horizon=horizon,
        )
    weekly = analysis.get("weekly_roadmap") or []
    if not skip_weekly and isinstance(weekly, list):
        for i, w in enumerate(weekly[:8]):
            if not isinstance(w, dict):
                continue
            title = str(w.get("week_range") or w.get("period") or f"Неделя {i + 1}").strip()
            bits = []
            for key in ("learn", "practice", "outcome"):
                val = str(w.get(key) or "").strip()
                if val:
                    bits.append(val)
            topics = w.get("topics") or []
            if not bits and isinstance(topics, list):
                bits = [str(t).strip() for t in topics if str(t).strip()]
            stages_src.append(
                {
                    "title": title[:180],
                    "details": " ".join(bits)[:600],
                    "offset_days": min(horizon, 7 * (i + 1)),
                }
            )
    if not skip_weekly and len(stages_src) < STAGES_MIN:
        career = analysis.get("career_stages") or analysis.get("growth_stages_rich") or []
        if isinstance(career, list):
            for i, s in enumerate(career):
                if not isinstance(s, dict):
                    continue
                title = str(s.get("title") or "").strip()
                if not title:
                    continue
                details = str(s.get("description") or s.get("subtitle") or "").strip()
                stages_src.append(
                    {
                        "title": title[:180],
                        "details": details[:600],
                        "offset_days": min(horizon, max(7, round(horizon * (i + 1) / 4))),
                    }
                )
    mode = str(analysis.get("analysis_mode") or "career")
    if len(stages_src) < STAGES_MIN:
        stages_src.extend(_generic_stages(mode, horizon))
    parsed = {
        "title": "Следующий этап плана" if continue_plan else _default_title(user_request),
        "horizon_days": horizon,
        "stages": stages_src[:STAGES_MAX],
        "explanation": mock_explanation(
            analysis,
            user_request,
            remarks=remarks,
            rewrite=skip_weekly,
            continue_plan=continue_plan,
        ),
        "analysis_mode": mode,
    }
    return assemble_action_plan(
        user_request=user_request,
        parsed=parsed,
        created_at=created_at,
        source="mock",
        notice=notice or "Показан запасной план без нейросети.",
        inferred_horizon=horizon,
    )


def compact_plan_context(
    analysis: dict[str, Any],
    profile_extra: dict[str, Any] | None,
    *,
    include_weekly: bool = True,
) -> str:
    lines: list[str] = []
    mode = str(analysis.get("analysis_mode") or "")
    depth = str(analysis.get("analysis_depth") or "")
    if mode or depth:
        lines.append(f"Режим разбора: {mode or '—'}; глубина: {depth or '—'}")
    summary = str(analysis.get("profile_summary") or "").strip()
    if summary:
        lines.append("Профиль: " + summary[:900])
    extra = profile_extra if isinstance(profile_extra, dict) else {}
    for key, label in (
        ("city", "Город"),
        ("course_grade", "Класс/курс"),
        ("education_detail", "Образование"),
        ("post_school_goal", "После школы"),
        ("post_spo_goal", "После колледжа"),
        ("hours_per_week", "Часов в неделю"),
        ("favorite_subjects", "Предметы"),
        ("main_sphere", "Сфера"),
    ):
        val = extra.get(key)
        if val is None or val == "" or val == []:
            continue
        if isinstance(val, list):
            val = ", ".join(str(x) for x in val[:8] if x)
        lines.append(f"{label}: {val}")
    if include_weekly:
        narrative = str(analysis.get("ai_narrative") or "").strip()
        if narrative:
            lines.append("Вывод разбора: " + narrative[:700])
    dirs = analysis.get("directions") or []
    if isinstance(dirs, list) and dirs:
        dir_bits = []
        for d in dirs[:3]:
            if not isinstance(d, dict):
                continue
            name = d.get("name") or ""
            code = d.get("plan_code") or ""
            score = d.get("match_score")
            bit = f"{code} {name}".strip()
            if score is not None:
                bit += f" ({score}%)"
            if bit:
                dir_bits.append(bit)
        if dir_bits:
            lines.append("Сценарии: " + "; ".join(dir_bits))
    if include_weekly:
        gap = analysis.get("gap_analysis") or {}
        if isinstance(gap, dict):
            closing = gap.get("closing_skills") or []
            if closing:
                lines.append("Подтянуть: " + ", ".join(str(x) for x in closing[:6]))
            head = str(gap.get("headline") or "").strip()
            if head:
                lines.append("Разрыв: " + head[:240])
        weekly = analysis.get("weekly_roadmap") or []
        if isinstance(weekly, list) and weekly:
            wk = []
            for w in weekly[:4]:
                if not isinstance(w, dict):
                    continue
                title = w.get("week_range") or ""
                learn = w.get("learn") or ""
                topics = w.get("topics") or []
                extra_t = ", ".join(str(t) for t in topics[:3]) if isinstance(topics, list) else ""
                wk.append(f"{title}: {learn or extra_t}".strip(": "))
            if wk:
                lines.append(
                    "Черновик недель (не добавляй из него предметы и языки, которых нет в анкете и запросе): "
                    + " | ".join(wk)[:500]
                )
    return "\n".join(lines) or "Данных мало — опирайся на запрос."


def compact_test_insight_context(
    analysis: dict[str, Any],
    profile_extra: dict[str, Any] | None,
) -> str:
    """Фон для отчёта по тесту — без сценариев A/B/C и советов."""
    lines: list[str] = []
    mode = str(analysis.get("analysis_mode") or "")
    if mode:
        lines.append(f"Режим разбора: {mode}")
    extra = profile_extra if isinstance(profile_extra, dict) else {}
    for key, label in (
        ("course_grade", "Класс/курс"),
        ("favorite_subjects", "Предметы из анкеты"),
        ("main_sphere", "Сфера"),
    ):
        val = extra.get(key)
        if val is None or val == "" or val == []:
            continue
        if isinstance(val, list):
            val = ", ".join(str(x) for x in val[:8] if x)
        lines.append(f"{label}: {val}")
    radar = analysis.get("style_radar") or {}
    axes = radar.get("axes") if isinstance(radar, dict) else None
    if isinstance(axes, list) and axes:
        bits = []
        for ax in axes[:6]:
            if not isinstance(ax, dict):
                continue
            lab = str(ax.get("label") or ax.get("key") or "").strip()
            if lab:
                bits.append(lab)
        if bits:
            lines.append("Стиль в задачах: " + ", ".join(bits))
    return "\n".join(lines) or "Данных мало — опиши только сам тест."


def mock_explanation(
    analysis: dict[str, Any],
    user_request: str,
    *,
    remarks: list[str] | None = None,
    rewrite: bool = False,
    continue_plan: bool = False,
) -> str:
    dirs = analysis.get("directions") or []
    name = ""
    if isinstance(dirs, list) and dirs and isinstance(dirs[0], dict):
        name = str(dirs[0].get("name") or "").strip()
    route = name or "рекомендуемый маршрут"
    narrative = str(analysis.get("ai_narrative") or "").strip()
    bits = [
        f"Рекомендуемый ориентир — «{route}».",
        "Это конкретный следующий шаг в учёбе или навыках, а не портрет личности.",
    ]
    if continue_plan:
        bits.append(
            "Прошлые шаги отмечены выполненными — ниже новый этап с учётом сезона и уже сделанного."
        )
    elif narrative and not rewrite:
        bits.append(narrative[:420])
    if rewrite and not continue_plan:
        bits.append("Совет пересобран целиком по вашему уточнению — без отвергнутых пунктов.")
    elif not continue_plan:
        bits.append("Что готовить: один фокус на ближайшие 1–2 недели и разговор с тем, кто поможет выбрать.")
    req = (user_request or "").strip()
    if req:
        bits.append("Учли пожелание: " + req[:220])
    notes = [str(x).strip() for x in (remarks or []) if str(x).strip()]
    if notes:
        bits.append("Замечание: " + notes[-1][:220])
    return " ".join(bits)[:2500]


def mock_test_insight(analysis: dict[str, Any], new_test: dict[str, Any] | None) -> str:
    test = new_test if isinstance(new_test, dict) else {}
    title = str(test.get("title") or "пройденный тест").strip()
    kind = str(test.get("kind") or "").strip()
    kind_bit = f" Тест типа «{kind}»." if kind else ""
    return (
        f"Тест «{title}» завершён.{kind_bit} "
        "Ниже — отчёт по ответам: что опросник измерил и какие интересы или склонности видны. "
        "Маршруты поступления и планы сюда не входят."
    )[:1200]


def parse_test_insight_json(raw: str | None) -> str | None:
    parsed = parse_plan_llm_json(raw) if raw else None
    if parsed:
        text = str(parsed.get("test_insight") or "").strip()
        if text:
            return text[:1200]
    text = (raw or "").strip()
    if not text:
        return None
    m = _FENCE_RE.search(text)
    if m:
        text = m.group(1).strip()
    start = text.find("{")
    end = text.rfind("}")
    if start >= 0 and end > start:
        try:
            data = json.loads(text[start : end + 1])
        except json.JSONDecodeError:
            data = None
        if isinstance(data, dict):
            insight = str(data.get("test_insight") or "").strip()
            if insight:
                return insight[:1200]
    return None


def compact_revision_block(
    *,
    previous_title: str | None = None,
    previous_explanation: str | None = None,
    completed_stages: list[dict[str, Any]] | None = None,
    previous_stages: list[dict[str, Any]] | None = None,
    remarks: list[str] | None = None,
    new_test: dict[str, Any] | None = None,
    calendar_hint: str | None = None,
) -> str:
    lines: list[str] = []
    if calendar_hint and str(calendar_hint).strip():
        lines.append("Календарь и сезон (обязательно учти в этапах): " + str(calendar_hint).strip()[:900])
    if previous_title:
        lines.append("Прошлый заголовок (заменить): " + previous_title.strip()[:200])
    if previous_explanation:
        lines.append(
            "Старый совет — ЗАМЕНИТЬ ЦЕЛИКОМ, не копировать отвергнутое: "
            + previous_explanation.strip()[:1200]
        )
    old_titles = []
    for s in previous_stages or []:
        if not isinstance(s, dict):
            continue
        title = str(s.get("title") or "").strip()
        if title:
            old_titles.append(title[:160])
    if old_titles:
        lines.append("Старые этапы (не переносить отвергнутые): " + "; ".join(old_titles[:12]))
    done = []
    for s in completed_stages or []:
        if not isinstance(s, dict):
            continue
        title = str(s.get("title") or "").strip()
        details = str(s.get("details") or "").strip()
        if title and details:
            done.append(f"{title[:100]} — {details[:120]}")
        elif title:
            done.append(title[:160])
    if done:
        lines.append(
            "Уже выполнено (сохранить в чеклисте, не повторять; строй следующий этап на базе этого): "
            + "; ".join(done[:12])
        )
    notes = [str(x).strip() for x in (remarks or []) if str(x).strip()]
    if notes:
        lines.append(
            "Замечания человека (жёсткие запреты, пересобери план с нуля): "
            + " | ".join(notes[-6:])[:1200]
        )
    if isinstance(new_test, dict) and new_test.get("title"):
        lines.append("Новый тест: " + str(new_test.get("title"))[:180])
    return "\n".join(lines)


def calendar_timing_hint(
    today: date | None = None,
    *,
    analysis_mode: str = "career",
    profile_extra: dict[str, Any] | None = None,
) -> str:
    """Подсказка по российскому учебному/приёмному календарю для этапов плана."""
    day = today or date.today()
    month = day.month
    mode = (analysis_mode or "career").strip().lower()
    extra = profile_extra if isinstance(profile_extra, dict) else {}
    course = str(extra.get("course_grade") or extra.get("course_or_grade") or "").strip()
    grade_num = None
    m = re.search(r"(\d{1,2})", course)
    if m:
        try:
            grade_num = int(m.group(1))
        except ValueError:
            grade_num = None

    bits: list[str] = [f"Сегодня: {day.isoformat()} (месяц {month})."]
    if course:
        bits.append(f"Класс/курс из анкеты: {course}.")

    if mode == "school":
        if month in (8, 9):
            bits.append(
                "Начало учебного года: расписание, диагностика пробелов, кружки/олимпиады. "
                "НЕ предлагай подавать документы в вуз/колледж — основная приёмная кампания уже прошла "
                "(июнь–начало августа). В сентябре — учёба и уточнение цели, не подача заявлений."
            )
        elif month in (10, 11, 12):
            bits.append(
                "Осень: углубление предметов, олимпиады, пробники. Документы на поступление сейчас не в фокусе."
            )
        elif month in (1, 2):
            bits.append(
                "Зима: регистрация на ЕГЭ/ОГЭ (если ещё не), пробники, закрытие пробелов по темам. "
                "Подача документов в вуз — не сейчас."
            )
        elif month in (3, 4):
            bits.append(
                "Весна: интенсив по экзаменам (конкретные темы и варианты), дни открытых дверей. "
                "Списки программ — да; подача документов — ближе к июню–июлю."
            )
        elif month == 5:
            bits.append(
                "Май: финальные пробники и повторение слабых тем. Документы в вуз — после экзаменов "
                "(июнь–июль), не сейчас."
            )
        elif month in (6, 7):
            bits.append(
                "Лето / экзамены: ЕГЭ/ОГЭ, затем подача документов и выбор вузов/колледжей по срокам приёма. "
                "Конкретные дедлайны и пакет документов — уместны."
            )
        else:
            bits.append(
                "Учитывай учебный год и приёмные окна РФ: документы — в сезон приёма, не «на всякий случай»."
            )
        if grade_num is not None and grade_num <= 9 and month in (5, 6, 7, 8):
            bits.append(
                "После 9 класса: колледж/СПО — приём обычно июнь–август; уточняй сроки конкретного колледжа."
            )
        if grade_num == 11 and month in (6, 7, 8):
            bits.append(
                "11 класс: после ЕГЭ — заявление в вузы (основная волна обычно до начала августа)."
            )
    elif mode == "vocational":
        goal = str(extra.get("post_spo_goal") or "").strip().lower()
        if month in (8, 9):
            bits.append(
                "Начало семестра: практика, диплом, сессия. Подача в вуз «прямо сейчас в сентябре» — обычно поздно "
                "для основной волны; сначала учёба и портфолио по специальности."
            )
        elif month in (10, 11, 12, 1, 2):
            bits.append(
                "Середина года: практика, тема диплома, навыки. Вступительные в вуз — готовить заранее, не подавать вне сезона."
            )
        elif month in (3, 4, 5):
            bits.append(
                "Весна: диплом, практика, выбор программ вуза или стажировок — по цели после колледжа."
            )
        else:
            bits.append(
                "Лето: защита/доделка диплома, подача в вуз или первые рабочие шаги — по цели из анкеты."
            )
        if "university" in goal or "вуз" in goal:
            bits.append("Цель — вуз: этапы про программы, вступительные/портфолио, а не массовый hh.")
        elif "work" in goal or "работ" in goal:
            bits.append("Цель — работа: практика, артефакт по специальности, резюме стажёра — без senior.")
    else:
        if month in (8, 9):
            bits.append(
                "Осень: учебный/проектный фокус; стажировки часто открываются к весне — сейчас навык и портфолио."
            )
        elif month in (10, 11, 12):
            bits.append(
                "Поздняя осень: конкретный проект/курс, не абстрактный «составь план обучения»."
            )
        elif month in (1, 2, 3):
            bits.append("Зима–весна: заявки на стажировки, хакатоны, учебные кейсы — с дедлайнами.")
        else:
            bits.append("Весна–лето: практика, итоговые проекты, заявки — с конкретными артефактами.")

    bits.append(
        "Запрещены абстракции: «составь план», «реши задания», «подтяни предмет» без темы. "
        "Нужны темы (например «квадратные уравнения», «ветвления в Python»), число вариантов, документ или встреча."
    )
    return " ".join(bits)


def mock_continue_stages(
    analysis: dict[str, Any],
    *,
    profile_extra: dict[str, Any] | None = None,
    completed_stages: list[dict[str, Any]] | None = None,
    today: date | None = None,
    horizon: int = DEFAULT_HORIZON_DAYS,
) -> list[dict[str, Any]]:
    """Конкретные следующие этапы после выполненного чеклиста (без LLM)."""
    day = today or date.today()
    mode = str(analysis.get("analysis_mode") or "career").strip().lower()
    extra = profile_extra if isinstance(profile_extra, dict) else {}
    done_keys = {
        re.sub(r"\s+", " ", str(s.get("title") or "").strip().lower())
        for s in (completed_stages or [])
        if isinstance(s, dict)
    }
    subjects = extra.get("favorite_subjects") or []
    if isinstance(subjects, list):
        subj_labels = [str(x).strip() for x in subjects if str(x).strip()][:3]
    else:
        subj_labels = []
    gap = analysis.get("gap_analysis") or {}
    closing = []
    if isinstance(gap, dict):
        closing = [str(x).strip() for x in (gap.get("closing_skills") or []) if str(x).strip()][:3]
    focus = subj_labels[0] if subj_labels else (closing[0] if closing else "основной предмет")
    focus2 = subj_labels[1] if len(subj_labels) > 1 else (closing[1] if len(closing) > 1 else focus)
    month = day.month

    pool: list[tuple[str, str]] = []
    if mode == "school":
        if month in (8, 9):
            pool = [
                (
                    f"Диагностика по «{focus}»: 2 варианта",
                    "Реши 2 пробных варианта (ФИПИ или школьный банк) по теме, где больше ошибок; выпиши 5 слабых пунктов.",
                ),
                (
                    f"Темы на 2 недели: {focus}",
                    "Составь список из 4 конкретных тем (не «весь предмет»): формулы, типы задач, типичные ошибки.",
                ),
                (
                    "Кружок или олимпиада — одна заявка",
                    "Найди 1 кружок/олимпиаду по интересу и запиши дату регистрации или ближайшее занятие.",
                ),
                (
                    "Разговор про цель после школы",
                    "15 минут с родителями или классным: колледж / 11 класс — зафиксируй одну рабочую гипотезу на бумаге.",
                ),
            ]
        elif month in (6, 7):
            pool = [
                (
                    "Пакет документов: чеклист приёмной",
                    "Скачай с сайта 1 вуза/колледжа список документов и отметь, чего не хватает (паспорт, аттестат, фото, согласие).",
                ),
                (
                    f"3 программы под «{focus}»",
                    "Выпиши 3 программы: название, предметы вступительных, ориентир по баллам.",
                ),
                (
                    "Календарь подачи заявлений",
                    "Отметь в календаре дедлайн основной волны выбранного вуза/колледжа (не «когда-нибудь»).",
                ),
                (
                    "Запасной вариант поступления",
                    "Один запасной колледж или программа на случай недобора — с контактами приёмной.",
                ),
            ]
        elif month in (1, 2, 3, 4, 5):
            pool = [
                (
                    f"Пробник «{focus}»: разобрать ошибки",
                    "Пройди 1 полный пробник; по каждой ошибке — тема + 3 аналогичные задачи.",
                ),
                (
                    f"Блок тем «{focus2}» за неделю",
                    f"Выбери 3 темы по «{focus2}», на каждую — конспект на 1 страницу и 5 задач.",
                ),
                (
                    "День открытых дверей или онлайн-консультация",
                    "Запишись или поставь напоминание на 1 мероприятие выбранного колледжа/вуза.",
                ),
                (
                    "Регистрация / проверка ЕГЭ-ОГЭ",
                    "Проверь статус регистрации или список предметов к сдаче; если всё готово — отметь дату следующего пробника.",
                ),
            ]
        else:
            pool = [
                (
                    f"Неделя фокуса: {focus}",
                    "4 слота по 40 минут: тема → теория 10 мин → 8–10 задач → разбор ошибок.",
                ),
                (
                    f"Слабое место: {focus2}",
                    "Одна тема, где больше всего ошибок; 15 задач только по ней.",
                ),
                (
                    "Список программ без подачи документов",
                    "3 колледжа/вуза: сайт, вступительные, что готовить — без заявления, если не сезон приёма.",
                ),
                (
                    "Мини-проект по интересу",
                    "Один артефакт за 2 недели: презентация, код, отчёт или макет — с названием темы.",
                ),
            ]
    elif mode == "vocational":
        pool = [
            (
                "Тема диплома / курсовой: 1 абзац",
                "Сформулируй тему и 3 источника; согласуй формулировку с руководителем на этой неделе.",
            ),
            (
                "Практика: один артефакт",
                "Отчёт, макет, репозиторий или конспект смены — с датой сдачи куратору.",
            ),
            (
                f"Навык: 3 упражнения по «{focus}»",
                "3 конкретных упражнения или задачи из методички, не «подтянуть предмет».",
            ),
            (
                "Следующий горизонт после колледжа",
                "Если вуз — 2 программы и вступительные; если работа — черновик резюме стажёра и 1 место практики.",
            ),
        ]
        if month in (6, 7, 8):
            pool[3] = (
                "Документы / заявка по цели",
                "Только если сейчас окно приёма или стажировок: чеклист документов и дата отправки. Иначе — подготовка пакета.",
            )
    else:
        pool = [
            (
                f"Учебный блок: {focus}",
                "5 конкретных подтем; по каждой — конспект и мини-упражнение (не «изучи курс целиком»).",
            ),
            (
                "Артефакт за 2 недели",
                "Один проверяемый результат: репозиторий, кейс, презентация или разбор — с названием.",
            ),
            (
                "Обратная связь",
                "Покажи артефакт наставнику/однокурснику; запиши 3 правки.",
            ),
            (
                "Календарь слотов на месяц",
                "2 слота в неделю в календаре: тема + длительность + критерий «готово».",
            ),
        ]

    out: list[dict[str, Any]] = []
    n = max(1, len(pool))
    for i, (title, details) in enumerate(pool):
        key = re.sub(r"\s+", " ", title.strip().lower())
        if key in done_keys:
            continue
        out.append(
            {
                "title": title,
                "details": details,
                "offset_days": max(1, round(horizon * (len(out) + 1) / n)),
            }
        )
    if len(out) < STAGES_MIN:
        for pad in _generic_stages(mode, horizon):
            key = re.sub(r"\s+", " ", pad["title"].strip().lower())
            if key in done_keys or any(
                re.sub(r"\s+", " ", x["title"].strip().lower()) == key for x in out
            ):
                continue
            out.append(pad)
            if len(out) >= STAGES_MIN:
                break
    return out[:STAGES_MAX]


def assemble_test_insight_plan(
    *,
    user_request: str,
    insight: str,
    created_at: datetime,
    source: Literal["llm", "mock"] = "mock",
    notice: str | None = None,
    new_test: dict[str, Any] | None = None,
) -> dict[str, Any]:
    test = new_test if isinstance(new_test, dict) else {}
    return {
        "id": f"insight-{uuid.uuid4().hex[:12]}",
        "title": "По результатам новых тестов",
        "user_request": (user_request or "").strip()[:2000],
        "created_at": _iso(created_at),
        "horizon_days": 7,
        "stages": [],
        "source": source,
        "notice": notice,
        "explanation": "",
        "test_insight": (insight or "").strip()[:1200],
        "test_id": str(test.get("id") or "")[:80] or None,
        "test_title": str(test.get("title") or "")[:180] or None,
    }


def _generic_stages(mode: str, horizon: int) -> list[dict[str, Any]]:
    if mode == "school":
        titles = [
            (
                "Пробник по главному предмету",
                "1 вариант ФИПИ или школьный: выпиши темы ошибок и по 3 задачи на каждую.",
            ),
            (
                "4 темы на 2 недели",
                "Не «весь предмет», а 4 названия тем + слот в календаре на каждую.",
            ),
            (
                "Список из 2 программ поступления",
                "Сайт, вступительные предметы, что готовить — без подачи документов вне сезона приёма.",
            ),
            (
                "Разговор 15 минут",
                "С родителями или классным: одна рабочая цель после школы и дата следующего шага.",
            ),
        ]
    elif mode == "vocational":
        titles = [
            (
                "Тема диплома: формулировка",
                "1 абзац темы + 3 источника; согласовать с руководителем на этой неделе.",
            ),
            (
                "Артефакт практики",
                "Отчёт, макет или репозиторий — с датой сдачи куратору.",
            ),
            (
                "3 упражнения по слабому навыку",
                "Конкретные задания из методички, не «подтянуть специальность».",
            ),
            (
                "Горизонт после колледжа",
                "2 программы вуза или 1 место практики — с дедлайном, если сейчас сезон.",
            ),
        ]
    else:
        titles = [
            (
                "5 подтем учебного блока",
                "Список подтем + конспект и мини-упражнение по каждой.",
            ),
            (
                "Артефакт за 2 недели",
                "Репозиторий, кейс или презентация с названием — проверяемый результат.",
            ),
            (
                "Разбор 1 вакансии/стажировки",
                "Требования → что уже умеешь → 3 пункта к закрытию.",
            ),
            (
                "2 слота в календаре",
                "Тема + длительность + критерий «готово» на ближайшие 14 дней.",
            ),
        ]
    n = len(titles)
    return [
        {
            "title": t,
            "details": d,
            "offset_days": max(1, round(horizon * (i + 1) / n)),
        }
        for i, (t, d) in enumerate(titles)
    ]


def _default_title(user_request: str) -> str:
    text = re.sub(r"\s+", " ", (user_request or "").strip())
    if len(text) >= 8:
        return (text[:72] + "…") if len(text) > 72 else text
    return "План на ближайшие недели"


def _iso(created_at: datetime) -> str:
    if created_at.tzinfo is None:
        created_at = created_at.replace(tzinfo=timezone.utc)
    return created_at.isoformat()
