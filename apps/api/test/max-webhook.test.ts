import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';
import {
  assertMaxWebhookConfiguration,
  MemoryMaxWebhookMetrics,
  MemoryMaxWebhookStore,
  parseMaxUpdate,
} from '../src/max-webhook.js';

describe('MAX webhook', () => {
  it('requires a public HTTPS endpoint and a syntactically valid secret before external enablement', () => {
    expect(() =>
      assertMaxWebhookConfiguration({
        publicBaseUrl: 'http://localhost:3000',
        secret: 'valid-secret',
        token: 'token',
        identityEncryptionKey: Buffer.alloc(32, 1).toString('base64url'),
      }),
    ).toThrow();
    expect(() =>
      assertMaxWebhookConfiguration({
        publicBaseUrl: 'https://bot.example',
        secret: 'valid-secret',
        token: 'token',
        identityEncryptionKey: Buffer.alloc(32, 1).toString('base64url'),
      }),
    ).not.toThrow();
  });
  it('rejects an invalid secret without recording an event', async () => {
    const store = new MemoryMaxWebhookStore();
    const app = buildServer({
      registerJobs: false,
      maxWebhookSecret: 'expected',
      webhookStore: store,
    });
    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/max',
      headers: { 'x-max-bot-api-secret': 'wrong' },
      payload: { event_id: 'e1', type: 'message_created', user_id: 1, text: 'private' },
    });
    expect(response.statusCode).toBe(401);
    expect(store.events.size).toBe(0);
    await app.close();
  });
  it('commits valid input before acknowledging and deduplicates it', async () => {
    const store = new MemoryMaxWebhookStore();
    const metrics = new MemoryMaxWebhookMetrics();
    let queued = 0;
    const app = buildServer({
      registerJobs: false,
      maxWebhookSecret: 'expected',
      webhookStore: store,
      webhookMetrics: metrics,
      webhookEnqueuer: {
        enqueueMaxUpdate() {
          queued += 1;
          return Promise.resolve();
        },
      },
    });
    const input = { event_id: 'event-1', type: 'message_created', user_id: 1, text: 'hello' };
    const started = performance.now();
    const first = await app.inject({
      method: 'POST',
      url: '/webhooks/max',
      headers: { 'x-max-bot-api-secret': 'expected' },
      payload: input,
    });
    const second = await app.inject({
      method: 'POST',
      url: '/webhooks/max',
      headers: { 'x-max-bot-api-secret': 'expected' },
      payload: input,
    });
    expect(performance.now() - started).toBeLessThan(30_000);
    expect(first.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ duplicate: true });
    expect(queued).toBe(1);
    expect(store.events.size).toBe(1);
    expect(metrics.counters.get('accepted')).toBe(1);
    expect(metrics.counters.get('duplicate')).toBe(1);
    expect(metrics.latenciesMs.every((value) => value < 30_000)).toBe(true);
    await app.close();
  });
  it('rejects malformed updates', async () => {
    const app = buildServer({
      registerJobs: false,
      maxWebhookSecret: 'expected',
      webhookEnqueuer: { enqueueMaxUpdate: () => Promise.resolve() },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/max',
      headers: { 'x-max-bot-api-secret': 'expected' },
      payload: { event_id: 'x' },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it('accepts the documented update_type shape but blocks derived ids in production mode', async () => {
    const update = parseMaxUpdate({
      update_type: 'message_created',
      timestamp: 1,
      chat_id: 7,
      message: { id: 4, text: 'hello', sender: { user_id: 1 } },
    });
    expect(update.type).toBe('message_created');
    expect(update.hasProviderEventId).toBe(false);
    const app = buildServer({
      registerJobs: false,
      maxWebhookSecret: 'expected',
      requireMaxProviderEventId: true,
      webhookEnqueuer: { enqueueMaxUpdate: () => Promise.resolve() },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/max',
      headers: { 'x-max-bot-api-secret': 'expected' },
      payload: {
        update_type: 'message_created',
        timestamp: 1,
        chat_id: 7,
        message: { id: 4, text: 'hello', sender: { user_id: 1 } },
      },
    });
    expect(response.statusCode).toBe(503);
    await app.close();
  });

  it('encrypts the recipient before a MAX-enabled webhook reaches storage', () => {
    const update = parseMaxUpdate(
      { event_id: 'encrypted-1', type: 'message_created', user_id: 123456, text: 'hello' },
      Buffer.alloc(32, 1).toString('base64url'),
    );
    expect(update.actorId).toBe('123456');
    expect(update.encryptedRecipient).toMatch(/^v1\./);
    expect(update.encryptedRecipient).not.toContain('123456');
  });

  it('leaves a committed event pending when queue handoff fails and retries on redelivery', async () => {
    const store = new MemoryMaxWebhookStore();
    let attempts = 0;
    const app = buildServer({
      registerJobs: false,
      maxWebhookSecret: 'expected',
      webhookStore: store,
      webhookEnqueuer: {
        enqueueMaxUpdate() {
          attempts += 1;
          return attempts === 1 ? Promise.reject(new Error('unavailable')) : Promise.resolve();
        },
      },
    });
    const payload = { event_id: 'retry-1', type: 'message_created', user_id: 1, text: 'hello' };
    const first = await app.inject({
      method: 'POST',
      url: '/webhooks/max',
      headers: { 'x-max-bot-api-secret': 'expected' },
      payload,
    });
    const second = await app.inject({
      method: 'POST',
      url: '/webhooks/max',
      headers: { 'x-max-bot-api-secret': 'expected' },
      payload,
    });
    expect(first.statusCode).toBe(500);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ duplicate: true });
    expect(attempts).toBe(2);
    await app.close();
  });
});
