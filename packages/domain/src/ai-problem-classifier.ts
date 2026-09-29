import type { ModelPolicy } from '@vibework/ai';
import type { AiProblemClassifier } from './classification.js';
import type { BudgetedTemplateAiOperations } from './ai-operations.js';

/** Only ambiguous requests reach this adapter; budget admission is rechecked atomically on call. */
export class TemplateAiProblemClassifier implements AiProblemClassifier {
  readonly modelIdentifier: string;

  constructor(
    private readonly operations: BudgetedTemplateAiOperations,
    private readonly modelPolicy: ModelPolicy,
    private readonly operationIdentity: string,
  ) {
    this.modelIdentifier = modelPolicy.preferredModel ?? modelPolicy.allowedModels[0] ?? 'unknown';
  }

  async classify(input: { text: string; promptVersion: string }): Promise<unknown> {
    const result = await this.operations.execute({
      templateId: 'classification',
      approvedContext: {
        allowedTypes: ['DIRECTION', 'KNOWLEDGE_GAP', 'SKILL', 'PRACTICE_READINESS'],
        classifierVersion: input.promptVersion,
      },
      userInput: input.text,
      domainContext: {},
      operationIdentity: this.operationIdentity,
      modelPolicy: this.modelPolicy,
      maxInputTokens: 1_000,
      maxOutputTokens: 200,
    });
    return result.value;
  }
}
