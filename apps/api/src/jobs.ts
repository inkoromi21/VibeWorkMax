import type { JobAccepted, JobStatusResponse } from '@vibework/contracts';
import {
  ApplicationError,
  DEAD_LETTER_QUEUE,
  JOB_QUEUE,
  asUuid,
  newUuid,
  requestFingerprint,
  scopedIdempotencyHash,
  type JobEnvelope,
  type JobId,
  type TraceId,
} from '@vibework/shared';
import { Queue, type Job } from 'bullmq';
import type { Redis } from 'ioredis';

type ProbeMode = 'success' | 'transient' | 'timeout';
interface ProbePayload extends Record<string, unknown> {
  mode: ProbeMode;
}

function options() {
  return {
    attempts: 3,
    backoff: { type: 'exponential' as const, delay: 100 },
    removeOnComplete: false,
    removeOnFail: false,
  };
}

export class JobService {
  readonly queue: Queue<JobEnvelope>;
  readonly deadLetterQueue: Queue;

  constructor(connection: Redis) {
    this.queue = new Queue<JobEnvelope>(JOB_QUEUE, { connection, defaultJobOptions: options() });
    this.deadLetterQueue = new Queue(DEAD_LETTER_QUEUE, { connection });
  }

  async enqueueProbe(input: {
    mode: ProbeMode;
    idempotencyKey: string;
    traceId: TraceId;
    timeoutMs?: number;
  }): Promise<JobAccepted> {
    const idempotencyHash = scopedIdempotencyHash('probe-job', input.idempotencyKey);
    const jobId = asUuid<JobId>(newUuid<JobId>());
    const stableJobId = idempotencyHash;
    const payload: ProbePayload = { mode: input.mode };
    const existing = await this.queue.getJob(stableJobId);
    if (existing) {
      if (
        existing.data.idempotencyHash !== idempotencyHash ||
        requestFingerprint(existing.data.payload) !== requestFingerprint(payload)
      ) {
        throw new ApplicationError({
          code: 'IDEMPOTENCY_CONFLICT',
          message: 'Idempotency-Key уже использован для другого запроса',
          statusCode: 409,
        });
      }
      return {
        job_id: existing.id ?? stableJobId,
        status: 'QUEUED',
        polling_url: `/jobs/${existing.id ?? stableJobId}`,
      };
    }
    const envelope: JobEnvelope<ProbePayload> = {
      jobId,
      traceId: input.traceId,
      idempotencyHash,
      type: 'phase1.probe',
      timeoutMs: input.timeoutMs ?? 1_000,
      payload,
    };
    const job = await this.queue.add('phase1.probe', envelope, {
      ...options(),
      jobId: stableJobId,
      deduplication: { id: idempotencyHash },
    });
    return {
      job_id: job.id ?? stableJobId,
      status: 'QUEUED',
      polling_url: `/jobs/${job.id ?? stableJobId}`,
    };
  }

  async enqueueMaxUpdate(input: { eventId: string; traceId: TraceId }): Promise<void> {
    const idempotencyHash = scopedIdempotencyHash('max-update', `max-event-${input.eventId}`);
    const envelope: JobEnvelope = {
      jobId: newUuid<JobId>(),
      traceId: input.traceId,
      idempotencyHash,
      type: 'max.process',
      timeoutMs: 15_000,
      payload: { event_id: input.eventId },
    };
    await this.queue.add('max.process', envelope, {
      ...options(),
      jobId: idempotencyHash,
      deduplication: { id: idempotencyHash },
    });
  }

  async status(jobId: string): Promise<JobStatusResponse> {
    const job = await this.queue.getJob(jobId);
    if (!job)
      throw new ApplicationError({
        code: 'JOB_NOT_FOUND',
        message: 'Job не найдена',
        statusCode: 404,
      });
    const dead = await this.deadLetterQueue.getJob(jobId);
    const state = await mapState(job, Boolean(dead));
    const failed = state === 'FAILED' || state === 'TIMED_OUT' || state === 'DEAD_LETTERED';
    return {
      job_id: jobId,
      state,
      attempts_made: job.attemptsMade,
      retryable: failed,
      failure: failed
        ? {
            code: state === 'TIMED_OUT' ? 'JOB_TIMEOUT' : 'JOB_FAILED',
            message:
              state === 'TIMED_OUT'
                ? 'Job превысила безопасный timeout'
                : 'Job завершилась ошибкой',
          }
        : null,
    };
  }

  async retry(jobId: string): Promise<void> {
    const job = await this.queue.getJob(jobId);
    if (!job)
      throw new ApplicationError({
        code: 'JOB_NOT_FOUND',
        message: 'Job не найдена',
        statusCode: 404,
      });
    if ((await job.getState()) !== 'failed') {
      throw new ApplicationError({
        code: 'JOB_NOT_RETRYABLE',
        message: 'Job нельзя повторить в текущем состоянии',
        statusCode: 409,
      });
    }
    const deadLetter = await this.deadLetterQueue.getJob(jobId);
    if (deadLetter) await deadLetter.remove();
    await job.retry('failed', { resetAttemptsMade: true });
  }

  async close(): Promise<void> {
    await Promise.all([this.queue.close(), this.deadLetterQueue.close()]);
  }
}

async function mapState(job: Job, deadLettered: boolean): Promise<JobStatusResponse['state']> {
  if (deadLettered) return 'DEAD_LETTERED';
  const state = await job.getState();
  if (state === 'active') return 'RUNNING';
  if (state === 'completed') return 'SUCCEEDED';
  if (state === 'failed') return job.failedReason === 'JOB_TIMEOUT' ? 'TIMED_OUT' : 'FAILED';
  return 'QUEUED';
}
