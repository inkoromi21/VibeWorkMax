# Отклонения и расширения контрактов

## CD-001 — статус инфраструктурной job

- **Источник:** `openapi-core.json`, комплект MAX 4.0.
- **Место:** перечень 17 paths и ответ `JobAccepted`.
- **Проблема:** исходный core-контракт намеренно не является полной OpenAPI и не задаёт endpoint/response для чтения статуса фоновой job.
- **Локальное решение:** исходные файлы не изменяются; `phase1-schemas.json` добавляет только инфраструктурные `JobState` и `JobStatusResponse`, а API предоставляет `GET /jobs/{jobId}`.
- **Риск:** потребители только исходного `openapi-core.json` не увидят расширение Фазы 1; перед публичной публикацией расширение должно войти в общую OpenAPI.

Других отклонений в импортированных JSON Schema на момент импорта не обнаружено.

## CD-004 — внутренний DiagnosticResult

- **Источник:** `openapi-core.json`, комплект MAX 4.0.
- **Проблема:** публичный `GET /diagnostic-sessions/{id}/result` в исходном контракте
  возвращает `DiagnosticContext`, но не описывает сохраняемый технический снимок
  результата с refs на question instances, answers и evidence.
- **Локальное решение:** `diagnostic_results` хранит внутренний типизированный
  `DiagnosticResult`, включающий воспроизводимый `DiagnosticContext`; исходная
  JSON Schema и её checksum не меняются.
- **Риск:** до обновления общего OpenAPI этот расширенный внутренний снимок не
  является опубликованным API-ответом.

## CD-005 — legacy profile completeness score

- **Источник:** legacy `services/diagnostics.py`.
- **Проблема:** legacy вычисляет процент полноты анкеты эвристически; актуальные
  contracts требуют evidence sufficiency, а не выдуманного процента знания.
- **Локальное решение:** процент не переносится. Результат использует только
  contract `CompetencyEstimate`, `MasteryPolicy` и сохранённые evidence refs.

## CD-003 — Mini app session boundary

- **Источник:** MAX Bridge и validation documentation, требования Фазы 3.
- **Проблема:** стартовый `openapi-core.json` содержит только доменные маршруты 4.0 и не описывает transport-boundary для `initData`, HttpOnly cookie или CSRF token.
- **Локальное решение:** API добавляет изолированные `/mini-app/*` endpoints; они принимают только исходную строку `initData`, не передают bot token клиенту и возвращают CSRF token только после создания серверной сессии. Расширение должно быть внесено в общую public OpenAPI перед внешней публикацией.
- **Риск:** пока расширение не включено в исходный immutable комплект, внешние клиенты не должны считать его опубликованным контрактом.

## CD-002 — inbound MAX Update identifier

- **Источник:** публичная документация MAX Update и webhook subscription.
- **Проблема:** документация на момент проверки описывает `update_type`, но не
  фиксирует единый стабильный ID для каждого webhook delivery.
- **Локальное решение:** parser принимает явные `event_id`/`update_id` в
  тестовых или будущих официальных fixtures. При их отсутствии он создаёт
  локальный fingerprint только для disabled/mock режима; `MAX_MODE=enabled`
  отклоняет такой Update до получения официального поля.
- **Риск:** production exactly-once delivery нельзя заявлять до закрытия MI-042.
