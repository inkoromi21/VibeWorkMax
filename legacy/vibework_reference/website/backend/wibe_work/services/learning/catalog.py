"""Загрузка каталога ресурсов и путей обучения."""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any, Dict, List, Optional

from wibe_work.paths import data_file

_CATALOG_PATH = data_file("learning_catalog.json")
_PATHS_PATH = data_file("learning_paths.json")


@lru_cache(maxsize=1)
def load_catalog() -> Dict[str, Any]:
    if not _CATALOG_PATH.is_file():
        return {"resources": []}
    with _CATALOG_PATH.open(encoding="utf-8") as f:
        return json.load(f)


@lru_cache(maxsize=1)
def load_paths() -> Dict[str, Any]:
    if not _PATHS_PATH.is_file():
        return {"paths": []}
    with _PATHS_PATH.open(encoding="utf-8") as f:
        return json.load(f)


def resources_by_id() -> Dict[str, Dict[str, Any]]:
    out: Dict[str, Dict[str, Any]] = {}
    for r in load_catalog().get("resources") or []:
        rid = str(r.get("id") or "")
        if rid:
            out[rid] = r
    return out


def get_resource(resource_id: str) -> Optional[Dict[str, Any]]:
    return resources_by_id().get(resource_id)


_CATALOG_BLURBS: Dict[str, str] = {
    "roadmap_backend": "Карта тем для backend: что учить по шагам, чтобы дойти до junior без хаоса.",
    "roadmap_frontend": "Дорожная карта frontend: HTML, CSS, JS и экосистема в логичном порядке.",
    "roadmap_devops": "Обзор DevOps: инфраструктура, CI/CD, облака — куда смотреть в начале пути.",
    "roadmap_data_analyst": "Карта для аналитика данных: SQL, Python, визуализация и soft skills.",
    "odin_fullstack": "Бесплатный путь full stack: проекты в браузере, много практики, английский интерфейс.",
    "fcc_responsive": "Интерактивный курс вёрстки: адаптивные страницы с проверкой заданий.",
    "fcc_python": "Python с нуля на freeCodeCamp: основы и небольшие проекты в браузере.",
    "cs50_intro": "Классический вводный курс Harvard: логика, алгоритмы и программирование с нуля.",
    "ms_learn_python": "Короткие модули Microsoft: синтаксис Python и первые скрипты.",
    "ms_learn_azure_fund": "База облака Azure — полезно, если целитесь в DevOps или backend в облаке.",
    "mdn_html": "Официальный учебник MDN по HTML: разметка страниц с примерами.",
    "mdn_js": "Справочник и гайд по JavaScript — основа для frontend и простого backend.",
    "mdn_http": "Как работают HTTP-запросы и API — must-have перед backend-проектами.",
    "devdocs_python": "Быстрый справочник по Python — удобно держать открытым при задачах.",
    "stepik_python": "Курс на русском: Python от переменных до функций, с тестами после уроков.",
    "git_branching": "Интерактивный тренажёр Git: ветки, merge и rebase визуально.",
    "github_skills": "Пошаговые задания на GitHub: репозиторий, issues, pull request.",
    "kaggle_learn": "Микрокурсы по данным: Python, pandas, визуализация, ввод в ML.",
    "sql_academy": "Тренажёр SQL на русском: SELECT, JOIN, агрегаты с автопроверкой.",
    "hf_learn": "Введение в NLP и трансформеры — для тех, кто идёт в data/ML.",
    "google_ml_crash": "Короткое введение в ML от Google: термины, модели, этика.",
    "deeplearning_ai_short": "Небольшие курсы по нейросетям и LLM — можно брать выборочно.",
    "figma_learn": "Официальные уроки Figma: макеты, компоненты, прототипы.",
    "google_design": "Материалы Google про UX: принципы, кейсы, насмотренность.",
    "hubspot_academy": "Бесплатные курсы по маркетингу и CRM — воронка, контент, метрики.",
    "atlassian_agile": "Простое объяснение Agile и Scrum для менеджмента и команд.",
    "exercism_python": "Задачи по Python с наставником: код проверяют, дают фидбек.",
    "exercism_javascript": "Практика JavaScript малыми шагами — удобно после основ MDN.",
    "codewars_python": "Ката-задачи по Python разной сложности — разминка перед собесами.",
    "leetcode_explore": "Тематические наборы задач: структуры данных и алгоритмы.",
    "linkedin_learning_note": "Платформа курсов (часто по подписке) — если есть доступ через вуз или работу.",
    "udemy_note": "Каталог платных курсов — сравнивайте отзывы, есть частые скидки.",
}


def _generic_resource_blurb(r: Dict[str, Any]) -> str:
    kind = str(r.get("kind") or r.get("format") or "ресурс").lower()
    title = str(r.get("title") or "материал")[:80]
    if kind == "roadmap":
        return "Дорожная карта: порядок тем и навыков по направлению."
    if kind in ("курс", "course"):
        return f"Бесплатный пошаговый курс — разберите основы по «{title}»."
    if kind in ("документация", "docs", "справочник"):
        return f"Справочник и примеры — держите под рукой при выполнении шага."
    if kind in ("практика", "practice", "симулятор"):
        return "Практика с заданиями: закрепите тему шага на конкретных упражнениях."
    if kind in ("видео", "video"):
        return "Видеоурок — посмотрите вводную часть и решите, подходит ли темп."
    if kind in ("гайд", "article"):
        return "Короткий обзор темы — прочитайте и выпишите 3 идеи для себя."
    return "Материал по теме шага — откройте и отметьте, что примените на практике."


def resource_description(r: Dict[str, Any]) -> str:
    raw = str(r.get("description") or "").strip()
    if raw:
        return raw[:400]
    rid = str(r.get("id") or "")
    if rid in _CATALOG_BLURBS:
        return _CATALOG_BLURBS[rid]
    return _generic_resource_blurb(r)


def resource_to_card(r: Dict[str, Any], *, source_type: str = "curated") -> Dict[str, Any]:
    return {
        "id": r.get("id"),
        "title": r.get("title") or "Материал",
        "url": r.get("url") or "#",
        "kind": r.get("kind") or r.get("format") or "ресурс",
        "description": resource_description(r),
        "provider": r.get("provider") or "curated",
        "source_type": source_type,
        "is_free": bool(r.get("is_free", True)),
        "language": r.get("language") or "ru",
    }


def pick_path(
    sphere: str,
    track: Optional[str],
    preparation: str,
    *,
    signals: Optional[Dict[str, Any]] = None,
) -> Optional[Dict[str, Any]]:
    paths = load_paths().get("paths") or []
    sphere = (sphere or "other").strip()
    track = (track or "").strip().lower()
    if signals:
        sphere = str(signals.get("sphere") or sphere)
        track = str(signals.get("track") or track or "").strip().lower()
        preparation = str(signals.get("preparation_level") or preparation)
    prep = preparation if preparation in ("weak", "medium", "strong") else "medium"

    scored: List[tuple[int, Dict[str, Any]]] = []
    for p in paths:
        spheres = p.get("spheres") or []
        tracks = [str(t).lower() for t in (p.get("tracks") or [])]
        levels = p.get("levels") or ["weak", "medium", "strong"]
        if sphere not in spheres and "other" not in spheres:
            continue
        if prep not in levels:
            continue
        if track and tracks and track not in tracks:
            continue
        score = 0
        if sphere in spheres:
            score += 10
        if track and track in tracks:
            score += 25
        if not tracks and p.get("id") == "general_career":
            score += 1
        if p.get("id", "").startswith("it_dev") and sphere == "it_dev":
            score += 5
        scored.append((score, p))

    if not scored:
        return None
    scored.sort(key=lambda x: -x[0])
    best_score, best = scored[0]
    if track and best_score < 25:
        for score, p in scored:
            if track in [str(t).lower() for t in (p.get("tracks") or [])]:
                return p
    return best


def pick_catalog_resources_for_signals(
    signals: Dict[str, Any],
    *,
    limit: int = 8,
) -> List[Dict[str, Any]]:
    """Каталог, отфильтрованный по сфере/треку/разрыву из разбора."""
    from wibe_work.services.learning.assessment_signals import resource_allowed, resource_match_score

    scored: List[tuple[int, Dict[str, Any]]] = []
    for r in resources_by_id().values():
        sc = resource_match_score(r, signals)
        if resource_allowed(r, signals):
            scored.append((sc, resource_to_card(r)))
    scored.sort(key=lambda x: -x[0])
    return [c for _, c in scored[:limit]]
