"""Лимит входа, защита LLM-эндпоинтов, prod JWT."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parents[2]
_WEBSITE = _REPO / "website"
_BACKEND = _WEBSITE / "backend"
for p in (str(_WEBSITE), str(_BACKEND)):
    if p not in sys.path:
        sys.path.insert(0, p)


def test_chat_requires_login():
    from fastapi.testclient import TestClient

    from app.main import app
    from app.website_session import require_website_session

    app.dependency_overrides.pop(require_website_session, None)
    client = TestClient(app)
    r = client.post(
        "/api/chat",
        json={"messages": [{"role": "user", "content": "привет"}]},
    )
    assert r.status_code == 401


def test_login_throttles_after_failures():
    from fastapi.testclient import TestClient

    from app.main import app
    from wibe_work.login_rate_limit import LOGIN_MAX_PER_IDENTITY, reset_for_tests

    reset_for_tests()
    client = TestClient(app)
    body = {"email": "throttle-test@example.com", "password": "definitely-wrong-xx"}
    last = None
    for _ in range(LOGIN_MAX_PER_IDENTITY):
        last = client.post("/auth/email/login", json=body)
        assert last.status_code == 401, last.text
    blocked = client.post("/auth/email/login", json=body)
    assert blocked.status_code == 429
    reset_for_tests()


def test_prod_rejects_default_jwt(monkeypatch):
    import wibe_work.config as cfg

    monkeypatch.setattr(cfg, "VIBEWORK_ENV", "prod")
    monkeypatch.setattr(cfg, "_DEFAULT_JWT_SECRET", "dev-change-me-in-production-vibework")
    monkeypatch.setattr(cfg, "JWT_SECRET", "dev-change-me-in-production-vibework")
    with pytest.raises(RuntimeError, match="JWT_SECRET"):
        cfg.assert_prod_security()


def test_security_headers_on_health():
    from fastapi.testclient import TestClient

    from app.main import app

    client = TestClient(app)
    r = client.get("/api/health")
    assert r.status_code == 200
    assert r.headers.get("x-content-type-options") == "nosniff"
    assert r.headers.get("x-frame-options") == "DENY"
