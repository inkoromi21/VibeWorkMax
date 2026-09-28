# Обучение: интеграции

## Без ключей (уже в продукте)

- **Каталог** — `website/data/learning_catalog.json` (roadmap.sh, Stepik, MDN, Figma, HubSpot, Kaggle, …)
- **Пути по шагам** — `website/data/learning_paths.json`
- **Exercism**, **Codewars** — задачи на шагах
- **ESCO** — по умолчанию `ESCO_API_ENABLED=1`
- **Прогресс** — SQLite `learning_progress`; данные включаются в карьерный разбор сайта.

## С ключами (опционально)

- **`VK_ACCESS_TOKEN`** — [vk.com/apps](https://vk.com/apps), поиск видео на шагах с адаптером `video`
- **`VK_VIDEO_OWNER_IDS`** — альбомы сообществ для `video.get`
- **`GITHUB_TOKEN`** — GitHub PAT, поиск репозиториев-проектов
- **`ONET_USERNAME`**, **`ONET_PASSWORD`** — [onetcenter.org](https://www.onetcenter.org/webowners/)
- **`ESCO_API_ENABLED=0`** — отключить ESCO при блокировках

## Без публичного API (только ссылки в каталоге)

LinkedIn Learning, Udemy, LeetCode, Microsoft Learn Catalog, DevDocs API, Odin/FCC curriculum — в продукте прямые ссылки и пути в JSON, не live-каталоги.

## Статус и метрики

- **`python scripts/check_integrations.py`** — что сконфигурировано
- В разборе: `learning_path.metrics` — `coverage_percent`, `current_step_index`, `total_steps`, `completed_steps`

Шаги отмечаются в разделе «Разбор» («В работе» / «Готово»).

## Деплой

После `git pull` перезапустите API. Таблицы прогресса создаются при первом запросе.

Пример блока в корневом `.env` (см. [ENV.md](ENV.md)):

```env
VK_ACCESS_TOKEN=
VK_VIDEO_OWNER_IDS=
GITHUB_TOKEN=
ONET_USERNAME=
ONET_PASSWORD=
ESCO_API_ENABLED=1
```
