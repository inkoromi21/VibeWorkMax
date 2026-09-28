"""Подшаги внутри этапа пути обучения (материалы и цель)."""

from __future__ import annotations

from typing import Any, Dict, List

SUBSTEP_SEP = "__"

_LEGACY_GOAL_SUB_IDS = frozenset({"goal"})
_LEGACY_GOAL_SUB_TITLES = frozenset(
    {
        "понять цель этапа",
        "понять цель",
    }
)


def is_legacy_goal_substep(sub: Dict[str, Any]) -> bool:
    """Подшаг «Понять цель» из старых снимков разбора — не показываем."""
    sid = str(sub.get("sub_id") or "").strip().lower()
    if sid in _LEGACY_GOAL_SUB_IDS:
        return True
    title = str(sub.get("title") or "").strip().lower()
    if title in _LEGACY_GOAL_SUB_TITLES:
        return True
    return title.startswith("понять цель")


def substep_storage_id(step_id: str, sub_id: str) -> str:
    return f"{step_id}{SUBSTEP_SEP}{sub_id}"


def parse_storage_id(storage_id: str) -> tuple[str, str | None]:
    if SUBSTEP_SEP in storage_id:
        parent, sub = storage_id.split(SUBSTEP_SEP, 1)
        return parent, sub or None
    return storage_id, None


def build_substeps_for_step(
    *,
    goal: str | None,
    resources: List[Dict[str, Any]] | None,
) -> List[Dict[str, Any]]:
    """Контракт подшага для UI и прогресса (только материалы; цель — в шапке этапа)."""
    substeps: List[Dict[str, Any]] = []
    goal_txt = (goal or "").strip()
    for i, res in enumerate(resources or []):
        title = str(res.get("title") or "Материал").strip() or "Материал"
        substeps.append(
            {
                "sub_id": f"res{i}",
                "title": title,
                "url": (res.get("url") or "").strip(),
                "kind": str(res.get("kind") or "").strip(),
                "description": str(res.get("description") or "")[:240],
                "provider": res.get("provider"),
                "status": "pending",
            }
        )
    if not substeps:
        substeps.append(
            {
                "sub_id": "main",
                "title": "Выполнить этап",
                "description": goal_txt,
                "status": "pending",
            }
        )
    return substeps


def attach_substeps_to_step(step: Dict[str, Any]) -> Dict[str, Any]:
    row = dict(step)
    existing = row.get("substeps")
    if isinstance(existing, list) and existing:
        filtered = [
            s for s in existing if isinstance(s, dict) and not is_legacy_goal_substep(s)
        ]
        if filtered:
            row["substeps"] = filtered
        else:
            row["substeps"] = build_substeps_for_step(
                goal=row.get("goal"),
                resources=row.get("resources"),
            )
    else:
        row["substeps"] = build_substeps_for_step(
            goal=row.get("goal"),
            resources=row.get("resources"),
        )
    return row
