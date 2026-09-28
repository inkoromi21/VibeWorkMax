"""Regression and security coverage for private profile documents."""

from __future__ import annotations

import io
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
WEBSITE_ROOT = REPO_ROOT / "website"
BACKEND_ROOT = WEBSITE_ROOT / "backend"
for path in (str(WEBSITE_ROOT), str(BACKEND_ROOT)):
    if path not in sys.path:
        sys.path.insert(0, path)


@pytest.fixture
def documents_client(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    from fastapi.testclient import TestClient
    from app.main import app
    from wibe_work import config as cfg
    from wibe_work import sqlite_db
    from wibe_work.routers.website_auth_compat_routes import require_user_id

    monkeypatch.setenv("DATABASE_PATH", str(tmp_path / "profile-files.sqlite3"))
    monkeypatch.setattr(sqlite_db, "_db_path_memo", None)
    monkeypatch.setattr(sqlite_db, "_legacy_done", True)
    monkeypatch.setattr(cfg, "PROFILE_FILES_DIR", tmp_path / "private-files")
    monkeypatch.setattr(cfg, "PROFILE_FILE_MAX_SIZE", 10 * 1024 * 1024)
    monkeypatch.setattr(cfg, "PROFILE_FILES_MAX_COUNT", 20)
    monkeypatch.setattr(cfg, "PROFILE_FILES_MAX_TOTAL_SIZE", 100 * 1024 * 1024)
    monkeypatch.setattr(cfg, "VIBEWORK_ENV", "dev")
    sqlite_db.init_db()
    current_user = {"id": "owner"}
    app.dependency_overrides[require_user_id] = lambda: current_user["id"]
    with TestClient(app) as client:
        yield client, current_user, cfg, sqlite_db
    app.dependency_overrides.pop(require_user_id, None)


def _pdf(label: bytes = b"test") -> bytes:
    return b"%PDF-1.4\n" + label + b"\n%%EOF"


def _image_bytes(fmt: str) -> bytes:
    from PIL import Image

    out = io.BytesIO()
    Image.new("RGB", (2, 2), color="white").save(out, format=fmt)
    return out.getvalue()


def _upload(client, *, filename="resume.pdf", content=None, mime="application/pdf", category="resume", **data):
    return client.post(
        "/api/profile/files",
        data={"category": category, **data},
        files={"file": (filename, _pdf() if content is None else content, mime)},
    )


def test_uploads_pdf_png_and_jpeg_with_safe_metadata(documents_client):
    client, _, _, _ = documents_client
    pdf = _upload(client, filename="Резюме.pdf", title="Моё резюме")
    png = _upload(client, filename="certificate.png", content=_image_bytes("PNG"), mime="image/png", category="certificate")
    jpeg = _upload(client, filename="award.jpg", content=_image_bytes("JPEG"), mime="image/jpeg", category="award")

    assert [response.status_code for response in (pdf, png, jpeg)] == [200, 200, 200]
    metadata = pdf.json()
    assert metadata["original_filename"] == "Резюме.pdf"
    assert "storage_key" not in metadata
    assert "profile-files" not in str(metadata)
    listed = client.get("/api/profile/files")
    assert listed.status_code == 200
    assert len(listed.json()["files"]) == 3


@pytest.mark.parametrize(
    ("filename", "content", "mime"),
    [
        ("malware.exe", _pdf(), "application/pdf"),
        ("fake.pdf", b"not a pdf", "application/pdf"),
        ("fake.jpg", b"not an image", "image/jpeg"),
        ("resume.exe.pdf", _pdf(), "application/pdf"),
        ("../resume.pdf", _pdf(), "application/pdf"),
    ],
)
def test_rejects_unsafe_or_fake_files(documents_client, filename, content, mime):
    client, _, _, _ = documents_client
    response = _upload(client, filename=filename, content=content, mime=mime)
    assert response.status_code == 400
    assert client.get("/api/profile/files").json()["files"] == []


def test_rejects_mime_extension_mismatch_and_oversized_file(documents_client):
    client, _, _, _ = documents_client
    mismatch = _upload(client, filename="resume.pdf", mime="image/png")
    oversized = _upload(client, filename="large.pdf", content=b"%PDF-" + b"x" * (10 * 1024 * 1024), category="other")
    assert mismatch.status_code == 400
    assert oversized.status_code == 413


def test_category_and_total_limits_are_enforced(documents_client):
    client, _, cfg, _ = documents_client
    assert _upload(client).status_code == 200
    assert _upload(client, filename="new-resume.pdf").status_code == 409

    cfg.PROFILE_FILES_MAX_TOTAL_SIZE = len(_pdf()) + 1
    assert _upload(client, filename="certificate.pdf", category="certificate").status_code == 413


def test_twenty_first_file_is_rejected(documents_client):
    client, _, _, _ = documents_client
    categories = (
        ["resume"]
        + ["certificate"] * 8
        + ["diploma"] * 3
        + ["award"] * 6
        + ["project"] * 2
    )
    assert len(categories) == 20
    for index, category in enumerate(categories):
        response = _upload(client, filename=f"document-{index}.pdf", category=category)
        assert response.status_code == 200, response.text
    assert _upload(client, filename="twenty-first.pdf", category="other").status_code == 409


def test_download_and_delete_require_the_owner_and_remove_physical_file(documents_client):
    client, current_user, cfg, sqlite_db = documents_client
    created = _upload(client, filename="portfolio.pdf", category="project").json()
    with sqlite_db.get_db() as conn:
        row = conn.execute("SELECT storage_key FROM profile_files WHERE id = ?", (created["id"],)).fetchone()
    physical_path = cfg.PROFILE_FILES_DIR / row["storage_key"]
    assert physical_path.is_file()

    current_user["id"] = "other-user"
    assert client.get(created["download_url"]).status_code == 404
    assert client.delete(f"/api/profile/files/{created['id']}").status_code == 404

    current_user["id"] = "owner"
    downloaded = client.get(created["download_url"])
    assert downloaded.status_code == 200
    assert downloaded.headers["content-disposition"].startswith("attachment")
    assert downloaded.headers["x-content-type-options"] == "nosniff"
    assert client.delete(f"/api/profile/files/{created['id']}").status_code == 200
    assert not physical_path.exists()
    assert client.get(created["download_url"]).status_code == 404


def test_missing_physical_file_is_not_disclosed_and_delete_still_succeeds(documents_client):
    client, _, cfg, sqlite_db = documents_client
    created = _upload(client, filename="missing.pdf", category="other").json()
    with sqlite_db.get_db() as conn:
        row = conn.execute("SELECT storage_key FROM profile_files WHERE id = ?", (created["id"],)).fetchone()
    (cfg.PROFILE_FILES_DIR / row["storage_key"]).unlink()
    assert client.get(created["download_url"]).status_code == 404
    assert client.delete(f"/api/profile/files/{created['id']}").status_code == 200


def test_unauthenticated_calls_are_rejected(documents_client):
    client, _, _, _ = documents_client
    from app.main import app
    from wibe_work.routers.website_auth_compat_routes import require_user_id

    app.dependency_overrides.pop(require_user_id, None)
    try:
        assert _upload(client).status_code == 401
        assert client.get("/api/profile/files").status_code == 401
        assert client.get("/api/profile/files/unknown/download").status_code == 401
    finally:
        app.dependency_overrides[require_user_id] = lambda: "owner"


def test_upload_rejects_cross_site_origin(documents_client):
    client, _, _, _ = documents_client
    response = client.post(
        "/api/profile/files",
        headers={"Origin": "https://attacker.example"},
        data={"category": "resume"},
        files={"file": ("resume.pdf", _pdf(), "application/pdf")},
    )
    assert response.status_code == 403


def test_account_deletion_removes_document_metadata_and_bytes(documents_client):
    client, _, cfg, sqlite_db = documents_client
    from wibe_work.services.user_accounts import delete_user_account

    created = _upload(client, filename="resume.pdf").json()
    with sqlite_db.get_db() as conn:
        conn.execute(
            "INSERT INTO email_users (user_id, email, password_hash, created_at) VALUES (?, ?, ?, ?)",
            ("owner", "owner@example.test", "hash", "now"),
        )
        storage_key = conn.execute("SELECT storage_key FROM profile_files WHERE id = ?", (created["id"],)).fetchone()["storage_key"]
        conn.commit()
    assert delete_user_account("owner")
    assert not (cfg.PROFILE_FILES_DIR / storage_key).exists()
    with sqlite_db.get_db() as conn:
        assert conn.execute("SELECT COUNT(*) FROM profile_files WHERE owner_user_id = ?", ("owner",)).fetchone()[0] == 0


def test_documents_card_is_available_for_school_and_graduate_profiles():
    script = (WEBSITE_ROOT / "frontend" / "script.js").read_text(encoding="utf-8")
    assert '{ id: "documents", icon: "▣", title: "Документы и портфолио"' in script
    assert 'school: ["goals", "education"' in script
    assert '"experience", "documents"]' in script
    assert 'graduate: ["experience", "documents", "skills"' in script
