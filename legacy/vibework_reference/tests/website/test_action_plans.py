"""Генерация календарного плана: даты, JSON LLM, fallback без модели."""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import AsyncMock, patch

_REPO = Path(__file__).resolve().parents[2]
_WEBSITE = _REPO / "website"
_BACKEND = _WEBSITE / "backend"
for p in (str(_WEBSITE), str(_BACKEND)):
    if p not in sys.path:
        sys.path.insert(0, p)


def test_infer_horizon_and_stamp_dates():
    from wibe_work.services.action_plans import (
        infer_horizon_days,
        stamp_stage_dates,
    )

    assert infer_horizon_days("хочу план на 8 недель") == 56
    assert infer_horizon_days("на 2 месяца") == 60
    assert infer_horizon_days("за 10 дней") == 10
    assert infer_horizon_days("просто план") == 28
    assert infer_horizon_days("на 1 день") == 7

    created = datetime(2026, 8, 14, 10, 0, tzinfo=timezone.utc)
    stages = stamp_stage_dates(
        [
            {"title": "A", "details": "one", "offset_days": 7},
            {"title": "B", "details": "two", "offset_days": 14},
        ],
        created_at=created,
        horizon_days=28,
    )
    assert stages[0]["due_date"] == "2026-08-21"
    assert stages[1]["due_date"] == "2026-08-28"
    assert stages[0]["offset_days"] == 7
    assert stages[1]["offset_days"] == 14


def test_parse_llm_json_and_assemble():
    from wibe_work.services.action_plans import assemble_action_plan, parse_plan_llm_json

    raw = """```json
    {"title": "К вузу", "horizon_days": 28, "stages": [
      {"title": "Список вузов", "details": "3 варианта", "offset_days": 5},
      {"title": "Предметы", "details": "математика", "offset_days": 12},
      {"title": "Пробник", "details": "вариант ФИПИ", "offset_days": 20},
      {"title": "Разговор", "details": "с классным", "offset_days": 28}
    ]}
    ```"""
    parsed = parse_plan_llm_json(raw)
    assert parsed and parsed["title"] == "К вузу"
    created = datetime(2026, 8, 14, 8, 0, tzinfo=timezone.utc)
    plan = assemble_action_plan(
        user_request="план на 4 недели к выбору вуза",
        parsed=parsed,
        created_at=created,
        source="llm",
    )
    assert plan["source"] == "llm"
    assert plan["horizon_days"] == 28
    assert len(plan["stages"]) == 4
    assert plan["stages"][-1]["due_date"] == "2026-09-11"
    assert "explanation" in plan


def test_mock_plan_includes_explanation():
    from wibe_work.services.action_plans import mock_plan_from_analysis

    analysis = {
        "analysis_mode": "career",
        "ai_narrative": "Подходит бэкенд.",
        "directions": [{"plan_code": "A", "name": "Бэкенд-разработка", "match_score": 80}],
    }
    created = datetime(2026, 8, 14, tzinfo=timezone.utc)
    plan = mock_plan_from_analysis(analysis, "мне не нравится фронтенд", created)
    assert "бэкенд" in plan["explanation"].lower() or "Бэкенд" in plan["explanation"]
    assert plan["explanation"]


def test_mock_plan_uses_weekly_roadmap():
    from wibe_work.services.action_plans import mock_plan_from_analysis

    analysis = {
        "analysis_mode": "school",
        "ai_narrative": "Короткий вывод",
        "weekly_roadmap": [
            {"week_range": "Неделя 1", "learn": "Алгебра", "topics": []},
            {"week_range": "Неделя 2", "learn": "Геометрия", "topics": []},
            {"week_range": "Неделя 3", "learn": "Физика", "topics": []},
            {"week_range": "Неделя 4", "learn": "Пробник", "topics": []},
        ],
    }
    created = datetime(2026, 8, 14, tzinfo=timezone.utc)
    plan = mock_plan_from_analysis(analysis, "план на месяц", created)
    assert plan["source"] == "mock"
    assert plan["horizon_days"] == 30
    titles = [s["title"] for s in plan["stages"]]
    assert "Неделя 1" in titles
    assert all(s["due_date"] for s in plan["stages"])


def test_horizon_clamp():
    from wibe_work.services.action_plans import infer_horizon_days

    assert infer_horizon_days("на 24 месяца") == 180
    assert infer_horizon_days("полгода") == 180


def test_generate_endpoint_requires_analysis():
    from fastapi.testclient import TestClient

    from app.main import app

    client = TestClient(app)
    r = client.post(
        "/api/plans/generate",
        json={"user_request": "план на месяц", "analysis": {}},
    )
    assert r.status_code == 422


@patch("app.plans_bridge.llm_configured", return_value=True)
@patch(
    "app.plans_bridge.fetch_llm_completion",
    new_callable=AsyncMock,
    return_value=(
        json.dumps(
            {
                "title": "Месяц к цели",
                "horizon_days": 28,
                "stages": [
                    {"title": "Шаг 1", "details": "a", "offset_days": 7},
                    {"title": "Шаг 2", "details": "b", "offset_days": 14},
                    {"title": "Шаг 3", "details": "c", "offset_days": 21},
                    {"title": "Шаг 4", "details": "d", "offset_days": 28},
                ],
            }
        ),
        None,
    ),
)
def test_generate_endpoint_llm(_fetch, _cfg):
    from fastapi.testclient import TestClient

    from app.main import app

    client = TestClient(app)
    r = client.post(
        "/api/plans/generate",
        json={
            "user_request": "план на 4 недели",
            "analysis": {
                "analysis_mode": "career",
                "ai_narrative": "Подходит бэкенд.",
                "directions": [{"plan_code": "A", "name": "Бэкенд", "match_score": 80}],
            },
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["source"] == "llm"
    assert body["title"] == "Месяц к цели"
    assert len(body["stages"]) == 4
    assert body["stages"][0]["due_date"]
    assert body.get("explanation")


@patch("app.plans_bridge.llm_configured", return_value=False)
def test_generate_endpoint_mock_without_llm(_cfg):
    from fastapi.testclient import TestClient

    from app.main import app

    client = TestClient(app)
    r = client.post(
        "/api/plans/generate",
        json={
            "user_request": "план на 4 недели",
            "analysis": {"analysis_mode": "school", "ai_narrative": "Учись дальше."},
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["source"] == "mock"
    assert len(body["stages"]) >= 4
    assert all(s.get("due_date") for s in body["stages"])
    assert body.get("explanation")


@patch("app.plans_bridge.llm_configured", return_value=False)
def test_test_insight_endpoint_mock(_cfg):
    from fastapi.testclient import TestClient

    from app.main import app

    client = TestClient(app)
    r = client.post(
        "/api/plans/generate",
        json={
            "user_request": "что меняет тест ценностей",
            "intent": "test_insight",
            "new_test": {"id": "personality", "title": "Ценности и стиль", "kind": "personality"},
            "analysis": {
                "analysis_mode": "school",
                "ai_narrative": "Маршрут — 11 класс и информатика.",
                "directions": [{"plan_code": "A", "name": "11 класс + информатика", "match_score": 70}],
            },
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["source"] == "mock"
    assert body.get("test_insight")
    assert "Ценности" in body["test_insight"] or "ценност" in body["test_insight"].lower()
    assert body.get("test_id") == "personality"
    assert body.get("stages") == []
    assert "английск" not in body["test_insight"].lower()


def test_test_insight_context_skips_plan_advice():
    from wibe_work.services.action_plans import compact_plan_context, compact_test_insight_context

    analysis = {
        "analysis_mode": "school",
        "ai_narrative": "Добавьте английский для КемГУ.",
        "weekly_roadmap": [{"week_range": "Неделя 1", "learn": "Два часа английского"}],
        "directions": [{"plan_code": "A", "name": "11 класс + информатика", "match_score": 70}],
        "gap_analysis": {"closing_skills": ["английский"], "headline": "Подтянуть язык"},
    }
    insight_ctx = compact_test_insight_context(analysis, None)
    assert "английск" not in insight_ctx.lower()
    assert "кемгу" not in insight_ctx.lower()
    assert "сценари" not in insight_ctx.lower()
    assert "11 класс" not in insight_ctx.lower()
    draft_ctx = compact_plan_context(analysis, None, include_weekly=True)
    assert "английск" in draft_ctx.lower()
    revise_ctx = compact_plan_context(analysis, None, include_weekly=False)
    assert "английск" not in revise_ctx.lower()
    assert "информатика" in revise_ctx.lower()


def test_mock_test_insight_skips_abc_plans():
    from wibe_work.services.action_plans import mock_test_insight

    analysis = {
        "analysis_mode": "school",
        "directions": [{"plan_code": "A", "name": "11 класс + информатика", "match_score": 70}],
    }
    text = mock_test_insight(analysis, {"id": "profil", "title": "Интересы к учёбе", "kind": "module"})
    low = text.lower()
    assert "интересы" in low or "тест" in low
    assert "вариант" not in low
    assert "план a" not in low and "план b" not in low
    assert "маршрут" not in low or "не входят" in low
    # не должно быть привязки к сценарию A/B/C
    assert "11 класс" not in low
    assert "информатика" not in low


def test_deterministic_matrix_insight_no_llm_jargon():
    from wibe_work.services.test_insights import build_deterministic_test_insight

    questions = [
        {
            "id": 1,
            "text": "С чем вам интереснее работать чаще всего?",
            "options": [
                {"id": "A", "label": "С людьми"},
                {"id": "B", "label": "С информацией"},
                {"id": "C", "label": "С техникой"},
                {"id": "D", "label": "С образами"},
            ],
            "weights": [(1, 3, 1, 0), (2, 0, 3, 0), (1, 0, 3, 0), (2, 0, 0, 2)],
        },
        {
            "id": 2,
            "text": "Где вам комфортнее «примерять» будущую роль?",
            "options": [
                {"id": "A", "label": "Помогать людям"},
                {"id": "B", "label": "Вести таблицы"},
                {"id": "C", "label": "Мастерская"},
                {"id": "D", "label": "Студия"},
            ],
            "weights": [(1, 3, 1, 0), (2, 0, 3, 0), (1, 0, 2, 1), (2, 1, 0, 2)],
        },
    ]
    text = build_deterministic_test_insight(
        module_id="matrix",
        title="Матрица выбора профессии",
        questions=questions,
        answers={1: "B", 2: "B"},
        kind="module",
    )
    low = text.lower()
    assert "матриц" in low
    assert "информация" in low or "схем" in low or "порядок" in low or "техник" in low
    assert "с чем вам интереснее" not in low
    assert "чаще выбирали" not in low
    assert "чаще в ответах" not in low
    assert "вам ближе:" not in low
    assert "вариант a" not in low
    assert "нейросет" not in low


def test_deterministic_sphere_insight_interprets_not_lists():
    from wibe_work.services.test_insights import build_deterministic_test_insight

    questions = [
        {
            "id": 1,
            "text": "Что ближе в работе?",
            "options": [
                {"id": "A", "label": "отладка, логи, поиск узкого места в коде"},
                {"id": "B", "label": "встречи и объяснения команде"},
            ],
        },
        {
            "id": 2,
            "text": "Ещё?",
            "options": [
                {"id": "A", "label": "перепроверите граничные случаи и тесты"},
                {"id": "B", "label": "творческий брейншторм"},
            ],
        },
    ]
    text = build_deterministic_test_insight(
        module_id="sphere",
        title="Задачи в вашей сфере",
        questions=questions,
        answers={1: "A", 2: "A"},
        kind="sphere",
    )
    low = text.lower()
    assert "отладка" not in low
    assert "чаще выбирали" not in low
    assert "системность" in low or "проверк" in low or "качеств" in low


def test_mock_plan_rewrite_drops_weekly_english():
    from wibe_work.services.action_plans import mock_plan_from_analysis

    analysis = {
        "analysis_mode": "school",
        "ai_narrative": "Учите английский два часа в неделю.",
        "directions": [{"plan_code": "A", "name": "11 класс + информатика", "match_score": 70}],
        "weekly_roadmap": [
            {"week_range": "Неделя 1", "learn": "Добавьте английский для КемГУ", "topics": []},
            {"week_range": "Неделя 2", "learn": "ЕГЭ", "topics": []},
            {"week_range": "Неделя 3", "learn": "Проекты", "topics": []},
            {"week_range": "Неделя 4", "learn": "Пробник", "topics": []},
        ],
    }
    created = datetime(2026, 8, 14, tzinfo=timezone.utc)
    plan = mock_plan_from_analysis(
        analysis,
        "не хочу учить английский",
        created,
        remarks=["не хочу учить английский"],
        rewrite=True,
    )
    stages_blob = " ".join(
        f"{s.get('title')} {s.get('details')}" for s in plan.get("stages") or []
    )
    assert "английск" not in stages_blob.lower()
    assert "кемгу" not in stages_blob.lower()
    assert "Неделя 1" not in [s["title"] for s in plan["stages"]]
    assert "пересобран" in plan["explanation"].lower() or "замечание" in plan["explanation"].lower()


def test_revision_block_asks_full_replace():
    from wibe_work.services.action_plans import compact_revision_block

    block = compact_revision_block(
        previous_explanation="Добавьте английский для КемГУ.",
        previous_stages=[{"title": "Учить английский"}],
        remarks=["не хочу английский"],
    )
    assert "ЗАМЕНИТЬ ЦЕЛИКОМ" in block
    assert "не хочу английский" in block
    assert "Учить английский" in block


def test_calendar_timing_september_no_documents():
    from datetime import date

    from wibe_work.services.action_plans import calendar_timing_hint

    hint = calendar_timing_hint(
        date(2026, 9, 10),
        analysis_mode="school",
        profile_extra={"course_grade": "10 класс", "favorite_subjects": ["информатика"]},
    )
    low = hint.lower()
    assert "месяц 9" in low
    assert "не предлагай подавать документы" in low or "не подача" in low
    assert "абстракц" in low


def test_calendar_timing_june_allows_documents():
    from datetime import date

    from wibe_work.services.action_plans import calendar_timing_hint

    hint = calendar_timing_hint(
        date(2026, 6, 20),
        analysis_mode="school",
        profile_extra={"course_grade": "11"},
    )
    low = hint.lower()
    assert "документ" in low
    assert "экзамен" in low or "лет" in low or "июн" in low


def test_mock_continue_stages_concrete_and_skips_done():
    from datetime import date

    from wibe_work.services.action_plans import mock_continue_stages, mock_plan_from_analysis

    analysis = {
        "analysis_mode": "school",
        "directions": [{"plan_code": "A", "name": "11 класс + информатика", "match_score": 90}],
        "gap_analysis": {"closing_skills": ["Подготовка к ЕГЭ"]},
    }
    done = [{"title": "Кружок или олимпиада — одна заявка", "details": "уже"}]
    stages = mock_continue_stages(
        analysis,
        profile_extra={"favorite_subjects": ["Информатика", "Математика"], "course_grade": "10"},
        completed_stages=done,
        today=date(2026, 9, 5),
        horizon=28,
    )
    assert len(stages) >= 4
    blob = " ".join(f"{s['title']} {s['details']}" for s in stages).lower()
    assert "кружок или олимпиада — одна заявка" not in blob
    assert "составь план" not in blob
    assert any("вариант" in s["details"].lower() or "тем" in s["details"].lower() for s in stages)

    created = datetime(2026, 9, 5, tzinfo=timezone.utc)
    plan = mock_plan_from_analysis(
        analysis,
        "следующий этап после выполненных шагов",
        created,
        continue_plan=True,
        completed_stages=done,
        profile_extra={"favorite_subjects": ["Информатика"], "course_grade": "10"},
    )
    assert len(plan["stages"]) >= 4
    assert "следующ" in plan["explanation"].lower() or "выполнен" in plan["explanation"].lower()


def test_continue_intent_in_prompt():
    from wibe_work.services.llm_prompts import build_plan_user_prompt

    prompt = build_plan_user_prompt(
        user_request="продолжи план",
        analysis_mode="school",
        context_block="Профиль: школьник",
        inferred_horizon_days=28,
        intent="continue",
        extra_block="Календарь: сентябрь, не подавать документы",
    )
    low = prompt.lower()
    assert "следующ" in low
    assert "календарь" in low
    assert "составь план" in low
