"""Персональные советы по планам A/B/C с привязкой к материалам обучения."""

from __future__ import annotations

import json
import re
from typing import Any, Dict, List, Optional, Set, Tuple

from wibe_work.services.learning.assessment_signals import (
    build_assessment_signals,
    infer_track_from_plan_name,
    resource_allowed,
    resource_match_score,
)
from wibe_work.services.learning.catalog import resource_to_card, resources_by_id
from wibe_work.services.learning.engine import build_learning_path_payload
from wibe_work.services.learning.material_relevance import (
    filter_materials_for_context,
    heuristic_material_score,
)
from wibe_work.services.llm_client import fetch_llm_completion, llm_configured
from wibe_work.services.llm_prompts import (
    advice_json_system_for_grade,
    build_advice_user_prompt,
)
from wibe_work.services.profile_analysis_context import education_grade as profile_education_grade

# Ключевые слова направления в названии плана → track для каталога
_TRACK_HINTS: List[Tuple[str, Tuple[str, ...]]] = [
    ("devops", ("devops", "релиз", "инфраструкт", "docker", "kubernetes", "ci/cd")),
    ("backend", ("backend", "бэкенд", "python", "api", "сервер", "fastapi")),
    ("frontend", ("frontend", "фронт", "javascript", "вёрст", "react", "html")),
    ("data", ("data", "аналит", "sql", "pandas", "ml", "данн")),
    ("design", ("design", "дизайн", "ux", "ui", "figma")),
    ("marketing", ("маркет", "smm", "digital", "реклам")),
    ("qa", ("qa", "тест", "quality")),
]


def _plan_label(plan: Dict[str, Any]) -> str:
    name = str(plan.get("name") or "")
    return re.sub(r"^План [ABC]:\s*", "", name, flags=re.I).strip() or name


def _infer_track_from_plan(plan_name: str) -> Optional[str]:
    return infer_track_from_plan_name(plan_name)


def _priority_skills(gap: Dict[str, Any]) -> List[str]:
    closing = gap.get("closing_skills") or []
    if closing:
        return [str(x) for x in closing[:5]]
    out: List[str] = []
    for bar in gap.get("bars") or []:
        lab = bar.get("label") or bar.get("key")
        if lab:
            out.append(str(lab))
    if out:
        return out[:5]
    return ["самопознание", "карьерные ценности", "резюме и отклики"]


def _flatten_path_resources(learning_path: Optional[Dict[str, Any]]) -> List[Dict[str, Any]]:
    if not learning_path:
        return []
    seen: Set[str] = set()
    out: List[Dict[str, Any]] = []
    for step in learning_path.get("steps") or []:
        for res in step.get("resources") or []:
            url = (res.get("url") or "").strip()
            if not url or url == "#" or url in seen:
                continue
            seen.add(url)
            out.append(dict(res))
    return out


def _catalog_resources_for_track(
    sphere: str,
    track: Optional[str],
    preparation: str,
    *,
    limit: int = 8,
    signals: Optional[Dict[str, Any]] = None,
) -> List[Dict[str, Any]]:
    """Ресурсы из каталога под направление плана (строго по сфере/треку из разбора)."""
    sig = signals or {
        "sphere": sphere,
        "track": track,
        "preparation_level": preparation,
        "priority_skills": [],
        "catalog_min_score": 8,
    }
    if track and not sig.get("track"):
        sig = dict(sig)
        sig["track"] = track
    scored: List[Tuple[int, Dict[str, Any]]] = []
    for r in resources_by_id().values():
        if not resource_allowed(r, sig):
            continue
        scored.append((resource_match_score(r, sig), resource_to_card(r)))
    scored.sort(key=lambda x: -x[0])
    return [c for _, c in scored[:limit]]


def _pool_materials(
    *,
    sphere: str,
    track: Optional[str],
    preparation: str,
    learning_path: Optional[Dict[str, Any]],
    signals: Optional[Dict[str, Any]] = None,
    use_llm_filter: bool = False,
) -> List[Dict[str, Any]]:
    merged: List[Dict[str, Any]] = []
    seen: Set[str] = set()

    def add(card: Dict[str, Any]) -> None:
        url = (card.get("url") or "").strip()
        if url and url != "#" and url not in seen:
            seen.add(url)
            merged.append(card)

    for c in _flatten_path_resources(learning_path):
        add(c)
    for c in _catalog_resources_for_track(
        sphere, track, preparation, limit=6, signals=signals
    ):
        add(c)
    plan_hint = str((signals or {}).get("best_plan_name") or "")
    return filter_materials_for_context(
        merged,
        track=track,
        sphere=sphere,
        plan_direction=plan_hint,
        use_llm=use_llm_filter,
    )[:14]


def _material_card(m: Dict[str, Any]) -> Dict[str, Any]:
    desc = str(m.get("description") or "").strip()
    card: Dict[str, Any] = {
        "title": m.get("title"),
        "url": m.get("url") or "",
        "kind": m.get("kind") or "ресурс",
        "provider": m.get("provider"),
    }
    if desc:
        card["description"] = desc[:220]
    return card


def _pick_materials(
    materials: List[Dict[str, Any]],
    *,
    keywords: Tuple[str, ...],
    limit: int = 2,
    used_urls: Optional[Set[str]] = None,
    track: Optional[str] = None,
) -> List[Dict[str, Any]]:
    used = used_urls if used_urls is not None else set()
    scored: List[Tuple[float, Dict[str, Any]]] = []
    for m in materials:
        url = m.get("url") or ""
        if url in used:
            continue
        blob = " ".join(
            str(m.get(k) or "")
            for k in ("title", "description", "kind", "provider", "step_title")
        ).lower()
        score = sum(3.0 for kw in keywords if kw and kw in blob)
        if score > 0:
            scored.append((score, m))
        else:
            h = heuristic_material_score(m, track=track)
            if h >= 8:
                scored.append((float(h), m))
    scored.sort(key=lambda x: -x[0])
    picked: List[Dict[str, Any]] = []
    for _, m in scored[:limit]:
        url = m.get("url") or ""
        if url:
            used.add(url)
        picked.append(_material_card(m))
    return picked


def _step(
    text: str,
    materials: Optional[List[Dict[str, Any]]] = None,
    *,
    section: str = "",
) -> Dict[str, Any]:
    out: Dict[str, Any] = {"text": text, "materials": materials or []}
    if section:
        out["section"] = section
    return out


def _human_skill_label(skill: str) -> str:
    sk = (skill or "").strip()
    if not sk:
        return "пункты из разбора"
    if re.match(r"^[a-z0-9_.\-]+$", sk, re.I):
        return sk.replace("_", " ").replace("-", " ").title()
    return sk


def _skill_keywords(skill: str, track: Optional[str]) -> Tuple[str, ...]:
    parts = [p for p in re.split(r"[\s_\-]+", skill.lower()) if len(p) > 2]
    if track:
        parts.append(track)
    return tuple(parts[:4])


_PAIN_INTRO: Dict[str, str] = {
    "pain_career": "Сейчас полезно выбрать одно направление и проверить его маленьким делом за пару недель — без бесконечного «а вдруг другое».",
    "pain_no_exp": "Опыта в резюме может не быть — это нормально: опирайтесь на учёбу, проекты и то, чем уже помогали людям.",
    "pain_region": "Если город сужает выбор — смотрите удалёнку и 2–3 города, где реально есть вакансии по вашей сфере.",
    "pain_money_courses": "Платные курсы не обязательны: возьмите один бесплатный трек ниже и доведите до конкретного результата.",
    "pain_interview": "Собеседования пугают — отработайте три ответа вслух, с таймером на 2 минуты, по типовым вопросам сферы.",
    "pain_overload": "Не пытайтесь закрыть всё сразу: один шаг на эту неделю, остальное — в заметку «потом».",
    "pain_low_confidence": "Если кажется, что «ничего не умею» — начните с фактов из жизни (школа, хобби, помощь людям), а не с сравнением с идеалом.",
    "pain_gap_skills": "Разрыв навыков — это список задач, а не приговор: закройте один узкий пункт за месяц.",
}


def _build_plan_intro(
    plan_name: str,
    *,
    score: Any,
    like: str,
    pain_id: Optional[str],
) -> str:
    if score is not None:
        intro = f"Этот вариант совпадает с вашими ответами примерно на {score}%."
    else:
        intro = "Этот вариант собран по вашим ответам."
    if like:
        intro += f" Также учтено, что вам нравится: {like[:72].strip()}."
    return intro


def _flatten_sections(sections: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    flat: List[Dict[str, Any]] = []
    for sec in sections:
        title = str(sec.get("title") or "").strip()
        for st in sec.get("steps") or []:
            if not isinstance(st, dict):
                continue
            item = dict(st)
            if title and not item.get("section"):
                item["section"] = title
            flat.append(item)
    return flat


def _rule_based_plan_advice(
    plan: Dict[str, Any],
    *,
    preparation: str,
    profile: Dict[str, Any],
    gap: Dict[str, Any],
    sphere: str,
    materials: List[Dict[str, Any]],
    pain_id: Optional[str],
    priority: List[str],
    base_track: Optional[str] = None,
) -> Dict[str, Any]:
    plan_name = _plan_label(plan)
    track = _infer_track_from_plan(plan_name) or base_track
    used: Set[str] = set()
    priority_top = [_human_skill_label(s) for s in priority[:3]]
    like = (profile.get("like_to_do") or "").strip()[:100]
    intro = _build_plan_intro(
        plan_name,
        score=plan.get("score_percent"),
        like=like,
        pain_id=pain_id,
    )

    skill_focus = priority_top[0] if priority_top else "базу по направлению"
    skill_kw = _skill_keywords(priority[0] if priority else "", track)

    sections: List[Dict[str, Any]] = []

    sections.append(
        {
            "title": "С чего начать",
            "steps": [
                _step(
                    f"Подтяните «{skill_focus}»: 30–60 минут в день, один материал ниже. "
                    "К концу недели — короткий итог: конспект или мини-задача.",
                    _pick_materials(
                        materials,
                        keywords=skill_kw + (track or "", "курс", "урок"),
                        limit=2,
                        used_urls=used,
                        track=track,
                    ),
                    section="С чего начать",
                ),
            ],
        }
    )

    learn_text = {
        "weak": (
            "Начните с базы: выделите 10–15 часов на вводный курс. "
            "С откликами не спешите, пока не сделали одно задание из курса."
        ),
        "medium": (
            "Проходите один учебный модуль в неделю и сразу добавляйте небольшую практику "
            "(задача, скрипт или макет)."
        ),
        "strong": (
            "Сделайте небольшой самостоятельный проект за 2–3 недели. "
            "Курс как справочник, не бесконечная теория."
        ),
    }
    learn_kw: Tuple[str, ...] = ("курс", "intro", "beginner", "основ", track or "обучен")
    if preparation == "strong":
        learn_kw = ("github", "portfolio", "project", track or "", "практик")
    elif preparation == "medium":
        learn_kw = (track or "practice", "практик", "exercism", "stepik")

    sections.append(
        {
            "title": "Обучение",
            "steps": [
                _step(
                    learn_text.get(preparation, learn_text["medium"]),
                    _pick_materials(
                        materials, keywords=learn_kw, limit=2, used_urls=used, track=track
                    ),
                    section="Обучение",
                ),
            ],
        }
    )

    sections.append(
        {
            "title": "Резюме и отклики",
            "steps": [
                _step(
                    "Через 2–3 недели обновите резюме: добавьте три пункта о том, "
                    "что изучили, что сделали и какой получили результат. "
                    "Попросите близких назвать 2 сильные стороны.",
                    _pick_materials(
                        materials,
                        keywords=(track or "", "stepik", "roadmap", "курс"),
                        limit=1,
                        used_urls=used,
                        track=track,
                    ),
                    section="Резюме и отклики",
                ),
            ],
        }
    )

    steps = _flatten_sections(sections)

    return {
        "title": plan.get("name", "План"),
        "plan_direction": plan_name,
        "track": track,
        "intro": intro,
        "priority_skills": priority_top,
        "sections": sections,
        "steps": steps,
        "source": "rules",
    }


def _parse_llm_advice_json(raw: str) -> Optional[Dict[str, Any]]:
    text = (raw or "").strip()
    if not text:
        return None
    m = re.search(r"```(?:json)?\s*([\s\S]*?)```", text)
    if m:
        text = m.group(1).strip()
    try:
        data = json.loads(text)
        return data if isinstance(data, dict) else None
    except json.JSONDecodeError:
        return None


def _allowed_material_urls(materials: List[Dict[str, Any]]) -> Set[str]:
    return {(m.get("url") or "").strip() for m in materials if (m.get("url") or "").strip()}


def _clamp_materials_to_pool(
    mats: List[Dict[str, Any]],
    allowed: Set[str],
    pool: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    by_url = {(m.get("url") or "").strip(): m for m in pool if m.get("url")}
    out: List[Dict[str, Any]] = []
    for m in mats:
        url = (m.get("url") or "").strip()
        if not url or url not in allowed:
            continue
        base = by_url.get(url, m)
        out.append(_material_card(base))
    return out


def _merge_llm_plan(
    plan_id: str,
    plan: Dict[str, Any],
    llm_block: Dict[str, Any],
    *,
    fallback: Dict[str, Any],
    allowed_urls: Optional[Set[str]] = None,
    material_pool: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    def _parse_step(item: Any, section: str = "") -> Optional[Dict[str, Any]]:
        if isinstance(item, str):
            text = item.strip()
            return _step(text, section=section) if text else None
        if not isinstance(item, dict):
            return None
        text = str(item.get("text") or item.get("step") or "").strip()
        if not text:
            return None
        mats = []
        for m in item.get("materials") or []:
            if isinstance(m, dict) and m.get("url"):
                mats.append(_material_card(m))
        if allowed_urls is not None and material_pool is not None:
            mats = _clamp_materials_to_pool(mats, allowed_urls, material_pool)
        sec = str(item.get("section") or section or "").strip()
        return _step(text, mats, section=sec)

    sections: List[Dict[str, Any]] = []
    llm_sections = llm_block.get("sections")
    if isinstance(llm_sections, list) and llm_sections:
        for sec in llm_sections[:4]:
            if not isinstance(sec, dict):
                continue
            title = str(sec.get("title") or "").strip() or "Шаги"
            sec_steps: List[Dict[str, Any]] = []
            for item in sec.get("steps") or []:
                st = _parse_step(item, section=title)
                if st:
                    sec_steps.append(st)
            if sec_steps:
                sections.append({"title": title, "steps": sec_steps})

    steps: List[Dict[str, Any]] = []
    if sections:
        steps = _flatten_sections(sections)
    else:
        for item in llm_block.get("steps") or []:
            st = _parse_step(item)
            if st:
                steps.append(st)
        if steps:
            sections = [{"title": "Ваш план", "steps": steps}]

    if not steps:
        return fallback
    intro = str(llm_block.get("intro") or "").strip() or fallback.get("intro") or ""
    return {
        "title": llm_block.get("title") or plan.get("name") or f"План {plan_id}",
        "plan_direction": _plan_label(plan),
        "track": fallback.get("track"),
        "intro": intro,
        "priority_skills": llm_block.get("priority_skills") or fallback.get("priority_skills"),
        "sections": sections or fallback.get("sections"),
        "steps": steps[:5],
        "source": "llm",
    }


def build_individual_advice(
    *,
    scenarios: Dict[str, Any],
    preparation_level: str,
    profile: Dict[str, Any],
    gap: Dict[str, Any],
    interest: str,
    learning_path: Optional[Dict[str, Any]] = None,
    profile_summary: str = "",
    user_id: Optional[str] = None,
    assessment_signals: Optional[Dict[str, Any]] = None,
    axes: Optional[List[Dict[str, Any]]] = None,
    answers: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    """
    Советы по планам A/B/C с материалами.
    При наличии LLM — персонализация; иначе правила + каталог/путь обучения.
    """
    from wibe_work.services.career_analysis import _resolve_effective_interest

    plans = scenarios.get("plans") or []
    sphere = _resolve_effective_interest(profile, interest)
    pain_id = (profile.get("primary_pain") or "").strip()
    priority = _priority_skills(gap)
    signals = assessment_signals or build_assessment_signals(
        profile=profile,
        interest=interest,
        preparation_level=preparation_level,
        scenarios=scenarios,
        gap=gap,
        axes=axes,
        answers=answers,
    )
    base_track = signals.get("track")

    if learning_path is None and user_id is not None:
        learning_path = build_learning_path_payload(
            user_id=user_id,
            profile=profile,
            interest=interest,
            preparation_level=preparation_level,
            scenarios=scenarios,
            gap=gap,
            axes=axes,
            answers=answers,
            assessment_signals=signals,
        )

    by_plan: Dict[str, Any] = {}
    materials_global = filter_materials_for_context(
        _pool_materials(
            sphere=sphere,
            track=base_track or _infer_track_from_plan(_plan_label(plans[0]) if plans else ""),
            preparation=preparation_level,
            learning_path=learning_path,
            signals=signals,
            use_llm_filter=False,
        ),
        track=base_track,
        sphere=sphere,
        plan_direction=str(signals.get("best_plan_name") or ""),
        use_llm=False,
    )

    # LLM: один запрос на все планы (не для школы/СПО — шаблоны быстрее и без hh-жаргона).
    llm_by_plan: Dict[str, Any] = {}
    grade = profile_education_grade(profile)
    allow_llm = grade not in ("school", "vocational")
    if llm_configured() and plans and profile_summary and allow_llm:
        mat_lines = []
        for i, m in enumerate(materials_global[:12], 1):
            desc = str(m.get("description") or "").strip()[:100]
            line = f"{i}. [{m.get('kind')}] {m.get('title')} — {m.get('url')} ({m.get('provider')})"
            if desc:
                line += f" — {desc}"
            mat_lines.append(line)
        pain_hint = _PAIN_INTRO.get(pain_id, "") if pain_id else ""
        prompt = build_advice_user_prompt(
            profile_summary=profile_summary,
            preparation_level=preparation_level,
            priority_skills=priority,
            plans=plans,
            materials_list="\n".join(mat_lines) or "—",
            pain_hint=pain_hint,
            education_grade=grade,
        )
        raw, _ = fetch_llm_completion(
            prompt,
            max_tokens=1200,
            temperature=0.45,
            system_prompt=advice_json_system_for_grade(grade, profile, interest=str(interest or "")),
            timeout=12.0,
        )
        parsed = _parse_llm_advice_json(raw or "")
        if parsed:
            llm_by_plan = parsed.get("by_plan") or parsed

    for p in plans:
        pid = str(p.get("id") or "A")
        track = _infer_track_from_plan(_plan_label(p)) or base_track
        plan_name = _plan_label(p)
        mats = filter_materials_for_context(
            _pool_materials(
                sphere=sphere,
                track=track,
                preparation=preparation_level,
                learning_path=learning_path,
                signals=signals,
                use_llm_filter=False,
            ),
            track=track,
            sphere=sphere,
            plan_direction=plan_name,
            use_llm=allow_llm,
        )
        allowed = _allowed_material_urls(mats)
        fallback = _rule_based_plan_advice(
            p,
            preparation=preparation_level,
            profile=profile,
            gap=gap,
            sphere=sphere,
            materials=mats,
            pain_id=pain_id if pid == "A" else None,
            priority=priority,
            base_track=base_track,
        )
        llm_block = llm_by_plan.get(pid) if isinstance(llm_by_plan, dict) else None
        if isinstance(llm_block, dict) and llm_block.get("steps"):
            by_plan[pid] = _merge_llm_plan(
                pid,
                p,
                llm_block,
                fallback=fallback,
                allowed_urls=allowed,
                material_pool=mats,
            )
        else:
            by_plan[pid] = fallback

    return {
        "by_plan": by_plan,
        "source": "llm" if any(b.get("source") == "llm" for b in by_plan.values()) else "rules",
    }
