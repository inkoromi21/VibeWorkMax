import {
  DEAD_LETTER_QUEUE,
  JOB_QUEUE,
  newUuid,
  runWithTrace,
  scopedIdempotencyHash,
  type JobEnvelope,
  type JobId,
} from '@vibework/shared';
import type { BotTransition } from '@vibework/domain';
import type { createLogger } from '@vibework/shared';
import { Queue, Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
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
          if (transition) await enqueueTransitionJobs(jobQueue, job.data, transition);
          return { ok: true };
        }
        if (job.data.type === 'attempt.grade') {
          const reference = job.data.payload.reference;
          if (typeof reference !== 'string') throw new Error('INVALID_ATTEMPT_JOB');
          await options.processAttemptGrade?.(reference);
          return { ok: true };
        }
        if (job.data.type === 'course.build') {
          // The deterministic demo adapter has no provider work.  Keeping this
          // as a durable worker boundary makes a later approved adapter safe.
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
    async close() {
      await worker.close();
      await deadLetters.close();
      await jobQueue.close();
    },
  };
}

async function enqueueTransitionJobs(
  queue: Queue,
  parent: JobEnvelope,
  transition: BotTransition,
): Promise<void> {
  for (const item of transition.jobs) {
    if (item.type !== 'course.build' && item.type !== 'attempt.grade') continue;
    const idempotencyHash = scopedIdempotencyHash(item.type, item.key);
    await queue.add(
      item.type,
      {
        jobId: newUuid<JobId>(),
        traceId: parent.traceId,
        idempotencyHash,
        type: item.type,
        timeoutMs: 15_000,
        payload: { reference: item.key },
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
