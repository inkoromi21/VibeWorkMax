import {
  buildStructuredTemplateRequest,
  promptTemplates,
  validateStructuredTemplateOutput,
  type PromptTemplateId,
} from './prompts.js';
import { actualAiCost, estimateInputTokens, type AiPricingCatalog } from './pricing.js';
import type { AiProvider, AiResult, ModelPolicy, Usage } from './port.js';

export const BENCHMARK_RESULT_VERSION = 'v1' as const;
export const BENCHMARK_PROVIDER = 'yandex-ai-studio' as const;
export const BENCHMARK_MAX_INPUT_TOKENS = 600;
export const BENCHMARK_MAX_OUTPUT_TOKENS = 200;

export type BenchmarkModelId = 'alice-ai-llm-flash' | 'alice-ai-llm' | 'yandexgpt-pro-5.1';
export type BenchmarkRunStatus = 'COMPLETED' | 'BLOCKED_EXTERNAL_INPUT';
export type MeasurementStatus = 'MEASURED' | 'NOT_APPLICABLE' | 'NOT_MEASURABLE';

export interface BenchmarkModel {
  id: BenchmarkModelId;
  displayName: string;
  modelUri: string | null;
  availability: 'CONFIGURED' | 'UNAVAILABLE';
  unavailableReason?: string;
}

export interface BenchmarkCase {
  id: string;
  requestType: 'DIRECTION' | 'KNOWLEDGE_GAP' | 'SKILL' | 'PRACTICE_READINESS';
  templateId: PromptTemplateId;
  userInput: unknown;
  approvedContext: Record<string, unknown>;
  domainContext: { allowedIds: readonly string[]; allowedUrls: readonly string[] };
  expectedOutput: Record<string, unknown>;
  sourceExpectation:
    | { status: 'NOT_APPLICABLE' }
    | { status: 'REQUIRED'; referenceIds: readonly string[]; urls: readonly string[] };
  rubric: { status: 'NOT_MEASURABLE'; reason: string };
}

export interface BenchmarkDataset {
  id: string;
  version: string;
  promptTemplateVersion: string;
  cases: readonly BenchmarkCase[];
}

export interface BenchmarkThresholds {
  schemaValidityRate: number;
  domainValidityRate: number;
  sourceFidelityRate: number;
  maxMedianLatencyMs: number;
}

export const DEFAULT_BENCHMARK_THRESHOLDS: BenchmarkThresholds = {
  schemaValidityRate: 1,
  domainValidityRate: 1,
  sourceFidelityRate: 1,
  maxMedianLatencyMs: 15_000,
};

export interface BenchmarkInvocation {
  model: BenchmarkModel;
  caseId: string;
  run: number;
  operationKind: string;
  promptVersion: string;
  schemaVersion: string;
  status: 'SUCCEEDED' | 'FAILED';
  schemaValid: boolean | null;
  domainValid: boolean | null;
  sourceFidelity: boolean | null;
  rubricAgreement: MeasurementStatus;
  quality: MeasurementStatus;
  latencyMs: number | null;
  usage: Usage | null;
  cost: { amount: number | null; currency: string | null } | null;
  providerRequestId: string | null;
  output: Record<string, unknown> | null;
  error: string | null;
}

export interface BenchmarkAggregate {
  model: BenchmarkModel;
  operationKind: string;
  invocationCount: number;
  schemaValidityRate: number | null;
  domainValidityRate: number | null;
  sourceFidelityRate: number | null;
  rubricAgreement: MeasurementStatus;
  quality: MeasurementStatus;
  latency: {
    minMs: number | null;
    medianMs: number | null;
    maxMs: number | null;
    rangeMs: number | null;
  };
  usage: { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null };
  cost: { amount: number | null; currency: string | null };
  rejectedReasons: readonly string[];
}

export interface BenchmarkResult {
  formatVersion: typeof BENCHMARK_RESULT_VERSION;
  status: BenchmarkRunStatus;
  dataset: { id: string; version: string; promptTemplateVersion: string };
  runCount: number;
  provider: string;
  models: readonly BenchmarkModel[];
  thresholds: BenchmarkThresholds;
  invocations: readonly BenchmarkInvocation[];
  aggregates: readonly BenchmarkAggregate[];
  modelPolicy: {
    status: 'NOT_SELECTED' | 'SELECTED';
    byOperationKind: Record<string, ModelPolicy>;
  };
  actualAiSpend: { amount: number | null; currency: string | null };
  blockedReasons: readonly string[];
  pricingVersion?: string;
  costReconciliation?: 'RECORDED_USAGE_REQUESTED_MODEL';
}

function validRate(values: readonly (boolean | null)[]): number | null {
  const measured = values.filter((value): value is boolean => value !== null);
  return measured.length === 0 ? null : measured.filter(Boolean).length / measured.length;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  const lower = ordered[middle];
  if (lower === undefined) return null;
  return ordered.length % 2 === 1 ? lower : (lower + (ordered[middle - 1] ?? lower)) / 2;
}

function strings(value: unknown): readonly string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : null;
}

function isSubset(actual: readonly string[], allowed: ReadonlySet<string>): boolean {
  return actual.every((value) => allowed.has(value));
}

export function validateBenchmarkDomain(
  value: Record<string, unknown>,
  context: BenchmarkCase['domainContext'],
): boolean {
  const allowedIds = new Set(context.allowedIds);
  const allowedUrls = new Set(context.allowedUrls);
  for (const [key, candidate] of Object.entries(value)) {
    if (key.endsWith('Ids')) {
      const ids = strings(candidate);
      if (!ids || !isSubset(ids, allowedIds)) return false;
    }
    if (key === 'urls') {
      const urls = strings(candidate);
      if (!urls || !isSubset(urls, allowedUrls)) return false;
    }
  }
  return true;
}

export function validateSourceFidelity(
  value: Record<string, unknown>,
  expectation: BenchmarkCase['sourceExpectation'],
): boolean | null {
  if (expectation.status === 'NOT_APPLICABLE') return null;
  const referenceIds = strings(value.referenceIds);
  const urls = strings(value.urls);
  return (
    referenceIds !== null &&
    urls !== null &&
    expectation.referenceIds.every((id) => referenceIds.includes(id)) &&
    expectation.urls.every((url) => urls.includes(url))
  );
}

function invocationFromResult(
  input: { model: BenchmarkModel; case: BenchmarkCase; run: number },
  result: AiResult<Record<string, unknown>>,
): BenchmarkInvocation {
  const schema = validateStructuredTemplateOutput(input.case.templateId, result.value);
  const value = schema.valid ? schema.value : null;
  return {
    model: input.model,
    caseId: input.case.id,
    run: input.run,
    operationKind: promptTemplates[input.case.templateId].operationKind,
    promptVersion: `${input.case.templateId}-${promptTemplates[input.case.templateId].version}`,
    schemaVersion: promptTemplates[input.case.templateId].schemaVersion,
    status: 'SUCCEEDED',
    schemaValid: schema.valid,
    domainValid: value === null ? null : validateBenchmarkDomain(value, input.case.domainContext),
    sourceFidelity:
      value === null ? null : validateSourceFidelity(value, input.case.sourceExpectation),
    rubricAgreement: 'NOT_MEASURABLE',
    quality: 'NOT_MEASURABLE',
    latencyMs: result.latencyMs,
    usage: result.usage,
    cost: result.cost,
    providerRequestId: result.providerRequestId,
    output: result.value,
    error: null,
  };
}

function failedInvocation(input: {
  model: BenchmarkModel;
  case: BenchmarkCase;
  run: number;
  error: unknown;
}): BenchmarkInvocation {
  const template = promptTemplates[input.case.templateId];
  return {
    model: input.model,
    caseId: input.case.id,
    run: input.run,
    operationKind: template.operationKind,
    promptVersion: `${input.case.templateId}-${template.version}`,
    schemaVersion: template.schemaVersion,
    status: 'FAILED',
    schemaValid: null,
    domainValid: null,
    sourceFidelity: null,
    rubricAgreement: 'NOT_MEASURABLE',
    quality: 'NOT_MEASURABLE',
    latencyMs: null,
    usage: null,
    cost: null,
    providerRequestId: null,
    output: null,
    error: input.error instanceof Error ? input.error.message : 'Unknown benchmark provider error',
  };
}

function aggregate(input: {
  model: BenchmarkModel;
  operationKind: string;
  invocations: readonly BenchmarkInvocation[];
  thresholds: BenchmarkThresholds;
}): BenchmarkAggregate {
  const schemaValidityRate = validRate(input.invocations.map((row) => row.schemaValid));
  const domainValidityRate = validRate(input.invocations.map((row) => row.domainValid));
  const sourceFidelityRate = validRate(input.invocations.map((row) => row.sourceFidelity));
  const latencies = input.invocations.flatMap((row) =>
    row.latencyMs === null ? [] : [row.latencyMs],
  );
  const minMs = latencies.length === 0 ? null : Math.min(...latencies);
  const maxMs = latencies.length === 0 ? null : Math.max(...latencies);
  const medianMs = median(latencies);
  const usages = input.invocations.flatMap((row) => (row.usage === null ? [] : [row.usage]));
  const costs = input.invocations.flatMap((row) =>
    row.cost?.amount === null || row.cost === null ? [] : [row.cost],
  );
  const currencies = new Set(
    costs.map((cost) => cost.currency).filter((currency): currency is string => currency !== null),
  );
  const rejectedReasons: string[] = [];
  if (schemaValidityRate === null || schemaValidityRate < input.thresholds.schemaValidityRate)
    rejectedReasons.push('SCHEMA_VALIDITY_THRESHOLD');
  if (domainValidityRate === null || domainValidityRate < input.thresholds.domainValidityRate)
    rejectedReasons.push('DOMAIN_VALIDITY_THRESHOLD');
  if (sourceFidelityRate !== null && sourceFidelityRate < input.thresholds.sourceFidelityRate)
    rejectedReasons.push('SOURCE_FIDELITY_THRESHOLD');
  if (medianMs === null || medianMs > input.thresholds.maxMedianLatencyMs)
    rejectedReasons.push('LATENCY_THRESHOLD');
  if (input.invocations.some((row) => row.rubricAgreement === 'NOT_MEASURABLE'))
    rejectedReasons.push('RUBRIC_AGREEMENT_NOT_MEASURABLE');
  if (input.invocations.some((row) => row.quality === 'NOT_MEASURABLE'))
    rejectedReasons.push('QUALITY_NOT_MEASURABLE');
  if (input.invocations.some((row) => row.status === 'FAILED'))
    rejectedReasons.push('PROVIDER_FAILURE');
  return {
    model: input.model,
    operationKind: input.operationKind,
    invocationCount: input.invocations.length,
    schemaValidityRate,
    domainValidityRate,
    sourceFidelityRate,
    rubricAgreement: 'NOT_MEASURABLE',
    quality: 'NOT_MEASURABLE',
    latency: {
      minMs,
      medianMs,
      maxMs,
      rangeMs: minMs === null || maxMs === null ? null : maxMs - minMs,
    },
    usage: {
      inputTokens:
        usages.length === 0 ? null : usages.reduce((sum, row) => sum + (row.inputTokens ?? 0), 0),
      outputTokens:
        usages.length === 0 ? null : usages.reduce((sum, row) => sum + (row.outputTokens ?? 0), 0),
      totalTokens:
        usages.length === 0 ? null : usages.reduce((sum, row) => sum + (row.totalTokens ?? 0), 0),
    },
    cost: {
      amount:
        costs.length === 0 || currencies.size !== 1
          ? null
          : costs.reduce((sum, row) => sum + (row.amount ?? 0), 0),
      currency: currencies.size === 1 ? ([...currencies][0] ?? null) : null,
    },
    rejectedReasons,
  };
}

export async function runBenchmark(input: {
  dataset: BenchmarkDataset;
  models: readonly BenchmarkModel[];
  runCount: number;
  providerForModel: (model: BenchmarkModel) => AiProvider;
  thresholds?: BenchmarkThresholds;
}): Promise<BenchmarkResult> {
  if (!Number.isInteger(input.runCount) || input.runCount < 1)
    throw new Error('Benchmark runCount must be positive');
  if (input.dataset.promptTemplateVersion !== 'v1')
    throw new Error('Dataset prompt template version does not match installed templates');
  for (const benchmarkCase of input.dataset.cases) {
    const template = promptTemplates[benchmarkCase.templateId];
    const request = buildStructuredTemplateRequest({
      templateId: benchmarkCase.templateId,
      approvedContext: benchmarkCase.approvedContext,
      userInput: benchmarkCase.userInput,
      deadlineMs: 10_000,
      maxInputTokens: BENCHMARK_MAX_INPUT_TOKENS,
      maxOutputTokens: BENCHMARK_MAX_OUTPUT_TOKENS,
      modelPolicy: { allowedModels: ['preflight'] },
    });
    if (
      estimateInputTokens(request.prompt + JSON.stringify(template.schema)) >
      BENCHMARK_MAX_INPUT_TOKENS
    )
      throw new Error(`Benchmark case ${benchmarkCase.id} exceeds input token reservation`);
  }
  const thresholds = input.thresholds ?? DEFAULT_BENCHMARK_THRESHOLDS;
  const invocations: BenchmarkInvocation[] = [];
  for (const model of input.models) {
    if (model.availability === 'UNAVAILABLE') continue;
    const provider = input.providerForModel(model);
    for (let run = 1; run <= input.runCount; run += 1) {
      for (const benchmarkCase of input.dataset.cases) {
        const request = buildStructuredTemplateRequest({
          templateId: benchmarkCase.templateId,
          approvedContext: benchmarkCase.approvedContext,
          userInput: benchmarkCase.userInput,
          deadlineMs: 10_000,
          maxInputTokens: BENCHMARK_MAX_INPUT_TOKENS,
          maxOutputTokens: BENCHMARK_MAX_OUTPUT_TOKENS,
          modelPolicy: {
            allowedModels: [model.modelUri ?? 'unavailable'],
            preferredModel: model.modelUri ?? 'unavailable',
          },
        });
        try {
          const result = await provider.generateStructured<Record<string, unknown>>(request);
          invocations.push(invocationFromResult({ model, case: benchmarkCase, run }, result));
        } catch (error) {
          invocations.push(failedInvocation({ model, case: benchmarkCase, run, error }));
        }
      }
    }
  }
  const aggregates = input.models.flatMap((model) => {
    if (model.availability === 'UNAVAILABLE') return [];
    return [
      ...new Set(
        input.dataset.cases.map(
          (benchmarkCase) => promptTemplates[benchmarkCase.templateId].operationKind,
        ),
      ),
    ].map((operationKind) =>
      aggregate({
        model,
        operationKind,
        invocations: invocations.filter(
          (row) => row.model.id === model.id && row.operationKind === operationKind,
        ),
        thresholds,
      }),
    );
  });
  const costs = invocations.flatMap((row) =>
    row.cost?.amount === null || row.cost === null ? [] : [row.cost],
  );
  const currencies = new Set(
    costs.map((cost) => cost.currency).filter((currency): currency is string => currency !== null),
  );
  const policy: Record<string, ModelPolicy> = {};
  for (const row of aggregates) {
    if (row.rejectedReasons.length === 0 && !policy[row.operationKind])
      policy[row.operationKind] = row.model.modelUri
        ? { allowedModels: [row.model.modelUri], preferredModel: row.model.modelUri }
        : { allowedModels: [] };
  }
  return {
    formatVersion: BENCHMARK_RESULT_VERSION,
    status: 'COMPLETED',
    dataset: {
      id: input.dataset.id,
      version: input.dataset.version,
      promptTemplateVersion: input.dataset.promptTemplateVersion,
    },
    runCount: input.runCount,
    provider: BENCHMARK_PROVIDER,
    models: input.models,
    thresholds,
    invocations,
    aggregates,
    modelPolicy: {
      status: Object.keys(policy).length === 0 ? 'NOT_SELECTED' : 'SELECTED',
      byOperationKind: policy,
    },
    actualAiSpend: {
      amount:
        costs.length === 0 || currencies.size !== 1
          ? null
          : costs.reduce((sum, row) => sum + (row.amount ?? 0), 0),
      currency: currencies.size === 1 ? ([...currencies][0] ?? null) : null,
    },
    blockedReasons: [],
  };
}

export function blockedBenchmark(input: {
  dataset: BenchmarkDataset;
  models: readonly BenchmarkModel[];
  runCount: number;
  blockedReasons: readonly string[];
  thresholds?: BenchmarkThresholds;
}): BenchmarkResult {
  return {
    formatVersion: BENCHMARK_RESULT_VERSION,
    status: 'BLOCKED_EXTERNAL_INPUT',
    dataset: {
      id: input.dataset.id,
      version: input.dataset.version,
      promptTemplateVersion: input.dataset.promptTemplateVersion,
    },
    runCount: input.runCount,
    provider: BENCHMARK_PROVIDER,
    models: input.models,
    thresholds: input.thresholds ?? DEFAULT_BENCHMARK_THRESHOLDS,
    invocations: [],
    aggregates: [],
    modelPolicy: { status: 'NOT_SELECTED', byOperationKind: {} },
    actualAiSpend: { amount: null, currency: null },
    blockedReasons: input.blockedReasons,
  };
}

/** Repair older reports when AI Studio returned a generic model alias. */
export function repriceBenchmarkFromRecordedUsage(
  result: BenchmarkResult,
  pricing: AiPricingCatalog,
): BenchmarkResult {
  if (result.status !== 'COMPLETED' || result.provider !== BENCHMARK_PROVIDER)
    throw new Error('Only completed Yandex benchmark reports can be repriced');
  const invocations = result.invocations.map((row) => {
    if (row.status === 'FAILED') return row;
    if (!row.model.modelUri || !row.usage)
      throw new Error(`Missing requested model or usage for ${row.caseId}`);
    const cost = actualAiCost(pricing, result.provider, row.model.modelUri, row.usage);
    if (!cost) throw new Error(`Missing tariff or token usage for ${row.caseId}`);
    return { ...row, cost: { amount: cost.totalCost, currency: cost.currency } };
  });
  const aggregates = result.aggregates.map((row) =>
    aggregate({
      model: row.model,
      operationKind: row.operationKind,
      invocations: invocations.filter(
        (invocation) =>
          invocation.model.id === row.model.id && invocation.operationKind === row.operationKind,
      ),
      thresholds: result.thresholds,
    }),
  );
  const amount = invocations.reduce((sum, row) => sum + (row.cost?.amount ?? 0), 0);
  return {
    ...result,
    invocations,
    aggregates,
    actualAiSpend: { amount, currency: pricing.currency },
    pricingVersion: pricing.version,
    costReconciliation: 'RECORDED_USAGE_REQUESTED_MODEL',
  };
}
