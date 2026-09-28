# AI provider: подтверждённые границы и отклонения

## Подтверждённая интеграция

Адаптер использует заданный OpenAI-compatible base URL `https://ai.api.cloud.yandex.net/v1/` и endpoint `chat/completions`. Заголовки запроса: `Authorization: Api-Key …`, `x-folder-id` и `x-data-logging-enabled: false`; тело содержит `store: false`.

URI моделей не зашиты: нужны `YANDEX_MODEL_ALICE_FLASH_URI` и/или `YANDEX_MODEL_ALICE_URI`. Это исключает ложное предположение о доступе к Alice AI LLM Flash либо Alice AI LLM конкретному аккаунту.

## Отклонение от исходной формулировки

В исходном реестре до этой фазы использовались имена `YANDEX_AI_FOLDER_ID`, `YANDEX_AI_API_KEY` и один `YANDEX_AI_MODEL_ID`. Они заменены на требуемые в текущей задаче `YANDEX_FOLDER_ID`, `YANDEX_API_KEY` и два URI моделей. Обратная совместимость намеренно не добавлена: отсутствие одной из новых переменных оставляет adapter в безопасном disabled состоянии.

Проверка живого API не выполнялась: отсутствуют folder ID, API key и подтверждение доступа к обеим моделям. Contract tests используют только локальный mock `fetch`.
