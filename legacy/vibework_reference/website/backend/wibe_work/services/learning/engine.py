"""Сборка пути обучения и карточек для разбора."""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from wibe_work.services.learning.adapters import integration_status, run_dynamic_adapter
from wibe_work.services.learning.assessment_signals import (
    build_assessment_signals,
    resource_allowed,
)
from wibe_work.services.learning.catalog import (
    get_resource,
    pick_path,
    resource_to_card,
    resources_by_id,
)
from wibe_work.services.learning.progress import (
    apply_progress_to_steps,
    compute_metrics,
    get_progress_map,
)
from wibe_work.services.learning.substeps import attach_substeps_to_step


def _infer_track(
    scenarios: Optional[Dict[str, Any]],
    *,
    sphere: str = "",
    answers: Optional[List[Dict[str, Any]]] = None,
    axes: Optional[List[Dict[str, Any]]] = None,
    signals: Optional[Dict[str, Any]] = None,
) -> Optional[str]:
    if signals and signals.get("track"):
        return str(signals["track"])
    from wibe_work.services.learning.assessment_signals import resolve_learning_track

    track, _ = resolve_learning_track(
        sphere=sphere,
        scenarios=scenarios,
        answers=answers,
        axes=axes,
    )
    return track


def _resolve_sphere(interest: str, profile: Dict[str, Any]) -> str:
    from wibe_work.services.career_analysis import _resolve_effective_interest

    return _resolve_effective_interest(profile, interest)


def _priority_skills_from_gap(gap: Optional[Dict[str, Any]]) -> List[str]:
    if not gap:
        return []
    out: List[str] = []
    for bar in gap.get("bars") or []:
        lab = bar.get("label") or bar.get("key")
        if lab:
            out.append(str(lab))
    closing = gap.get("closing_skills") or []
    for c in closing:
        if c and str(c) not in out:
            out.append(str(c))
    return out[:5]


def _enrich_step_resources(
    step: Dict[str, Any],
    *,
    sphere: Optional[str] = None,
    track: Optional[str] = None,
    signals: Optional[Dict[str, Any]] = None,
) -> List[Dict[str, Any]]:
    by_id = resources_by_id()
    seen_urls: set[str] = set()
    out: List[Dict[str, Any]] = []

    def add(card: Dict[str, Any]) -> None:
        url = (card.get("url") or "").strip()
        if not url or url in seen_urls:
            return
        seen_urls.add(url)
        out.append(card)

    for rid in step.get("resource_ids") or []:
        r = by_id.get(str(rid))
        if r and (not signals or resource_allowed(r, signals)):
            add(resource_to_card(r, source_type="curated"))

    for spec in step.get("dynamic") or []:
        dyn = dict(spec)
        if track and "track" not in dyn:
            dyn["track"] = track
        if sphere and "sphere" not in dyn:
            dyn["sphere"] = sphere
        if not dyn.get("step_title"):
            dyn["step_title"] = str(step.get("title") or "")
        if signals and not dyn.get("plan_direction"):
            dyn["plan_direction"] = str(signals.get("best_plan_name") or "")
        from wibe_work.services.learning.material_relevance import filter_materials_for_context
        from wibe_work.services.llm_client import llm_configured

        dyn_track = dyn.get("track") or track
        plan_hint = str(dyn.get("plan_direction") or step.get("title") or "")
        for card in filter_materials_for_context(
            run_dynamic_adapter(dyn),
            track=dyn_track,
            sphere=sphere or "",
            plan_direction=plan_hint,
            use_llm=llm_configured(),
        ):
            add(card)

    return out[:8]


_SPHERE_STEP_RESOURCE: Dict[str, str] = {
    "marketing": "hubspot_academy",
    "sales": "hubspot_academy",
    "design": "figma_learn",
    "creative": "figma_learn",
    "data": "kaggle_learn",
    "it_dev": "stepik_python",
}


def build_learning_path_payload(
    *,
    user_id: Optional[str],
    profile: Dict[str, Any],
    interest: str,
    preparation_level: str,
    scenarios: Optional[Dict[str, Any]] = None,
    gap: Optional[Dict[str, Any]] = None,
    axes: Optional[List[Dict[str, Any]]] = None,
    answers: Optional[List[Dict[str, Any]]] = None,
    assessment_signals: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    signals = assessment_signals or build_assessment_signals(
        profile=profile,
        interest=interest,
        preparation_level=preparation_level,
        scenarios=scenarios,
        gap=gap,
        axes=axes,
        answers=answers,
    )
    if signals.get("analysis_mode") == "school":
        from wibe_work.services.school_subject_resources import build_school_learning_path_payload

        return build_school_learning_path_payload(
            user_id=user_id,
            profile=profile,
            interest=interest,
            preparation_level=preparation_level,
            scenarios=scenarios,
            gap=gap,
        )
    sphere = str(signals.get("sphere") or _resolve_sphere(interest, profile))
    track = _infer_track(
        scenarios,
        sphere=sphere,
        answers=answers,
        axes=axes,
        signals=signals,
    )
    signals = dict(signals)
    signals["track"] = track
    path_def = pick_path(sphere, track, preparation_level, signals=signals)
    if not path_def:
        return {
            "path_id": None,
            "title": "Путь обучения",
            "steps": [],
            "metrics": compute_metrics([]),
            "integration": integration_status(),
        }

    path_id = str(path_def.get("id") or "")
    steps_out: List[Dict[str, Any]] = []
    by_id = resources_by_id()
    for raw in sorted(path_def.get("steps") or [], key=lambda s: int(s.get("order") or 0)):
        step_raw = dict(raw)
        if path_id == "general_career":
            rids = [
                str(rid)
                for rid in (step_raw.get("resource_ids") or [])
                if by_id.get(str(rid)) and resource_allowed(by_id[str(rid)], signals)
            ]
            if not rids:
                fallback_rid = _SPHERE_STEP_RESOURCE.get(sphere)
                fb_res = by_id.get(fallback_rid) if fallback_rid else None
                if fb_res and resource_allowed(fb_res, signals):
                    rids = [fallback_rid]
            step_raw["resource_ids"] = rids
        resources = _enrich_step_resources(
            step_raw, sphere=sphere, track=track, signals=signals
        )
        steps_out.append(
            attach_substeps_to_step(
                {
                    "step_id": raw.get("id"),
                    "order": raw.get("order"),
                    "title": raw.get("title"),
                    "goal": raw.get("goal"),
                    "duration_hint": raw.get("duration_hint"),
                    "skills": raw.get("skills") or [],
                    "checkpoint": raw.get("goal"),
                    "resources": resources,
                    "status": "pending",
                }
            )
        )

    progress: Dict[str, str] = {}
    if user_id and path_id:
        progress = get_progress_map(user_id, path_id)
    steps_out = apply_progress_to_steps(steps_out, progress)
    metrics = compute_metrics(steps_out)

    priority_skills: List[str] = []
    if gap:
        for bar in gap.get("bars") or []:
            lab = bar.get("label") or bar.get("key")
            if lab:
                priority_skills.append(str(lab))

    return {
        "path_id": path_id,
        "title": path_def.get("title") or "Путь обучения",
        "sphere": sphere,
        "track": track,
        "preparation_level": preparation_level,
        "steps": steps_out,
        "metrics": metrics,
        "priority_skills_from_gap": priority_skills[:5],
        "assessment_signals": {
            "sphere": signals.get("sphere"),
            "track": track,
            "track_source": signals.get("track_source"),
            "best_plan_name": signals.get("best_plan_name"),
            "dominant_axis": signals.get("dominant_axis"),
        },
        "integration": integration_status(),
    }


def build_learning_for_analysis(
    *,
    user_id: Optional[str],
    profile: Dict[str, Any],
    interest: str,
    preparation_level: str,
    scenarios: Optional[Dict[str, Any]] = None,
    gap: Optional[Dict[str, Any]] = None,
    axes: Optional[List[Dict[str, Any]]] = None,
    answers: Optional[List[Dict[str, Any]]] = None,
    assessment_signals: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Карточки для блока «Обучение» + полный learning_path."""
    path_payload = build_learning_path_payload(
        user_id=user_id,
        profile=profile,
        interest=interest,
        preparation_level=preparation_level,
        scenarios=scenarios,
        gap=gap,
        axes=axes,
        answers=answers,
        assessment_signals=assessment_signals,
    )
    cards: List[Dict[str, Any]] = []
    seen: set[str] = set()
    steps = path_payload.get("steps") or []
    current_idx = int((path_payload.get("metrics") or {}).get("current_step_index") or 0)
    # текущий и следующий шаг — в приоритете для карточек
    order_indices = [current_idx]
    if current_idx + 1 < len(steps):
        order_indices.append(current_idx + 1)
    for i, step in enumerate(steps):
        if i not in order_indices and len(cards) >= 6:
            continue
        for res in step.get("resources") or []:
            url = res.get("url") or ""
            if url in seen:
                continue
            seen.add(url)
            cards.append(
                {
                    "title": res.get("title"),
                    "url": url,
                    "kind": res.get("kind") or "ресурс",
                    "description": (res.get("description") or step.get("goal") or "")[:300],
                    "step_title": step.get("title"),
                    "provider": res.get("provider"),
                }
            )
            if len(cards) >= 8:
                break
        if len(cards) >= 8:
            break

    if not cards:
        sig = assessment_signals or path_payload.get("assessment_signals") or {}
        if not sig.get("sphere"):
            sig = build_assessment_signals(
                profile=profile,
                interest=interest,
                preparation_level=preparation_level,
                scenarios=scenarios,
                gap=gap,
                axes=axes,
                answers=answers,
            )
        from wibe_work.services.learning.catalog import pick_catalog_resources_for_signals

        cards = pick_catalog_resources_for_signals(sig, limit=6)

    return {"learning": cards, "learning_path": path_payload}


def get_integration_status() -> Dict[str, Any]:
    return integration_status()


def learning_cards_from_path_payload(
    path_payload: Dict[str, Any],
    *,
    limit: int = 8,
) -> List[Dict[str, Any]]:
    """Карточки из уже сохранённых resources шагов (без повторных внешних адаптеров)."""
    cards: List[Dict[str, Any]] = []
    seen: set[str] = set()
    for step in path_payload.get("steps") or []:
        for res in step.get("resources") or []:
            url = (res.get("url") or "").strip()
            if not url or url in seen:
                continue
            seen.add(url)
            cards.append(
                {
                    "title": res.get("title"),
                    "url": url,
                    "kind": res.get("kind") or "ресурс",
                    "description": (res.get("description") or step.get("goal") or "")[:300],
                    "step_title": step.get("title"),
                    "provider": res.get("provider"),
                }
            )
            if len(cards) >= limit:
                return cards
    return cards


def merge_learning_progress_in_snapshot(
    snap: Dict[str, Any],
    user_id: str,
) -> Dict[str, Any]:
    """Обновить только статусы шагов из БД — без пересборки каталога и API."""
    lp = snap.get("learning_path")
    if not isinstance(lp, dict) or not lp.get("path_id"):
        return snap
    path_id = str(lp["path_id"])
    steps = list(lp.get("steps") or [])
    if not steps:
        return snap
    progress = get_progress_map(user_id, path_id)
    steps = apply_progress_to_steps(steps, progress)
    out = dict(snap)
    lp_out = dict(lp)
    lp_out["steps"] = steps
    lp_out["metrics"] = compute_metrics(steps)
    out["learning_path"] = lp_out
    if not out.get("learning"):
        cards = learning_cards_from_path_payload(lp_out)
        if cards:
            out["learning"] = cards
    return out
