import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  actualAiCost,
  blockedBenchmark,
  budgetPolicyFromEnvironment,
  estimateWorstCaseCost,
  pricingCatalogFromEnvironment,
  runBenchmark,
  unknownCost,
  YandexAiStudioProvider,
  yandexAiStudioConfigFromEnvironment,
  type AiProvider,
  type AiRequest,
  type AiResult,
  type BenchmarkDataset,
  type BenchmarkModel,
  type BenchmarkResult,
  type StructuredAiRequest,
} from '../packages/ai/src/index.ts';
import { PostgresAiUsageLedger } from '../packages/domain/src/ai-usage-ledger.ts';
import { Pool } from 'pg';

const providerName = 'yandex-ai-studio';
const datasetPath = resolve(process.cwd(), 'packages/ai/benchmark/datasets/model-policy-v1.json');
const outputDirectory = resolve(
  process.cwd(),
  process.env.BENCHMARK_OUTPUT_DIR ?? 'artifacts/benchmarks/latest',
);

function positiveNumber(value: string | undefined): number | null {
  if (!value?.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function benchmarkModels(env: NodeJS.ProcessEnv): BenchmarkModel[] {
  const definitions: readonly [BenchmarkModel['id'], string, string][] = [
    ['alice-ai-llm-flash', 'Alice AI LLM Flash', 'YANDEX_MODEL_ALICE_FLASH_URI'],
    ['alice-ai-llm', 'Alice AI LLM', 'YANDEX_MODEL_ALICE_URI'],
    ['yandexgpt-pro-5.1', 'YandexGPT Pro 5.1', 'YANDEX_MODEL_YANDEXGPT_PRO_5_1_URI'],
  ];
  return definitions.map(([id, displayName, variable]) => {
    const configuredUri = env[variable]?.trim();
    const modelUri = configuredUri && configuredUri.length > 0 ? configuredUri : null;
    return modelUri
      ? { id, displayName, modelUri, availability: 'CONFIGURED' }
      : {
          id,
          displayName,
          modelUri: null,
          availability: 'UNAVAILABLE',
          unavailableReason: `Missing ${variable}; account/catalog access is unconfirmed.`,
        };
  });
}

function blockedReasons(input: {
  env: NodeJS.ProcessEnv;
  models: readonly BenchmarkModel[];
  runCount: number;
  dataset: BenchmarkDataset;
}): string[] {
  const reasons: string[] = [];
  const env = input.env;
  if (env.YANDEX_AI_MODE !== 'enabled') reasons.push('YANDEX_AI_MODE must be enabled.');
  if (!env.YANDEX_FOLDER_ID) reasons.push('Missing YANDEX_FOLDER_ID.');
  if (!env.YANDEX_API_KEY) reasons.push('Missing YANDEX_API_KEY.');
  if (!env.DATABASE_URL)
    reasons.push('Missing DATABASE_URL required by the Prompt 37 budget ledger.');
  if (input.models.some((model) => model.availability === 'UNAVAILABLE'))
    reasons.push(
      'At least one required benchmark model URI is absent; unavailable models are not substituted.',
    );
  const confirmed = new Set(
    (env.BENCHMARK_CONFIRMED_MODEL_URIS ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  );
  if (input.models.some((model) => !model.modelUri || !confirmed.has(model.modelUri)))
    reasons.push(
      'All model URIs need account/catalog confirmation in BENCHMARK_CONFIRMED_MODEL_URIS.',
    );
  const testBudget = positiveNumber(env.BENCHMARK_TEST_BUDGET);
  if (testBudget === null) reasons.push('Missing positive BENCHMARK_TEST_BUDGET.');
  if (input.runCount < 2) reasons.push('BENCHMARK_RUNS must be at least 2 for live benchmarking.');
  let pricing = null;
  try {
    pricing = pricingCatalogFromEnvironment(env);
  } catch (error) {
    reasons.push(error instanceof Error ? error.message : 'Invalid AI pricing catalog.');
  }
  if (!pricing) reasons.push('Missing AI_PRICING_CONFIG_JSON.');
  let policy = null;
  try {
    policy = budgetPolicyFromEnvironment(env);
  } catch (error) {
    reasons.push(error instanceof Error ? error.message : 'Invalid AI budget policy.');
  }
  if (policy?.mode !== 'enabled' || !policy.maxOperationCost || !policy.dailyAiBudget)
    reasons.push('Prompt 37 budget guard must be enabled with operation and daily limits.');
  const dailyBudget = policy?.dailyAiBudget;
  if (
    testBudget !== null &&
    dailyBudget !== null &&
    dailyBudget !== undefined &&
    testBudget > dailyBudget
  )
    reasons.push('BENCHMARK_TEST_BUDGET must not exceed DAILY_AI_BUDGET.');
  if (pricing) {
    for (const model of input.models) {
      if (
        model.modelUri &&
        !pricing.models.some((row) => row.provider === providerName && row.model === model.modelUri)
      )
        reasons.push(`Pricing is missing for ${model.displayName}.`);
    }
    if (testBudget !== null) {
      const ceiling = input.models.reduce((total, model) => {
        const modelUri = model.modelUri;
        if (!modelUri) return total;
        const estimate = estimateWorstCaseCost(pricing, providerName, {
          prompt: '',
          maxInputTokens: 4_000,
          maxOutputTokens: 600,
          modelPolicy: { allowedModels: [modelUri], preferredModel: modelUri },
        });
        return (
          total + (estimate?.totalCost ?? Infinity) * input.dataset.cases.length * input.runCount
        );
      }, 0);
      if (ceiling > testBudget)
        reasons.push('BENCHMARK_TEST_BUDGET is below the benchmark worst-case reservation.');
    }
  }
  return [...new Set(reasons)];
}

class LedgerGuardedProvider implements AiProvider {
  private sequence = 0;

  constructor(
    private readonly provider: AiProvider,
    private readonly ledger: PostgresAiUsageLedger,
    private readonly pricing: NonNullable<ReturnType<typeof pricingCatalogFromEnvironment>>,
    private readonly model: BenchmarkModel,
  ) {}

  generateText(request: AiRequest): Promise<AiResult<string>> {
    return this.provider.generateText(request);
  }

  async generateStructured<T>(request: StructuredAiRequest): Promise<AiResult<T>> {
    const reservation = await this.ledger.preflight({
      request,
      provider: providerName,
      operationIdentity: `benchmark:${this.model.id}:${String((this.sequence += 1))}`,
      provenance: { benchmark: true, dataset: 'model-policy-eval-v1' },
    });
    if (reservation.kind !== 'RESERVED')
      throw new Error(
        `Budget guard did not reserve benchmark request: ${reservation.kind === 'DENIED' ? reservation.reason : reservation.kind}`,
      );
    try {
      const result = await this.provider.generateStructured<T>(request);
      await this.ledger.reconcile({
        entryId: reservation.entry.id,
        result,
        provider: providerName,
      });
      const actual = actualAiCost(this.pricing, providerName, result.model, result.usage);
      return {
        ...result,
        cost: actual ? { amount: actual.totalCost, currency: actual.currency } : unknownCost(),
      };
    } catch (error) {
      await this.ledger.markProviderFailure(reservation.entry.id);
      throw error;
    }
  }
}

function markdown(result: BenchmarkResult): string {
  const lines = [
    '# Model benchmark report',
    '',
    `- Status: **${result.status}**`,
    `- Dataset: \`${result.dataset.id}\` / \`${result.dataset.version}\``,
    `- Prompt templates: \`${result.dataset.promptTemplateVersion}\``,
    `- Run count: ${String(result.runCount)}`,
    `- Provider: \`${result.provider}\``,
    `- Actual AI spend: ${result.actualAiSpend.amount === null ? 'not measured' : `${String(result.actualAiSpend.amount)} ${result.actualAiSpend.currency ?? ''}`}`,
    '',
    '## Models',
    '',
    '| Model | URI state | Note |',
    '| --- | --- | --- |',
    ...result.models.map(
      (model) =>
        `| ${model.displayName} | ${model.availability} | ${model.unavailableReason ?? 'URI configured; live availability is established only by a completed guarded run.'} |`,
    ),
    '',
    '## Rejection thresholds',
    '',
    `- schema validity: ${String(result.thresholds.schemaValidityRate)}`,
    `- domain validity: ${String(result.thresholds.domainValidityRate)}`,
    `- source fidelity: ${String(result.thresholds.sourceFidelityRate)}`,
    `- median latency: ${String(result.thresholds.maxMedianLatencyMs)} ms`,
    '',
    '## Metrics',
    '',
    '- Schema validity, domain validity, source fidelity, latency, input/output token usage, and cost are recorded per invocation and aggregated by model and operation.',
    '- Rubric agreement and quality are `NOT_MEASURABLE` until an approved rubric is supplied; no substitute quality score is invented.',
    '',
  ];
  if (result.status === 'BLOCKED_EXTERNAL_INPUT') {
    lines.push(
      '## Blocked external inputs',
      '',
      ...result.blockedReasons.map((reason) => `- ${reason}`),
      '',
      '## Rejected configurations',
      '',
      '- All live configurations were rejected before provider invocation because the required external inputs were incomplete.',
      '',
      '## ModelPolicy',
      '',
      'No live model was called and no winner or ModelPolicy was selected.',
    );
    return lines.join('\n');
  }
  lines.push(
    '## Aggregates',
    '',
    '| Model | Operation | Schema | Domain | Source fidelity | Median latency | Cost | Rejected |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  );
  for (const aggregate of result.aggregates) {
    lines.push(
      `| ${aggregate.model.displayName} | ${aggregate.operationKind} | ${String(aggregate.schemaValidityRate ?? 'n/a')} | ${String(aggregate.domainValidityRate ?? 'n/a')} | ${String(aggregate.sourceFidelityRate ?? 'n/a')} | ${String(aggregate.latency.medianMs ?? 'n/a')} | ${String(aggregate.cost.amount ?? 'n/a')} ${aggregate.cost.currency ?? ''} | ${aggregate.rejectedReasons.length > 0 ? aggregate.rejectedReasons.join(', ') : 'no'} |`,
    );
  }
  lines.push(
    '',
    'Rubric agreement and quality are `NOT_MEASURABLE`: no approved evaluation rubric is present in this repository. ModelPolicy is selected only for operations meeting every applicable mandatory threshold; price is not a passing criterion.',
  );
  return lines.join('\n');
}

async function main(): Promise<void> {
  const dataset = JSON.parse(await readFile(datasetPath, 'utf8')) as BenchmarkDataset;
  const runCount = Number(process.env.BENCHMARK_RUNS ?? '2');
  const models = benchmarkModels(process.env);
  const reasons = blockedReasons({ env: process.env, models, runCount, dataset });
  let result: BenchmarkResult;
  if (reasons.length > 0) {
    result = blockedBenchmark({ dataset, models, runCount, blockedReasons: reasons });
  } else {
    const pricing = pricingCatalogFromEnvironment(process.env);
    const policy = budgetPolicyFromEnvironment(process.env);
    if (!pricing || policy.mode !== 'enabled')
      throw new Error('Live benchmark preconditions unexpectedly changed.');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const ledger = new PostgresAiUsageLedger(pool, pricing, policy);
    const config = yandexAiStudioConfigFromEnvironment(process.env);
    try {
      result = await runBenchmark({
        dataset,
        models,
        runCount,
        providerForModel: (model) =>
          new LedgerGuardedProvider(new YandexAiStudioProvider(config), ledger, pricing, model),
      });
    } finally {
      await pool.end();
    }
  }
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(
    resolve(outputDirectory, 'benchmark-results.json'),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  await writeFile(resolve(outputDirectory, 'benchmark-report.md'), `${markdown(result)}\n`);
  process.stdout.write(`${result.status}: ${outputDirectory}\n`);
}

void main();
