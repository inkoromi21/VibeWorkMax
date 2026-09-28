import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { JobService } from '../../apps/api/src/jobs.js';
import { buildServer } from '../../apps/api/src/server.js';
import { createJobWorker } from '../../apps/worker/src/jobs.js';
import {
  MemoryNotificationTransport,
  PostgresAiUsageLedger,
  PostgresDiagnosticSessionRepository,
  PostgresProblemDiagnosticRepository,
  classifyProblem,
  dispatchOutboxBatch,
  recordGoalDecision,
} from '../../packages/domain/dist/index.js';
import { demoDiagnosticCatalog } from '../../packages/content/dist/index.js';
import {
  createLogger,
  newUuid,
  type TraceId,
  type UserId,
} from '../../packages/shared/dist/index.js';
import { Redis } from 'ioredis';
import { Pool } from 'pg';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url));
let postgres: StartedTestContainer;
let redisContainer: StartedTestContainer;
let databaseUrl: string;
let redisUrl: string;
let pool: Pool;
let postgresStarted = false;
let redisStarted = false;
let poolStarted = false;

function migrate(command = 'migrate'): void {
  execFileSync('pnpm', [command], {
    cwd: root,
    env: { ...process.env, CI: 'true', DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });
}

async function waitUntil<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (accept(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('condition timeout');
}

beforeAll(async () => {
  postgres = await new GenericContainer('postgres:17.6-alpine')
    .withEnvironment({
      POSTGRES_DB: 'phase1',
      POSTGRES_USER: 'phase1',
      POSTGRES_PASSWORD: 'phase1',
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/))
    .start();
  postgresStarted = true;
  redisContainer = await new GenericContainer('redis:7.4.5-alpine')
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
    .start();
  redisStarted = true;
  databaseUrl = `postgresql://phase1:phase1@${postgres.getHost()}:${String(postgres.getMappedPort(5432))}/phase1`;
  redisUrl = `redis://${redisContainer.getHost()}:${String(redisContainer.getMappedPort(6379))}`;
  pool = new Pool({ connectionString: databaseUrl });
  poolStarted = true;
  migrate();
});

afterAll(async () => {
  if (poolStarted) await pool.end();
  if (redisStarted) await redisContainer.stop();
  if (postgresStarted) await postgres.stop();
});

describe('PostgreSQL migrations', () => {
  it('creates required tables, owner indexes, constraints and is repeatable', async () => {
    migrate();
    const tables = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    const names = new Set(tables.rows.map((row) => row.table_name));
    for (const table of [
      'users',
      'sessions',
      'profile_versions',
      'problems',
      'problem_versions',
      'goals',
      'consents',
      'idempotency_keys',
      'decision_events',
      'audit_events',
      'notification_outbox',
      'max_webhook_events',
      'max_webhook_job_outbox',
      'max_user_identities',
      'bot_callback_tokens',
      'bot_reply_outbox',
      'bot_transition_job_outbox',
      'bot_reviews',
      'bot_disputes',
      'classification_decisions',
      'diagnostic_sessions',
      'diagnostic_question_instances',
      'diagnostic_answer_submissions',
      'diagnostic_evidence_records',
      'diagnostic_results',
      'ai_budget_days',
      'ai_usage_ledger',
    ])
      expect(names.has(table)).toBe(true);
    const indexes = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`,
    );
    expect(indexes.rows.map((row) => row.indexname)).toContain('goals_user_id_idx');
    expect(indexes.rows.map((row) => row.indexname)).toContain('max_webhook_job_outbox_ready_idx');
    const userId = newUuid<UserId>();
    await pool.query('INSERT INTO users(id) VALUES ($1)', [userId]);
    await pool.query(
      `INSERT INTO consents(id, user_id, consent_type, document_version, granted, occurred_at) VALUES ($1,$2,'privacy','v1',true,now())`,
      [crypto.randomUUID(), userId],
    );
    await expect(
      pool.query(
        `INSERT INTO consents(id, user_id, consent_type, document_version, granted, occurred_at) VALUES ($1,$2,'privacy','v1',true,now())`,
        [crypto.randomUUID(), userId],
      ),
    ).rejects.toThrow();
  });

  it('supports local down and forward recovery', async () => {
    migrate('migrate:down:local-test');
    const absent = await pool.query<{ name: string | null }>(
      `SELECT to_regclass('public.diagnostic_sessions') AS name`,
    );
    expect(absent.rows[0]?.name).toBeNull();
    migrate();
    const restored = await pool.query<{ name: string | null }>(
      `SELECT to_regclass('public.diagnostic_sessions') AS name`,
    );
    expect(restored.rows[0]?.name).toBe('diagnostic_sessions');
  });
});

describe('AI usage ledger', () => {
  const request = {
    operationKind: 'lesson',
    promptVersion: 'lesson-v1',
    // Fits the declared 10-token input ceiling under the conservative UTF-8 estimator.
    prompt: 'lesson',
    deadlineMs: 1_000,
    maxInputTokens: 10,
    maxOutputTokens: 10,
    modelPolicy: { allowedModels: ['fake/model-v1'] },
  };
  const pricing = {
    version: 'integration-pricing-v1',
    currency: 'RUB',
    models: [
      {
        provider: 'fake',
        model: 'fake/model-v1',
        inputPerMillion: 100_000,
        outputPerMillion: 100_000,
      },
    ],
  };
  const policy = { mode: 'enabled' as const, maxOperationCost: 2.5, dailyAiBudget: 3 };

  it('atomically reserves, deduplicates retries, enforces limits, and reconciles actual usage', async () => {
    const ledger = new PostgresAiUsageLedger(pool, pricing, policy);
    const [left, right] = await Promise.all([
      ledger.preflight({ request, provider: 'fake', operationIdentity: 'ledger-concurrent-left' }),
      ledger.preflight({ request, provider: 'fake', operationIdentity: 'ledger-concurrent-right' }),
    ]);
    const first = left.kind === 'RESERVED' ? left : right;
    expect(first.kind).toBe('RESERVED');
    expect([left, right].find((outcome) => outcome.kind === 'DENIED')).toMatchObject({
      reason: 'DAILY_LIMIT',
    });
    await expect(
      ledger.preflight({
        request,
        provider: 'fake',
        operationIdentity: first.entry.operationIdentity,
      }),
    ).resolves.toMatchObject({ kind: 'EXISTING', entry: { id: first.entry.id } });
    await ledger.reconcile({
      entryId: first.entry.id,
      provider: 'fake',
      result: {
        value: {},
        model: 'fake/model-v1',
        providerRequestId: 'provider-1',
        latencyMs: 1,
        metadata: {},
        cost: { amount: null, currency: null },
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      },
    });
    await expect(
      ledger.preflight({
        request: { ...request, maxInputTokens: 30, maxOutputTokens: 30 },
        provider: 'fake',
        operationIdentity: 'ledger-operation-limit',
      }),
    ).resolves.toMatchObject({ kind: 'DENIED', reason: 'OPERATION_LIMIT' });
    const entry = await pool.query<{
      status: string;
      actual_cost: string;
      input_tokens: number;
      output_tokens: number;
    }>('SELECT status,actual_cost,input_tokens,output_tokens FROM ai_usage_ledger WHERE id=$1', [
      first.entry.id,
    ]);
    expect(entry.rows[0]).toMatchObject({
      status: 'SUCCEEDED',
      actual_cost: '0.20000000',
      input_tokens: 1,
      output_tokens: 1,
    });
    const audit = await pool.query<{ action: string }>(
      "SELECT action FROM audit_events WHERE action='AI_BUDGET_DENIED'",
    );
    expect(audit.rowCount).toBeGreaterThanOrEqual(2);
  });
});

describe('canonical diagnostic persistence', () => {
  it('persists provenance without raw text and enforces ownership, consent, and hard limits', async () => {
    const userId = newUuid<UserId>();
    const otherUserId = newUuid<UserId>();
    await pool.query('INSERT INTO users(id) VALUES ($1),($2)', [userId, otherUserId]);
    const created = await new PostgresProblemDiagnosticRepository(pool).createConfirmedSession({
      userId,
      rawText: 'не понимаю дроби',
      classification: classifyProblem('не понимаю дроби'),
      profile: { educationTrack: 'student' },
      traceId: 'trace-diagnostic-1',
    });
    const audit = await pool.query<{ metadata: Record<string, unknown> }>(
      'SELECT metadata FROM decision_events WHERE event_id=$1',
      [created.classificationEventId],
    );
    expect(JSON.stringify(audit.rows[0]?.metadata)).not.toContain('дроби');
    const persisted = await pool.query<{ snapshot: Record<string, unknown> }>(
      'SELECT snapshot FROM diagnostic_sessions WHERE id=$1',
      [created.sessionId],
    );
    expect(JSON.stringify(persisted.rows[0]?.snapshot)).not.toContain('дроби');
    const sessions = new PostgresDiagnosticSessionRepository(pool);
    const issue = () =>
      sessions.issueNextQuestion({
        sessionId: created.sessionId,
        userId,
        catalog: demoDiagnosticCatalog,
        seed: 'integration-selector-seed',
      });
    await issue();
    await expect(
      sessions.saveAnswer({
        sessionId: created.sessionId,
        userId: otherUserId,
        kind: 'TEXT',
        value: 'cross-user',
      }),
    ).rejects.toThrow('not found');
    for (let index = 0; index < 8; index += 1) {
      await sessions.saveAnswer({
        sessionId: created.sessionId,
        userId,
        kind: 'TEXT',
        value: `answer-${String(index)}`,
        ...(index === 0 ? { assistanceReported: 'SOLUTION' as const } : {}),
      });
      if (index < 7) await issue();
    }
    await expect(
      sessions.saveAnswer({
        sessionId: created.sessionId,
        userId,
        kind: 'TEXT',
        value: 'too-soon',
      }),
    ).rejects.toThrow('consent');
    await sessions.grantAdditionalConsent({ sessionId: created.sessionId, userId });
    for (let index = 8; index < 12; index += 1) {
      await issue();
      await sessions.saveAnswer({
        sessionId: created.sessionId,
        userId,
        kind: 'TEXT',
        value: `answer-${String(index)}`,
      });
    }
    await expect(
      sessions.saveAnswer({
        sessionId: created.sessionId,
        userId,
        kind: 'TEXT',
        value: 'thirteenth',
      }),
    ).rejects.toThrow('hard');
    const finished = await sessions.finish({
      sessionId: created.sessionId,
      userId,
      policies: [],
      stoppingReason: 'HARD_LIMIT',
      evaluatedAt: '2026-09-27T00:00:00.000Z',
    });
    expect(finished.result.status).toBe('COMPLETED_PARTIAL');
    const disclosed = await pool.query<{ disclosed: boolean }>(
      `SELECT disclosed FROM diagnostic_evidence_records
       WHERE session_id=$1 AND evidence->>'assistance_level'='SOLUTION'`,
      [created.sessionId],
    );
    expect(disclosed.rows).toEqual([{ disclosed: true }]);
    const reassessmentSessionId = await sessions.reassess({
      sessionId: created.sessionId,
      userId,
      sessionIdForReassess: newUuid(),
    });
    expect(reassessmentSessionId).not.toBe(created.sessionId);
    const lineage = await pool.query<{
      parent_session_id: string;
      parent_result_id: string;
      status: string;
    }>('SELECT parent_session_id,parent_result_id,status FROM diagnostic_sessions WHERE id=$1', [
      reassessmentSessionId,
    ]);
    expect(lineage.rows[0]).toMatchObject({
      parent_session_id: created.sessionId,
      parent_result_id: finished.resultId,
      status: 'IN_PROGRESS',
    });
    await sessions.issueNextQuestion({
      sessionId: reassessmentSessionId,
      userId,
      catalog: demoDiagnosticCatalog,
      seed: 'reassess-selector-seed',
    });
    await sessions.saveAnswer({
      sessionId: reassessmentSessionId,
      userId,
      kind: 'DONT_KNOW',
      value: null,
    });
    const reassessed = await sessions.finish({
      sessionId: reassessmentSessionId,
      userId,
      policies: [],
      stoppingReason: 'USER_FINISHED',
      evaluatedAt: '2026-09-27T00:00:01.000Z',
    });
    expect(reassessed.resultId).not.toBe(finished.resultId);
    const reassessedResult = await pool.query<{ previous_result_id: string }>(
      'SELECT previous_result_id FROM diagnostic_results WHERE id=$1',
      [reassessed.resultId],
    );
    expect(reassessedResult.rows[0]?.previous_result_id).toBe(finished.resultId);
    const originalResult = await pool.query<{ payload: { status: string } }>(
      'SELECT payload FROM diagnostic_results WHERE id=$1',
      [finished.resultId],
    );
    expect(originalResult.rows[0]?.payload.status).toBe('COMPLETED_PARTIAL');
  });
});

describe('BullMQ infrastructure', () => {
  it('handles success, retry, timeout, dead letter, manual retry and deduplication', async () => {
    const producerRedis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
    const workerRedis = new Redis(redisUrl, { maxRetriesPerRequest: null });
    const jobs = new JobService(producerRedis);
    const consumer = createJobWorker(workerRedis, createLogger());
    const traceId = newUuid<TraceId>();

    const success = await jobs.enqueueProbe({
      mode: 'success',
      idempotencyKey: 'probe-success-001',
      traceId,
    });
    await waitUntil(
      () => jobs.status(success.job_id),
      (status) => status.state === 'SUCCEEDED',
    );

    const transient = await jobs.enqueueProbe({
      mode: 'transient',
      idempotencyKey: 'probe-transient-001',
      traceId,
    });
    const transientStatus = await waitUntil(
      () => jobs.status(transient.job_id),
      (status) => status.state === 'SUCCEEDED',
    );
    expect(transientStatus.attempts_made).toBeGreaterThanOrEqual(2);

    const firstDuplicate = await jobs.enqueueProbe({
      mode: 'success',
      idempotencyKey: 'probe-duplicate-001',
      traceId,
    });
    const secondDuplicate = await jobs.enqueueProbe({
      mode: 'success',
      idempotencyKey: 'probe-duplicate-001',
      traceId,
    });
    expect(secondDuplicate.job_id).toBe(firstDuplicate.job_id);

    const timed = await jobs.enqueueProbe({
      mode: 'timeout',
      idempotencyKey: 'probe-timeout-001',
      traceId,
      timeoutMs: 25,
    });
    const timedStatus = await waitUntil(
      () => jobs.status(timed.job_id),
      (status) => status.state === 'DEAD_LETTERED',
    );
    expect(timedStatus.failure?.code).toBe('JOB_FAILED');
    await jobs.retry(timed.job_id);

    await consumer.close();
    await jobs.close();
    producerRedis.disconnect();
    workerRedis.disconnect();
  });

  it('serves JobAccepted and status through Fastify without waiting', async () => {
    const workerRedis = new Redis(redisUrl, { maxRetriesPerRequest: null });
    const consumer = createJobWorker(workerRedis, createLogger());
    const app = buildServer({ redisUrl });
    const accepted = await app.inject({
      method: 'POST',
      url: '/internal/jobs/probe',
      headers: { 'idempotency-key': 'api-probe-001' },
      payload: { mode: 'success' },
    });
    expect(accepted.statusCode).toBe(202);
    const jobId = accepted.json<{ job_id: string }>().job_id;
    await waitUntil(
      async () =>
        (await app.inject({ method: 'GET', url: `/jobs/${jobId}` })).json<{ state: string }>(),
      (status) => status.state === 'SUCCEEDED',
    );
    await app.close();
    await consumer.close();
    workerRedis.disconnect();
  });
});

describe('transactional outbox and audit', () => {
  it('delivers once, audits fields, rolls back atomically and preserves domain data on delivery failure', async () => {
    const userId = newUuid<UserId>();
    await pool.query('INSERT INTO users(id) VALUES ($1) ON CONFLICT DO NOTHING', [userId]);
    const transport = new MemoryNotificationTransport();
    const created = await recordGoalDecision(pool, {
      userId,
      actorType: 'USER',
      goalPayload: { kind: 'demo' },
      notificationPayload: { goal_id: 'safe-reference' },
    });
    await Promise.all([
      dispatchOutboxBatch(pool, transport, 'worker-a'),
      dispatchOutboxBatch(pool, transport, 'worker-b'),
    ]);
    expect(transport.delivered.has(created.eventId)).toBe(true);
    expect(transport.sideEffects).toBe(1);
    const audit = await pool.query(
      `SELECT actor_type, action, target_type, target_version, result FROM audit_events WHERE event_id = $1`,
      [created.eventId],
    );
    expect(audit.rows[0]).toMatchObject({
      actor_type: 'USER',
      action: 'GOAL_CREATED',
      target_type: 'GOAL',
      target_version: 1,
      result: 'SUCCEEDED',
    });

    const before = await pool.query<{ count: string }>(
      'SELECT count(*) FROM goals WHERE user_id = $1',
      [userId],
    );
    await expect(
      recordGoalDecision(pool, {
        userId,
        actorType: 'USER',
        goalPayload: { kind: 'rollback' },
        notificationPayload: { raw_text: 'forbidden' },
      }),
    ).rejects.toThrow('sensitive');
    const after = await pool.query<{ count: string }>(
      'SELECT count(*) FROM goals WHERE user_id = $1',
      [userId],
    );
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);

    const failed = await recordGoalDecision(pool, {
      userId,
      actorType: 'SYSTEM',
      goalPayload: { kind: 'durable' },
      notificationPayload: { goal_id: 'durable-reference' },
    });
    transport.fail = true;
    await dispatchOutboxBatch(pool, transport, 'worker-failure');
    const domain = await pool.query('SELECT id FROM goals WHERE id = $1', [failed.goalId]);
    const outbox = await pool.query(
      'SELECT status, last_error_code FROM notification_outbox WHERE event_id = $1',
      [failed.eventId],
    );
    expect(domain.rowCount).toBe(1);
    expect(outbox.rows[0]).toMatchObject({ status: 'FAILED', last_error_code: 'DELIVERY_FAILED' });
  });
});
