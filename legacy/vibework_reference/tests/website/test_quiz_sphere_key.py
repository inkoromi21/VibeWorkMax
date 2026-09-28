"""Квиз веб-сайта принимает id сферы из анкеты v2."""

from __future__ import annotations

import sys
from pathlib import Path

_REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(_REPO / "website"))
sys.path.insert(0, str(_REPO / "website" / "backend"))

from app.aptitude_quiz_content import resolve_quiz_key  # noqa: E402


def test_resolve_quiz_key_from_sphere_id() -> None:
    assert resolve_quiz_key("it_dev", None) == "IT"
    assert resolve_quiz_key("design", None) == "дизайн"
    assert resolve_quiz_key("marketing", None) == "маркетинг"
