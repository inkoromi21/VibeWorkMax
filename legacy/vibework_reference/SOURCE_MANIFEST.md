# Манифест выборки VibeWork

Статусы: **перенести** — можно использовать как источник данных или правил; **адаптировать** — переписать под целевую доменную модель и TypeScript; **справочно** — использовать только для извлечения тестовых случаев или требований.

## Диагностика и профиль

| Источник | Статус | Назначение в MAX |
|---|---|---|
| `website/backend/wibe_work/services/user_pain_mapping.py` | адаптировать | Классификация четырёх типов пользовательского запроса и fallback |
| `website/backend/wibe_work/services/diagnostics.py` | адаптировать | Идеи формирования диагностического результата |
| `website/backend/wibe_work/services/profile_analysis_context.py` | адаптировать | Нормализация данных профиля и учебного контекста |
| `website/backend/wibe_work/questionnaire_fields.py` | справочно | Словари полей и допустимые значения |
| `website/backend/wibe_work/services/assessment_routing.py` | адаптировать | Правила выбора ветки диагностики |
| `website/backend/wibe_work/services/assessment_modules.py` | справочно | Наборы вопросов и модулей старой диагностики |
| `website/backend/wibe_work/services/aptitude_quiz_grading.py` | справочно | Тестовые правила подсчёта, не доказательство освоения |
| `website/backend/wibe_work/services/user_context.py` | адаптировать | Чистые функции нормализации и извлечения контекста |

## Учебный каталог и маршрут

| Источник | Статус | Назначение в MAX |
|---|---|---|
| `website/data/learning_catalog.json` | перенести после проверки | Начальный каталог ресурсов; добавить provenance, license и версии |
| `website/data/learning_paths.json` | адаптировать | Черновые последовательности шагов; преобразовать в граф предпосылок |
| `website/backend/wibe_work/services/learning/` | адаптировать | Каталог, сигналы, подбор материалов, прогресс и fallback |
| `website/backend/wibe_work/services/learning_pack.py` | справочно | Сборка старого учебного пакета |
| `website/backend/wibe_work/services/action_plans.py` | адаптировать | Идеи формирования ограниченного плана действий |
| `website/backend/wibe_work/services/llm_prompts.py` | справочно | Формулировки и fallback; не переносить старый провайдер и свободную публикацию |
| `docs/LEARNING_INTEGRATIONS.md` | справочно | Ограничения внешних источников и интеграций |

## Выбор направления и возможности

| Источник | Статус | Назначение в MAX |
|---|---|---|
| `website/backend/wibe_work/services/career_navigator.py` | адаптировать | Ветка выбора направления только для соответствующего типа запроса |
| `website/backend/wibe_work/services/recommendations.py` | справочно | Эвристики рекомендаций; перепроверить источники и названия |
| `website/backend/wibe_work/services/role_confirmation.py` | адаптировать | Подтверждение выбранного направления |
| `website/backend/wibe_work/services/career_analysis*.py` | справочно | Различия школьного, СПО и взрослого сценариев |
| `website/backend/wibe_work/services/hh_client.py` | справочно | Контур внешнего API; не переносить ключи и сетевой код напрямую |
| `website/backend/wibe_work/services/hh_filter.py` | адаптировать | Фильтры и тестовые случаи вакансий |
| `website/backend/wibe_work/services/hh_web_link.py` | справочно | Безопасное формирование внешних ссылок |
| `website/backend/wibe_work/services/job_search.py` | адаптировать | Модуль возможностей после подтверждённой цели |
| `website/backend/wibe_work/services/mts_match.py` | адаптировать | Сопоставление с возможностями МТС после подтверждённой цели |
| `website/data/mts_role_matrix.json` и `website/app/mts_matrix.json` | перенести после проверки | Демонстрационный каталог ролей с пометкой источника и даты |

## Практика и файлы

| Источник | Статус | Назначение в MAX |
|---|---|---|
| `website/backend/wibe_work/services/workday_simulator.py` | адаптировать | Практическое задание или проверка готовности, не отдельная карьерная игра |
| `website/backend/wibe_work/services/simulator_progress.py` | справочно | События прогресса; заменить SQLite на целевую модель попыток |
| `website/backend/wibe_work/services/profile_files.py` | справочно | Негативные сценарии загрузки; саму реализацию переписать под S3 и ClamAV |

## Регрессионные сценарии

Файлы в `tests/website/` не переносятся как готовый Python test suite. Из них нужно извлекать fixtures, граничные случаи и ожидаемые результаты для новых unit, contract и integration тестов.

## Обязательная замена технологий

Перенос означает переписывание поведения под целевой стек, а не подключение старого runtime. Новый проект не должен запускать Python как subprocess или sidecar и не должен импортировать код из `legacy/` во время работы.

| В VibeWork | В новом проекте |
|---|---|
| Python и FastAPI | Node.js, TypeScript и Fastify |
| Pydantic модели | TypeScript types из контрактов и runtime validation через JSON Schema/Ajv |
| SQLite и `get_db` | PostgreSQL, миграции и типизированные repositories |
| `requests` и сетевые вызовы из роутов | Типизированные server-side HTTP adapters с timeout, retry policy и rate limit |
| Старый облачный LLM клиент | Общий AI provider port и Yandex AI adapter со structured output |
| Глобальные словари и module state | Чистые domain functions и versioned entities в PostgreSQL |
| Долгая работа внутри HTTP request | BullMQ worker и Redis с идемпотентными jobs |
| `UploadFile`, Pillow, `tempfile` и локальные пути | Fastify streaming, FileStorage/S3, magic bytes и ClamAV quarantine |
| Python unit tests | TypeScript fixtures, unit, contract и integration tests на текущем test runner |
| Старый веб интерфейс | React/TypeScript mini app с MAX Bridge; основной сценарий остаётся в боте |

Для каждого переносимого элемента сначала зафиксируй ожидаемое поведение и тестовые случаи, затем реализуй эквивалент в целевом модуле. Если новое ТЗ конфликтует со старым поведением, приоритет имеют конкурс, дополнение тимлида и контракты комплекта 4.0; расхождение нужно записать в `docs/VIBEWORK_PORTING_MATRIX.md`.

## Правило для Codex

Во всех промтах сначала используй эту выборку. Обращайся к полному `/Users/inkoromi21/Documents/VibeWork` только если нужного поведения нет в манифесте, и в итоговом отчёте объясни, зачем потребовалось расширить область чтения.
