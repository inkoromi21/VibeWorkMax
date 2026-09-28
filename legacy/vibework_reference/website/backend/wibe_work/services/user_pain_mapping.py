"""
Сопоставление с методологией «боли пользователя», user stories и KPI
(таблица: https://docs.google.com/spreadsheets/d/1FJ4Zl7z3UQjh5snMyXf0Yj0A47tbJk-p3M1uHIpbVCg/edit).
"""

import re
from typing import Any, Dict, List, Optional

USER_PAINS: List[Dict[str, Any]] = [
    {
        "id": 1,
        "pain": "Я не знаю, кем стать",
        "signal_keywords": ["не знаю", "кем стать", "професси", "выбор", "определ"],
        "bot_value": [
            "Топ направлений с пояснением «почему вам» (см. /career/recommendations/)",
            "Диагностика и полнота профиля (/career/diagnostics/)",
        ],
        "success_metric_hint": "CR → выбор направления после диагностики; целевое время решения <5 мин",
    },
    {
        "id": 2,
        "pain": "У меня нет опыта, меня никуда не возьмут",
        "signal_keywords": ["нет опыта", "не возьмут", "стажир", "первый"],
        "bot_value": [
            "Фильтр вакансий «без опыта» (entry_level в каталоге)",
            "План из 3 навыков для первого оффера (/career/recommendations/)",
            "Блок опыта в профиле: проекты, волонтёрство, подработки",
        ],
        "success_metric_hint": "CR → отклик; interview rate",
    },
    {
        "id": 3,
        "pain": "Я из маленького города",
        "signal_keywords": ["город", "регион", "урюпинск", "нет ваканс", "удал"],
        "bot_value": [
            "Фильтр формата работы: удалёнка / гибрид (/career/jobs/ + поле work_format)",
            "Готовность к переезду в профиле",
        ],
        "success_metric_hint": "Доля пользователей из регионов с найденным удалённым форматом",
    },
    {
        "id": 4,
        "pain": "У меня нет денег на курсы",
        "signal_keywords": ["денег", "курс", "дорог", "бесплатн"],
        "bot_value": [
            "В рекомендациях — бесплатные треки (открытые лекции, документация, Stepik)",
        ],
        "success_metric_hint": "Завершаемость бесплатного трека (неделя 1 плана)",
    },
    {
        "id": 5,
        "pain": "Я боюсь собеседований",
        "signal_keywords": ["боюсь", "собес", "тревог", "стресс"],
        "bot_value": [
            "Тренажёр (заготовка): типовые вопросы по направлению — подключите LLM к /career/report/",
        ],
        "success_metric_hint": "Self-reported тревога 8→4 после 3 тренировок",
    },
    {
        "id": 6,
        "pain": "Слишком много информации, не знаю с чего начать",
        "signal_keywords": ["много информации", "с чего начать", "запутался", "паралич"],
        "bot_value": [
            "Пошаговый план на 12 недель (/career/navigator/)",
        ],
        "success_metric_hint": "Завершаемость недели 1 плана >40%",
    },
    {
        "id": 7,
        "pain": "Я ничего не умею",
        "signal_keywords": ["ничего не умею", "бесполезн", "не умею"],
        "bot_value": [
            "Разбор «что уже умеешь» из повседневности (/career/diagnostics/ → skills_analysis)",
        ],
        "success_metric_hint": "Рост уверенности 3→6 за 2 недели (опрос)",
    },
    {
        "id": 8,
        "pain": "Всё умею, но работу не дают",
        "signal_keywords": ["всё умею", "не дают работу", "обида"],
        "bot_value": [
            "Явный список пробелов к требованиям вакансий и матрицы ролей (/career/mts-match/)",
        ],
        "success_metric_hint": "Доля, признавших пробелы и начавших закрывать",
    },
]


def _profile_text_blob(profile: Dict[str, Any]) -> str:
    parts = [
        profile.get("interests"),
        profile.get("like_to_do"),
        profile.get("dislike_to_do"),
        profile.get("city"),
        profile.get("extra_education"),
        profile.get("experience_projects"),
    ]
    return " ".join(str(p).lower() for p in parts if p)


def align_pains(profile: Dict[str, Any]) -> Dict[str, Any]:
    blob = _profile_text_blob(profile)
    matched: List[Dict[str, Any]] = []
    for p in USER_PAINS:
        hits = sum(1 for kw in p["signal_keywords"] if kw in blob)
        if hits:
            matched.append(
                {
                    **{k: v for k, v in p.items() if k != "signal_keywords"},
                    "match_strength": hits,
                }
            )
    matched.sort(key=lambda x: -x["match_strength"])

    kpi_reference = [
        "CR → выбор профессии после диагностики >60%",
        "Медиана времени до выбора <5 мин",
        "Завершаемость недели 1 плана >40%",
        "NPS >40 ежемесячно",
        "Retention D7 >25%",
    ]

    return {
        "matched_pains": matched,
        "kpi_reference_product": kpi_reference,
        "note": "Сигналы строятся по текстовым полям профиля; при пустом профиле заполните интересы и «что нравится».",
    }
