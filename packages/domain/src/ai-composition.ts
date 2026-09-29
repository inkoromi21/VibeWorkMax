import {
  FakeAiProvider,
  YandexAiStudioProvider,
  budgetPolicyFromEnvironment,
  pricingCatalogFromEnvironment,
  yandexAiStudioConfigFromEnvironment,
  type ModelPolicy,
} from '@vibework/ai';
import type { Pool } from 'pg';
import { BudgetedTemplateAiOperations } from './ai-operations.js';
import { PostgresAiUsageLedger } from './ai-usage-ledger.js';

/** Shared API/worker composition: no live provider exists without approved pricing and budget. */
export function createBudgetedAiOperations(pool: Pool) {
  const config = yandexAiStudioConfigFromEnvironment();
  const policy = budgetPolicyFromEnvironment();
  const pricing = pricingCatalogFromEnvironment();
  const configuredModels = [
    config.aliceFlashModelUri,
    config.aliceModelUri,
    config.yandexGptProModelUri,
  ].filter((value): value is string => Boolean(value));
  const approvedModels = configuredModels.filter((model) =>
    pricing?.models.some((row) => row.provider === 'yandex-ai-studio' && row.model === model),
  );
  const enabled =
    config.mode === 'enabled' &&
    policy.mode === 'enabled' &&
    Boolean(config.folderId && config.apiKey) &&
    approvedModels.length > 0;
  const provider = enabled ? new YandexAiStudioProvider(config) : new FakeAiProvider([]);
  const providerName = enabled ? 'yandex-ai-studio' : 'fake-disabled';
  const modelPolicy: ModelPolicy = {
    allowedModels: enabled ? approvedModels : ['disabled/deterministic-fallback'],
    ...(enabled && approvedModels[0] ? { preferredModel: approvedModels[0] } : {}),
  };
  const ledger = new PostgresAiUsageLedger(pool, pricing, policy);
  return {
    operations: new BudgetedTemplateAiOperations(provider, providerName, ledger),
    modelPolicy,
    enabled,
  };
}
