# VibeWork MAX

Минимальный TypeScript monorepo для web, Fastify API, BullMQ worker и общих
контрактов/доменной инфраструктуры. Фаза 1 не подключает внешние production API
и не переносит Python runtime старого VibeWork.

## Требования

- Node.js 22 или новее;
- pnpm 11.19.0;
- Docker Engine с Docker Compose для PostgreSQL, Redis, MinIO и ClamAV;
- свободный порт 8080 для локального proxy.

## Установка

```sh
pnpm install --frozen-lockfile
cp .env.example .env
```

`.env.example` содержит только локальные или disabled значения. Реальные
credentials не должны попадать в репозиторий, images или логи.

## Команды

```sh
pnpm --filter @vibework/web dev       # web
pnpm --filter @vibework/api dev       # API
pnpm --filter @vibework/worker dev    # worker
pnpm build                            # production build всех workspaces
pnpm typecheck                        # strict TypeScript
pnpm lint                             # ESLint
pnpm format:check                     # Prettier check
pnpm test                             # unit/contract tests
pnpm test:integration                 # ephemeral PostgreSQL + Redis через Docker
pnpm contracts:generate               # generated TS из JSON Schema
pnpm contracts:check                  # checksums, schemas и OpenAPI
pnpm migrate                          # PostgreSQL migrations up
pnpm migrate:down:local-test          # только local/test: разрушительный откат 007→002
pnpm check:deps                       # циклические imports
```

## Docker

Облегчённый профиль не запускает ClamAV:

```sh
docker compose --profile lightweight up --build --wait
```

Production-shaped профиль включает ClamAV, но внешние integrations остаются
disabled до получения настоящей конфигурации через секрет-хранилище:

```sh
docker compose --profile production up --build --wait
```

После проверки: `docker compose --profile lightweight --profile production down`.
Named volumes сохраняют PostgreSQL, Redis, MinIO и ClamAV signatures.

## Карта каталогов

### Applications

- `apps/web` — минимальный React/Vite mini-app каркас;
- `apps/api` — Fastify HTTP boundary, безопасные ошибки и BullMQ producer/status;
- `apps/worker` — BullMQ consumer, health endpoint и outbox dispatcher.

### Packages

- `packages/contracts` — неизменённые контракты MAX 4.0, Ajv validators и generated types;
- `packages/domain` — PostgreSQL transactional outbox и минимальный goal repository scenario;
- `packages/content` — граница будущего versioned content layer;
- `packages/ai` — vendor-neutral AI provider port, deterministic fake и server-side Yandex AI Studio adapter; без credentials adapter disabled;
- `packages/shared` — IDs, errors, trace, idempotency, logging и job primitives.

### Infrastructure

- `migrations` — единственный источник PostgreSQL-схемы (`node-pg-migrate`);
- `compose.yaml`, `Dockerfile`, `docker/` — локальный stack и reverse proxy;
- `tests/integration` — проверки реальных PostgreSQL/Redis/BullMQ boundaries;
- `legacy/vibework_reference` — только читаемый источник идей, не runtime dependency.

## HTTP infrastructure

- `GET /health`;
- `GET /jobs/{jobId}`;
- `POST /internal/jobs/probe` — только при `NODE_ENV != production`.

API возвращает `x-request-id`; тот же trace ID переносится в job envelope. Ошибки
соответствуют контракту `ApiError` и не раскрывают stack или внутреннюю причину.

## MAX bot (локальный / disabled режим)

- `POST /webhooks/max` принимает только подписанные события, сохраняет минимальный
  payload до `200` и передаёт обработку в BullMQ;
- внешний MAX transport выключен, пока не предоставлены токен, webhook secret,
  публичный HTTPS URL и утверждённые правовые тексты/возрастные правила;
- бот хранит состояние диалога, версии проблемы, ответы, попытки, цели и
  уведомления в PostgreSQL. Логи не содержат входной текст, payload или секреты.

## Данные и безопасность

SQLite запрещён. Outbox использует `FOR UPDATE SKIP LOCKED`, `event_id` как
idempotency key и безопасные payload. Analytics принимает только allowlisted
обезличенные поля. MAX/Yandex/production S3/analytics adapters выключены до
получения входных данных, перечисленных в `docs/MISSING_INPUTS.md`.
