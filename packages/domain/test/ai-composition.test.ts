import type { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBudgetedAiOperations } from '../src/index.js';

afterEach(() => vi.unstubAllEnvs());

describe('AI composition', () => {
  it('does not create a live provider from credentials alone', () => {
    vi.stubEnv('YANDEX_AI_MODE', 'enabled');
    vi.stubEnv('YANDEX_FOLDER_ID', 'test-folder');
    vi.stubEnv('YANDEX_API_KEY', 'test-key');
    vi.stubEnv('YANDEX_MODEL_ALICE_FLASH_URI', 'test/model');
    vi.stubEnv('AI_BUDGET_MODE', 'disabled');
    vi.stubEnv('AI_PRICING_CONFIG_JSON', '');
    const ai = createBudgetedAiOperations({} as Pool);
    expect(ai.enabled).toBe(false);
    expect(ai.modelPolicy.allowedModels).toEqual(['disabled/deterministic-fallback']);
  });

  it('allows only a model with an approved tariff and complete budget configuration', () => {
    vi.stubEnv('YANDEX_AI_MODE', 'enabled');
    vi.stubEnv('YANDEX_FOLDER_ID', 'test-folder');
    vi.stubEnv('YANDEX_API_KEY', 'test-key');
    vi.stubEnv('YANDEX_MODEL_ALICE_FLASH_URI', 'test/unpriced');
    vi.stubEnv('YANDEX_MODEL_ALICE_URI', 'test/priced');
    vi.stubEnv('AI_BUDGET_MODE', 'enabled');
    vi.stubEnv('MAX_OPERATION_COST', '1');
    vi.stubEnv('DAILY_AI_BUDGET', '10');
    vi.stubEnv(
      'AI_PRICING_CONFIG_JSON',
      JSON.stringify({
        version: 'test-v1',
        currency: 'RUB',
        models: [
          {
            provider: 'yandex-ai-studio',
            model: 'test/priced',
            inputPerMillion: 1,
            outputPerMillion: 2,
          },
        ],
      }),
    );
    const ai = createBudgetedAiOperations({} as Pool);
    expect(ai.enabled).toBe(true);
    expect(ai.modelPolicy).toEqual({
      allowedModels: ['test/priced'],
      preferredModel: 'test/priced',
    });
  });
});
