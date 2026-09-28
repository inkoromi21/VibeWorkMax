"""Релевантность учебных материалов: эвристики + LLM-фильтр."""

from __future__ import annotations

import json
import logging
import re
from typing import Any, Dict, List, Optional, Set

from wibe_work.services.learning.assessment_signals import infer_track_from_plan_name
from wibe_work.services.llm_client import fetch_llm_completion, llm_configured

logger = logging.getLogger(__name__)

# Развлечения / спорт / оффтоп — не учебные материалы
_ENTERTAINMENT_MARKERS = (
    "футбол",
    "футболист",
    "хоккей",
    "матч",
    "гол ",
    "лига чемпион",
    "чемпионат",
    "nba",
    "ufc",
    "бокс",
    "сериал",
    "фильм",
    "трейлер",
    "стрим",
    "летсплей",
    "minecraft",
    "fortnite",
    "музык",
    "клип",
    "песня",
    "концерт",
    "обзор игры",
    "прохождение игры",
    "рецепт",
    "готовим",
    "кулинар",
    "макияж",
    "похуден",
    "гороскоп",
    "новости дня",
    "ток-шоу",
    "интервью со",
    "развод",
    "отношения",
    "психолог",
    "медитация для сна",
    "животные",
    "котики",
    "путешеств",
    "влог",
    "обзор смартфон",
    "распаковка",
)

# Поиск видео по треку (если запрос из JSON слишком общий)
TRACK_SEARCH_QUERIES: Dict[str, str] = {
    "backend": "python backend разработка курс урок",
    "frontend": "javascript frontend веб разработка курс",
    "devops": "devops docker kubernetes курс",
    "data": "sql python аналитика данных курс",
    "qa": "тестирование qa автоматизация курс",
    "design": "figma ux ui дизайн курс",
    "marketing": "маркетинг smm digital курс",
    "sales": "продажи b2b курс",
    "pm": "product manager agile курс",
}

_VAGUE_QUERY_MARKERS = (
    "карьера",
    "обучение",
    "basics",
    "основы",
    "computer science",
    "профессия",
    "самопознание",
    "рынок",
)

# Слова, повышающие шанс что это урок/курс (не «разбор матча»)
_EDUCATION_MARKERS = (
    "курс",
    "урок",
    "лекц",
    "обучен",
    "туториал",
    "плейлист",
    "с нуля",
    "для начинающ",
    "программир",
    "разработ",
)

# Трек → ожидаемые слова в заголовке/описании
_TRACK_POSITIVE: Dict[str, tuple[str, ...]] = {
    "backend": (
        "python",
        "бэкенд",
        "backend",
        "api",
        "fastapi",
        "django",
        "сервер",
        "sql",
        "баз данных",
        "программир",
    ),
    "frontend": (
        "frontend",
        "фронт",
        "javascript",
        "react",
        "html",
        "css",
        "вёрст",
        "верст",
    ),
    "devops": ("devops", "docker", "kubernetes", "ci/cd", "инфраструкт"),
    "data": ("аналит", "sql", "данн", "pandas", "excel", "bi ", "метрик"),
    "qa": ("тест", "qa", "автотест", "quality"),
    "design": ("дизайн", "ux", "ui", "figma", "макет", "прототип"),
    "marketing": ("маркет", "smm", "реклам", "таргет", "контент"),
    "pm": ("продукт", "product", "agile", "scrum", "менедж"),
}

# Чужой трек: если материал явно про другое направление
_TRACK_NEGATIVE: Dict[str, tuple[str, ...]] = {
    "backend": ("figma", "ux", "ui/ux", "дизайн", "photoshop", "иллюстра", "макет в figma"),
    "frontend": ("дизайн-систем", "брендинг", "иллюстра"),
    "data": ("figma", "дизайн", "иллюстра", "вёрст", "react"),
    "devops": ("figma", "дизайн", "иллюстра"),
    "qa": ("figma", "дизайн", "иллюстра"),
    "design": ("fastapi", "django", "бэкенд", "backend", "devops", "kubernetes"),
    "marketing": ("fastapi", "django", "kubernetes", "sql academy"),
}


def _blob(card: Dict[str, Any]) -> str:
    return " ".join(
        str(card.get(k) or "")
        for k in ("title", "description", "kind", "provider", "step_title")
    ).lower()


def is_entertainment_or_sport(card: Dict[str, Any]) -> bool:
    b = _blob(card)
    return any(m in b for m in _ENTERTAINMENT_MARKERS)


def build_learning_search_query(
    query: str,
    *,
    track: Optional[str] = None,
    sphere: str = "",
    step_title: str = "",
) -> str:
    """Собирает поисковый запрос: общие фразы заменяются на трек-специфичные."""
    q = (query or "").strip()
    tr = (track or "").strip().lower()
    step = (step_title or "").strip().lower()

    if tr and tr in TRACK_SEARCH_QUERIES:
        base = TRACK_SEARCH_QUERIES[tr]
        q_low = q.lower()
        vague = not q or any(v in q_low for v in _VAGUE_QUERY_MARKERS) or len(q) < 12
        if vague:
            if step and len(step) > 4:
                return f"{base} {step[:40]}"
            return base

    if q:
        if tr and tr in TRACK_SEARCH_QUERIES:
            track_tokens = [w for w in TRACK_SEARCH_QUERIES[tr].split() if len(w) > 3][:3]
            if not any(t in q.lower() for t in track_tokens):
                return f"{q} {track_tokens[0]} курс"
        return q

    if tr and tr in TRACK_SEARCH_QUERIES:
        return TRACK_SEARCH_QUERIES[tr]
    if sphere == "it_dev":
        return "программирование курс для начинающих"
    return "профессиональное обучение курс"


def heuristic_material_score(
    card: Dict[str, Any],
    *,
    track: Optional[str],
    sphere: str = "",
    plan_direction: str = "",
) -> int:
    """0 = отбросить; чем выше — тем релевантнее."""
    if is_entertainment_or_sport(card):
        return 0

    b = _blob(card)
    tr = (track or "").strip().lower()
    if not tr and plan_direction:
        tr = (infer_track_from_plan_name(plan_direction) or "").strip().lower()

    if tr:
        for neg in _TRACK_NEGATIVE.get(tr, ()):
            if neg in b:
                return 0
        hits = sum(1 for kw in _TRACK_POSITIVE.get(tr, ()) if kw in b)
        if hits >= 2:
            return 14 + hits
        if hits == 1:
            return 8

    edu = sum(1 for m in _EDUCATION_MARKERS if m in b)
    if edu >= 2:
        return 6 + edu
    if sphere == "it_dev" and tr in ("backend", "frontend", "devops", "data", "qa"):
        return 0
    return 4 if edu else 2


def filter_materials_heuristic(
    materials: List[Dict[str, Any]],
    *,
    track: Optional[str],
    sphere: str = "",
    plan_direction: str = "",
    min_score: int = 6,
) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for m in materials:
        sc = heuristic_material_score(
            m, track=track, sphere=sphere, plan_direction=plan_direction
        )
        if sc >= min_score:
            out.append(m)
    return out


_MATERIAL_LLM_SYSTEM = """Ты фильтруешь учебные материалы для VibeWork.

Ответ — ТОЛЬКО JSON: {"keep": [1, 2]} — номера 1-based из списка.

Отклоняй ВСЁ, что не про указанный трек/план:
- спорт, матчи, голы, сериалы, музыка, игры, влоги, рецепты, новости, ток-шоу;
- дизайн/figma/ux для backend/frontend-dev; python/backend для дизайнера;
- «обучение»/«курс» в заголовке без связи с треком (например кулинария при треке backend).

Оставляй только уроки, курсы, плейлисты, практику по треку из запроса.
Сомневаешься — не включай. Пустой список: {"keep": []}.
Без пояснений, только JSON."""


def llm_filter_materials(
    materials: List[Dict[str, Any]],
    *,
    track: Optional[str],
    plan_direction: str = "",
    max_items: int = 12,
) -> List[Dict[str, Any]]:
    """LLM-фильтр (если настроен LLM). При сбое — эвристика."""
    items = materials[:max_items]
    if len(items) <= 1:
        return items
    if not llm_configured():
        return items

    lines = []
    for i, m in enumerate(items, 1):
        lines.append(
            f"{i}. [{m.get('kind')}] {m.get('title')} — {m.get('url')} "
            f"({m.get('provider')})"
        )
    user = (
        f"Направление (трек): {track or '—'}\n"
        f"План: {plan_direction or '—'}\n\n"
        f"Материалы:\n" + "\n".join(lines)
    )
    raw, _ = fetch_llm_completion(
        user,
        max_tokens=120,
        temperature=0.0,
        system_prompt=_MATERIAL_LLM_SYSTEM,
    )
    if not raw:
        return filter_materials_heuristic(
            items, track=track, plan_direction=plan_direction, min_score=8
        )
    text = raw.strip()
    m = re.search(r"\{[\s\S]*\}", text)
    if not m:
        return filter_materials_heuristic(
            items, track=track, plan_direction=plan_direction, min_score=8
        )
    try:
        data = json.loads(m.group(0))
        keep = data.get("keep") if isinstance(data, dict) else None
        if not isinstance(keep, list):
            return filter_materials_heuristic(
                items, track=track, plan_direction=plan_direction, min_score=8
            )
        idx_set: Set[int] = set()
        for x in keep:
            try:
                idx_set.add(int(x))
            except (TypeError, ValueError):
                continue
        out = [items[i - 1] for i in sorted(idx_set) if 1 <= i <= len(items)]
        return out
    except json.JSONDecodeError:
        logger.debug("material LLM filter: bad JSON %s", text[:200])
        return filter_materials_heuristic(
            items, track=track, plan_direction=plan_direction, min_score=8
        )


def filter_materials_for_context(
    materials: List[Dict[str, Any]],
    *,
    track: Optional[str],
    sphere: str = "",
    plan_direction: str = "",
    use_llm: bool = True,
) -> List[Dict[str, Any]]:
    """Эвристика → LLM → уникальные URL."""
    if not materials:
        return []
    step1 = filter_materials_heuristic(
        materials,
        track=track,
        sphere=sphere,
        plan_direction=plan_direction,
        min_score=6,
    )
    pool = step1 or []
    if use_llm and len(pool) >= 2:
        pool = llm_filter_materials(
            pool, track=track, plan_direction=plan_direction
        )
    seen: Set[str] = set()
    out: List[Dict[str, Any]] = []
    for c in pool:
        url = (c.get("url") or "").strip()
        if url and url != "#" and url not in seen:
            seen.add(url)
            out.append(c)
    return out
