import { createHmac, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryMiniAppStore, verifyMaxInitData } from '../src/mini-app.js';
import { buildServer } from '../src/server.js';

const token = 'test-bot-token';

function initData(overrides: Record<string, string> = {}): string {
  const values = {
    auth_date: String(Math.floor(Date.now() / 1_000)),
    query_id: 'request-1',
    user: JSON.stringify({ id: 42, first_name: 'Test' }),
    ...overrides,
  };
  const launch = Object.entries(values)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = createHmac('sha256', secret).update(launch).digest('hex');
  return [...Object.entries(values), ['hash', hash]]
    .map(([key, value]) => `${String(key)}=${encodeURIComponent(String(value))}`)
    .join('&');
}

describe('mini app session boundary', () => {
  const apps: ReturnType<typeof buildServer>[] = [];
  afterEach(async () => {
    delete process.env.MAX_BOT_TOKEN;
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it('accepts signed initData and protects the resulting session', async () => {
    process.env.MAX_BOT_TOKEN = token;
    const app = buildServer({
      registerJobs: false,
      miniAppStore: new MemoryMiniAppStore(),
      maxWebhookSecret: 'webhook',
    });
    apps.push(app);
    const session = await app.inject({
      method: 'POST',
      url: '/mini-app/session',
      payload: { initData: initData() },
    });
    expect(session.statusCode).toBe(201);
    expect(session.headers['set-cookie']).toContain('HttpOnly');
    expect(session.headers['set-cookie']).toContain('Secure');
    expect(session.headers['set-cookie']).toContain('SameSite=Lax');
    const cookie = String(session.headers['set-cookie']).split(';')[0];
    const { csrfToken } = session.json<{ csrfToken: string }>();
    const denied = await app.inject({
      method: 'POST',
      url: '/mini-app/problems',
      headers: { cookie, 'idempotency-key': 'first' },
      payload: { text: 'Не понимаю тему', revision: 0 },
    });
    expect(denied.statusCode).toBe(403);
    const accepted = await app.inject({
      method: 'POST',
      url: '/mini-app/problems',
      headers: { cookie, 'idempotency-key': 'second', 'x-csrf-token': csrfToken },
      payload: { text: 'Не понимаю тему', revision: 0 },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({
      state: { problem: { classification: { type: 'KNOWLEDGE_GAP' } } },
    });
  });

  it('rejects tampering, duplicate input, and expired authentication', () => {
    const valid = initData();
    expect(() => verifyMaxInitData(`${valid}&hash=00`, token)).toThrow(/Повторяющийся/);
    expect(() => verifyMaxInitData(valid.replace('request-1', 'request-2'), token)).toThrow(
      /Подпись/,
    );
    expect(() => verifyMaxInitData(initData({ auth_date: '1' }), token)).toThrow(/Срок/);
  });

  it('uses AI only for an ambiguous authorized request and rejects stale revisions before calling it', async () => {
    process.env.MAX_BOT_TOKEN = token;
    let calls = 0;
    const app = buildServer({
      registerJobs: false,
      miniAppStore: new MemoryMiniAppStore(),
      problemClassifierFactory: () => ({
        modelIdentifier: 'fake-classifier',
        classify: () => {
          calls += 1;
          return Promise.resolve({
            type: 'SKILL',
            confidence: 0.9,
            reason: 'The request is about learning a skill',
            clarification_needed: false,
          });
        },
      }),
    });
    apps.push(app);
    const session = await app.inject({
      method: 'POST',
      url: '/mini-app/session',
      payload: { initData: initData() },
    });
    const cookie = String(session.headers['set-cookie']).split(';')[0];
    const { csrfToken } = session.json<{ csrfToken: string }>();
    const submit = (text: string, revision: number) =>
      app.inject({
        method: 'POST',
        url: '/mini-app/problems',
        headers: { cookie, 'x-csrf-token': csrfToken, 'idempotency-key': randomUUID() },
        payload: { text, revision },
      });
    const stale = await submit('привет', 3);
    expect(stale.statusCode).toBe(409);
    expect(calls).toBe(0);
    const ambiguous = await submit('привет', 0);
    expect(ambiguous.statusCode).toBe(200);
    expect(ambiguous.json()).toMatchObject({
      state: { problem: { classification: { type: 'SKILL', path: 'ai' } } },
    });
    expect(calls).toBe(1);
    const deterministic = await submit('не понимаю дроби', 1);
    expect(deterministic.statusCode).toBe(200);
    expect(deterministic.json()).toMatchObject({
      state: { problem: { classification: { type: 'KNOWLEDGE_GAP', path: 'deterministic' } } },
    });
    expect(calls).toBe(1);
  });

  it('moves an ambiguous request through explicit clarification and minimal profile collection', async () => {
    process.env.MAX_BOT_TOKEN = token;
    const app = buildServer({
      registerJobs: false,
      miniAppStore: new MemoryMiniAppStore(),
      maxWebhookSecret: 'webhook',
    });
    apps.push(app);
    const session = await app.inject({
      method: 'POST',
      url: '/mini-app/session',
      payload: { initData: initData() },
    });
    const cookie = String(session.headers['set-cookie']).split(';')[0];
    const { csrfToken } = session.json<{ csrfToken: string }>();
    const mutate = (url: string, payload: Record<string, unknown>) =>
      app.inject({
        method: 'POST',
        url,
        headers: { cookie, 'x-csrf-token': csrfToken, 'idempotency-key': randomUUID() },
        payload,
      });
    const problem = await mutate('/mini-app/problems', { text: 'привет', revision: 0 });
    expect(
      problem.json<{ state: { problem: { classification: { type: null } } } }>().state.problem
        .classification.type,
    ).toBeNull();
    const clarified = await mutate('/mini-app/problems/clarification', {
      type: 'SKILL',
      revision: 1,
    });
    expect(
      clarified.json<{ state: { problem: { classification: { type: string } } } }>().state.problem
        .classification.type,
    ).toBe('SKILL');
    const profile = await mutate('/mini-app/diagnostic-profile', {
      educationTrack: 'student',
      interestIds: ['tech'],
      revision: 2,
    });
    expect(
      profile.json<{ state: { diagnosticProfile: { educationTrack: string } } }>().state,
    ).toMatchObject({
      diagnosticProfile: { educationTrack: 'student' },
    });
  });

  it('persists the mini-app path from problem through review in one version-locked state', async () => {
    process.env.MAX_BOT_TOKEN = token;
    const app = buildServer({
      registerJobs: false,
      miniAppStore: new MemoryMiniAppStore(),
      maxWebhookSecret: 'webhook',
    });
    apps.push(app);
    const session = await app.inject({
      method: 'POST',
      url: '/mini-app/session',
      payload: { initData: initData() },
    });
    const cookie = String(session.headers['set-cookie']).split(';')[0];
    const { csrfToken } = session.json<{ csrfToken: string }>();
    const mutate = async (url: string, payload: Record<string, unknown>, revision: number) =>
      app.inject({
        method: 'POST',
        url,
        headers: {
          cookie,
          'x-csrf-token': csrfToken,
          'idempotency-key': `flow-${String(revision)}`,
        },
        payload: { ...payload, revision },
      });

    const problem = await mutate(
      '/mini-app/problems',
      { text: 'Не понимаю, как проверить решение' },
      0,
    );
    expect(problem.statusCode).toBe(200);
    for (let revision = 1; revision <= 5; revision += 1) {
      const diagnosis = await mutate(
        '/mini-app/diagnosis',
        { action: 'answer', answer: 'test' },
        revision,
      );
      expect(diagnosis.statusCode).toBe(200);
    }
    const finished = await mutate('/mini-app/diagnosis', { action: 'finish' }, 6);
    expect(finished.statusCode).toBe(200);
    const goal = await mutate('/mini-app/goals', { text: 'Сделать первый проверяемый шаг' }, 7);
    expect(goal.json()).toMatchObject({
      state: {
        result: { evidenceSufficiency: 'PARTIAL' },
        goal: { version: 1 },
        route: { status: 'ACTIVE', version: 1, contentMode: 'DEMO' },
      },
    });
    const attempt = await mutate('/mini-app/attempts', { answer: 'Мой ответ' }, 8);
    expect(attempt.json()).toMatchObject({
      state: { attemptCount: 1, revision: 9 },
      review: { status: 'NEEDS_REVIEW', rubric: 'DEMO' },
    });
    const bootstrap = await app.inject({
      method: 'GET',
      url: '/mini-app/bootstrap',
      headers: { cookie },
    });
    const boot = bootstrap.json<{
      state: { attemptCount: number; route: { goalVersion: number } | null };
      questions: { id: string }[];
      certificate: { available: boolean };
      opportunities: unknown[];
    }>();
    expect(boot.state).toMatchObject({ attemptCount: 1, route: { goalVersion: 1 } });
    expect(boot.questions[0]?.id).toBe('gap-topic-v1');
    expect(boot.certificate.available).toBe(false);
    expect(boot.opportunities).toEqual([]);
  });
});
