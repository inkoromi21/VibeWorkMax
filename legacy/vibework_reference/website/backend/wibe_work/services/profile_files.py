"""Private storage and validation for documents attached to a profile."""

from __future__ import annotations

import os
import sqlite3
import tempfile
import unicodedata
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import UploadFile
from PIL import Image, UnidentifiedImageError

from wibe_work import config as cfg
from wibe_work.sqlite_db import get_db

CHUNK_SIZE = 1024 * 1024
MAX_TITLE_LENGTH = 160
MAX_DESCRIPTION_LENGTH = 1000

CATEGORY_LABELS = {
    "resume": "Резюме",
    "certificate": "Сертификат",
    "diploma": "Диплом",
    "award": "Грамота / награда",
    "project": "Материал проекта",
    "other": "Другое",
}
CATEGORY_LIMITS = {
    "resume": 1,
    "certificate": 8,
    "diploma": 3,
    "award": 6,
    "project": 5,
    "other": 3,
}

_FILE_TYPES = {
    ".pdf": {"mime": "application/pdf", "signature": b"%PDF-"},
    ".jpg": {"mime": "image/jpeg", "image_format": "JPEG"},
    ".jpeg": {"mime": "image/jpeg", "image_format": "JPEG"},
    ".png": {"mime": "image/png", "image_format": "PNG"},
}
_DANGEROUS_SUFFIXES = {
    ".apk", ".bat", ".cmd", ".com", ".dll", ".doc", ".docm", ".docx",
    ".exe", ".html", ".htm", ".jar", ".js", ".mjs", ".ps1", ".py",
    ".rar", ".sh", ".svg", ".tar", ".ts", ".zip", ".7z",
}


class ProfileFileError(Exception):
    def __init__(self, detail: str, status_code: int = 400):
        self.detail = detail
        self.status_code = status_code
        super().__init__(detail)


def _storage_dir() -> Path:
    root = cfg.PROFILE_FILES_DIR.resolve()
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    if not root.is_dir():
        raise ProfileFileError("Хранилище документов недоступно.", 500)
    return root


def _safe_storage_path(storage_key: str) -> Path:
    root = _storage_dir()
    if not storage_key or Path(storage_key).name != storage_key:
        raise ProfileFileError("Некорректный ключ файла.", 500)
    path = (root / storage_key).resolve()
    if path.parent != root:
        raise ProfileFileError("Некорректный путь файла.", 500)
    return path


def _clean_text(value: str | None, *, max_length: int, field_label: str) -> str:
    text = str(value or "").strip()
    if len(text) > max_length:
        raise ProfileFileError(f"{field_label} слишком длинное.")
    return text


def _validate_filename(raw_filename: str | None) -> tuple[str, str]:
    raw = unicodedata.normalize("NFC", str(raw_filename or "")).strip()
    if not raw or raw in {".", ".."}:
        raise ProfileFileError("Укажите имя файла.")
    if len(raw) > 255 or "\x00" in raw or "/" in raw or "\\" in raw:
        raise ProfileFileError("Некорректное имя файла.")
    if any(ord(char) < 32 for char in raw):
        raise ProfileFileError("Некорректное имя файла.")

    suffixes = [suffix.lower() for suffix in Path(raw).suffixes]
    extension = suffixes[-1] if suffixes else ""
    if extension not in _FILE_TYPES:
        raise ProfileFileError("Можно загрузить только PDF, JPG или PNG.")
    # A harmless name such as "portfolio.v2.pdf" is allowed; an embedded
    # executable/archive extension is not, even if the final suffix is PDF.
    if any(suffix in _DANGEROUS_SUFFIXES for suffix in suffixes[:-1]):
        raise ProfileFileError("Имя файла содержит запрещённое расширение.")
    return raw, extension


def _validate_category(raw_category: str | None) -> str:
    category = str(raw_category or "").strip().lower()
    if category not in CATEGORY_LABELS:
        raise ProfileFileError("Выберите категорию документа.")
    return category


async def _stream_to_temp(upload: UploadFile, root: Path) -> tuple[Path, int]:
    temp_path: Path | None = None
    total = 0
    try:
        with tempfile.NamedTemporaryFile(
            mode="wb", prefix=".upload-", suffix=".tmp", dir=root, delete=False
        ) as temp_file:
            temp_path = Path(temp_file.name)
            while True:
                chunk = await upload.read(CHUNK_SIZE)
                if not chunk:
                    break
                total += len(chunk)
                if total > cfg.PROFILE_FILE_MAX_SIZE:
                    raise ProfileFileError("Размер одного файла не должен превышать 10 МБ.", 413)
                temp_file.write(chunk)
        if total <= 0:
            raise ProfileFileError("Нельзя загрузить пустой файл.")
        return temp_path, total
    except Exception:
        if temp_path:
            temp_path.unlink(missing_ok=True)
        raise
    finally:
        await upload.close()


def _validate_content(path: Path, extension: str, declared_mime: str | None) -> str:
    file_type = _FILE_TYPES[extension]
    expected_mime = file_type["mime"]
    supplied_mime = str(declared_mime or "").split(";", 1)[0].strip().lower()
    if supplied_mime != expected_mime:
        raise ProfileFileError("Тип файла не соответствует выбранному формату.")

    if extension == ".pdf":
        with path.open("rb") as source:
            if source.read(5) != file_type["signature"]:
                raise ProfileFileError("Файл не похож на корректный PDF.")
        return expected_mime

    try:
        with Image.open(path) as image:
            if image.format != file_type["image_format"]:
                raise ProfileFileError("Содержимое файла не соответствует его расширению.")
            if image.width * image.height > 25_000_000:
                raise ProfileFileError("Изображение слишком большое по разрешению.")
            image.verify()
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError):
        raise ProfileFileError("Файл не является корректным изображением.") from None
    return expected_mime


def _row_metadata(row: Any) -> dict[str, Any]:
    return {
        "id": str(row["id"]),
        "category": str(row["category"]),
        "category_label": CATEGORY_LABELS.get(str(row["category"]), "Документ"),
        "original_filename": str(row["original_filename"]),
        "mime_type": str(row["mime_type"]),
        "size_bytes": int(row["size_bytes"]),
        "title": str(row["title"] or ""),
        "description": str(row["description"] or ""),
        "created_at": str(row["created_at"]),
        "download_url": f"/api/profile/files/{row['id']}/download",
    }


def list_profile_files(owner_user_id: str) -> list[dict[str, Any]]:
    with get_db() as conn:
        rows = conn.execute(
            """SELECT id, category, original_filename, mime_type, size_bytes, title, description, created_at
               FROM profile_files WHERE owner_user_id = ? ORDER BY created_at DESC, id DESC""",
            (owner_user_id,),
        ).fetchall()
    return [_row_metadata(row) for row in rows]


def get_owned_profile_file(owner_user_id: str, file_id: str) -> dict[str, Any] | None:
    with get_db() as conn:
        row = conn.execute(
            """SELECT id, owner_user_id, category, original_filename, storage_key, mime_type, size_bytes,
                      title, description, created_at
               FROM profile_files WHERE id = ? AND owner_user_id = ?""",
            (file_id, owner_user_id),
        ).fetchone()
    return dict(row) if row else None


def _assert_quota(conn: sqlite3.Connection, owner_user_id: str, category: str, incoming_size: int) -> None:
    totals = conn.execute(
        """SELECT COUNT(*) AS file_count, COALESCE(SUM(size_bytes), 0) AS total_size
           FROM profile_files WHERE owner_user_id = ?""",
        (owner_user_id,),
    ).fetchone()
    if int(totals["file_count"]) >= cfg.PROFILE_FILES_MAX_COUNT:
        raise ProfileFileError("Можно хранить не более 20 документов.", 409)
    if int(totals["total_size"]) + incoming_size > cfg.PROFILE_FILES_MAX_TOTAL_SIZE:
        raise ProfileFileError("Превышен общий лимит документов: 100 МБ.", 413)
    category_count = conn.execute(
        "SELECT COUNT(*) AS c FROM profile_files WHERE owner_user_id = ? AND category = ?",
        (owner_user_id, category),
    ).fetchone()["c"]
    if int(category_count) >= CATEGORY_LIMITS[category]:
        if category == "resume":
            raise ProfileFileError("Резюме уже загружено. Сначала удалите или замените старый файл.", 409)
        raise ProfileFileError("Достигнут лимит файлов для этой категории.", 409)


async def create_profile_file(
    *, owner_user_id: str, upload: UploadFile, category: str | None, title: str | None, description: str | None
) -> dict[str, Any]:
    if upload is None:
        raise ProfileFileError("Выберите файл.")
    safe_category = _validate_category(category)
    original_filename, extension = _validate_filename(upload.filename)
    safe_title = _clean_text(title, max_length=MAX_TITLE_LENGTH, field_label="Название")
    safe_description = _clean_text(description, max_length=MAX_DESCRIPTION_LENGTH, field_label="Описание")
    root = _storage_dir()
    temp_path, size_bytes = await _stream_to_temp(upload, root)
    final_path: Path | None = None
    moved = False
    try:
        mime_type = _validate_content(temp_path, extension, upload.content_type)
        file_id = str(uuid.uuid4())
        storage_key = f"{uuid.uuid4()}{extension}"
        final_path = _safe_storage_path(storage_key)
        created_at = datetime.now(timezone.utc).isoformat()
        with get_db() as conn:
            conn.execute("BEGIN IMMEDIATE")
            _assert_quota(conn, owner_user_id, safe_category, size_bytes)
            os.replace(temp_path, final_path)
            moved = True
            conn.execute(
                """INSERT INTO profile_files
                   (id, owner_user_id, category, original_filename, storage_key, mime_type, size_bytes, title, description, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (file_id, owner_user_id, safe_category, original_filename, storage_key, mime_type, size_bytes, safe_title, safe_description, created_at),
            )
            conn.commit()
        return {
            "id": file_id,
            "category": safe_category,
            "category_label": CATEGORY_LABELS[safe_category],
            "original_filename": original_filename,
            "mime_type": mime_type,
            "size_bytes": size_bytes,
            "title": safe_title,
            "description": safe_description,
            "created_at": created_at,
            "download_url": f"/api/profile/files/{file_id}/download",
        }
    except ProfileFileError:
        raise
    except sqlite3.Error:
        raise ProfileFileError("Не удалось сохранить документ. Попробуйте ещё раз.", 500) from None
    except OSError:
        raise ProfileFileError("Хранилище документов временно недоступно. Попробуйте ещё раз.", 500) from None
    finally:
        temp_path.unlink(missing_ok=True)
        if moved and final_path and not _profile_file_exists(owner_user_id, final_path.name):
            final_path.unlink(missing_ok=True)


def _profile_file_exists(owner_user_id: str, storage_key: str) -> bool:
    with get_db() as conn:
        row = conn.execute(
            "SELECT 1 FROM profile_files WHERE owner_user_id = ? AND storage_key = ?",
            (owner_user_id, storage_key),
        ).fetchone()
    return row is not None


def delete_profile_file(owner_user_id: str, file_id: str) -> bool:
    record = get_owned_profile_file(owner_user_id, file_id)
    if not record:
        return False
    try:
        _safe_storage_path(str(record["storage_key"])).unlink(missing_ok=True)
    except OSError:
        # Keep metadata intact if a real disk error occurs, so the user can
        # retry and the document does not become an unreachable orphan.
        raise ProfileFileError("Не удалось удалить файл из хранилища. Попробуйте ещё раз.", 500) from None
    with get_db() as conn:
        conn.execute(
            "DELETE FROM profile_files WHERE id = ? AND owner_user_id = ?",
            (file_id, owner_user_id),
        )
        conn.commit()
    return True


def delete_all_profile_files_for_user(owner_user_id: str) -> None:
    """Remove file metadata and best-effort private bytes during account deletion."""
    with get_db() as conn:
        exists = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'profile_files'"
        ).fetchone()
        if not exists:
            return
        rows = conn.execute(
            "SELECT storage_key FROM profile_files WHERE owner_user_id = ?", (owner_user_id,)
        ).fetchall()
    for row in rows:
        try:
            _safe_storage_path(str(row["storage_key"])).unlink(missing_ok=True)
        except OSError:
            # A missing path is already handled by missing_ok. Any other
            # filesystem failure must keep the account record retriable.
            raise ProfileFileError("Не удалось удалить документы пользователя.", 500) from None
    with get_db() as conn:
        conn.execute("DELETE FROM profile_files WHERE owner_user_id = ?", (owner_user_id,))
        conn.commit()
