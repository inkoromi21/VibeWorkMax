import { createHash } from 'node:crypto';
import { ApplicationError } from './errors.js';

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,200}$/;

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stable(child)]),
    );
  }
  return value;
}

export function normalizeIdempotencyKey(value: unknown): string {
  if (typeof value !== 'string' || !IDEMPOTENCY_KEY.test(value)) {
    throw new ApplicationError({
      code: 'INVALID_IDEMPOTENCY_KEY',
      message: 'Некорректный Idempotency-Key',
      statusCode: 422,
    });
  }
  return value;
}

export function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function requestFingerprint(value: unknown): string {
  return digest(JSON.stringify(stable(value)));
}

export function scopedIdempotencyHash(scope: string, key: string): string {
  return digest(`${scope}\u0000${normalizeIdempotencyKey(key)}`);
}
