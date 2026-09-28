"""Прогресс по шагам пути обучения."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from wibe_work.sqlite_db import get_db

from wibe_work.services.learning.substeps import (
    parse_storage_id,
    substep_storage_id,
)


def _migrate_learning_progress(conn) -> None:
    conn.execute(
        """CREATE TABLE IF NOT EXISTS learning_progress (
            user_id TEXT NOT NULL,
            path_id TEXT NOT NULL,
            step_id TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            updated_at TEXT NOT NULL,
            PRIMARY KEY (user_id, path_id, step_id)
        )"""
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_learning_progress_user ON learning_progress(user_id)"
    )


def ensure_table() -> None:
    with get_db() as conn:
        _migrate_learning_progress(conn)
        conn.commit()


def get_progress_map(user_id: str, path_id: str) -> Dict[str, str]:
    ensure_table()
    with get_db() as conn:
        rows = conn.execute(
            """SELECT step_id, status FROM learning_progress
               WHERE user_id = ? AND path_id = ?""",
            (user_id, path_id),
        ).fetchall()
    return {str(r["step_id"]): str(r["status"]) for r in rows}


def _write_status(
    conn,
    user_id: str,
    path_id: str,
    storage_id: str,
    status: str,
    now: str,
) -> None:
    conn.execute(
        """INSERT INTO learning_progress (user_id, path_id, step_id, status, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(user_id, path_id, step_id) DO UPDATE SET
             status = excluded.status,
             updated_at = excluded.updated_at""",
        (user_id, path_id, storage_id, status, now),
    )


def set_step_status(
    user_id: str,
    path_id: str,
    step_id: str,
    status: str,
    *,
    steps: Optional[List[Dict[str, Any]]] = None,
) -> None:
    if status not in ("pending", "in_progress", "done"):
        status = "pending"
    now = datetime.now(timezone.utc).isoformat()
    ensure_table()
    parent_id, sub_id = parse_storage_id(step_id.strip())
    with get_db() as conn:
        if sub_id is None and steps:
            for s in steps:
                if str(s.get("step_id") or "") != parent_id:
                    continue
                subs = s.get("substeps") or []
                if not subs:
                    _write_status(conn, user_id, path_id, parent_id, status, now)
                    break
                for sub in subs:
                    sid = substep_storage_id(parent_id, str(sub.get("sub_id") or ""))
                    _write_status(conn, user_id, path_id, sid, status, now)
                break
            else:
                _write_status(conn, user_id, path_id, step_id.strip(), status, now)
        else:
            _write_status(conn, user_id, path_id, step_id.strip(), status, now)
        conn.commit()


def _sync_substep_statuses(
    substeps: List[Dict[str, Any]], parent_id: str, progress: Dict[str, str]
) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for sub in substeps:
        row = dict(sub)
        sid = substep_storage_id(parent_id, str(sub.get("sub_id") or ""))
        row["status"] = progress.get(sid, progress.get(parent_id, "pending"))
        out.append(row)
    return out


def _derive_parent_status(subs: List[Dict[str, Any]], fallback: str) -> str:
    if not subs:
        return fallback
    if all(s.get("status") == "done" for s in subs):
        return "done"
    if any(s.get("status") == "in_progress" for s in subs):
        return "in_progress"
    if any(s.get("status") == "done" for s in subs):
        return "in_progress"
    return fallback


def apply_progress_to_steps(
    steps: List[Dict[str, Any]], progress: Dict[str, str]
) -> List[Dict[str, Any]]:
    from wibe_work.services.learning.substeps import attach_substeps_to_step

    out: List[Dict[str, Any]] = []
    for s in steps:
        row = attach_substeps_to_step(dict(s))
        sid = str(row.get("step_id") or "")
        subs = list(row.get("substeps") or [])
        if subs:
            row["substeps"] = _sync_substep_statuses(subs, sid, progress)
            row["status"] = _derive_parent_status(
                row["substeps"], progress.get(sid, "pending")
            )
        else:
            row["status"] = progress.get(sid, "pending")
        out.append(row)
    return out


def compute_metrics(steps: List[Dict[str, Any]]) -> Dict[str, Any]:
    flat: List[Dict[str, Any]] = []
    for s in steps:
        subs = s.get("substeps") or []
        if subs:
            flat.extend(subs)
        else:
            flat.append({"status": s.get("status")})

    total_sub = len(flat)
    done_sub = sum(1 for x in flat if x.get("status") == "done")
    in_prog_sub = sum(1 for x in flat if x.get("status") == "in_progress")

    parent_total = len(steps)
    parent_done = sum(1 for s in steps if s.get("status") == "done")

    current_idx = 0
    for i, s in enumerate(steps):
        subs = s.get("substeps") or []
        if subs:
            if all(x.get("status") == "done" for x in subs):
                continue
            current_idx = i
            break
        if s.get("status") != "done":
            current_idx = i
            break
    else:
        current_idx = max(0, parent_total - 1) if parent_total else 0

    pct = int(round(100 * done_sub / total_sub)) if total_sub else 0
    return {
        "total_steps": parent_total,
        "completed_steps": parent_done,
        "total_substeps": total_sub,
        "completed_substeps": done_sub,
        "in_progress_steps": in_prog_sub,
        "current_step_index": current_idx,
        "coverage_percent": pct,
    }
