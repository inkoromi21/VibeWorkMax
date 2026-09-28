import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  asUuid,
  createLogger,
  newUuid,
  requestFingerprint,
  scopedIdempotencyHash,
  validateAnalyticsEvent,
  type GoalId,
  type UserId,
} from '../src/index.js';

describe('shared infrastructure', () => {
  it('keeps UUID identifiers valid and branded', () => {
    const userId = newUuid<UserId>();
    expect(asUuid<UserId>(userId)).toBe(userId);
    // @ts-expect-error different identifier brands must not be assignable
    const goalId: GoalId = userId;
    expect(goalId).toBe(userId);
  });

  it('creates deterministic fingerprints and scoped idempotency hashes', () => {
    expect(requestFingerprint({ b: 2, a: 1 })).toBe(requestFingerprint({ a: 1, b: 2 }));
    expect(scopedIdempotencyHash('job', 'valid-key-001')).not.toBe(
      scopedIdempotencyHash('request', 'valid-key-001'),
    );
  });

  it('redacts sensitive log fields', async () => {
    let output = '';
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        output += (chunk as Buffer).toString();
        callback();
      },
    });
    createLogger(destination).info({ token: 'never-log', initData: 'private', safe: 'ok' });
    await new Promise((resolve) => destination.end(resolve));
    expect(output).not.toContain('never-log');
    expect(output).not.toContain('private');
    expect(output).toContain('[REDACTED]');
    expect(output).toContain('ok');
  });

  it('rejects raw answers in analytics', () => {
    expect(() => validateAnalyticsEvent({ event: 'safe', answer_text: 'private' })).toThrow(
      'forbidden field',
    );
    expect(validateAnalyticsEvent({ event: 'job_completed', result: 'ok' })).toEqual({
      event: 'job_completed',
      result: 'ok',
    });
  });
});
