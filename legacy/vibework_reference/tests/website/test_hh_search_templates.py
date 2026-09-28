"""Шаблоны поиска hh.ru по сферам анкеты."""

from __future__ import annotations

import sys
from pathlib import Path

_WEBSITE = Path(__file__).resolve().parents[2] / "website"
sys.path.insert(0, str(_WEBSITE))

from app.hh_search_templates import search_text_for_match  # noqa: E402


def test_marketing_sphere_id() -> None:
    t = search_text_for_match(profession="marketing", interest="маркетинг")
    assert "маркетолог" in t.lower()


def test_it_dev_sphere() -> None:
    t = search_text_for_match(profession="it_dev", interest="IT")
    assert "разработчик" in t.lower() or "программист" in t.lower()


def test_interest_only_marketing() -> None:
    t = search_text_for_match(interest="маркетинг")
    assert "маркетолог" in t.lower()


def test_track_hint_used_when_no_sphere() -> None:
    t = search_text_for_match(track_hint="План A: Junior маркетолог performance")
    assert "маркетолог" in t.lower()
