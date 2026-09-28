"""Режимы разбора: школа / СПО (вуз vs работа) / вуз; без LLM."""

from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import patch

_REPO = Path(__file__).resolve().parents[2]
_WEBSITE = _REPO / "website"
_BACKEND = _WEBSITE / "backend"
for p in (str(_WEBSITE), str(_BACKEND)):
    if p not in sys.path:
        sys.path.insert(0, p)


def test_education_aliases_university_not_vocational():
    from wibe_work.services.aptitude_quiz_grading import compute_quiz_grade, normalize_education_detail
    from wibe_work.services.profile_analysis_context import analysis_mode_for_profile

    uni = {"education_detail": "university", "age": 21}
    assert normalize_education_detail(uni) == "univ_bachelor"
    assert compute_quiz_grade(uni) == "university"
    assert analysis_mode_for_profile(uni) == "career"

    assert compute_quiz_grade({"education": "вуз", "age": 20}) == "university"
    assert compute_quiz_grade({"education_detail": "univ_bachelor", "age": 19}) == "university"
    assert compute_quiz_grade({"education_detail": "spo", "age": 18}) == "vocational"
    assert compute_quiz_grade({"education_detail": "school_8_11", "age": 15}) == "school"


def test_vocational_paths_follow_spo_goal():
    from wibe_work.services.career_analysis_vocational import pick_vocational_path_plans, spo_goal_kind

    base = {
        "education_detail": "spo",
        "interest_spheres": ["it_dev"],
        "like_to_do": "вёрстка",
        "course_grade": "2 курс",
        "city": "Казань",
    }
    axes = [{"key": "structure_mastery", "value_percent": 70}]
    uni = pick_vocational_path_plans({**base, "post_spo_goal": "spo_to_university"}, "it_dev", axes, 3)
    work = pick_vocational_path_plans({**base, "post_spo_goal": "spo_to_work"}, "it_dev", axes, 3)
    fork = pick_vocational_path_plans({**base, "post_spo_goal": "undecided"}, "it_dev", axes, 3)
    blob_u = " ".join(p["name"] for p in uni["plans"]).lower()
    blob_w = " ".join(p["name"] for p in work["plans"]).lower()
    blob_f = " ".join(p["name"] for p in fork["plans"]).lower()
    assert spo_goal_kind({**base, "post_spo_goal": "spo_to_university"}) == "university"
    assert "вуз" in blob_u or "бакалавр" in blob_u or "поступлен" in blob_u
    assert "hh" not in blob_u
    uni_names = [p["name"] for p in uni["plans"]]
    assert len(uni_names) == len(set(uni_names))
    assert "стажир" in blob_w or "практик" in blob_w or "помощник" in blob_w
    assert "вуз" in blob_f and ("работ" in blob_f or "стажир" in blob_f)


def test_school_no_medicine_without_sphere():
    from wibe_work.services.career_analysis_school import pick_school_path_plans

    profile = {
        "education_detail": "school_8_11",
        "interest_spheres": ["education"],
        "favorite_subjects": ["biology", "chemistry"],
        "post_school_goal": "after_11_college",
    }
    axes = [{"key": "people_service", "value_percent": 60}]
    plans = pick_school_path_plans(profile, "education", axes, 1)
    blob = " ".join(p["name"] for p in plans["plans"]).lower()
    assert "сестрин" not in blob
    assert "медколледж" not in blob


@patch("wibe_work.services.career_analysis.llm_configured", return_value=False)
def test_build_analysis_modes_and_school_copy(_llm):
    from wibe_work.services.career_analysis import build_analysis_result

    answers = [{"question_id": i, "choice": "A"} for i in range(1, 9)]
    school_p = {
        "education_detail": "school_8_11",
        "age": 15,
        "city": "Москва",
        "interest_spheres": ["it_dev", "marketing"],
        "favorite_subjects": ["informatics", "math"],
        "like_to_do": "кодить",
        "post_school_goal": "after_9_college",
        "course_grade": "9 класс",
    }
    full = build_analysis_result(school_p, {"city": "Москва"}, "it_dev", "школа", "medium", answers)
    assert full["analysis_mode"] == "school"
    blob = str(full.get("individual_advice")) + str(full.get("pain_focus")) + str(full.get("ai_narrative"))
    low = blob.lower()
    assert "hh.ru" not in low
    # после скраба не должно остаться «резюме» как совета о работе
    assert "резюме" not in low

    voc_p = {
        "education_detail": "spo",
        "age": 18,
        "city": "Казань",
        "interest_spheres": ["it_dev"],
        "like_to_do": "вёрстка",
        "post_spo_goal": "spo_to_university",
        "course_grade": "2 курс",
    }
    voc = build_analysis_result(voc_p, {"city": "Казань"}, "it_dev", "колледж", "medium", answers)
    assert voc["analysis_mode"] == "vocational"
    names = " ".join(p["name"] for p in (voc.get("scenarios") or {}).get("plans") or [])
    assert "вуз" in names.lower() or "бакалавр" in names.lower() or "поступлен" in names.lower()

    career_p = {
        "education_detail": "univ_bachelor",
        "age": 21,
        "city": "СПб",
        "interest_spheres": ["it_dev"],
        "like_to_do": "бэкенд",
    }
    car = build_analysis_result(career_p, {"city": "СПб"}, "it_dev", "вуз", "medium", answers)
    assert car["analysis_mode"] == "career"


@patch("wibe_work.services.career_analysis.llm_configured", return_value=False)
def test_sphere_matches_stage_no_it_leak(_llm):
    """Каждая сфера на школе / СПО / вузе остаётся в своём пуле (не уезжает в Backend/GitHub)."""
    from wibe_work.questionnaire_fields import INTEREST_SPHERES
    from wibe_work.services.career_analysis import build_analysis_result, infer_interest_from_test_answers

    answers = [{"question_id": i, "choice": "A"} for i in range(1, 9)]
    sample = ["medicine", "sport", "education", "finance", "marketing", "it_dev"]
    assert set(sample) <= {s["id"] for s in INTEREST_SPHERES}

    for sid in sample:
        school_p = {
            "education_detail": "school_8_11",
            "age": 16,
            "city": "Москва",
            "interest_spheres": [sid],
            "favorite_subjects": ["math", "russian"],
            "post_school_goal": "after_11_ege",
            "course_grade": "10 класс",
        }
        school = build_analysis_result(school_p, {"city": "Москва"}, sid, "школа", "medium", answers)
        assert school["analysis_mode"] == "school"
        s_names = " ".join(p["name"] for p in (school.get("scenarios") or {}).get("plans") or []).lower()
        if sid != "it_dev":
            assert "программирование и it" not in s_names
        assert "github" not in str(school.get("gap_analysis")).lower()

        voc_p = {
            "education_detail": "spo",
            "age": 19,
            "city": "Казань",
            "interest_spheres": [sid],
            "post_spo_goal": "spo_to_work",
            "course_grade": "2 курс",
        }
        voc = build_analysis_result(voc_p, {"city": "Казань"}, sid, "колледж", "medium", answers)
        assert voc["analysis_mode"] == "vocational"
        if sid == "medicine":
            g = str(voc.get("gap_analysis")).lower()
            assert "github" not in g
            assert "python" not in g

        car_p = {
            "education_detail": "univ_bachelor",
            "age": 22,
            "city": "Москва",
            "interest_spheres": [sid],
        }
        assert infer_interest_from_test_answers(car_p, answers, sid) == sid
        car = build_analysis_result(car_p, {"city": "Москва"}, sid, "вуз", "medium", answers)
        assert car["analysis_mode"] == "career"
        c_names = " ".join(p["name"] for p in (car.get("scenarios") or {}).get("plans") or []).lower()
        if sid == "medicine":
            assert "пациент" in c_names or "клинич" in c_names or "допуск" in c_names or "фармац" in c_names
            assert "backend" not in c_names
        if sid == "sport":
            assert "спорт" in c_names or "фитнес" in c_names or "тренир" in c_names or "безопас" in c_names
            assert "backend" not in c_names
        if sid == "it_dev":
            assert "backend" in c_names or "frontend" in c_names or "devops" in c_names or "qa" in c_names
