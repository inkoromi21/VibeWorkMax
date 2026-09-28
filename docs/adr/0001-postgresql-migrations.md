# ADR-0001: PostgreSQL migrations через node-pg-migrate

## Решение

Использовать `node-pg-migrate` и последовательные миграции в `migrations`.
PostgreSQL является единственной поддерживаемой продуктовой БД.

## Причины

- SQL constraints, indexes и transactional DDL остаются явными;
- инструмент не навязывает ORM;
- есть повторяемый `up`, локальный `down` и журнал миграций.

## Альтернативы

Prisma Migrate и Drizzle Kit потребовали бы преждевременного ORM/query-builder
решения. Ручные SQL-скрипты не дают достаточного журнала применения.

## Trade-offs и восстановление

Миграции требуют Node runtime и проверки на чистом PostgreSQL. В production
используется additive roll-forward/compensating migration. Скрипт
`migrate:down:local-test` разрешён только для локальных и одноразовых тестовых
БД; его имя намеренно не выглядит как безопасная production-команда.
