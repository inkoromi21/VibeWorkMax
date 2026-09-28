export type AiOperationKind = string;

export interface ModelPolicy {
  /** Only these configured model URIs may be selected by an adapter. */
  allowedModels: readonly string[];
  preferredModel?: string;
}

export interface Usage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

/** Providers do not always return a price, so absence is represented explicitly. */
export interface Cost {
  amount: number | null;
  currency: string | null;
}

export interface AiRequest {
  operationKind: AiOperationKind;
  promptVersion: string;
  prompt: string;
  deadlineMs: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  modelPolicy: ModelPolicy;
  /** A caller may opt in only for operations that are safe to repeat. */
  retrySafe?: boolean;
}

export interface StructuredAiRequest extends AiRequest {
  schema: Record<string, unknown>;
  schemaName: string;
}

export interface AiResult<T> {
  value: T;
  usage: Usage;
  cost: Cost;
  providerRequestId: string | null;
  model: string;
  latencyMs: number;
  metadata: Readonly<Record<string, string | number | boolean | null>>;
}

export type ProviderErrorKind = 'retryable' | 'permanent' | 'timeout';

/** Vendor-neutral failure: raw provider response and credentials never escape. */
export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly provider: string;
  readonly statusCode: number | null;

  constructor(input: {
    kind: ProviderErrorKind;
    provider: string;
    message: string;
    statusCode?: number | null;
    cause?: unknown;
  }) {
    super(input.message, { cause: input.cause });
    this.name = 'ProviderError';
    this.kind = input.kind;
    this.provider = input.provider;
    this.statusCode = input.statusCode ?? null;
  }
}

export interface AiProvider {
  generateText(request: AiRequest): Promise<AiResult<string>>;
  generateStructured<T>(request: StructuredAiRequest): Promise<AiResult<T>>;
}

export const emptyUsage = (): Usage => ({
  inputTokens: null,
  outputTokens: null,
  totalTokens: null,
});
export const unknownCost = (): Cost => ({ amount: null, currency: null });

export function assertRequestLimits(request: AiRequest): void {
  if (!request.operationKind.trim() || !request.promptVersion.trim())
    throw new ProviderError({
      kind: 'permanent',
      provider: 'configuration',
      message: 'AI operation kind and prompt version are required',
    });
  if (!request.prompt.trim() || request.maxInputTokens < 1 || request.maxOutputTokens < 1)
    throw new ProviderError({
      kind: 'permanent',
      provider: 'configuration',
      message: 'AI prompt and token ceilings must be positive',
    });
  if (
    !Number.isInteger(request.deadlineMs) ||
    request.deadlineMs < 1 ||
    request.deadlineMs > 30_000
  )
    throw new ProviderError({
      kind: 'permanent',
      provider: 'configuration',
      message: 'AI deadline must be between 1 and 30000 milliseconds',
    });
  if (request.modelPolicy.allowedModels.length === 0)
    throw new ProviderError({
      kind: 'permanent',
      provider: 'configuration',
      message: 'AI model policy must allow at least one model',
    });
}
