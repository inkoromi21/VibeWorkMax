import json
import re
from pathlib import Path
from typing import Any, Dict, List, Set, Tuple

from wibe_work.paths import data_file
from wibe_work.services.user_context import merge_skills_from_profile

_DATA_PATH = data_file("mts_role_matrix.json")


def _load_matrix() -> Dict[str, Any]:
    path = Path(_DATA_PATH)
    if not path.is_file():
        return {"roles": []}
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def _tokens(text: str) -> Set[str]:
    return {
        t
        for t in re.split(r"[^\wёЁа-яА-Яa-zA-Z]+", text.lower())
        if len(t) > 2
    }


def _score_role(
    role: Dict[str, Any], user_blob: str, user_tokens: Set[str]
) -> Tuple[float, List[str], List[str]]:
    req_text = " ".join(role.get("requirements") or [])
    duty_text = " ".join(role.get("duties") or [])
    combined = f"{req_text} {duty_text}".lower()
    rt = _tokens(combined)
    overlap = len(user_tokens & rt)
    # частичные совпадения длинных фраз
    extra = 0
    matched_phrases: List[str] = []
    for chunk in re.split(r"[;.]\s*", req_text.lower()):
        chunk = chunk.strip()
        if len(chunk) < 12:
            continue
        if chunk in user_blob or any(
            w in user_blob for w in chunk.split() if len(w) > 5
        ):
            extra += 0.15
            matched_phrases.append(chunk[:80])
    score = min(1.0, 0.05 * overlap + extra)
    missing_hints: List[str] = []
    if score < 0.35:
        for line in role.get("requirements") or []:
            if len(line) > 20:
                missing_hints.append(line.strip()[:120])
                if len(missing_hints) >= 3:
                    break
    return round(score, 3), matched_phrases[:3], missing_hints


def match_mts_roles(
    profile: Dict[str, Any], competencies: List[Dict[str, Any]], top_n: int = 5
) -> Dict[str, Any]:
    matrix = _load_matrix()
    roles: List[Dict[str, Any]] = matrix.get("roles") or []

    names, _ = merge_skills_from_profile(competencies, profile)
    blob_parts = [
        " ".join(names),
        str(profile.get("interests") or ""),
        str(profile.get("like_to_do") or ""),
        str(profile.get("programming_skills") or ""),
        str(profile.get("software_skills") or ""),
        str(profile.get("social_media_skills") or ""),
        str(profile.get("achievements") or ""),
    ]
    user_blob = " ".join(blob_parts).lower()
    user_tokens = _tokens(user_blob)

    scored: List[Dict[str, Any]] = []
    for role in roles:
        sc, matched, gaps = _score_role(role, user_blob, user_tokens)
        scored.append(
            {
                "title": role["title"],
                "fit_score": sc,
                "matched_signals": matched,
                "requirements_to_close": gaps,
                "requirements_count": len(role.get("requirements") or []),
                "duties_count": len(role.get("duties") or []),
            }
        )
    scored.sort(key=lambda x: (-x["fit_score"], x["title"]))
    return {
        "source": matrix.get("source"),
        "reference": "Матрица компетенций (роли, требования и обязанности)",
        "top_roles": scored[:top_n],
        "all_roles_scored": len(scored),
    }
