import {
  assertRequestLimits,
  emptyUsage,
  ProviderError,
  unknownCost,
  type AiProvider,
  type AiRequest,
  type AiResult,
  type StructuredAiRequest,
  type Usage,
} from './port.js';

const DEFAULT_BASE_URL = 'https://ai.api.cloud.yandex.net/v1/';
const MAX_TIMEOUT_MS = 30_000;

export interface YandexAiStudioConfig {
  mode: 'disabled' | 'enabled';
  folderId?: string;
  apiKey?: string;
  aliceFlashModelUri?: string;
  aliceModelUri?: string;
  yandexGptProModelUri?: string;
  baseUrl?: string;
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export function yandexAiStudioConfigFromEnvironment(
  env: Record<string, string | undefined> = process.env,
): YandexAiStudioConfig {
  const mode = env.YANDEX_AI_MODE === 'enabled' ? 'enabled' : 'disabled';
  return {
    mode,
    ...(env.YANDEX_FOLDER_ID ? { folderId: env.YANDEX_FOLDER_ID } : {}),
    ...(env.YANDEX_API_KEY ? { apiKey: env.YANDEX_API_KEY } : {}),
    ...(env.YANDEX_MODEL_ALICE_FLASH_URI
      ? { aliceFlashModelUri: env.YANDEX_MODEL_ALICE_FLASH_URI }
      : {}),
    ...(env.YANDEX_MODEL_ALICE_URI ? { aliceModelUri: env.YANDEX_MODEL_ALICE_URI } : {}),
    ...(env.YANDEX_MODEL_YANDEXGPT_PRO_5_1_URI
      ? { yandexGptProModelUri: env.YANDEX_MODEL_YANDEXGPT_PRO_5_1_URI }
      : {}),
    ...(env.YANDEX_AI_BASE_URL ? { baseUrl: env.YANDEX_AI_BASE_URL } : {}),
  };
}

/** Server-side OpenAI-compatible Yandex adapter with no SDK dependency. */
export class YandexAiStudioProvider implements AiProvider {
  constructor(
    private readonly config: YandexAiStudioConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async generateText(request: AiRequest): Promise<AiResult<string>> {
    const response = await this.request(request, undefined);
    return response.result;
  }

  async generateStructured<T>(request: StructuredAiRequest): Promise<AiResult<T>> {
    const response = await this.request(request, {
      name: request.schemaName,
      schema: request.schema,
    });
    try {
      return { ...response.result, value: JSON.parse(response.content) as T };
    } catch (cause) {
      throw new ProviderError({
        kind: 'permanent',
        provider: 'yandex-ai-studio',
        message: 'Provider returned invalid structured JSON',
        cause,
      });
    }
  }

  private async request(
    request: AiRequest,
    structured: { name: string; schema: Record<string, unknown> } | undefined,
  ): Promise<{ content: string; result: AiResult<string> }> {
    assertRequestLimits(request);
    this.assertEnabled();
    const model = selectModel(request, this.config);
    try {
      return await this.requestOnce(request, model, structured);
    } catch (error) {
      if (!(error instanceof ProviderError) || error.kind !== 'retryable' || !request.retrySafe)
        throw error;
      return this.requestOnce(request, model, structured);
    }
  }

  private async requestOnce(
    request: AiRequest,
    model: string,
    structured: { name: string; schema: Record<string, unknown> } | undefined,
  ): Promise<{ content: string; result: AiResult<string> }> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      Math.min(request.deadlineMs, MAX_TIMEOUT_MS),
    );
    const started = Date.now();
    try {
      const body = {
        model,
        messages: [{ role: 'user', content: request.prompt }],
        max_tokens: request.maxOutputTokens,
        stream: false,
        store: false,
        ...(structured === undefined
          ? {}
          : {
              response_format: {
                type: 'json_schema',
                json_schema: { name: structured.name, schema: structured.schema, strict: true },
              },
            }),
      };
      const response = await this.fetchImpl(
        new URL('chat/completions', normalizedBaseUrl(this.config)).toString(),
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Api-Key ${this.config.apiKey ?? ''}`,
            'x-folder-id': this.config.folderId ?? '',
            'x-data-logging-enabled': 'false',
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        },
      );
      if (!response.ok) throw normalizeHttpError(response.status);
      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch (cause) {
        throw new ProviderError({
          kind: 'permanent',
          provider: 'yandex-ai-studio',
          message: 'Provider returned malformed JSON',
          cause,
        });
      }
      const content = extractContent(parsed);
      const value = parsed as { model?: unknown; usage?: unknown };
      return {
        content,
        result: {
          value: content,
          usage: normalizeUsage(value.usage),
          cost: unknownCost(),
          providerRequestId: response.headers.get('x-request-id'),
          model: typeof value.model === 'string' ? value.model : model,
          latencyMs: Date.now() - started,
          metadata: { provider: 'yandex-ai-studio', operationKind: request.operationKind },
        },
      };
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (
        controller.signal.aborted ||
        (error instanceof DOMException && error.name === 'AbortError')
      )
        throw new ProviderError({
          kind: 'timeout',
          provider: 'yandex-ai-studio',
          message: 'Provider request timed out',
          cause: error,
        });
      throw new ProviderError({
        kind: 'retryable',
        provider: 'yandex-ai-studio',
        message: 'Provider network request failed',
        cause: error,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private assertEnabled(): void {
    if (
      this.config.mode !== 'enabled' ||
      !this.config.folderId ||
      !this.config.apiKey ||
      (!this.config.aliceFlashModelUri &&
        !this.config.aliceModelUri &&
        !this.config.yandexGptProModelUri)
    )
      throw new ProviderError({
        kind: 'permanent',
        provider: 'yandex-ai-studio',
        message: 'Yandex AI Studio adapter is disabled or incompletely configured',
      });
  }
}

function normalizedBaseUrl(config: YandexAiStudioConfig): string {
  const value = config.baseUrl ?? DEFAULT_BASE_URL;
  return value.endsWith('/') ? value : `${value}/`;
}

function selectModel(request: AiRequest, config: YandexAiStudioConfig): string {
  const configured = [
    config.aliceFlashModelUri,
    config.aliceModelUri,
    config.yandexGptProModelUri,
  ].filter((model): model is string => Boolean(model));
  const allowed = request.modelPolicy.allowedModels.filter((model) => configured.includes(model));
  const selected = request.modelPolicy.preferredModel;
  if (selected && allowed.includes(selected)) return selected;
  if (allowed[0]) return allowed[0];
  throw new ProviderError({
    kind: 'permanent',
    provider: 'yandex-ai-studio',
    message: 'No requested model is enabled in Yandex configuration',
  });
}

function normalizeHttpError(status: number): ProviderError {
  if (status === 408 || status === 504)
    return new ProviderError({
      kind: 'timeout',
      provider: 'yandex-ai-studio',
      message: 'Provider request timed out',
      statusCode: status,
    });
  if (status === 429 || status === 503 || status >= 500)
    return new ProviderError({
      kind: 'retryable',
      provider: 'yandex-ai-studio',
      message: 'Provider is temporarily unavailable',
      statusCode: status,
    });
  return new ProviderError({
    kind: 'permanent',
    provider: 'yandex-ai-studio',
    message: 'Provider rejected the request',
    statusCode: status,
  });
}

function extractContent(value: unknown): string {
  if (!value || typeof value !== 'object') throw invalidResponse();
  const choices = (value as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length !== 1) throw invalidResponse();
  const content = (choices[0] as { message?: { content?: unknown } } | undefined)?.message?.content;
  if (typeof content !== 'string') throw invalidResponse();
  return content;
}

function invalidResponse(): ProviderError {
  return new ProviderError({
    kind: 'permanent',
    provider: 'yandex-ai-studio',
    message: 'Provider returned an invalid response shape',
  });
}

function normalizeUsage(value: unknown): Usage {
  if (!value || typeof value !== 'object') return emptyUsage();
  const usage = value as {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    total_tokens?: unknown;
  };
  const token = (candidate: unknown): number | null =>
    typeof candidate === 'number' && candidate >= 0 ? candidate : null;
  return {
    inputTokens: token(usage.prompt_tokens),
    outputTokens: token(usage.completion_tokens),
    totalTokens: token(usage.total_tokens),
  };
}
