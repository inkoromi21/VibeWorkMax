import {
  DisabledNotificationTransport,
  dispatchOutboxBatch,
  MemoryNotificationTransport,
  consentPolicyFromEnvironment,
} from '@vibework/domain';
import { createLogger } from '@vibework/shared';
import Fastify from 'fastify';
import { Redis } from 'ioredis';
import { Pool } from 'pg';
import { createJobWorker } from './jobs.js';
import { DisabledBotReplyTransport, gradeAttempt, processMaxUpdate } from './max-bot.js';

export { createJobWorker };

if (process.env.NODE_ENV !== 'test') {
  const logger = createLogger();
  const connection = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379', {
    maxRetriesPerRequest: null,
  });
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const jobs = createJobWorker(connection, logger, {
    processMaxUpdate: async (eventId) =>
      processMaxUpdate(
        pool,
        eventId,
        new DisabledBotReplyTransport(),
        consentPolicyFromEnvironment(),
      ),
    processAttemptGrade: async (reference) => gradeAttempt(pool, reference),
  });
  const transport =
    process.env.NODE_ENV !== 'production' && process.env.NOTIFICATION_MODE === 'mock'
      ? new MemoryNotificationTransport()
      : new DisabledNotificationTransport();
  let dispatching = false;
  const dispatch = async () => {
    if (dispatching) return;
    dispatching = true;
    try {
      await dispatchOutboxBatch(pool, transport, `worker-${String(process.pid)}`);
    } catch (error) {
      logger.error({ err: error }, 'outbox dispatch failed');
    } finally {
      dispatching = false;
    }
  };
  const outboxTimer = setInterval(() => void dispatch(), 1_000);
  void dispatch();
  const health = Fastify({ loggerInstance: logger });
  health.get('/health', () => ({ status: jobs.worker.isRunning() ? 'ok' : 'starting' }));
  await health.listen({
    host: process.env.WORKER_HEALTH_HOST ?? '0.0.0.0',
    port: Number(process.env.WORKER_HEALTH_PORT ?? 3001),
  });

  const close = async () => {
    await health.close();
    clearInterval(outboxTimer);
    await jobs.close();
    await pool.end();
    connection.disconnect();
    process.exit(0);
  };
  process.once('SIGTERM', () => void close());
  process.once('SIGINT', () => void close());
}
