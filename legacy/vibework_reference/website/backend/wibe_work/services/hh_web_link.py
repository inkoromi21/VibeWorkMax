"""Ссылка на поиск веб-интерфейса hh.ru и демо-вакансии, если API hh недоступен."""

from __future__ import annotations

from typing import Any, Dict, Optional
from urllib.parse import urlencode

from wibe_work.services.hh_filter import HH_EXPERIENCE_API_IDS

_CITY_TO_AREA_ID: dict[str, int] = {
    "москва": 1,
    "moscow": 1,
    "санкт-петербург": 2,
    "санкт петербург": 2,
    "спб": 2,
    "saint petersburg": 2,
    "питер": 2,
    "екатеринбург": 3,
    "novosibirsk": 4,
    "новосибирск": 4,
    "нижний новгород": 66,
    "казань": 88,
    "самара": 78,
    "ростов-на-дону": 76,
    "ростов на дону": 76,
    "краснодар": 53,
    "воронеж": 26,
    "кемерово": 47,
    "омск": 68,
    "уфа": 99,
    "пермь": 72,
    "волгоград": 24,
    "томск": 90,
}


def _norm_city(city: Optional[str]) -> Optional[str]:
    if not city:
        return None
    c = str(city).strip().lower()
    return c or None


def _area_id_for_city(city: Optional[str]) -> Optional[int]:
    c = _norm_city(city)
    if not c:
        return None
    return _CITY_TO_AREA_ID.get(c)


def _experience_for_level(level: Optional[str]) -> Optional[str]:
    if not level:
        return None
    l = str(level).strip().lower()
    if not l:
        return None
    # hh web uses: noExperience | between1And3 | between3And6 | moreThan6
    if "стаж" in l or "intern" in l:
        return "noExperience"
    if "джун" in l or "jun" in l or "junior" in l:
        return "between1And3"
    if "мид" in l or "mid" in l:
        return "between3And6"
    if "сень" in l or "senior" in l:
        return "moreThan6"
    return None


def _salary_for_bracket(salary_bracket: Optional[str]) -> Optional[int]:
    if not salary_bracket:
        return None
    b = str(salary_bracket).strip().lower()
    if b == "low":
        return 50000
    if b == "medium":
        return 80000
    if b == "high":
        return 120000
    try:
        n = int(b)
        return n if n > 0 else None
    except ValueError:
        return None


def build_hh_web_search_url(
    *,
    text: Optional[str],
    city: Optional[str] = None,
    only_remote: bool = False,
    only_entry_level: bool = False,
    hh_experience: Optional[str] = None,
    min_salary: Optional[int] = None,
    work_format: Optional[str] = None,
    level: Optional[str] = None,
) -> str:
    """Собирает URL поиска на hh.ru (без запросов к API — только query string)."""
    q: Dict[str, Any] = {}
    if text:
        q["text"] = str(text).strip()

    wf = (work_format or "").strip().lower()
    is_remote = only_remote or "удал" in wf or "remote" in wf

    # Удалёнка — без привязки к региону; иначе город/area из справочника
    if not is_remote:
        area_id = _area_id_for_city(city)
        if area_id:
            q["area"] = area_id
        elif city:
            base = q.get("text") or ""
            c = str(city).strip()
            if c and c.lower() not in str(base).lower():
                q["text"] = (str(base) + " " + c).strip()

    if is_remote:
        q["schedule"] = "remote"

    if only_entry_level:
        q["experience"] = "noExperience"
    elif hh_experience is not None:
        hx = str(hh_experience).strip()
        if hx.lower() == "entry":
            q["experience"] = "noExperience"
        elif hx and hx.lower() != "any" and hx in HH_EXPERIENCE_API_IDS:
            q["experience"] = hx
    else:
        exp = _experience_for_level(level)
        if exp:
            q["experience"] = exp

    if min_salary and min_salary > 0:
        q["salary"] = int(min_salary)
        q["only_with_salary"] = "true"

    return "https://hh.ru/search/vacancy?" + urlencode(q, doseq=True)


def demo_hh_items(hh_search_url: str) -> list[dict[str, Any]]:
    """Три фейковые карточки под тот же формат, что ждёт фронт."""
    return [
        {
            "id": "demo_1",
            "name": "Стажёр / Junior аналитик данных (демо)",
            "alternate_url": hh_search_url,
            "employer_name": "Демо-компания",
            "area_name": "—",
            "salary": {"from": 60000, "to": None, "currency": "RUR"},
            "experience": "Без опыта",
            "schedule": "Удалённо",
            "snippet": {
                "requirement": "SQL, Excel/Sheets, базовая статистика. Это демо — откройте hh.ru по кнопке.",
                "responsibility": "",
            },
        },
        {
            "id": "demo_2",
            "name": "Junior Product Designer (демо)",
            "alternate_url": hh_search_url,
            "employer_name": "Демо-компания",
            "area_name": "—",
            "salary": {"from": 80000, "to": 120000, "currency": "RUR"},
            "experience": "1–3 года",
            "schedule": "Гибрид",
            "snippet": {
                "requirement": "Figma, пользовательские сценарии, UI-kit. Это демо — откройте hh.ru по кнопке.",
                "responsibility": "",
            },
        },
        {
            "id": "demo_3",
            "name": "Junior Marketing Specialist (демо)",
            "alternate_url": hh_search_url,
            "employer_name": "Демо-компания",
            "area_name": "—",
            "salary": {"from": None, "to": None, "currency": "RUR"},
            "experience": "Без опыта",
            "schedule": "Офис",
            "snippet": {
                "requirement": "SMM/контент, базовая аналитика. Это демо — откройте hh.ru по кнопке.",
                "responsibility": "",
            },
        },
    ]

