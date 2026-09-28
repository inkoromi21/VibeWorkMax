"""Сохранение последнего прохождения симулятора «день на работе» (для админки)."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from wibe_work.sqlite_db import get_db


def _migrate(conn) -> None:
    conn.execute(
        """CREATE TABLE IF NOT EXISTS simulator_progress (
            user_id TEXT PRIMARY KEY,
            role TEXT,
            step_index INTEGER NOT NULL DEFAULT 0,
            career_points INTEGER NOT NULL DEFAULT 0,
            done INTEGER NOT NULL DEFAULT 0,
            day_path_json TEXT NOT NULL DEFAULT '[]',
            state_json TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )"""
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_simulator_progress_updated ON simulator_progress(updated_at DESC)"
    )


def ensure_table() -> None:
    with get_db() as conn:
        _migrate(conn)
        conn.commit()


def save_progress(user_id: str, state: Dict[str, Any]) -> None:
    if not user_id or not state:
        return
    ensure_table()
    role = str(state.get("role") or "")
    step_index = int(state.get("step_index") or 0)
    career_points = int(state.get("career_points") or 0)
    done = 1 if state.get("done") else 0
    day_path = state.get("day_path") or []
    if not isinstance(day_path, list):
        day_path = []
    now = datetime.now(timezone.utc).isoformat()
    payload = json.dumps(state, ensure_ascii=False)
    day_json = json.dumps(day_path, ensure_ascii=False)
    with get_db() as conn:
        conn.execute(
            """INSERT INTO simulator_progress
               (user_id, role, step_index, career_points, done, day_path_json, state_json, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(user_id) DO UPDATE SET
                 role = excluded.role,
                 step_index = excluded.step_index,
                 career_points = excluded.career_points,
                 done = excluded.done,
                 day_path_json = excluded.day_path_json,
                 state_json = excluded.state_json,
                 updated_at = excluded.updated_at""",
            (user_id, role, step_index, career_points, done, day_json, payload, now),
        )
        conn.commit()


def get_progress(user_id: str) -> Optional[Dict[str, Any]]:
    ensure_table()
    with get_db() as conn:
        row = conn.execute(
            """SELECT role, step_index, career_points, done, day_path_json, state_json, updated_at
               FROM simulator_progress WHERE user_id = ?""",
            (user_id,),
        ).fetchone()
    if not row:
        return None
    try:
        state = json.loads(row["state_json"] or "{}")
    except (json.JSONDecodeError, TypeError):
        state = {}
    try:
        day_path = json.loads(row["day_path_json"] or "[]")
    except (json.JSONDecodeError, TypeError):
        day_path = []
    return {
        "role": row["role"],
        "step_index": int(row["step_index"] or 0),
        "career_points": int(row["career_points"] or 0),
        "done": bool(row["done"]),
        "day_path": day_path if isinstance(day_path, list) else [],
        "state": state if isinstance(state, dict) else {},
        "updated_at": row["updated_at"],
    }
