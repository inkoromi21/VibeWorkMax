import type { AiRequest, ModelPolicy, Usage } from './port.js';

export type AiBudgetMode = 'disabled' | 'configured-test' | 'enabled';

/**
 * Versioned operational data. Production values are supplied through the
 * environment; no provider tariff is embedded in domain behaviour.
 */
export interface AiPricingCatalog {
  version: string;
  currency: string;
  models: readonly AiModelPrice[];
}

export interface AiModelPrice {
  provider: string;
  model: string;
  inputPerMillion: number;
  outputPerMillion: number;
}

export interface AiBudgetPolicy {
  mode: AiBudgetMode;
  maxOperationCost: number | null;
  dailyAiBudget: number | null;
}

export interface AiCostEstimate {
  inputTokens: number;
  outputTokens: number;
  inputCost: number;
  outputCost: number;
  totalCost: number;
  currency: string;
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function positive(value: unknown): value is number {
  return finiteNonNegative(value) && value > 0;
}

export function assertPricingCatalog(value: unknown): asserts value is AiPricingCatalog {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('AI pricing catalog must be an object');
  const catalog = value as { version?: unknown; currency?: unknown; models?: unknown };
  if (typeof catalog.version !== 'string' || !catalog.version.trim())
    throw new Error('AI pricing catalog version is required');
  if (typeof catalog.currency !== 'string' || !/^[A-Z]{3}$/.test(catalog.currency))
    throw new Error('AI pricing catalog currency must be an ISO-like three-letter code');
  if (!Array.isArray(catalog.models) || catalog.models.length === 0)
    throw new Error('AI pricing catalog must contain at least one model tariff');
  const identities = new Set<string>();
  for (const row of catalog.models) {
    if (!row || typeof row !== 'object' || Array.isArray(row))
      throw new Error('AI model tariff requires provider and model');
    const tariff = row as Record<string, unknown>;
    if (
      typeof tariff.provider !== 'string' ||
      !tariff.provider.trim() ||
      typeof tariff.model !== 'string' ||
      !tariff.model.trim()
    )
      throw new Error('AI model tariff requires provider and model');
    if (!finiteNonNegative(tariff.inputPerMillion) || !finiteNonNegative(tariff.outputPerMillion))
      throw new Error('AI model tariff prices must be non-negative finite numbers');
    const identity = `${tariff.provider}\u0000${tariff.model}`;
    if (identities.has(identity))
      throw new Error('AI pricing catalog contains duplicate model tariff');
    identities.add(identity);
  }
}

export function pricingCatalogFromEnvironment(
  env: Record<string, string | undefined> = process.env,
): AiPricingCatalog | null {
  const raw = env.AI_PRICING_CONFIG_JSON;
  if (!raw?.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('AI_PRICING_CONFIG_JSON must be valid JSON');
  }
  assertPricingCatalog(parsed);
  return parsed;
}

function optionalPositiveNumber(value: string | undefined, name: string): number | null {
  if (!value?.trim()) return null;
  const parsed = Number(value);
  if (!positive(parsed))
    throw new Error(`${name} must be a positive finite number when configured`);
  return parsed;
}

/** Missing production limits deliberately leave the budget guard disabled. */
export function budgetPolicyFromEnvironment(
  env: Record<string, string | undefined> = process.env,
): AiBudgetPolicy {
  const requested = env.AI_BUDGET_MODE;
  const mode: AiBudgetMode =
    requested === 'enabled' || requested === 'configured-test' ? requested : 'disabled';
  const policy = {
    mode,
    maxOperationCost: optionalPositiveNumber(env.MAX_OPERATION_COST, 'MAX_OPERATION_COST'),
    dailyAiBudget: optionalPositiveNumber(env.DAILY_AI_BUDGET, 'DAILY_AI_BUDGET'),
  };
  if (mode === 'enabled' && (!policy.maxOperationCost || !policy.dailyAiBudget))
    throw new Error('Enabled AI budget policy requires MAX_OPERATION_COST and DAILY_AI_BUDGET');
  if (mode === 'configured-test' && env.NODE_ENV !== 'test')
    throw new Error('configured-test AI budget policy is permitted only when NODE_ENV=test');
  return policy;
}

export function priceFor(
  catalog: AiPricingCatalog,
  provider: string,
  model: string,
): AiModelPrice | null {
  return catalog.models.find((row) => row.provider === provider && row.model === model) ?? null;
}

/** Conservative byte-based estimate; actual provider usage replaces it after a response. */
export function estimateInputTokens(prompt: string): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(prompt, 'utf8') / 3));
}

export function selectedModel(policy: ModelPolicy): string {
  return policy.preferredModel ?? policy.allowedModels[0] ?? '';
}

export function estimateAiCost(input: {
  catalog: AiPricingCatalog;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}): AiCostEstimate | null {
  const price = priceFor(input.catalog, input.provider, input.model);
  if (!price || !finiteNonNegative(input.inputTokens) || !finiteNonNegative(input.outputTokens))
    return null;
  const inputCost = (input.inputTokens * price.inputPerMillion) / 1_000_000;
  const outputCost = (input.outputTokens * price.outputPerMillion) / 1_000_000;
  return {
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    inputCost,
    outputCost,
    totalCost: inputCost + outputCost,
    currency: input.catalog.currency,
  };
}

export function estimateWorstCaseCost(
  catalog: AiPricingCatalog,
  provider: string,
  request: Pick<AiRequest, 'prompt' | 'maxInputTokens' | 'maxOutputTokens' | 'modelPolicy'>,
): AiCostEstimate | null {
  // The input measurement is available via estimateInputTokens; admission uses
  // the configured ceiling, so a shorter current prompt cannot under-reserve.
  const inputTokens = request.maxInputTokens;
  return estimateAiCost({
    catalog,
    provider,
    model: selectedModel(request.modelPolicy),
    inputTokens,
    outputTokens: request.maxOutputTokens,
  });
}

export function actualAiCost(
  catalog: AiPricingCatalog,
  provider: string,
  model: string,
  usage: Usage,
): AiCostEstimate | null {
  if (usage.inputTokens === null || usage.outputTokens === null) return null;
  return estimateAiCost({
    catalog,
    provider,
    model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  });
}
