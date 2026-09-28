# Инвентарь источников Фазы 0

## Правила использования

Downloads используется только для чтения. Ничего из `/Users/inkoromi21/Downloads` не изменяется и не переносится автоматически. Старый проект `/Users/inkoromi21/Documents/VibeWork` не сканировался: подготовленной выборки достаточно для Фазы 0.

## Нормативные и связанные материалы

| Source ID | Путь | Назначение | Состояние при аудите |
|---|---|---|---|
| SRC-COMP | `/Users/inkoromi21/Downloads/Obrazovatelnye_reshenia_1.pdf` | условия конкурса, ограничения, формат сдачи, критерии | существует; 22 страницы; SHA-256 `373e1f482e5ec4ef4f60e157e3a0227e1781b941decb3b94aed7d61469761d97` |
| SRC-ADD | `/Users/inkoromi21/Downloads/Dopolnenie_k_TZ_MAX_po_kriteriam_khakatona.docx` | GATE, SC, VAL, UX, INT и E-требования | существует; SHA-256 `b1b9f8fd5ef4d2f97b812b347c5fb0ec21288263f06870d03fa8390f4f3b9ab5` |
| SRC-TZ-DEV | `/Users/inkoromi21/Downloads/TZ_MAX_komplekt_4_0/ТЗ для разработчика Персональная образовательная платформа MAX.docx` | основной объём, FR-01–FR-16, стек, безопасность и сдача | существует; SHA-256 `f5a8deb96524526b4a2a9a4260f9d482fadc2289e0fc89d4c3012beb7cd19565` |
| SRC-TZ-LOGIC | `/Users/inkoromi21/Downloads/TZ_MAX_komplekt_4_0/Логика работы персональной образовательной платформы MAX.docx` | общая доменная модель, состояния, FL-01–FL-08 | существует; SHA-256 `c0cc1e936a90e15fb721e17576838bd76e45c04d62ebca70d87bee4336045000` |
| SRC-TZ-COURSE | `/Users/inkoromi21/Downloads/TZ_MAX_komplekt_4_0/Спецификация персонального создания курсов MAX.docx` | алгоритм курса, CR-01–CR-12 | существует; SHA-256 `b3052284a6c191d9b56c04c70185152bfb43a4d5a4357c8dd54439c8a77058f5` |
| SRC-TZ-DIAG | `/Users/inkoromi21/Downloads/TZ_MAX_komplekt_4_0/ТЗ Персональная диагностика после профиля MAX.docx` | алгоритм диагностики, DT-01–DT-12 | существует; SHA-256 `fd3b06001fc6247b4a15dfa7fe0485363be174fa710d7f2deb9b619821e38362` |
| SRC-CHANGES | `/Users/inkoromi21/Downloads/TZ_MAX_komplekt_4_0/Изменения комплекта 4.0.md` | версия комплекта и перечень изменений | существует; SHA-256 `272e72cf6786443e7ffe9b9cf094c4cd742f388a94e5b3cfed74babbe31397e7` |
| SRC-CONTRACT-README | `/Users/inkoromi21/Downloads/TZ_MAX_komplekt_4_0/Контракты и примеры/README.md` | статус синтетики и правила контрактов | существует |
| SRC-SCHEMAS | `/Users/inkoromi21/Downloads/TZ_MAX_komplekt_4_0/Контракты и примеры/schemas.json` | нормативные JSON Schema 4.0 | существует |
| SRC-OPENAPI | `/Users/inkoromi21/Downloads/TZ_MAX_komplekt_4_0/Контракты и примеры/openapi-core.json` | проектный контракт API ядра | существует; не является полной OpenAPI всех FR |
| SRC-FIXTURES | `/Users/inkoromi21/Downloads/TZ_MAX_komplekt_4_0/Контракты и примеры/fixtures.json` | синтетический технический эталон и ожидаемые сценарии | существует; не имеет экспертного утверждения |
| SRC-CONTEXTS | `/Users/inkoromi21/Downloads/TZ_MAX_komplekt_4_0/Контракты и примеры/context-examples.json` | валидные примеры обмена | существует |
| SRC-VALIDATION | `/Users/inkoromi21/Downloads/TZ_MAX_komplekt_4_0/Контракты и примеры/validation-report.json` | отчёт проверки документации и связей | существует; 151 passed checks; не доказывает работу приложения |
| SRC-LEGACY-README | `legacy/vibework_reference/README.md` | provenance выборки, commit и ограничения | существует |
| SRC-LEGACY-MANIFEST | `legacy/vibework_reference/SOURCE_MANIFEST.md` | подготовленная матрица источников legacy | существует |
| SRC-BOOK-BUILDER | `build_max_book.py` | связанный рабочий материал: зафиксированные границы, конфликты и промты книги | существует; не является нормативнее конкурса/ТЗ |
| SRC-BOOK | `MAX_образовательная_платформа_книга_разработчика.docx` | сгенерированная книга разработчика | существует; производный материал, не заменяет первоисточники |

Дублирующий каталог `/Users/inkoromi21/Downloads/ТЗ MAX комплект 4.0` обнаружен, но не использован как отдельный нормативный источник: аудит выполнен по пути `TZ_MAX_komplekt_4_0`, который явно указан в книге разработчика. Это исключает двойной учёт одинакового комплекта.

## Контракты и фикстуры

| Файл | Содержимое | Как использовать |
|---|---|---|
| `schemas.json` | `$defs` для DiagnosticContext, Evidence, MasteryPolicy, CompetencyEstimate, RoutePlan, BuildRequest, PublishDecision, CourseCompletionPolicy, ApiError и связанных типов | импортировать позднее как contract source; неизвестные поля запрещены; дополнить бизнес-проверками владельца, версий и ссылок |
| `openapi-core.json` | OpenAPI ядра диагностики, проблем, курсов, попыток и споров | считать стартовым контрактом, не полной документацией FR-01–FR-16 |
| `fixtures.json` | 5 профилей/контекстов, 5 блоков, 15 заданий, рубрики и 10 ожидаемых сценариев для 4 типов запросов | использовать только как `DEMO` синтетику в contract/unit tests |
| `context-examples.json` | полные и частичные контексты, Evidence, BuildRequest, RoutePlan, отказ stale publish и PublicQuestion | позитивные и граничные contract fixtures |
| `validation-report.json` | 151 проверка структуры, примеров, ссылок и правил | исходное свидетельство качества комплекта; повторить после импорта, не считать тестом приложения |

## Подготовленная выборка VibeWork

Зафиксированный источник: commit `d301b694a584089ac9bb4bd59744bd7e30f7ec94`; выборка сделана из рабочей копии с незакоммиченными изменениями. В неё попали изменённые или неотслеживаемые `career_analysis.py`, `career_navigator.py`, `hh_filter.py`, `profile_analysis_context.py`, `recommendations.py`, `user_context.py`, `profile_files.py`, `test_profile_files.py`. Прямой перенос этих файлов без проверки запрещён.

| Группа из SOURCE_MANIFEST | Фактические пути в выборке | Потенциал переноса |
|---|---|---|
| Диагностика и профиль | `questionnaire_fields.py`, `services/user_pain_mapping.py`, `diagnostics.py`, `profile_analysis_context.py`, `assessment_routing.py`, `assessment_modules.py`, `aptitude_quiz_grading.py`, `user_context.py` | правила нормализации, ветвления, наборы вопросов и негативные случаи; переписать под типы 4.0 |
| Учебный каталог и маршрут | `website/data/learning_catalog.json`, `learning_paths.json`, `services/learning/`, `learning_pack.py`, `action_plans.py`, `llm_prompts.py`, `docs/LEARNING_INTEGRATIONS.md` | данные после provenance/license review; алгоритмы и fallback как идеи; старый AI-клиент не переносить |
| Направление и возможности | `career_navigator.py`, `recommendations.py`, `role_confirmation.py`, `career_analysis.py`, `career_analysis_school.py`, `career_analysis_vocational.py`, `hh_client.py`, `hh_filter.py`, `hh_web_link.py`, `job_search.py`, `mts_match.py`, `website/data/mts_role_matrix.json`, `website/app/mts_matrix.json` | ветка только для соответствующего типа; тестовые фильтры; demo-каталог после проверки |
| Практика и файлы | `workday_simulator.py`, `simulator_progress.py`, `profile_files.py` | сценарии практики и негативные file cases; хранение и runtime переписать |
| Регрессионные сценарии | все 10 файлов `tests/website/test_*.py` | извлечь fixtures, границы и expected outcomes; не переносить Python test suite |

Подробное решение `take / adapt / leave` для каждого файла находится в `docs/VIBEWORK_REUSE.md`. Контрольные суммы всей выборки находятся в `legacy/vibework_reference/SHA256SUMS`.

## Обнаруженные риски источника

- `test_learning_bridge.py` импортирует `GapBar` из отсутствующей в выборке старой схемы: тест нельзя считать переносимым готовым набором.
- Тест удаления аккаунта проверяет очистку `profile_files.owner_user_id`; в старом проекте он известен как падающий. Переносится требование владельца и каскадного удаления, не реализация.
- `website/data` в старом проекте был игнорируемым/неотслеживаемым организационным риском. В выборке JSON присутствует, но требует отдельного checksum, provenance и лицензирования.
- `user_pain_mapping.py` содержит восемь старых карьерных болей, тогда как ТЗ 4.0 задаёт четыре типа запроса. Нормативны четыре типа 4.0.
- Синтетические contracts fixtures не проходили проверку профориентолога или предметного эксперта.
