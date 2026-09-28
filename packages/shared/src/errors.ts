import type { ApiError as ApiErrorContract } from '@vibework/contracts';
import type { TraceId } from './ids.js';

export class ApplicationError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly currentRevision: number | null;
  readonly statusCode: number;

  constructor(options: {
    code: string;
    message: string;
    statusCode?: number;
    retryable?: boolean;
    currentRevision?: number | null;
    cause?: unknown;
  }) {
    super(options.message, { cause: options.cause });
    this.name = 'ApplicationError';
    this.code = options.code;
    this.statusCode = options.statusCode ?? 500;
    this.retryable = options.retryable ?? false;
    this.currentRevision = options.currentRevision ?? null;
  }
}

export function toApiError(error: unknown, requestId: TraceId): ApiErrorContract {
  if (error instanceof ApplicationError) {
    return {
      code: error.code,
      message: error.message,
      request_id: requestId,
      retryable: error.retryable,
      current_revision: error.currentRevision,
    };
  }
  return {
    code: 'INTERNAL_ERROR',
    message: 'Внутренняя ошибка сервиса',
    request_id: requestId,
    retryable: false,
    current_revision: null,
  };
}

export function statusCodeFor(error: unknown): number {
  return error instanceof ApplicationError ? error.statusCode : 500;
}
