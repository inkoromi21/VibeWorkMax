"""
Подтверждение предложенной роли (карьера) или сферы и предметов (школа)
перед показом полного разбора.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Set, Tuple

from wibe_work.questionnaire_fields import INTEREST_SPHERES
from wibe_work.services.career_analysis import (
    _IT_TRACK_LABELS,
    _answer_fingerprint,
    _build_gap_analysis,
    _dominant_radar_key,
    _mock_ai_narrative,
    _pain_focus,
    _pick_scenario_plans,
    _rank_mts_rows,
    _resolve_effective_interest,
    _weekly_roadmap,
)
from wibe_work.services.profile_analysis_context import SUBJECT_GAP_LABELS

ROLE_SHORT_DESCRIPTIONS: Dict[str, str] = {
    "backend": (
        "Разработка серверной логики, API и баз данных. "
        "Подходит, если нравится разбираться, как устроены системы «изнутри»."
    ),
    "frontend": (
        "Сайты и приложения: вёрстка и клиентская логика. "
        "Подходит, если важны интерфейс, удобство для людей и быстрый визуальный результат."
    ),
    "devops": (
        "Инфраструктура, деплой и надёжность сервисов. "
        "Подходит, если интересны автоматизация и стабильная работа продуктов."
    ),
    "data": (
        "SQL, метрики и аналитика. "
        "Подходит, если нравится искать закономерности в данных и объяснять цифрами."
    ),
    "qa": (
        "Тестирование и качество продукта. "
        "Подходит, если внимательны к деталям и хотите улучшать продукт до релиза."
    ),
}

_FEEDBACK_TRACK_KEYWORDS: Dict[str, Tuple[str, ...]] = {
    "backend": ("бэкенд", "backend", "бекенд", "api", "сервер", "django", "flask"),
    "frontend": ("фронт", "frontend", "интерфейс", "вёрст", "верст", "react", "vue"),
    "devops": ("devops", "деплой", "ci/cd", "инфраструктур", "kubernetes"),
    "data": ("аналитик данных", "sql", "витрин", "дашборд"),
    "qa": ("тестиров", " qa", "автотест", "качеств"),
}

_FEEDBACK_SUBJECT_KEYWORDS: Dict[str, Tuple[str, ...]] = {
    "informatics": ("информ", "программ", "python", "егэ по информ", "огэ по информ"),
    "math": ("матем", "профильн матем", "алгебр"),
    "english": ("англий", "англ "),
    "physics": ("физик",),
    "chemistry": ("хими",),
    "biology": ("биолог",),
    "russian": ("русск", "литератур"),
    "social": ("обществ",),
}

_FEEDBACK_SPHERE_KEYWORDS: Dict[str, Tuple[str, ...]] = {
    "it_dev": ("айти", " it", "ит ", "it-", "программирован", "разработчик"),
    "data": ("аналитик данных", "data science", "большие данн"),
    "design": ("дизайн", "ux", "ui", "графическ"),
}

_POOL_ENTRY_TRACK: List[Tuple[str, str]] = [
    ("backend", "бэкенд"),
    ("backend", "backend"),
    ("backend", "api"),
    ("frontend", "frontend"),
    ("frontend", "интерфейс"),
    ("frontend", "веб-интерфейс"),
    ("qa", "автотест"),
    ("qa", "qa"),
    ("data", "sql"),
    ("data", "аналит"),
    ("data", "данн"),
    ("devops", "devops"),
]

_SPHERE_LABELS: Dict[str, str] = {s["id"]: s["label"] for s in INTEREST_SPHERES}

_PUBLIC_FULL_KEYS = (
    "analyzed_at",
    "analysis_mode",
    "readiness",
    "style_radar",
    "scenarios",
    "inferred_profession",
    "mts_matrix",
    "learning",
    "learning_path",
    "learning_path_detail",
    "individual_advice",
    "growth_stages",
    "growth_stages_rich",
    "assessment_signals",
    "gap_analysis",
    "pain_focus",
    "weekly_roadmap",
    "behavioral_hint",
    "ai_narrative",
    "ai_narrative_source",
    "ai_narrative_notice",
)


def rank_it_track_scores(answers: List[Dict[str, Any]]) -> List[Tuple[str, float]]:
    from wibe_work.services.career_analysis import _it_track_scores_from_answers

    scores = _it_track_scores_from_answers(answers)
    return sorted(
        [(k, v) for k, v in scores.items() if v >= 0.5],
        key=lambda x: -x[1],
    )


def track_from_direction_name(name: str) -> Optional[str]:
    n = (name or "").lower()
    for tid, kw in _POOL_ENTRY_TRACK:
        if kw in n:
            return tid
    return None


def parse_feedback_exclusions_career(feedback: str) -> Set[str]:
    low = (feedback or "").lower()
    out: Set[str] = set()
    for tid, kws in _FEEDBACK_TRACK_KEYWORDS.items():
        if any(k in low for k in kws):
            out.add(tid)
    return out


def _school_wants_exam_subjects(feedback: str) -> bool:
    """Человек отказывается от части, но хочет готовиться к экзаменам/предметам."""
    low = (feedback or "").lower()
    return any(
        k in low
        for k in (
            "хочу сда",
            "сдавать",
            "егэ",
            "огэ",
            "предмет",
            "экзамен",
            "остальн",
            "другие предмет",
            "но матем",
            "но физик",
            "но русск",
        )
    )


def parse_feedback_exclusions_school(
    feedback: str,
) -> Tuple[Set[str], Set[str]]:
    low = (feedback or "").lower()
    subjects: Set[str] = set()
    spheres: Set[str] = set()
    for sid, kws in _FEEDBACK_SUBJECT_KEYWORDS.items():
        if any(k in low for k in kws):
            subjects.add(sid)
    for sp, kws in _FEEDBACK_SPHERE_KEYWORDS.items():
        if any(k in low for k in kws):
            spheres.add(sp)
    return subjects, spheres


def _proposal_match_percent(full: Dict[str, Any], label: str, track_id: Optional[str]) -> int:
    rows = list((full.get("mts_matrix") or {}).get("rows") or [])
    low_label = (label or "").lower()
    for r in rows:
        rn = str(r.get("role_name") or "")
        if rn.lower() == low_label or (track_id and track_from_direction_name(rn) == track_id):
            p = r.get("match_percent")
            if p is None:
                p = r.get("percent")
            if p is not None:
                return int(max(38, min(97, int(p))))
    scenarios = full.get("scenarios") or {}
    if scenarios.get("best_avg_percent") is not None:
        return int(scenarios["best_avg_percent"])
    gap = full.get("gap_analysis") or {}
    if gap.get("overall_hp") is not None:
        return int(gap["overall_hp"])
    return 72


def _career_proposal(full: Dict[str, Any]) -> Dict[str, Any]:
    inf = full.get("inferred_profession") or (full.get("scenarios") or {}).get("inferred_profession")
    track_id: Optional[str] = None
    label = ""
    if isinstance(inf, dict) and inf.get("label"):
        track_id = str(inf.get("track_id") or "") or None
        label = str(inf.get("label") or "")
    if not label:
        rows = list((full.get("mts_matrix") or {}).get("rows") or [])
        if rows:
            label = str(rows[0].get("role_name") or "Направление")
            track_id = track_from_direction_name(label) or track_id
    if not label:
        scenarios = full.get("scenarios") or {}
        label = re.sub(
            r"^План [ABC]:\s*",
            "",
            str(scenarios.get("best_plan_name") or "Направление"),
            flags=re.I,
        ).strip()
    pct = _proposal_match_percent(full, label, track_id)
    desc = ROLE_SHORT_DESCRIPTIONS.get(track_id or "", "") or (
        f"Направление «{label}» подобрано по тесту и анкете. "
        "После подтверждения откроется полный разбор, план и материалы."
    )
    return {
        "mode": "career",
        "track_id": track_id,
        "label": label,
        "match_percent": pct,
        "description": desc,
    }


def _school_exam_subjects(full: Dict[str, Any], interest: str) -> List[Dict[str, str]]:
    from wibe_work.services.school_subject_resources import pick_school_subject_ids

    profile = full.get("_profile_cache") or {}
    gap = full.get("gap_analysis") or {}
    rc = full.get("role_confirmation") or {}
    excluded = set(str(x) for x in (rc.get("excluded_subject_ids") or []))
    ids = pick_school_subject_ids(profile, interest, gap, exclude_subject_ids=excluded)
    out: List[Dict[str, str]] = []
    for sid in sorted(ids):
        out.append({"id": sid, "label": SUBJECT_GAP_LABELS.get(sid, sid)})
    return out


def _school_proposal(full: Dict[str, Any]) -> Dict[str, Any]:
    from wibe_work.services.user_context import parse_interest_spheres

    interest = str(full.get("_analysis_interest") or "")
    scenarios = full.get("scenarios") or {}
    path_label = re.sub(
        r"^Вариант\s+[ABC]:\s*",
        "",
        str(scenarios.get("best_plan_name") or ""),
        flags=re.I,
    ).strip()
    spheres = parse_interest_spheres(full.get("_profile_cache") or {})
    if not spheres and full.get("_profile_cache", {}).get("main_sphere"):
        spheres = [str(full["_profile_cache"]["main_sphere"]).strip()]
    sphere_id = spheres[0] if spheres else interest or "other"
    sphere_label = _SPHERE_LABELS.get(sphere_id, scenarios.get("focus_label") or sphere_id)
    if str(scenarios.get("focus_label") or "").startswith("Сфера"):
        sphere_label = str(scenarios["focus_label"]).replace("Сфера интересов:", "").strip()

    pct = _proposal_match_percent(full, path_label, None)
    subjects = _school_exam_subjects(full, interest)
    sub_line = ", ".join(s["label"] for s in subjects[:5])
    desc = (
        f"По тесту ближе всего сфера «{sphere_label}» (≈{pct}%). "
        f"Предметы к сдаче: {sub_line or 'профильные предметы'}. "
        f"Маршрут обучения: {path_label or 'уточните с наставником'}. "
        "После подтверждения откроется полный план подготовки и материалы."
    )
    return {
        "mode": "school",
        "sphere_id": sphere_id,
        "sphere_label": sphere_label,
        "match_percent": pct,
        "path_label": path_label,
        "exam_subjects": subjects,
        "description": desc,
    }


def _vocational_proposal(full: Dict[str, Any]) -> Dict[str, Any]:
    from wibe_work.services.user_context import parse_interest_spheres

    interest = str(full.get("_analysis_interest") or "")
    scenarios = full.get("scenarios") or {}
    path_label = re.sub(
        r"^Вариант\s+[ABC]:\s*",
        "",
        str(scenarios.get("best_plan_name") or ""),
        flags=re.I,
    ).strip()
    spheres = parse_interest_spheres(full.get("_profile_cache") or {})
    if not spheres and full.get("_profile_cache", {}).get("main_sphere"):
        spheres = [str(full["_profile_cache"]["main_sphere"]).strip()]
    sphere_id = spheres[0] if spheres else interest or "other"
    sphere_label = _SPHERE_LABELS.get(sphere_id, scenarios.get("focus_label") or sphere_id)
    pct = _proposal_match_percent(full, path_label, None)
    closing = list((full.get("gap_analysis") or {}).get("closing_skills") or [])[:3]
    close_line = ", ".join(closing) if closing else "навыки специальности и практика"
    desc = (
        f"По тесту ближе всего сфера «{sphere_label}» (≈{pct}%). "
        f"Фокус: {close_line}. "
        f"Маршрут: {path_label or 'уточните с куратором'}. "
        "После подтверждения откроется план практики и материалы."
    )
    return {
        "mode": "vocational",
        "sphere_id": sphere_id,
        "sphere_label": sphere_label,
        "match_percent": pct,
        "path_label": path_label,
        "description": desc,
    }


def build_role_proposal(full: Dict[str, Any]) -> Dict[str, Any]:
    mode = (full.get("analysis_mode") or "")
    if mode == "school":
        return _school_proposal(full)
    if mode == "vocational":
        return _vocational_proposal(full)
    return _career_proposal(full)


def _default_role_confirmation(full: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "status": "pending",
        "proposal": build_role_proposal(full),
        "rejection_history": [],
        "excluded_track_ids": [],
        "excluded_subject_ids": [],
        "excluded_sphere_ids": [],
    }


def ensure_role_confirmation(full: Dict[str, Any], profile: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    out = dict(full)
    if profile is not None:
        out["_profile_cache"] = dict(profile)
    rc = dict(out.get("role_confirmation") or {})
    if rc.get("status") == "accepted":
        rc["proposal"] = build_role_proposal(out)
        out["role_confirmation"] = rc
        return out
    fresh = _default_role_confirmation(out)
    for key in ("rejection_history", "excluded_track_ids", "excluded_subject_ids", "excluded_sphere_ids"):
        if rc.get(key):
            fresh[key] = list(rc[key]) if key == "rejection_history" else list(rc[key])
    out["role_confirmation"] = fresh
    return out


def wrap_fresh_analysis(full: Dict[str, Any], profile: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    return ensure_role_confirmation(full, profile)


def accept_role_confirmation(full: Dict[str, Any]) -> Dict[str, Any]:
    out = dict(full)
    rc = dict(out.get("role_confirmation") or _default_role_confirmation(out))
    rc["status"] = "accepted"
    rc["accepted_at"] = datetime.now(timezone.utc).isoformat()
    rc["proposal"] = build_role_proposal(out)
    out["role_confirmation"] = rc
    return out


def _pick_next_it_track(
    answers: List[Dict[str, Any]], excluded: Set[str]
) -> Optional[Dict[str, str]]:
    for tid, _sc in rank_it_track_scores(answers):
        if tid in excluded:
            continue
        return {"track_id": tid, "label": _IT_TRACK_LABELS.get(tid, tid)}
    return None


def _rebuild_career_sections(
    full: Dict[str, Any],
    profile: Dict[str, Any],
    profile_extra: Dict[str, Any],
    *,
    it_track: Optional[str],
    top_track: str,
) -> Dict[str, Any]:
    interest = str(full.get("_analysis_interest") or "")
    preparation = str(profile.get("preparation_level") or "medium")
    answers = list(full.get("_quiz_answers") or [])
    axes = list((full.get("style_radar") or {}).get("axes") or [])
    fp = _answer_fingerprint(answers)
    eff = _resolve_effective_interest(profile, interest)
    excluded = set(str(x) for x in (full.get("role_confirmation") or {}).get("excluded_track_ids") or [])

    scenarios = _pick_scenario_plans(
        eff, axes, fp, answers, it_track_override=it_track, exclude_track_ids=excluded
    )
    gap = _build_gap_analysis(profile, interest, top_track, axes, fp)
    readiness = int((full.get("readiness") or {}).get("value_percent") or 50)

    from wibe_work.services.learning.engine import build_learning_for_analysis

    learn_x = build_learning_for_analysis(
        user_id=str(profile.get("_user_id") or "") or None,
        profile=profile,
        interest=eff,
        preparation_level=preparation,
        scenarios=scenarios,
        gap=gap,
        axes=axes,
        answers=answers,
    )
    narrative = _mock_ai_narrative(
        profile,
        interest,
        preparation,
        scenarios,
        axes,
        fp,
        readiness_percent=readiness,
        gap=gap,
    )
    from wibe_work.services.career_analysis import _rank_career_direction_rows

    mts_rows = _rank_career_direction_rows(
        eff,
        axes,
        fp,
        answers,
        it_track_override=it_track,
        exclude_track_ids=excluded,
    )
    if not mts_rows:
        mts_rows = _rank_mts_rows(profile, profile_extra, eff, answers, axes)

    pain = _pain_focus(
        profile,
        gap=gap,
        scenarios=scenarios,
        axes=axes,
        readiness_percent=readiness,
        top_track=top_track,
    )
    weekly = _weekly_roadmap(top_track, interest, preparation=preparation)

    out = dict(full)
    out["scenarios"] = scenarios
    out["gap_analysis"] = gap
    out["mts_matrix"] = {"rows": mts_rows}
    out["learning"] = learn_x.get("learning") or out.get("learning")
    out["learning_path"] = learn_x.get("learning_path")
    out["learning_path_detail"] = learn_x.get("learning_path_detail")
    out["individual_advice"] = learn_x.get("individual_advice")
    out["growth_stages"] = learn_x.get("growth_stages")
    out["growth_stages_rich"] = learn_x.get("growth_stages_rich")
    out["assessment_signals"] = learn_x.get("assessment_signals")
    out["pain_focus"] = pain
    out["weekly_roadmap"] = weekly
    out["ai_narrative"] = narrative
    out["narrative"] = narrative
    if it_track:
        inf = {"track_id": it_track, "label": _IT_TRACK_LABELS.get(it_track, it_track)}
        out["inferred_profession"] = inf
        sc = dict(out.get("scenarios") or {})
        sc["inferred_profession"] = inf
        out["scenarios"] = sc
    return out


def _rebuild_school_sections(
    full: Dict[str, Any],
    profile: Dict[str, Any],
    profile_extra: Dict[str, Any],
    *,
    interest: str,
    top_path: str,
) -> Dict[str, Any]:
    from wibe_work.services.career_analysis_school import (
        _safe_top_path_for_profile,
        build_school_gap_analysis,
        mock_school_narrative,
        pick_school_path_plans,
        sanitize_school_scenarios,
        school_education_hints,
        school_learning_extras,
        school_weekly_roadmap,
    )

    answers = list(full.get("_quiz_answers") or [])
    axes = list((full.get("style_radar") or {}).get("axes") or [])
    fp = _answer_fingerprint(answers)
    rc = full.get("role_confirmation") or {}
    excluded_subjects = set(str(x) for x in (rc.get("excluded_subject_ids") or []))
    excluded_spheres = set(str(x) for x in (rc.get("excluded_sphere_ids") or []))

    scenarios = sanitize_school_scenarios(
        profile,
        pick_school_path_plans(
            profile,
            interest,
            axes,
            fp,
            exclude_sphere_ids=excluded_spheres,
            exclude_subject_ids=excluded_subjects,
        ),
        interest,
        axes,
        fp,
    )
    if not top_path:
        top_path = str(scenarios.get("best_plan_name") or "")
    top_path = _safe_top_path_for_profile(profile, top_path, interest, scenarios)
    gap = build_school_gap_analysis(
        profile,
        interest,
        top_path,
        axes,
        fp,
        exclude_subject_ids=excluded_subjects,
    )
    preparation = str(profile.get("preparation_level") or "medium")
    readiness = int((full.get("readiness") or {}).get("value_percent") or 50)
    learn_x = school_learning_extras(
        profile=profile,
        interest=interest,
        preparation_level=preparation,
        scenarios=scenarios,
        gap=gap,
        profile_summary=(full.get("profile_summary") or ""),
        user_id=str(profile.get("_user_id") or "") or None,
        eff_interest=interest,
        exclude_subject_ids=excluded_subjects,
    )
    narrative = mock_school_narrative(
        profile,
        interest,
        scenarios,
        axes,
        fp,
        readiness_percent=readiness,
        gap=gap,
    )

    out = dict(full)
    out["scenarios"] = scenarios
    out["gap_analysis"] = gap
    out["mts_matrix"] = school_education_hints(profile, interest, scenarios)
    out["learning"] = learn_x.get("learning") or out.get("learning")
    out["learning_path"] = learn_x.get("learning_path")
    out["learning_path_detail"] = learn_x.get("learning_path_detail")
    out["individual_advice"] = learn_x.get("individual_advice")
    out["growth_stages"] = learn_x.get("growth_stages")
    out["weekly_roadmap"] = school_weekly_roadmap(profile, top_path, interest, scenarios)
    out["ai_narrative"] = narrative
    out["narrative"] = narrative
    return out


def _rebuild_vocational_sections(
    full: Dict[str, Any],
    profile: Dict[str, Any],
    profile_extra: Dict[str, Any],
    *,
    interest: str,
    top_path: str,
) -> Dict[str, Any]:
    from wibe_work.services.career_analysis_vocational import (
        build_vocational_gap_analysis,
        mock_vocational_narrative,
        pick_vocational_path_plans,
        sanitize_vocational_scenarios,
        safe_top_path_vocational,
        vocational_education_hints,
        vocational_learning_extras,
        vocational_weekly_roadmap,
    )

    answers = list(full.get("_quiz_answers") or [])
    axes = list((full.get("style_radar") or {}).get("axes") or [])
    fp = _answer_fingerprint(answers)
    rc = full.get("role_confirmation") or {}
    excluded_spheres = set(str(x) for x in (rc.get("excluded_sphere_ids") or []))

    scenarios = sanitize_vocational_scenarios(
        profile,
        pick_vocational_path_plans(
            profile,
            interest,
            axes,
            fp,
            exclude_sphere_ids=excluded_spheres,
        ),
        interest,
        axes,
        fp,
    )
    if not top_path:
        top_path = str(scenarios.get("best_plan_name") or "")
    top_path = safe_top_path_vocational(profile, top_path, interest, scenarios)
    gap = build_vocational_gap_analysis(
        profile,
        interest,
        top_path,
        axes,
        fp,
        preparation_level=str(profile.get("preparation_level") or "medium"),
    )
    preparation = str(profile.get("preparation_level") or "medium")
    readiness = int((full.get("readiness") or {}).get("value_percent") or 50)
    learn_x = vocational_learning_extras(
        profile=profile,
        interest=interest,
        preparation_level=preparation,
        scenarios=scenarios,
        gap=gap,
        profile_summary=(full.get("profile_summary") or ""),
        user_id=str(profile.get("_user_id") or "") or None,
        eff_interest=interest,
        axes=axes,
        answers=answers,
    )
    narrative = mock_vocational_narrative(
        profile,
        interest,
        scenarios,
        axes,
        fp,
        readiness_percent=readiness,
        gap=gap,
    )

    out = dict(full)
    out["scenarios"] = scenarios
    out["gap_analysis"] = gap
    out["mts_matrix"] = vocational_education_hints(profile, interest, scenarios)
    out["learning"] = learn_x.get("learning") or out.get("learning")
    out["learning_path"] = learn_x.get("learning_path")
    out["learning_path_detail"] = learn_x.get("learning_path_detail")
    out["individual_advice"] = learn_x.get("individual_advice")
    out["growth_stages"] = learn_x.get("growth_stages")
    out["growth_stages_rich"] = learn_x.get("growth_stages")
    out["weekly_roadmap"] = vocational_weekly_roadmap(profile, top_path, interest, scenarios)
    out["ai_narrative"] = narrative
    out["narrative"] = narrative
    return out


def reject_role_and_regenerate(
    full: Dict[str, Any],
    profile: Dict[str, Any],
    profile_extra: Dict[str, Any],
    feedback: str,
) -> Dict[str, Any]:
    out = ensure_role_confirmation(dict(full), profile)
    rc = dict(out.get("role_confirmation") or {})
    proposal = dict(rc.get("proposal") or build_role_proposal(out))
    mode = proposal.get("mode") or out.get("analysis_mode") or "career"

    history = list(rc.get("rejection_history") or [])
    history.append(
        {
            "label": proposal.get("label") or proposal.get("sphere_label"),
            "feedback": (feedback or "").strip()[:2000],
            "rejected_at": datetime.now(timezone.utc).isoformat(),
        }
    )

    if mode == "school":
        from wibe_work.services.user_context import parse_interest_spheres

        excluded_subjects = set(str(x) for x in (rc.get("excluded_subject_ids") or []))
        excluded_spheres = set(str(x) for x in (rc.get("excluded_sphere_ids") or []))
        sub_new, sp_new = parse_feedback_exclusions_school(feedback)
        excluded_subjects |= sub_new
        excluded_spheres |= sp_new
        cur_sphere = str(proposal.get("sphere_id") or "")
        wants_exams = _school_wants_exam_subjects(feedback)

        if cur_sphere and cur_sphere in sp_new:
            excluded_spheres.add(cur_sphere)
        elif cur_sphere and sp_new and not wants_exams:
            excluded_spheres.add(cur_sphere)

        interest = str(out.get("_analysis_interest") or "")
        if excluded_spheres and interest in excluded_spheres:
            for alt in parse_interest_spheres(profile):
                if alt not in excluded_spheres:
                    interest = alt
                    break
            else:
                interest = "other"
            out["_analysis_interest"] = interest

        answers = list(out.get("_quiz_answers") or [])
        axes = list((out.get("style_radar") or {}).get("axes") or [])
        fp = _answer_fingerprint(answers)
        from wibe_work.services.career_analysis_school import pick_school_path_plans

        scenarios = pick_school_path_plans(
            profile,
            interest,
            axes,
            fp,
            exclude_sphere_ids=excluded_spheres,
            exclude_subject_ids=excluded_subjects,
        )
        top_path = str(scenarios.get("best_plan_name") or "")
        out = _rebuild_school_sections(
            out, profile, profile_extra, interest=interest, top_path=top_path
        )
        rc["excluded_subject_ids"] = sorted(excluded_subjects)
        rc["excluded_sphere_ids"] = sorted(excluded_spheres)
    elif mode == "vocational":
        from wibe_work.services.user_context import parse_interest_spheres
        from wibe_work.services.career_analysis_vocational import pick_vocational_path_plans

        excluded_spheres = set(str(x) for x in (rc.get("excluded_sphere_ids") or []))
        _sub_new, sp_new = parse_feedback_exclusions_school(feedback)
        excluded_spheres |= sp_new
        cur_sphere = str(proposal.get("sphere_id") or "")
        if cur_sphere and cur_sphere in sp_new:
            excluded_spheres.add(cur_sphere)

        interest = str(out.get("_analysis_interest") or "")
        if excluded_spheres and interest in excluded_spheres:
            for alt in parse_interest_spheres(profile):
                if alt not in excluded_spheres:
                    interest = alt
                    break
            else:
                interest = "other"
            out["_analysis_interest"] = interest

        answers = list(out.get("_quiz_answers") or [])
        axes = list((out.get("style_radar") or {}).get("axes") or [])
        fp = _answer_fingerprint(answers)
        scenarios = pick_vocational_path_plans(
            profile,
            interest,
            axes,
            fp,
            exclude_sphere_ids=excluded_spheres,
        )
        top_path = str(scenarios.get("best_plan_name") or "")
        out = _rebuild_vocational_sections(
            out, profile, profile_extra, interest=interest, top_path=top_path
        )
        rc["excluded_sphere_ids"] = sorted(excluded_spheres)
    else:
        excluded: Set[str] = set(str(x) for x in (rc.get("excluded_track_ids") or []))
        cur_tid = str(proposal.get("track_id") or "").strip()
        if cur_tid:
            excluded.add(cur_tid)
        excluded |= parse_feedback_exclusions_career(feedback)

        answers = list(out.get("_quiz_answers") or [])
        picked = _pick_next_it_track(answers, excluded)
        it_track: Optional[str] = None
        top_track = ""
        if picked:
            it_track = picked["track_id"]
            top_track = picked["label"]
        else:
            eff = str(out.get("_analysis_interest") or "")
            axes = list((out.get("style_radar") or {}).get("axes") or [])
            from wibe_work.services.career_analysis import _rank_career_direction_rows

            rows = _rank_career_direction_rows(
                eff,
                axes,
                _answer_fingerprint(answers),
                answers,
                exclude_track_ids=excluded,
            )
            if rows:
                top_track = str(rows[0].get("role_name") or "")
                it_track = track_from_direction_name(top_track)
            else:
                top_track = "Универсальный карьерный трек"
        out = _rebuild_career_sections(
            out, profile, profile_extra, it_track=it_track, top_track=top_track
        )
        rc["excluded_track_ids"] = sorted(excluded)

    rc["status"] = "pending"
    rc["rejection_history"] = history
    out["role_confirmation"] = rc
    return ensure_role_confirmation(out, profile)


def public_analysis_payload(full: Dict[str, Any]) -> Dict[str, Any]:
    full = ensure_role_confirmation(full, full.get("_profile_cache"))
    rc = full.get("role_confirmation") or {}
    if rc.get("status") != "accepted":
        return {
            "analyzed_at": full.get("analyzed_at"),
            "analysis_mode": full.get("analysis_mode"),
            "role_confirmation": rc,
        }
    out = {k: full[k] for k in _PUBLIC_FULL_KEYS if k in full}
    inf = (full.get("scenarios") or {}).get("inferred_profession")
    if inf and "inferred_profession" not in out:
        out["inferred_profession"] = inf
    out["role_confirmation"] = rc
    return out
