import type { JobId, TraceId } from './ids.js';

export const JOB_STATES = [
  'QUEUED',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'TIMED_OUT',
  'DEAD_LETTERED',
] as const;

export const JOB_QUEUE = 'vibework-jobs';
export const DEAD_LETTER_QUEUE = 'vibework-jobs-dead-letter';

export type JobState = (typeof JOB_STATES)[number];

export interface JobEnvelope<TPayload extends Record<string, unknown> = Record<string, unknown>> {
  jobId: JobId;
  traceId: TraceId;
  idempotencyHash: string;
  type: string;
  timeoutMs: number;
  payload: TPayload;
}

export interface SafeJobFailure {
  code: string;
  message: string;
  retryable: boolean;
}
