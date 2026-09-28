# Реестр повторного использования VibeWork

## Зафиксированный источник и граница

- Исходный репозиторий: `/Users/inkoromi21/Documents/VibeWork`.
- Зафиксированный commit: `d301b694a584089ac9bb4bd59744bd7e30f7ec94`.
- Выборка: `legacy/vibework_reference`.
- Состояние: выборка создана из рабочей копии с незакоммиченными изменениями.
- Изменённые или неотслеживаемые файлы в выборке: `career_analysis.py`, `career_navigator.py`, `hh_filter.py`, `profile_analysis_context.py`, `recommendations.py`, `user_context.py`, `profile_files.py`, `test_profile_files.py`.

Полный старый проект в ходе Фазы 0 не открывался. Подготовленная выборка и `SOURCE_MANIFEST.md` дали достаточную информацию.

## Значение решений

| Решение | Значение |
|---|---|
| `take` | сохранить как источник provenance или взять данные после обязательной проверки происхождения, лицензии и версии; это не разрешение исполнять legacy-код |
| `adapt` | перенести ожидаемое поведение, алгоритм, UX-паттерн или тестовый случай и заново реализовать на целевом TypeScript-стеке и контрактах 4.0 |
| `leave` | не переносить элемент; при необходимости он остаётся только свидетельством ограничения или исторического решения |

**Python-код не является и не входит в целевой runtime.** Ни один `.py` из `legacy/` не импортируется, не запускается subprocess/sidecar и не поставляется как рабочий сервис. Целевой runtime — Node.js/TypeScript; Python-файлы являются только читаемыми источниками поведения и тестовых идей.

## Файловый реестр take adapt leave

| Путь относительно `legacy/vibework_reference` | Решение | Обоснование и назначение в новом продукте |
|---|---|---|
| `.gitignore` | leave | правила старого Python/SQLite проекта неполны для нового monorepo; использовать только как свидетельство исключения `.env`, БД и кэшей |
| `README.md` | take | источник commit, состояния рабочей копии и запретов переноса |
| `SOURCE_MANIFEST.md` | take | исходная матрица provenance и технологических замен |
| `docs/LEARNING_INTEGRATIONS.md` | adapt | ограничения и идеи интеграций; URL и условия источников перепроверить |
| `tests/website/test_action_plans.py` | adapt | expected cases ограниченного плана, ветвления и fallback для TypeScript unit tests |
| `tests/website/test_analysis_modes.py` | adapt | граничные случаи режимов профиля; сверить с четырьмя типами 4.0 |
| `tests/website/test_hh_experience_filter.py` | adapt | fixtures фильтра опыта для вторичного модуля возможностей |
| `tests/website/test_hh_search_templates.py` | adapt | безопасные шаблоны поиска; не переносить сетевой вызов |
| `tests/website/test_learning_bridge.py` | leave | готовый тест сломан импортом отсутствующего `GapBar`; полезные ожидания покрыть новыми fixtures без старой схемы |
| `tests/website/test_profile_files.py` | adapt | негативные сценарии MIME, квоты, owner isolation и удаления; реализацию SQLite/локальных файлов оставить |
| `tests/website/test_quiz_sphere_key.py` | adapt | тестовая идея стабильного ключа сферы; согласовать с контрактами 4.0 |
| `tests/website/test_security_hardening.py` | adapt | негативные security cases, origin/auth/validation для новых adapters |
| `tests/website/test_sphere_locked_analysis.py` | adapt | invariants фиксированной области анализа для нового routing |
| `tests/website/test_vacancy_profession.py` | adapt | проверка соответствия роли/возможности подтверждённой цели |
| `website/app/mts_matrix.json` | adapt | демонстрационные роли после дедупликации, provenance и актуализации; не считать реальными вакансиями |
| `website/backend/wibe_work/questionnaire_fields.py` | adapt | словари и допустимые значения как идеи для versioned schemas; не переносить Python-константы |
| `website/backend/wibe_work/services/action_plans.py` | adapt | правила ограниченного плана действий для course engine |
| `website/backend/wibe_work/services/aptitude_quiz_grading.py` | adapt | примеры подсчёта как диагностический сигнал; не использовать как доказательство mastery |
| `website/backend/wibe_work/services/assessment_modules.py` | adapt | наборы вопросов после предметной/методической проверки и привязки к QuestionTemplateVersion |
| `website/backend/wibe_work/services/assessment_routing.py` | adapt | чистые правила выбора релевантной ветки диагностики |
| `website/backend/wibe_work/services/career_analysis.py` | adapt | различия взрослого сценария и edge cases; свободные LLM-решения не переносить |
| `website/backend/wibe_work/services/career_analysis_school.py` | adapt | школьные ограничения и тестовые случаи; не предлагать работу как основной путь |
| `website/backend/wibe_work/services/career_analysis_vocational.py` | adapt | сценарии СПО и практики после сверки с типом запроса 04 |
| `website/backend/wibe_work/services/career_navigator.py` | adapt | ветка выбора направления только после подтверждённого соответствующего запроса |
| `website/backend/wibe_work/services/diagnostics.py` | adapt | идеи формирования результата; заменить старые статусы на DiagnosticContext 4.0 |
| `website/backend/wibe_work/services/hh_client.py` | leave | старый сетевой клиент, API-пути и обработка credentials не переносятся |
| `website/backend/wibe_work/services/hh_filter.py` | adapt | чистые фильтры и граничные случаи; источники и актуальность проверяются отдельно |
| `website/backend/wibe_work/services/hh_web_link.py` | adapt | правила безопасного формирования внешней ссылки в server-side adapter |
| `website/backend/wibe_work/services/job_search.py` | adapt | модуль возможностей только после подтверждённой цели, с честным empty state |
| `website/backend/wibe_work/services/learning/__init__.py` | leave | Python package marker не имеет назначения в целевом runtime |
| `website/backend/wibe_work/services/learning/adapters.py` | adapt | порт/adapter pattern; интерфейсы заново задать TypeScript-типами |
| `website/backend/wibe_work/services/learning/assessment_signals.py` | adapt | преобразование сигналов в Evidence без объявления unknown как gap |
| `website/backend/wibe_work/services/learning/catalog.py` | adapt | идеи каталога; реализовать versioned import и статусы 4.0 |
| `website/backend/wibe_work/services/learning/engine.py` | adapt | алгоритмические идеи маршрута; нормативны CR-01–CR-12 и prerequisite graph 4.0 |
| `website/backend/wibe_work/services/learning/growth_stages.py` | adapt | UX-этапы роста как объяснение, не отдельная mastery policy |
| `website/backend/wibe_work/services/learning/material_relevance.py` | adapt | фильтры релевантности источника, возраста, темы и ограничений |
| `website/backend/wibe_work/services/learning/personalized_advice.py` | adapt | explainability patterns; рекомендации только из разрешённого контекста |
| `website/backend/wibe_work/services/learning/progress.py` | adapt | события прогресса; разделить step state и mastery state |
| `website/backend/wibe_work/services/learning/substeps.py` | adapt | разбиение длинного блока только по заранее допустимым границам |
| `website/backend/wibe_work/services/learning/video_scoring.py` | leave | старые эвристические баллы источников не являются проверкой качества 4.0 |
| `website/backend/wibe_work/services/learning/vk_video.py` | leave | старый внешний adapter и сетевой код; будущая интеграция требует отдельного решения |
| `website/backend/wibe_work/services/learning_pack.py` | adapt | композиция учебного пакета как тестовая идея; заменить RoutePlan/CourseVersion |
| `website/backend/wibe_work/services/llm_prompts.py` | adapt | переносить только ограниченные формулировки, schema/fallback идеи; старый provider и свободную публикацию оставить |
| `website/backend/wibe_work/services/mts_match.py` | adapt | сопоставление навыков с маркированными возможностями после подтверждённой цели |
| `website/backend/wibe_work/services/profile_analysis_context.py` | adapt | нормализация профиля и учебного контекста в versioned domain types |
| `website/backend/wibe_work/services/profile_files.py` | leave | SQLite, локальные пути, `UploadFile` и runtime-код оставить; негативные случаи уже учтены отдельно |
| `website/backend/wibe_work/services/recommendations.py` | adapt | эвристики как candidate cases; источники и названия перепроверить |
| `website/backend/wibe_work/services/role_confirmation.py` | adapt | подтверждение гипотезы направления/пробы пользователем |
| `website/backend/wibe_work/services/simulator_progress.py` | adapt | события попытки и восстановления; заменить SQLite на Attempt/ReviewVersion/Evidence |
| `website/backend/wibe_work/services/user_context.py` | adapt | чистые функции нормализации; запрет догадок для неизвестных признаков |
| `website/backend/wibe_work/services/user_pain_mapping.py` | adapt | только примеры сигналов; восемь старых болей не заменяют четыре нормативных типа запроса |
| `website/backend/wibe_work/services/workday_simulator.py` | adapt | отдельные сценарии превратить в профессиональные пробы/практику с versioned rubric |
| `website/data/learning_catalog.json` | adapt | начальный demo-каталог после проверки provenance, лицензий, дат, ID и статусов |
| `website/data/learning_paths.json` | adapt | черновые пути преобразовать в граф компетенций и prerequisites |
| `website/data/mts_role_matrix.json` | adapt | объединить/сверить с app-копией, пометить demo и дату источника |

Итого: 55 файлов; `take` — 2, `adapt` — 46, `leave` — 7. `take` относится только к provenance-документам, поэтому исполняемый Python не попадает в целевой runtime.

## Потенциально переносимые элементы по типу

| Тип | Элементы | Назначение в MAX |
|---|---|---|
| Каталоги | `website/data/learning_catalog.json`, `learning_paths.json`, обе MTS-матрицы | seed для маркированного demo-каталога и проверка versioned import; не production-контент без ревизии |
| Алгоритмы | assessment routing, signals, material relevance, stable filters, action plans, substeps | чистые TypeScript domain functions под схемами 4.0 |
| Подходы | ports/adapters, fallback, owner isolation, восстановление прогресса, безопасные ссылки | границы внешних интеграций и устойчивые локальные режимы |
| Тестовые идеи | 9 пригодных legacy test-файлов плюс полезные ожидания из сломанного GapBar-теста | unit, contract и integration fixtures в новом test runner |
| UX-паттерны | свободная проблема, раздельные школьный/СПО/взрослый контексты, объяснение причины шага, восстановление | bot-first диалог и расширенные экраны mini app без обязательной профориентации |
| Контракты | в legacy нет нормативных контрактов 4.0; `questionnaire_fields.py` и структуры сервисов только справочные | нормативными остаются `schemas.json` и `openapi-core.json` из комплекта 4.0 |
| Фикстуры | JSON-каталоги, role matrices и expected cases тестов | синтетические regression cases после очистки и явной маркировки provenance |

## Известные проблемы, которые нельзя унаследовать

### GapBar

`tests/website/test_learning_bridge.py` импортирует `GapBar` и другие старые `app.*` модули, отсутствующие в подготовленной выборке. Тест не является автономным и не переносится. Его полезное ожидание — маршрут имеет шаги и материалы — будет заново выражено через RoutePlan и contracts fixtures 4.0.

### owner_user_id

`tests/website/test_profile_files.py` проверяет, что удаление аккаунта очищает строки `profile_files` по `owner_user_id` и физические байты. Этот legacy-тест известен как падающий. Требование owner isolation и каскадного удаления сохраняется, но SQLite-схема и реализация `profile_files.py` оставляются. В новом продукте нужны PostgreSQL repository tests, S3 object cleanup и идемпотентный deletion job.

### Игнорируемый website data

Каталог `website/data` в исходной рабочей копии был организационно игнорируемым/неотслеживаемым риском. Файлы в подготовленной выборке существуют, но не считаются надёжным production-source. Их checksum фиксируется; перед импортом обязательны provenance, лицензия, дата проверки, дедупликация и экспертный статус.

## Запрещённый перенос

Не переносятся `.env`, токены, ключи, `vibework.db`, любые пользовательские БД, кэши, виртуальное окружение, персональные данные, старые FastAPI routes, SQLite runtime, email-аутентификация, старый LLM client, монолитный frontend и deployment/runtime файлы старого проекта.

Manifest `legacy/vibework_reference/SHA256SUMS` содержит SHA-256 каждого файла выборки, кроме самого manifest. Добавление, удаление или изменение файла обнаруживается `node scripts/check-phase0.mjs 01`.

