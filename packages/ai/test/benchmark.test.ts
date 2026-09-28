import { describe, expect, it } from 'vitest';
import dataset from '../benchmark/datasets/model-policy-v1.json' with { type: 'json' };
import {
  FakeAiProvider,
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
    expect(result.aggregates.every((row) => row.schemaValidityRate === 1)).toBe(true);
    expect(result.aggregates.every((row) => row.domainValidityRate === 1)).toBe(true);
    expect(
      result.aggregates.find((row) => row.operationKind === 'explanation')?.sourceFidelityRate,
    ).toBe(1);
    expect(result.aggregates.every((row) => row.rubricAgreement === 'NOT_MEASURABLE')).toBe(true);
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
});
