"""
VK Video API: video.search и video.get.

Документация:
- https://dev.vk.com/ru/method/video.search
- https://dev.vk.com/ru/method/video.get

Токен: сервисный ключ приложения или access_token с правом video
(для video.get по закрытым записям — пользовательский ключ).
"""

from __future__ import annotations

import logging
import re
from typing import Any, Dict, List, Optional, Set, Tuple

import requests

from wibe_work.config import VK_ACCESS_TOKEN, VK_API_VERSION, VK_VIDEO_OWNER_IDS
from wibe_work.services.learning.video_scoring import course_score

_log = logging.getLogger(__name__)
_TIMEOUT = 12
_API = "https://api.vk.com/method"


def _vk_call(method: str, **params: Any) -> Any:
    if not VK_ACCESS_TOKEN:
        return None
    p = dict(params)
    p["access_token"] = VK_ACCESS_TOKEN
    p["v"] = VK_API_VERSION
    try:
        r = requests.get(f"{_API}/{method}", params=p, timeout=_TIMEOUT)
        r.raise_for_status()
        data = r.json()
    except Exception as e:
        _log.debug("vk %s request failed: %s", method, e)
        return None
    if "error" in data:
        err = data["error"]
        _log.debug(
            "vk %s error %s: %s",
            method,
            err.get("error_code"),
            err.get("error_msg"),
        )
        return None
    return data.get("response")


def _video_page_url(owner_id: int, video_id: int) -> str:
    return f"https://vk.com/video{owner_id}_{video_id}"


def _item_to_card(
    item: Dict[str, Any],
    *,
    query: str = "",
    track: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    try:
        owner_id = int(item.get("owner_id"))
        video_id = int(item.get("id"))
    except (TypeError, ValueError):
        return None
    url = _video_page_url(owner_id, video_id)
    title = str(item.get("title") or "Видео VK").strip()
    desc = str(item.get("description") or "")[:300]
    score = course_score(title, query, description=desc, track=track)
    if score < 6:
        return None
    kind = "курс" if score >= 8 else "видео"
    return {
        "title": title[:200],
        "url": url,
        "kind": kind,
        "description": desc,
        "provider": "vk",
        "source_type": "api",
        "is_free": True,
        "language": "ru",
        "_score": score,
    }


def vk_video_search(
    query: str,
    limit: int = 3,
    *,
    track: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """Поиск публичных видео (video.search)."""
    q = (query or "").strip()
    if not q or not VK_ACCESS_TOKEN:
        return []
    resp = _vk_call(
        "video.search",
        q=q,
        count=min(max(limit * 3, 6), 50),
        offset=0,
        sort=2,
        adult=0,
    )
    if not resp:
        return []
    items = list(resp.get("items") or [])
    scored: List[Tuple[float, Dict[str, Any]]] = []
    for item in items:
        card = _item_to_card(item, query=q, track=track)
        if card:
            scored.append((float(card.pop("_score", 0)), card))
    scored.sort(key=lambda x: -x[0])
    out: List[Dict[str, Any]] = []
    seen: Set[str] = set()
    for _, card in scored:
        u = card.get("url") or ""
        if u in seen:
            continue
        seen.add(u)
        out.append(card)
        if len(out) >= limit:
            break
    return out


def vk_video_get_from_owners(
    query: str,
    limit: int = 3,
    *,
    owner_ids: Optional[List[int]] = None,
    track: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """
    Видео из альбомов сообществ (video.get).
    owner_id сообщества — отрицательное число.
    """
    q = (query or "").strip()
    ids = owner_ids if owner_ids is not None else VK_VIDEO_OWNER_IDS
    if not ids or not VK_ACCESS_TOKEN:
        return []
    scored: List[Tuple[float, Dict[str, Any]]] = []
    seen: Set[str] = set()
    for owner_id in ids:
        resp = _vk_call("video.get", owner_id=owner_id, count=30, offset=0)
        if not resp:
            continue
        for item in resp.get("items") or []:
            card = _item_to_card(item, query=q, track=track)
            if not card:
                continue
            u = card.get("url") or ""
            if u in seen:
                continue
            seen.add(u)
            if q:
                score = course_score(
                    str(card.get("title") or ""),
                    q,
                    description=str(card.get("description") or ""),
                    track=track,
                )
                if score < 1 and not any(
                    w in (card.get("title") or "").lower()
                    for w in re.split(r"\s+", q)
                    if len(w) > 2
                ):
                    continue
                card["_score"] = score
            scored.append((float(card.pop("_score", 0)), card))
    scored.sort(key=lambda x: -x[0])
    return [c for _, c in scored[:limit]]


def vk_search_for_learning(
    query: str,
    *,
    track: Optional[str] = None,
    sphere: Optional[str] = None,
    limit: int = 3,
    prefer_course: bool = True,
) -> List[Dict[str, Any]]:
    """Поиск VK Video для шагов обучения."""
    del sphere
    q = (query or "").strip()
    if not q:
        q = "обучение курс"
    merged: List[Dict[str, Any]] = []
    seen: Set[str] = set()

    def add(cards: List[Dict[str, Any]]) -> None:
        for c in cards:
            u = c.get("url") or ""
            if u and u not in seen:
                seen.add(u)
                merged.append(c)

    add(vk_video_search(q, limit=limit + 1, track=track))
    if len(merged) < limit and VK_VIDEO_OWNER_IDS:
        add(vk_video_get_from_owners(q, limit=limit, track=track))
    if prefer_course:
        merged.sort(
            key=lambda c: course_score(
                str(c.get("title") or ""),
                q,
                description=str(c.get("description") or ""),
                track=track,
            ),
            reverse=True,
        )
    return merged[:limit]


def video_search_for_learning(
    query: str,
    *,
    track: Optional[str] = None,
    sphere: Optional[str] = None,
    limit: int = 3,
    plan_direction: str = "",
    step_title: str = "",
) -> List[Dict[str, Any]]:
    """Видео для шага пути: VK Video (нужен VK_ACCESS_TOKEN)."""
    from wibe_work.services.learning.material_relevance import (
        build_learning_search_query,
        filter_materials_for_context,
    )
    from wibe_work.services.llm_client import llm_configured

    if not VK_ACCESS_TOKEN:
        return []

    q = build_learning_search_query(
        query,
        track=track,
        sphere=sphere or "",
        step_title=step_title,
    )
    plan_hint = (plan_direction or "").strip()
    cards = vk_search_for_learning(
        q or query,
        track=track,
        sphere=sphere,
        limit=limit + 6,
        prefer_course=True,
    )
    return filter_materials_for_context(
        cards,
        track=track,
        sphere=sphere or "",
        plan_direction=plan_hint,
        use_llm=llm_configured(),
    )[:limit]
