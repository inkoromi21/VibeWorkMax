import { validateContract } from '@vibework/contracts';
import {
  ApplicationError,
  createLogger,
  normalizeIdempotencyKey,
  normalizeTraceId,
  runWithTrace,
  statusCodeFor,
  toApiError,
  type TraceId,
} from '@vibework/shared';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { Redis } from 'ioredis';
import { Pool } from 'pg';
import { JobService } from './jobs.js';
import {
  MemoryMaxWebhookStore,
  NoopMaxWebhookMetrics,
  assertMaxWebhookConfiguration,
  parseMaxUpdate,
  PostgresMaxWebhookStore,
  verifyMaxWebhookSecret,
  type MaxWebhookMetrics,
  type MaxWebhookStore,
} from './max-webhook.js';
import {
  MemoryMiniAppStore,
  PostgresMiniAppStore,
  registerMiniAppRoutes,
  type MiniAppStore,
} from './mini-app.js';

declare module 'fastify' {
  interface FastifyRequest {
    traceId: TraceId;
  }
}

export interface ServerOptions {
  redisUrl?: string;
  registerJobs?: boolean;
  maxWebhookSecret?: string;
  webhookStore?: MaxWebhookStore;
  databaseUrl?: string;
  webhookEnqueuer?: {
    enqueueMaxUpdate(input: { eventId: string; traceId: TraceId }): Promise<void>;
  };
  webhookMetrics?: MaxWebhookMetrics;
  miniAppStore?: MiniAppStore;
  /** Production registration is blocked until MAX confirms an Update event ID. */
  requireMaxProviderEventId?: boolean;
}

export function buildServer(options: ServerOptions = {}): FastifyInstance {
  const app = Fastify({ loggerInstance: createLogger() as unknown as FastifyBaseLogger });
  app.decorateRequest('traceId');
  void app.register(cookie);

  app.addHook('onRequest', (request, _reply, done) => {
    const incoming = request.headers['x-request-id'];
    request.traceId = normalizeTraceId(typeof incoming === 'string' ? incoming : undefined);
    runWithTrace({ traceId: request.traceId }, done);
  });

  app.addHook('onSend', (request, reply, _payload, done) => {
    void reply.header('x-request-id', request.traceId);
    done();
  });

  app.setErrorHandler((error, request, reply) => {
    const response = toApiError(error, request.traceId);
    if (!validateContract('ApiError', response).valid) {
      request.log.error({ code: response.code }, 'invalid ApiError serialization');
    }
    void reply.status(statusCodeFor(error)).send(response);
  });

  app.get('/health', () => ({ status: 'ok' }));

  let jobs: JobService | undefined;
  let miniAppStore = options.miniAppStore ?? new MemoryMiniAppStore();
  let webhookStore = options.webhookStore;
  if (options.registerJobs ?? true) {
    const redis = new Redis(options.redisUrl ?? process.env.REDIS_URL ?? 'redis://127.0.0.1:6379', {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    const jobService = new JobService(redis);
    jobs = jobService;
    const pool = new Pool({ connectionString: options.databaseUrl ?? process.env.DATABASE_URL });
    if (!options.miniAppStore) miniAppStore = new PostgresMiniAppStore(pool);
    webhookStore ??= new PostgresMaxWebhookStore(pool);
    app.addHook('onClose', async () => {
      await jobs?.close();
      await pool.end();
      redis.disconnect();
    });

    app.get<{ Params: { jobId: string } }>('/jobs/:jobId', async (request) =>
      jobService.status(request.params.jobId),
    );

    if (process.env.NODE_ENV !== 'production') {
      app.post<{
        Body: { mode?: 'success' | 'transient' | 'timeout'; timeout_ms?: number } | undefined;
      }>('/internal/jobs/probe', async (request, reply) => {
        const key = normalizeIdempotencyKey(request.headers['idempotency-key']);
        const mode = request.body?.mode ?? 'success';
        if (!['success', 'transient', 'timeout'].includes(mode)) {
          throw new ApplicationError({
            code: 'INVALID_JOB_MODE',
            message: 'Некорректный режим probe job',
            statusCode: 422,
          });
        }
        const accepted = await jobService.enqueueProbe({
          mode,
          idempotencyKey: key,
          traceId: request.traceId,
          ...(request.body?.timeout_ms === undefined ? {} : { timeoutMs: request.body.timeout_ms }),
        });
        return reply.status(202).send(accepted);
      });
    }
  }

  webhookStore ??= new MemoryMaxWebhookStore();
  void app.register(registerMiniAppRoutes, {
    store: miniAppStore,
    ...(process.env.MAX_BOT_TOKEN === undefined ? {} : { botToken: process.env.MAX_BOT_TOKEN }),
    allowDevAuth:
      process.env.MINI_APP_DEV_AUTH === 'enabled' && process.env.NODE_ENV !== 'production',
  });
  app.post('/webhooks/max', async (request, reply) => {
    const startedAt = performance.now();
    const metrics = options.webhookMetrics ?? new NoopMaxWebhookMetrics();
    const secret = request.headers['x-max-bot-api-secret'];
    if (process.env.MAX_MODE === 'enabled') {
      assertMaxWebhookConfiguration({
        ...(process.env.PUBLIC_BASE_URL === undefined
          ? {}
          : { publicBaseUrl: process.env.PUBLIC_BASE_URL }),
        ...(process.env.MAX_WEBHOOK_SECRET === undefined
          ? {}
          : { secret: process.env.MAX_WEBHOOK_SECRET }),
        ...(process.env.MAX_BOT_TOKEN === undefined ? {} : { token: process.env.MAX_BOT_TOKEN }),
      });
    }
    if (
      !verifyMaxWebhookSecret(
        typeof secret === 'string' ? secret : undefined,
        options.maxWebhookSecret ?? process.env.MAX_WEBHOOK_SECRET,
      )
    ) {
      metrics.increment('rejected');
      throw new ApplicationError({
        code: 'INVALID_MAX_WEBHOOK_SECRET',
        message: 'Недопустимая подпись webhook',
        statusCode: 401,
      });
    }
    const enqueuer = jobs ?? options.webhookEnqueuer;
    if (!enqueuer)
      throw new ApplicationError({
        code: 'MAX_WEBHOOK_DISABLED',
        message: 'Webhook временно недоступен',
        statusCode: 503,
        retryable: true,
      });
    const update = parseMaxUpdate(request.body);
    const requireProviderEventId =
      options.requireMaxProviderEventId ?? process.env.MAX_MODE === 'enabled';
    if (requireProviderEventId && !update.hasProviderEventId) {
      metrics.increment('rejected');
      throw new ApplicationError({
        code: 'MAX_PROVIDER_EVENT_ID_UNCONFIRMED',
        message: 'Webhook ожидает подтверждённый идентификатор события',
        statusCode: 503,
        retryable: true,
      });
    }
    // `persist` commits both the inbound event and a durable job-outbox record.
    const persisted = await webhookStore.persist(update);
    try {
      if (persisted.needsQueue) {
        await enqueuer.enqueueMaxUpdate({ eventId: update.eventId, traceId: request.traceId });
        await webhookStore.markQueued(update.eventId);
      }
    } catch (error) {
      metrics.increment('queue_failed');
      // The next delivery can claim the still-pending outbox record safely.
      throw error;
    } finally {
      metrics.observeLatencyMs(performance.now() - startedAt);
    }
    metrics.increment(persisted.inserted ? 'accepted' : 'duplicate');
    return reply.status(200).send({ accepted: true, duplicate: !persisted.inserted });
  });

  return app;
}
