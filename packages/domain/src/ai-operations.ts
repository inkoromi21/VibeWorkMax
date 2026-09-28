import {
  buildRepairRequest,
  buildStructuredTemplateRequest,
  promptProvenance,
  promptTemplates,
  validateStructuredTemplateOutput,
} from '@vibework/ai';
import type { AiProvider, ModelPolicy, PromptTemplateId, PromptProvenance } from '@vibework/ai';
import type { PostgresAiUsageLedger } from './ai-usage-ledger.js';

export interface TemplateDomainContext {
  allowedIds?: readonly string[];
  allowedUrls?: readonly string[];
}

export function validateTemplateDomainOutput(
  value: Record<string, unknown>,
  context: TemplateDomainContext,
): { valid: true } | { valid: false; reason: string } {
  const allowedIds = new Set(context.allowedIds ?? []);
  const allowedUrls = new Set(context.allowedUrls ?? []);
  for (const [key, candidate] of Object.entries(value)) {
    if (key.endsWith('Ids')) {
      if (
        !Array.isArray(candidate) ||
        candidate.some((id) => typeof id !== 'string' || !allowedIds.has(id))
      )
        return { valid: false, reason: `UNKNOWN_ID:${key}` };
    }
    if (key === 'urls') {
      if (
        !Array.isArray(candidate) ||
        candidate.some((url) => typeof url !== 'string' || !allowedUrls.has(url))
      )
        return { valid: false, reason: 'UNKNOWN_URL' };
    }
  }
  return { valid: true };
}

export interface TemplateOperationResult {
  value: Record<string, unknown>;
  usedFallback: boolean;
  provenance: PromptProvenance;
  repairAttempts: 0 | 1;
  fallbackReason?: 'BUDGET_EXCEEDED' | 'INVALID_OUTPUT' | 'PROVIDER_UNAVAILABLE';
}

/**
 * One bounded provider call plus at most one schema/domain repair. Every call
 * receives its own ledger attempt; duplicate job delivery returns the existing
 * reservation and never performs a second provider call.
 */
export class BudgetedTemplateAiOperations {
  constructor(
    private readonly provider: AiProvider,
    private readonly providerName: string,
    private readonly ledger: PostgresAiUsageLedger,
  ) {}

  async execute(input: {
    templateId: PromptTemplateId;
    approvedContext: Record<string, unknown>;
    userInput: unknown;
    domainContext: TemplateDomainContext;
    operationIdentity: string;
    modelPolicy: ModelPolicy;
    deadlineMs?: number;
    maxInputTokens?: number;
    maxOutputTokens?: number;
  }): Promise<TemplateOperationResult> {
    const template = promptTemplates[input.templateId];
    const request = buildStructuredTemplateRequest({
      templateId: input.templateId,
      approvedContext: input.approvedContext,
      userInput: input.userInput,
      deadlineMs: input.deadlineMs ?? 10_000,
      maxInputTokens: input.maxInputTokens ?? 4_000,
      maxOutputTokens: input.maxOutputTokens ?? 600,
      modelPolicy: input.modelPolicy,
    });
    type RunResult =
      | { kind: 'VALUE'; value: Record<string, unknown>; model: string }
      | { kind: 'DENIED' | 'EXISTING' | 'INVALID' | 'PROVIDER_UNAVAILABLE' };
    const run = async (candidate: typeof request, attempt: 0 | 1): Promise<RunResult> => {
      const reservation = await this.ledger.preflight({
        request: candidate,
        provider: this.providerName,
        operationIdentity: input.operationIdentity,
        attempt,
        provenance: promptProvenance(
          input.templateId,
          this.providerName,
          null,
        ) as unknown as Record<string, unknown>,
      });
      if (reservation.kind === 'DENIED') return { kind: 'DENIED' };
      if (reservation.kind === 'EXISTING') return { kind: 'EXISTING' };
      try {
        const result = await this.provider.generateStructured<Record<string, unknown>>(candidate);
        await this.ledger.reconcile({
          entryId: reservation.entry.id,
          result,
          provider: this.providerName,
        });
        const schema = validateStructuredTemplateOutput(input.templateId, result.value);
        if (!schema.valid || !validateTemplateDomainOutput(schema.value, input.domainContext).valid)
          return { kind: 'INVALID' };
        return { kind: 'VALUE', value: schema.value, model: result.model };
      } catch {
        await this.ledger.markProviderFailure(reservation.entry.id);
        return { kind: 'PROVIDER_UNAVAILABLE' };
      }
    };
    const first = await run(request, 0);
    if (first.kind === 'VALUE')
      return {
        value: first.value,
        usedFallback: false,
        provenance: promptProvenance(input.templateId, this.providerName, first.model),
        repairAttempts: 0,
      };
    if (first.kind === 'DENIED')
      return {
        value: template.fallback,
        usedFallback: true,
        provenance: promptProvenance(input.templateId, this.providerName, null),
        repairAttempts: 0,
        fallbackReason: 'BUDGET_EXCEEDED',
      };
    if (first.kind !== 'INVALID')
      return {
        value: template.fallback,
        usedFallback: true,
        provenance: promptProvenance(input.templateId, this.providerName, null),
        repairAttempts: 0,
        fallbackReason: 'PROVIDER_UNAVAILABLE',
      };
    const repair = await run(buildRepairRequest(request, { invalid: true }), 1);
    if (repair.kind === 'VALUE')
      return {
        value: repair.value,
        usedFallback: false,
        provenance: promptProvenance(input.templateId, this.providerName, repair.model),
        repairAttempts: 1,
      };
    // No claimed model output is surfaced when a budget or validation path fails.
    return {
      value: template.fallback,
      usedFallback: true,
      provenance: promptProvenance(input.templateId, this.providerName, null),
      repairAttempts: 1,
      fallbackReason:
        repair.kind === 'DENIED'
          ? 'BUDGET_EXCEEDED'
          : repair.kind === 'INVALID'
            ? 'INVALID_OUTPUT'
            : 'PROVIDER_UNAVAILABLE',
    };
  }
}
