"""Рекомендации обучения: каталог, пути, API-адаптеры, прогресс."""

from wibe_work.services.learning.engine import (
    build_learning_for_analysis,
    build_learning_path_payload,
    get_integration_status,
)

__all__ = [
    "build_learning_for_analysis",
    "build_learning_path_payload",
    "get_integration_status",
]
