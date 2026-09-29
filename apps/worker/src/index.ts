import {
  DisabledNotificationTransport,
  dispatchOutboxBatch,
  MemoryNotificationTransport,
  consentPolicyFromEnvironment,
  PostgresLearningRepository,
} from '@vibework/domain';
import { assertMaxIdentityEncryptionKey, createLogger } from '@vibework/shared';
import Fastify from 'fastify';
import { Redis } from 'ioredis';
import { Pool } from 'pg';
import { createJobWorker } from './jobs.js';
import {
  DisabledBotReplyTransport,
  dispatchPendingBotReplies,
  gradeAttempt,
  processMaxUpdate,
} from './max-bot.js';
import { MaxBotReplyTransport } from './max-reply-transport.js';
import { MaxNotificationTransport } from './max-notification-transport.js';
import { MaxApiClient } from '../../api/src/max-client.js';
import { createWorkerAiOperations } from './ai.js';

export { createJobWorker };

if (process.env.NODE_ENV !== 'test') {
  const logger = createLogger();
  const connection = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379', {
    maxRetriesPerRequest: null,
  });
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const botReplyTransport = createBotReplyTransport(logger);
  const ai = createWorkerAiOperations(pool);
  const jobs = createJobWorker(connection, logger, {
    checkAiAdmission: async (type, reference) => {
      const attempt =
        type === 'attempt.grade' ? await loadAttemptFeedbackInput(pool, reference) : null;
      if (type === 'attempt.grade' && !attempt) throw new Error('ATTEMPT_NOT_FOUND');
      return ai.operations.canAdmit({
        templateId: type === 'course.build' ? 'lesson' : 'feedback',
        approvedContext:
          type === 'course.build'
            ? { learningBlockIds: ['demo-learning-block-v1'], referenceIds: [], urls: [] }
            : (attempt?.approvedContext ?? { rubricVersionIds: [], referenceIds: [], urls: [] }),
        userInput: attempt?.userInput ?? { reference },
        modelPolicy: ai.modelPolicy,
      });
    },
    processMaxUpdate: async (eventId) =>
      processMaxUpdate(pool, eventId, botReplyTransport, consentPolicyFromEnvironment()),
    processAttemptGrade: async (reference) => {
      const attempt = await loadAttemptFeedbackInput(pool, reference);
      if (!attempt) throw new Error('ATTEMPT_NOT_FOUND');
      const feedback = await ai.operations.execute({
        templateId: 'feedback',
        approvedContext: attempt.approvedContext,
        userInput: attempt.userInput,
        domainContext: { allowedIds: [attempt.rubricVersion], allowedUrls: [] },
        operationIdentity: `attempt-grade:${reference}`,
        modelPolicy: ai.modelPolicy,
      });
      await gradeAttempt(pool, reference, feedback);
    },
    processCourseBuild: async (reference) => {
      if (!reference.startsWith('goal:')) throw new Error('INVALID_COURSE_BUILD_REFERENCE');
      const lesson = await ai.operations.execute({
        templateId: 'lesson',
        approvedContext: {
          learningBlockIds: ['demo-learning-block-v1'],
          referenceIds: [],
          urls: [],
        },
        userInput: { reference },
        domainContext: { allowedIds: ['demo-learning-block-v1'], allowedUrls: [] },
        operationIdentity: `course-build:${reference}`,
        modelPolicy: ai.modelPolicy,
      });
      await new PostgresLearningRepository(pool).buildAndPublishForActor(
        reference.slice('goal:'.length),
        lesson,
      );
    },
  });
  const transport =
    process.env.NODE_ENV !== 'production' && process.env.NOTIFICATION_MODE === 'mock'
      ? new MemoryNotificationTransport()
      : process.env.MAX_MODE === 'enabled' && botReplyTransport instanceof MaxBotReplyTransport
        ? new MaxNotificationTransport(pool, botReplyTransport)
        : new DisabledNotificationTransport();
  let dispatching = false;
  const dispatch = async () => {
    if (dispatching) return;
    dispatching = true;
    try {
      await dispatchOutboxBatch(pool, transport, `worker-${String(process.pid)}`);
      await jobs.dispatchTransitionOutbox(pool);
      await jobs.dispatchAttemptGradeOutbox(pool);
      if (process.env.MAX_MODE === 'enabled')
        await dispatchPendingBotReplies(pool, botReplyTransport);
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
  const healthHost = process.env.WORKER_HEALTH_HOST ?? '127.0.0.1';
  await health.listen({
    host: healthHost,
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

async function loadAttemptFeedbackInput(pool: Pool, reference: string) {
  if (!reference.startsWith('attempt:')) return null;
  const result = await pool.query<{
    rubric_version: string;
    assistance_level: 'NONE' | 'HINT' | 'SOLUTION';
    answer_payload: { text?: string };
    rubric_payload: { criteria?: unknown };
  }>(
    `SELECT a.rubric_version,a.assistance_level,a.answer_payload,c.payload AS rubric_payload
     FROM attempts a JOIN content_catalog_versions c ON c.id::text=a.rubric_version
     WHERE a.id=$1`,
    [reference.slice('attempt:'.length)],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    rubricVersion: row.rubric_version,
    approvedContext: {
      rubricVersionIds: [row.rubric_version],
      criteria: row.rubric_payload.criteria ?? [],
      referenceIds: [],
      urls: [],
    },
    userInput: {
      answer: row.answer_payload.text ?? '',
      assistanceLevel: row.assistance_level,
    },
  };
}

function createBotReplyTransport(logger: ReturnType<typeof createLogger>) {
  if (process.env.MAX_MODE !== 'enabled') return new DisabledBotReplyTransport();
  const token = process.env.MAX_BOT_TOKEN;
  const encryptionKey = process.env.MAX_IDENTITY_ENCRYPTION_KEY;
  try {
    if (!token) throw new Error('MAX_BOT_TOKEN is required');
    assertMaxIdentityEncryptionKey(encryptionKey);
    return new MaxBotReplyTransport(new MaxApiClient(token), encryptionKey);
  } catch {
    // Do not include any environment value or provider identity in this log.
    logger.error('MAX reply transport unavailable: configuration is incomplete or invalid');
    throw new Error('MAX_REPLY_TRANSPORT_CONFIGURATION_INVALID');
  }
}
