# Model benchmark report

- Status: **BLOCKED_EXTERNAL_INPUT**
- Dataset: `model-policy-eval-v1` / `v1`
- Prompt templates: `v1`
- Run count: 2
- Provider: `yandex-ai-studio`
- Actual AI spend: not measured

## Models

| Model | URI state | Note |
| --- | --- | --- |
| Alice AI LLM Flash | UNAVAILABLE | Missing YANDEX_MODEL_ALICE_FLASH_URI; account/catalog access is unconfirmed. |
| Alice AI LLM | UNAVAILABLE | Missing YANDEX_MODEL_ALICE_URI; account/catalog access is unconfirmed. |
| YandexGPT Pro 5.1 | UNAVAILABLE | Missing YANDEX_MODEL_YANDEXGPT_PRO_5_1_URI; account/catalog access is unconfirmed. |

## Rejection thresholds

- schema validity: 1
- domain validity: 1
- source fidelity: 1
- median latency: 15000 ms

## Metrics

- Schema validity, domain validity, source fidelity, latency, input/output token usage, and cost are recorded per invocation and aggregated by model and operation.
- Rubric agreement and quality are `NOT_MEASURABLE` until an approved rubric is supplied; no substitute quality score is invented.

## Blocked external inputs

- YANDEX_AI_MODE must be enabled.
- Missing YANDEX_FOLDER_ID.
- Missing YANDEX_API_KEY.
- Missing DATABASE_URL required by the Prompt 37 budget ledger.
- At least one required benchmark model URI is absent; unavailable models are not substituted.
- All model URIs need account/catalog confirmation in BENCHMARK_CONFIRMED_MODEL_URIS.
- Missing positive BENCHMARK_TEST_BUDGET.
- Missing AI_PRICING_CONFIG_JSON.
- Prompt 37 budget guard must be enabled with operation and daily limits.

## Rejected configurations

- All live configurations were rejected before provider invocation because the required external inputs were incomplete.

## ModelPolicy

No live model was called and no winner or ModelPolicy was selected.
