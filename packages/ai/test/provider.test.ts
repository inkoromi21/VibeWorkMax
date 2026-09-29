import { describe, expect, it } from 'vitest';
import {
  FakeAiProvider,
  YandexAiStudioProvider,
  type AiRequest,
  type FetchLike,
} from '../src/index.js';

const request: AiRequest = {
  operationKind: 'problem.classification',
  promptVersion: 'problem-classifier-prompt-v1',
  prompt: 'Classify this request.',
  deadlineMs: 1_000,
  maxInputTokens: 100,
  maxOutputTokens: 60,
  modelPolicy: { allowedModels: ['gpt://folder/alice-flash/latest'] },
};

describe('FakeAiProvider', () => {
  it('returns deterministic text and structured results offline', async () => {
    const provider = new FakeAiProvider([
      { type: 'success', text: 'text result' },
      { type: 'structured', value: { type: 'SKILL' } },
    ]);
    await expect(provider.generateText(request)).resolves.toMatchObject({
      value: 'text result',
      latencyMs: 0,
    });
    await expect(
      provider.generateStructured<{ type: string }>({
        ...request,
        schemaName: 'classification',
        schema: { type: 'object' },
      }),
    ).resolves.toMatchObject({ value: { type: 'SKILL' } });
  });

  it.each(['retryable', 'permanent', 'timeout'] as const)(
    'models a %s provider error',
    async (type) => {
      const provider = new FakeAiProvider([{ type }]);
      await expect(provider.generateText(request)).rejects.toMatchObject({ kind: type });
    },
  );
});

describe('YandexAiStudioProvider contract', () => {
  const config = {
    mode: 'enabled' as const,
    folderId: 'folder',
    apiKey: 'test-key',
    aliceFlashModelUri: 'gpt://folder/alice-flash/latest',
  };

  it('uses the compatible request shape and never sends a key in the body', async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const fetchMock: FetchLike = (url, init) => {
      captured = { url, init };
      return Promise.resolve(
        new Response(
          JSON.stringify({
            model: 'actual-model',
            choices: [{ message: { content: 'done' } }],
            usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
          }),
          { headers: { 'x-request-id': 'provider-id' } },
        ),
      );
    };
    const result = await new YandexAiStudioProvider(config, fetchMock).generateText(request);
    expect(captured?.url).toBe('https://ai.api.cloud.yandex.net/v1/chat/completions');
    expect(captured?.init.headers).toMatchObject({
      authorization: 'Api-Key test-key',
      'x-folder-id': 'folder',
      'x-data-logging-enabled': 'false',
    });
    expect(captured?.init.body).toContain('"store":false');
    expect(captured?.init.body).not.toContain('test-key');
    expect(result).toMatchObject({
      value: 'done',
      model: 'gpt://folder/alice-flash/latest',
      providerRequestId: 'provider-id',
      usage: { totalTokens: 5 },
      metadata: { providerReportedModel: 'actual-model' },
    });
  });

  it.each([
    [429, 'retryable'],
    [503, 'retryable'],
    [504, 'timeout'],
  ] as const)('normalizes HTTP %i as %s', async (status, kind) => {
    const provider = new YandexAiStudioProvider(config, () =>
      Promise.resolve(new Response('', { status })),
    );
    await expect(provider.generateText(request)).rejects.toMatchObject({
      kind,
      statusCode: status,
    });
  });

  it('normalizes malformed JSON and disabled configuration', async () => {
    const malformed = new YandexAiStudioProvider(config, () =>
      Promise.resolve(new Response('{', { status: 200 })),
    );
    await expect(malformed.generateText(request)).rejects.toMatchObject({
      kind: 'permanent',
    });
    await expect(
      new YandexAiStudioProvider({ mode: 'disabled' }).generateText(request),
    ).rejects.toMatchObject({ kind: 'permanent' });
  });

  it('normalizes aborted calls and invalid structured output', async () => {
    const aborted = new YandexAiStudioProvider(config, () =>
      Promise.reject(new DOMException('Aborted', 'AbortError')),
    );
    await expect(aborted.generateText(request)).rejects.toMatchObject({
      kind: 'timeout',
    });
    const invalidStructured = new YandexAiStudioProvider(config, () =>
      Promise.resolve(
        new Response(JSON.stringify({ choices: [{ message: { content: '{' } }] }), {
          status: 200,
        }),
      ),
    );
    await expect(
      invalidStructured.generateStructured({
        ...request,
        schemaName: 'classification',
        schema: { type: 'object' },
      }),
    ).rejects.toMatchObject({ kind: 'permanent' });
  });

  it('retries once only when the operation is declared retry-safe', async () => {
    let calls = 0;
    const provider = new YandexAiStudioProvider(config, () => {
      calls += 1;
      return Promise.resolve(
        calls === 1
          ? new Response('', { status: 503 })
          : new Response(JSON.stringify({ choices: [{ message: { content: 'done' } }] })),
      );
    });
    await expect(provider.generateText({ ...request, retrySafe: true })).resolves.toMatchObject({
      value: 'done',
    });
    expect(calls).toBe(2);
  });
});
