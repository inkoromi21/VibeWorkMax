"""Оценка релевантности видео по заголовку и запросу (VK и др.)."""

from __future__ import annotations

import re
from typing import Optional

_COURSE_MARKERS = (
    "курс",
    "плейлист",
    "урок",
    "лекц",
    "обучен",
    "вебинар",
    "марафон",
    "туториал",
    "с нуля",
    "полный",
    "разбор",
)


def course_score(
    title: str,
    query: str,
    *,
    description: str = "",
    track: Optional[str] = None,
) -> float:
    from wibe_work.services.learning.material_relevance import (
        _TRACK_POSITIVE,
        is_entertainment_or_sport,
    )

    t = (title or "").lower()
    desc = (description or "").lower()
    blob = f"{t} {desc}"
    if is_entertainment_or_sport({"title": title, "description": description}):
        return -100.0
    q = (query or "").lower()
    score = 0.0
    q_hits = 0
    for w in re.split(r"\s+", q):
        if len(w) > 3 and w in blob:
            score += 3.0
            q_hits += 1
        elif len(w) > 2 and w in t:
            score += 1.5
            q_hits += 1
    tr = (track or "").strip().lower()
    track_hits = 0
    if tr:
        for kw in _TRACK_POSITIVE.get(tr, ()):
            if kw in blob:
                track_hits += 1
                score += 2.0
    edu_markers = 0
    for m in _COURSE_MARKERS:
        if m in t:
            edu_markers += 1
            score += 2.0
    if "полный курс" in t or "курс с нуля" in t or "плейлист" in t:
        score += 3.0
    if "разбор" in t and q_hits == 0 and track_hits == 0:
        score -= 12.0
    if q_hits >= 2 or (q_hits >= 1 and edu_markers >= 1 and track_hits >= 1):
        return score
    if q_hits >= 1 and edu_markers >= 2 and track_hits >= 1:
        return score
    if q and q_hits == 0 and track_hits == 0:
        return -50.0
    if edu_markers >= 1 and track_hits >= 2:
        return score
    return -20.0
