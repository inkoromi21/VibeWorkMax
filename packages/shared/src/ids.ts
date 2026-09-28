import { randomUUID } from 'node:crypto';

declare const brand: unique symbol;
export type Brand<T, Name extends string> = T & { readonly [brand]: Name };

export type UserId = Brand<string, 'UserId'>;
export type SessionId = Brand<string, 'SessionId'>;
export type ProfileVersionId = Brand<string, 'ProfileVersionId'>;
export type ProblemId = Brand<string, 'ProblemId'>;
export type ProblemVersionId = Brand<string, 'ProblemVersionId'>;
export type GoalId = Brand<string, 'GoalId'>;
export type ConsentId = Brand<string, 'ConsentId'>;
export type JobId = Brand<string, 'JobId'>;
export type EventId = Brand<string, 'EventId'>;
export type AuditEventId = Brand<string, 'AuditEventId'>;
export type OutboxId = Brand<string, 'OutboxId'>;
export type TraceId = Brand<string, 'TraceId'>;
export type AttemptId = Brand<string, 'AttemptId'>;
export type ReviewId = Brand<string, 'ReviewId'>;
export type ConversationId = Brand<string, 'ConversationId'>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function asUuid<T extends Brand<string, string>>(value: string): T {
  if (!UUID_PATTERN.test(value)) throw new Error('Invalid UUID');
  return value as T;
}

export function newUuid<T extends Brand<string, string>>(): T {
  return randomUUID() as T;
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}
