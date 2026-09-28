"""Внешние источники: API где возможно, иначе пустой список."""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional
import requests

from wibe_work.config import (
    ESCO_API_ENABLED,
    GITHUB_TOKEN,
    ONET_PASSWORD,
    ONET_USERNAME,
)

_log = logging.getLogger(__name__)
_TIMEOUT = 12


def _get(url: str, *, headers: Optional[Dict[str, str]] = None, params: Optional[dict] = None) -> Any:
    h = dict(headers or {})
    r = requests.get(url, headers=h, params=params, timeout=_TIMEOUT)
    r.raise_for_status()
    return r.json()


def _card(
    title: str,
    url: str,
    *,
    provider: str,
    kind: str = "ресурс",
    source_type: str = "api",
    description: str = "",
) -> Dict[str, Any]:
    return {
        "title": title[:200],
        "url": url,
        "kind": kind,
        "description": description[:400],
        "provider": provider,
        "source_type": source_type,
        "is_free": True,
        "language": "en",
    }


def exercism_track_exercises(track_slug: str, limit: int = 3) -> List[Dict[str, Any]]:
    slug = (track_slug or "python").strip().lower()
    try:
        data = _get(f"https://api.exercism.org/v2/tracks/{slug}/exercises")
        out: List[Dict[str, Any]] = []
        for ex in (data.get("exercises") or [])[:limit]:
            slug_ex = ex.get("slug")
            title = ex.get("title") or slug_ex
            if not slug_ex:
                continue
            out.append(
                _card(
                    f"Exercism: {title}",
                    f"https://exercism.org/tracks/{slug}/exercises/{slug_ex}",
                    provider="exercism",
                    kind="практика",
                    description="Задача с автопроверкой на Exercism.",
                )
            )
        return out
    except Exception as e:
        _log.debug("exercism failed: %s", e)
        return []


def github_search_repos(query: str, limit: int = 2) -> List[Dict[str, Any]]:
    headers = {"Accept": "application/vnd.github+json"}
    if GITHUB_TOKEN:
        headers["Authorization"] = f"Bearer {GITHUB_TOKEN}"
    try:
        data = _get(
            "https://api.github.com/search/repositories",
            headers=headers,
            params={"q": query, "sort": "stars", "per_page": limit},
        )
        out: List[Dict[str, Any]] = []
        for repo in data.get("items") or []:
            url = repo.get("html_url")
            if not url:
                continue
            out.append(
                _card(
                    repo.get("full_name") or "GitHub repo",
                    url,
                    provider="github",
                    kind="проект",
                    description=(repo.get("description") or "Репозиторий для практики.")[:200],
                )
            )
        return out
    except Exception as e:
        _log.debug("github search failed: %s", e)
        return []


def codewars_kata(language: str, limit: int = 2) -> List[Dict[str, Any]]:
    lang = (language or "python").strip().lower()
    try:
        data = _get(
            f"https://www.codewars.com/api/v1/code-challenges/{lang}/train/all",
            params={"page": 0},
        )
        out: List[Dict[str, Any]] = []
        for ch in (data.get("data") or [])[:limit]:
            slug = ch.get("slug")
            name = ch.get("name") or slug
            if not slug:
                continue
            out.append(
                _card(
                    f"Codewars: {name}",
                    f"https://www.codewars.com/kata/{slug}",
                    provider="codewars",
                    kind="практика",
                    description=f"Ранг: {ch.get('rank', {}).get('name', '—')}",
                )
            )
        return out
    except Exception as e:
        _log.debug("codewars failed: %s", e)
        return []


def esco_skill_hints(query: str, limit: int = 3) -> List[Dict[str, Any]]:
    if not ESCO_API_ENABLED:
        return []
    try:
        data = _get(
            "https://ec.europa.eu/esco/api/resource/skill",
            params={
                "language": "ru",
                "text": query,
                "offset": 0,
                "limit": limit,
                "full": "true",
            },
            headers={"Accept": "application/json"},
        )
        out: List[Dict[str, Any]] = []
        for emb in (data.get("_embedded") or {}).get("skills") or []:
            title = (emb.get("title") or {}).get("ru") or (emb.get("title") or {}).get("en")
            uri = emb.get("uri")
            if not title:
                continue
            out.append(
                _card(
                    f"ESCO: {title}",
                    uri or "https://esco.ec.europa.eu/",
                    provider="esco",
                    kind="навык",
                    description="Навык из европейской классификации ESCO.",
                )
            )
        return out
    except Exception as e:
        _log.debug("esco failed: %s", e)
        return []


def onet_occupation_hints(keyword: str, limit: int = 3) -> List[Dict[str, Any]]:
    if not ONET_USERNAME or not ONET_PASSWORD:
        return []
    try:
        r = requests.get(
            "https://services.onetcenter.org/ws/mnm/search",
            params={"keyword": keyword, "start": 1, "end": limit},
            auth=(ONET_USERNAME, ONET_PASSWORD),
            timeout=_TIMEOUT,
            headers={"Accept": "application/json"},
        )
        r.raise_for_status()
        data = r.json()
        out: List[Dict[str, Any]] = []
        for row in data.get("occupation") or data.get("result") or []:
            if isinstance(row, dict):
                title = row.get("title") or row.get("name")
                link = row.get("link") or row.get("href") or "https://www.onetonline.org/"
            else:
                title = str(row)
                link = "https://www.onetonline.org/"
            if title:
                out.append(
                    _card(
                        f"O*NET: {title}",
                        link,
                        provider="onet",
                        kind="профессия",
                        description="Профессия из базы O*NET (США).",
                    )
                )
        return out[:limit]
    except Exception as e:
        _log.debug("onet failed: %s", e)
        return []


def run_dynamic_adapter(spec: Dict[str, Any]) -> List[Dict[str, Any]]:
    adapter = str(spec.get("adapter") or "").strip().lower()
    if adapter in ("video", "video_ru", "vk", "vk_video"):
        from wibe_work.services.learning.vk_video import video_search_for_learning

        return video_search_for_learning(
            str(spec.get("query") or ""),
            limit=int(spec.get("limit") or 3),
            track=spec.get("track"),
            sphere=spec.get("sphere"),
            plan_direction=str(spec.get("plan_direction") or ""),
            step_title=str(spec.get("step_title") or ""),
        )
    if adapter == "exercism":
        return exercism_track_exercises(str(spec.get("track") or "python"))
    if adapter == "github":
        return github_search_repos(str(spec.get("query") or "starter"))
    if adapter == "codewars":
        return codewars_kata(str(spec.get("language") or "python"))
    if adapter == "esco":
        return esco_skill_hints(str(spec.get("query") or "skills"))
    if adapter == "onet":
        return onet_occupation_hints(str(spec.get("query") or "developer"))
    return []


def integration_status() -> Dict[str, Any]:
    from wibe_work.config import VK_ACCESS_TOKEN, VK_VIDEO_OWNER_IDS

    return {
        "vk_video": {
            "configured": bool(VK_ACCESS_TOKEN),
            "needs": "VK_ACCESS_TOKEN (сервисный ключ приложения VK)",
            "owner_ids": bool(VK_VIDEO_OWNER_IDS),
            "docs": "https://dev.vk.com/ru/method/video.search",
        },
        "github": {"configured": bool(GITHUB_TOKEN), "needs": "GITHUB_TOKEN (optional, выше лимит)"},
        "exercism": {"configured": True, "needs": None},
        "codewars": {"configured": True, "needs": None},
        "esco": {"configured": ESCO_API_ENABLED, "needs": None if ESCO_API_ENABLED else "ESCO_API_ENABLED=1"},
        "onet": {
            "configured": bool(ONET_USERNAME and ONET_PASSWORD),
            "needs": "ONET_USERNAME + ONET_PASSWORD (onetcenter.org)",
        },
        "curated_catalog": True,
        "roadmap_sh": "curated links",
        "microsoft_learn": "curated links",
        "linkedin_learning": "curated links only",
        "udemy": "curated links only",
        "mdn_devdocs": "curated links",
        "kaggle_hf_google_dl": "curated links",
        "figma_hubspot_atlassian": "curated links",
        "leetcode": "curated links only",
    }
