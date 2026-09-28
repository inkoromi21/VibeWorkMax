import { describe, expect, it } from 'vitest';
import { ApplicationError } from '@vibework/shared';
import { buildServer } from '../src/server.js';

describe('Fastify infrastructure', () => {
  it('preserves a valid correlation ID', async () => {
    const app = buildServer({ registerJobs: false });
    const traceId = 'b4f13fe4-09bc-4bd4-b26f-709e33744a5d';
    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': traceId },
    });
    expect(response.headers['x-request-id']).toBe(traceId);
    await app.close();
  });

  it('serializes a safe contract error without internal diagnostics', async () => {
    const app = buildServer({ registerJobs: false });
    app.get('/failure', () => {
      throw new ApplicationError({
        code: 'SAFE_FAILURE',
        message: 'Безопасное сообщение',
        statusCode: 409,
        cause: new Error('secret-internal'),
      });
    });
    const response = await app.inject({ method: 'GET', url: '/failure' });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      code: 'SAFE_FAILURE',
      retryable: false,
      current_revision: null,
    });
    expect(response.body).not.toContain('secret-internal');
    expect(response.body).not.toContain('stack');
    await app.close();
  });
});
