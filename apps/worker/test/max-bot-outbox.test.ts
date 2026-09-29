import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { MemoryBotReplyTransport, processMaxUpdate } from '../src/max-bot.js';

describe('MAX transition outbox recovery', () => {
  it('replays durable child jobs when the parent retries after commit', async () => {
    const client = {
      query: vi.fn((sql: string) => {
        if (sql.includes('FROM max_webhook_events'))
          return Promise.resolve({
            rows: [
              {
                event_id: 'event-1',
                event_type: 'message_created',
                payload: {},
                actor_id_hash: 'actor-hash',
                encrypted_recipient: null,
                status: 'PROCESSED',
              },
            ],
            rowCount: 1,
          });
        return Promise.resolve({ rows: [], rowCount: 0 });
      }),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn(() => Promise.resolve(client)),
      query: vi.fn((sql: string) => {
        if (sql.includes('FROM bot_transition_job_outbox'))
          return Promise.resolve({
            rows: [{ job_type: 'course.build', job_key: 'goal:actor-hash' }],
            rowCount: 1,
          });
        return Promise.resolve({ rows: [], rowCount: 0 });
      }),
    } as unknown as Pool;

    const transition = await processMaxUpdate(pool, 'event-1', new MemoryBotReplyTransport(), {
      enabled: false,
    });

    expect(transition?.jobs).toEqual([{ type: 'course.build', key: 'goal:actor-hash' }]);
    expect(client.release).toHaveBeenCalledOnce();
  });
});
