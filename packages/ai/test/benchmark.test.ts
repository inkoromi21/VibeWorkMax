import { describe, expect, it } from 'vitest';
import dataset from '../benchmark/datasets/model-policy-v1.json' with { type: 'json' };
import {
  FakeAiProvider,
  repriceBenchmarkFromRecordedUsage,
  runBenchmark,
  type BenchmarkDataset,
  type BenchmarkModel,
} from '../src/index.js';

const evalDataset = dataset as BenchmarkDataset;
const model: BenchmarkModel = {
  id: 'alice-ai-llm-flash',
  displayName: 'Alice AI LLM Flash',
  modelUri: 'fake/alice-flash',
  availability: 'CONFIGURED',
};

describe('model benchmark harness', () => {
  it('uses identical repeated requests and aggregates synthetic source/domain/schema measurements', async () => {
    const scenarios = Array.from({ length: evalDataset.cases.length * 2 }, (_, index) => ({
      type: 'structured' as const,
      value: evalDataset.cases[index % evalDataset.cases.length]?.expectedOutput ?? {},
      model: 'fake/alice-flash',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    }));
    const result = await runBenchmark({
      dataset: evalDataset,
      models: [model],
      runCount: 2,
      providerForModel: () => new FakeAiProvider(scenarios),
    });
    expect(result.status).toBe('COMPLETED');
    expect(result.invocations).toHaveLength(evalDataset.cases.length * 2);
    expect(result.invocations.every((row) => row.output !== null)).toBe(true);
    expect(result.aggregates.every((row) => row.schemaValidityRate === 1)).toBe(true);
    expect(result.aggregates.every((row) => row.domainValidityRate === 1)).toBe(true);
    expect(
      result.aggregates.find((row) => row.operationKind === 'explanation')?.sourceFidelityRate,
    ).toBe(1);
    expect(result.aggregates.every((row) => row.rubricAgreement === 'NOT_MEASURABLE')).toBe(true);
    expect(
      result.aggregates.every((row) =>
        row.rejectedReasons.includes('RUBRIC_AGREEMENT_NOT_MEASURABLE'),
      ),
    ).toBe(true);
    expect(result.modelPolicy.status).toBe('NOT_SELECTED');
  });

  it('rejects invalid structured output even when its price and latency are not measured', async () => {
    const firstCase = evalDataset.cases[0];
    if (!firstCase) throw new Error('Benchmark dataset must contain one case');
    const result = await runBenchmark({
      dataset: { ...evalDataset, cases: [firstCase] },
      models: [model],
      runCount: 1,
      providerForModel: () => new FakeAiProvider([{ type: 'structured', value: { wrong: true } }]),
    });
    expect(result.aggregates[0]?.rejectedReasons).toContain('SCHEMA_VALIDITY_THRESHOLD');
    expect(result.modelPolicy.status).toBe('NOT_SELECTED');
  });

  it('rejects an oversized case before any provider request', async () => {
    const firstCase = evalDataset.cases[0];
    if (!firstCase) throw new Error('Benchmark dataset must contain one case');
    let providerCalls = 0;
    await expect(
      runBenchmark({
        dataset: {
          ...evalDataset,
          cases: [{ ...firstCase, userInput: 'очень длинный запрос '.repeat(200) }],
        },
        models: [model],
        runCount: 2,
        providerForModel: () => {
          providerCalls += 1;
          return new FakeAiProvider([]);
        },
      }),
    ).rejects.toThrow('exceeds input token reservation');
    expect(providerCalls).toBe(0);
  });

  it('reconciles a provider model alias using recorded usage and requested URI', async () => {
    const firstCase = evalDataset.cases[0];
    if (!firstCase) throw new Error('Benchmark dataset must contain one case');
    const result = await runBenchmark({
      dataset: { ...evalDataset, cases: [firstCase] },
      models: [model],
      runCount: 2,
      providerForModel: () =>
        new FakeAiProvider(
          Array.from({ length: 2 }, () => ({
            type: 'structured' as const,
            value: firstCase.expectedOutput,
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
            model: 'generic/latest',
          })),
        ),
    });
    const repriced = repriceBenchmarkFromRecordedUsage(result, {
      version: 'official-test-v1',
      currency: 'RUB',
      models: [
        {
          provider: 'yandex-ai-studio',
          model: 'fake/alice-flash',
          inputPerMillion: 100,
          outputPerMillion: 200,
        },
      ],
    });
    expect(repriced.actualAiSpend.amount).toBeCloseTo(0.004);
    expect(repriced.costReconciliation).toBe('RECORDED_USAGE_REQUESTED_MODEL');
    expect(repriced.aggregates[0]?.cost.amount).toBeCloseTo(0.004);
    expect(repriced.modelPolicy.status).toBe('NOT_SELECTED');
  });
});
