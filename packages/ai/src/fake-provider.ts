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

export type FakeProviderScenario =
  | { type: 'success'; text: string; model?: string; usage?: Usage }
  | { type: 'structured'; value: unknown; model?: string; usage?: Usage }
  | { type: 'retryable' }
  | { type: 'permanent' }
  | { type: 'timeout' };

/** Deterministic, network-free provider for unit and contract tests. */
export class FakeAiProvider implements AiProvider {
  private cursor = 0;
  constructor(private readonly scenarios: readonly FakeProviderScenario[]) {}

  generateText(request: AiRequest): Promise<AiResult<string>> {
    return Promise.resolve().then(() => {
      assertRequestLimits(request);
      const scenario = this.next();
      if (scenario.type !== 'success') this.fail(scenario);
      return this.result(scenario.text, scenario.model, scenario.usage);
    });
  }

  generateStructured<T>(request: StructuredAiRequest): Promise<AiResult<T>> {
    return Promise.resolve().then(() => {
      assertRequestLimits(request);
      if (!request.schemaName.trim() || Object.keys(request.schema).length === 0)
        throw new ProviderError({
          kind: 'permanent',
          provider: 'fake',
          message: 'Structured requests require a named schema',
        });
      const scenario = this.next();
      if (scenario.type !== 'structured') this.fail(scenario);
      return this.result(scenario.value as T, scenario.model, scenario.usage);
    });
  }

  private next(): FakeProviderScenario {
    const scenario = this.scenarios[this.cursor];
    this.cursor += 1;
    if (!scenario)
      throw new ProviderError({
        kind: 'permanent',
        provider: 'fake',
        message: 'Fake provider scenario queue is exhausted',
      });
    return scenario;
  }

  private fail(scenario: FakeProviderScenario): never {
    const kind =
      scenario.type === 'timeout'
        ? 'timeout'
        : scenario.type === 'retryable' || scenario.type === 'permanent'
          ? scenario.type
          : 'permanent';
    throw new ProviderError({ kind, provider: 'fake', message: `Fake provider ${scenario.type}` });
  }

  private result<T>(value: T, model = 'fake/model-v1', usage: Usage = emptyUsage()): AiResult<T> {
    return {
      value,
      usage,
      cost: unknownCost(),
      providerRequestId: `fake-request-${String(this.cursor)}`,
      model,
      latencyMs: 0,
      metadata: { provider: 'fake' },
    };
  }
}
