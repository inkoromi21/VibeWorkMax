import {
  DEAD_LETTER_QUEUE,
  JOB_QUEUE,
  newUuid,
  runWithTrace,
  scopedIdempotencyHash,
  type JobEnvelope,
  type JobId,
  type TraceId,
} from '@vibework/shared';
import type { BotTransition } from '@vibework/domain';
import type { createLogger } from '@vibework/shared';
import { Queue, Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
type Logger = Pick<ReturnType<typeof createLogger>, 'info'>;

interface ProbePayload extends Record<string, unknown> {
  mode: 'success' | 'transient' | 'timeout';
}

async function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('JOB_TIMEOUT'));
      },
      { once: true },
    );
  });
}

async function processProbe(job: Job<JobEnvelope<ProbePayload>>): Promise<{ ok: true }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), job.data.timeoutMs);
  try {
    if (job.data.payload.mode === 'transient' && job.attemptsMade === 0) {
      throw new Error('TRANSIENT_TEST_FAILURE');
    }
    if (job.data.payload.mode === 'timeout') {
      await abortableDelay(job.data.timeoutMs + 5_000, controller.signal);
    }
    return { ok: true };
  } finally {
    clearTimeout(timeout);
  }
}

export function createJobWorker(
  connection: Redis,
  logger: Logger,
  options: {
    processMaxUpdate?: (eventId: string) => Promise<BotTransition | null>;
    processAttemptGrade?: (reference: string) => Promise<void>;
    processCourseBuild?: (reference: string) => Promise<void>;
    checkAiAdmission?: (
      type: 'course.build' | 'attempt.grade',
      reference: string,
    ) => Promise<boolean>;
  } = {},
) {
  const deadLetters = new Queue(DEAD_LETTER_QUEUE, { connection });
  const jobQueue = new Queue<JobEnvelope>(JOB_QUEUE, { connection });
  const worker = new Worker<JobEnvelope>(
    JOB_QUEUE,
    async (job) =>
      runWithTrace({ traceId: job.data.traceId }, async () => {
        logger.info({ jobId: job.id, traceId: job.data.traceId }, 'job started');
        if (job.data.type === 'max.process') {
          const eventId = job.data.payload.event_id;
          if (typeof eventId !== 'string') throw new Error('INVALID_MAX_JOB');
          if (!options.processMaxUpdate) return { ok: true };
          const transition = await options.processMaxUpdate(eventId);
          if (transition)
            await enqueueTransitionJobs(jobQueue, job.data, transition, options.checkAiAdmission);
          return { ok: true };
        }
        if (job.data.type === 'attempt.grade') {
          const reference = job.data.payload.reference;
          if (typeof reference !== 'string') throw new Error('INVALID_ATTEMPT_JOB');
          await options.processAttemptGrade?.(reference);
          return { ok: true };
        }
        if (job.data.type === 'course.build') {
          const reference = job.data.payload.reference;
          if (typeof reference !== 'string') throw new Error('INVALID_COURSE_BUILD_JOB');
          await options.processCourseBuild?.(reference);
          return { ok: true };
        }
        if (job.data.type !== 'phase1.probe') throw new Error('UNSUPPORTED_JOB_TYPE');
        return processProbe(job as Job<JobEnvelope<ProbePayload>>);
      }),
    { connection, concurrency: 4 },
  );

  worker.on('failed', (job, error) => {
    if (!job?.id) return;
    const exhausted = job.attemptsMade >= (job.opts.attempts ?? 1);
    if (!exhausted) return;
    const reasonCode = error.message === 'JOB_TIMEOUT' ? 'JOB_TIMEOUT' : 'JOB_FAILED';
    void deadLetters.add(
      'dead-letter',
      { sourceJobId: job.id, traceId: job.data.traceId, reasonCode },
      { jobId: job.id, removeOnComplete: false, removeOnFail: false },
    );
  });

  return {
    worker,
    async dispatchTransitionOutbox(pool: Pool): Promise<number> {
      const pending = await pool.query<{
        event_id: string;
        job_type: 'course.build' | 'attempt.grade';
        job_key: string;
      }>(
        `SELECT event_id,job_type,job_key FROM bot_transition_job_outbox
         WHERE enqueued_at IS NULL ORDER BY created_at LIMIT 50`,
      );
      for (const row of pending.rows) {
        await enqueueTransitionJobs(
          jobQueue,
          { traceId: newUuid<TraceId>() },
          { replies: [], jobs: [{ type: row.job_type, key: row.job_key }] },
          options.checkAiAdmission,
        );
        await pool.query(
          `UPDATE bot_transition_job_outbox SET enqueued_at=now()
           WHERE event_id=$1 AND job_type=$2 AND job_key=$3 AND enqueued_at IS NULL`,
          [row.event_id, row.job_type, row.job_key],
        );
      }
      return pending.rowCount ?? 0;
    },
    async dispatchAttemptGradeOutbox(pool: Pool): Promise<number> {
      const pending = await pool.query<{ attempt_id: string }>(
        `SELECT attempt_id FROM attempt_grade_outbox
         WHERE enqueued_at IS NULL ORDER BY created_at LIMIT 50`,
      );
      for (const row of pending.rows) {
        await enqueueTransitionJobs(
          jobQueue,
          { traceId: newUuid<TraceId>() },
          { replies: [], jobs: [{ type: 'attempt.grade', key: `attempt:${row.attempt_id}` }] },
          options.checkAiAdmission,
        );
        await pool.query(
          `UPDATE attempt_grade_outbox SET enqueued_at=now()
           WHERE attempt_id=$1 AND enqueued_at IS NULL`,
          [row.attempt_id],
        );
      }
      return pending.rowCount ?? 0;
    },
    async close() {
      await worker.close();
      await deadLetters.close();
      await jobQueue.close();
    },
  };
}

async function enqueueTransitionJobs(
  queue: Queue,
  parent: Pick<JobEnvelope, 'traceId'>,
  transition: BotTransition,
  checkAiAdmission?: (
    type: 'course.build' | 'attempt.grade',
    reference: string,
  ) => Promise<boolean>,
): Promise<void> {
  for (const item of transition.jobs) {
    if (item.type !== 'course.build' && item.type !== 'attempt.grade') continue;
    const idempotencyHash = scopedIdempotencyHash(item.type, item.key);
    const aiAdmitted = (await checkAiAdmission?.(item.type, item.key)) ?? false;
    await queue.add(
      item.type,
      {
        jobId: newUuid<JobId>(),
        traceId: parent.traceId,
        idempotencyHash,
        type: item.type,
        timeoutMs: 15_000,
        payload: { reference: item.key, ai_admitted: aiAdmitted },
      },
      {
        jobId: idempotencyHash,
        attempts: 3,
        backoff: { type: 'exponential', delay: 100 },
        removeOnComplete: false,
        removeOnFail: false,
        deduplication: { id: idempotencyHash },
      },
    );
  }
}
