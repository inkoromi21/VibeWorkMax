import { REQUEST_TYPES, type DiagnosticRequestType } from '@vibework/content';

export const CLASSIFICATION_RULES_VERSION = 'problem-classifier-rules-v1';
export const CLASSIFICATION_PROMPT_VERSION = 'problem-classifier-prompt-v1';
export type ClassificationPath = 'deterministic' | 'ai' | 'clarification';
export type ClassificationStatus = 'classified' | 'ambiguous';

export interface Classification {
  /** null is an uncertainty state, not a fifth request type. */
  type: DiagnosticRequestType | null;
  status: ClassificationStatus;
  confidence: number;
  reason: string;
  interpretation: string;
  clarificationNeeded: boolean;
  path: ClassificationPath;
  rulesVersion: string;
  promptVersion?: string;
  modelIdentifier?: string;
  providerResult?: 'accepted' | 'invalid' | 'unavailable';
}

export interface AiClassificationOutput {
  type: DiagnosticRequestType;
  confidence: number;
  reason: string;
  clarification_needed: boolean;
}

export interface AiProblemClassifier {
  readonly modelIdentifier: string;
  classify(input: { text: string; promptVersion: string }): Promise<unknown>;
}

const rules: Readonly<Record<DiagnosticRequestType, readonly RegExp[]>> = {
  DIRECTION: [/(кем стать|професси|направлен|выбор|определиться)/],
  KNOWLEDGE_GAP: [/(не понимаю|пробел|не знаю тему|ошибк|не получается|путаюсь|ничего не умею)/],
  SKILL: [/(научиться|освоить|навык|хочу уметь|хочу делать|практиковаться)/],
  PRACTICE_READINESS: [/(стажир|практик|собесед|работ[уыа]|нет опыта|не возьмут|ваканси|резюме)/],
};

const interpretations: Readonly<Record<DiagnosticRequestType, string>> = {
  DIRECTION: 'Похоже, вы хотите выбрать направление.',
  KNOWLEDGE_GAP: 'Похоже на конкретный пробел в знаниях.',
  SKILL: 'Похоже, вы хотите освоить навык.',
  PRACTICE_READINESS: 'Похоже на подготовку к практике.',
};

function ambiguous(
  reason: string,
  providerResult?: Classification['providerResult'],
): Classification {
  return {
    type: null,
    status: 'ambiguous',
    confidence: 0,
    reason,
    interpretation: 'Не хочу угадывать: уточните, что именно хотите получить.',
    clarificationNeeded: true,
    path: 'deterministic',
    rulesVersion: CLASSIFICATION_RULES_VERSION,
    ...(providerResult === undefined ? {} : { providerResult }),
  };
}

/** Pure, offline and deterministic. Confidence concerns only request classification. */
export function classifyProblem(text: string): Classification {
  const normalized = text.trim().toLocaleLowerCase('ru-RU');
  if (!normalized) return ambiguous('EMPTY_REQUEST');
  const matches = REQUEST_TYPES.filter((type) => rules[type].some((rule) => rule.test(normalized)));
  if (matches.length !== 1)
    return ambiguous(matches.length === 0 ? 'NO_RULE_MATCH' : 'CONFLICTING_RULES');
  const type = matches[0];
  if (!type) return ambiguous('NO_RULE_MATCH');
  return {
    type,
    status: 'classified',
    confidence: 0.9,
    reason: `RULE_MATCH:${type}`,
    interpretation: interpretations[type],
    clarificationNeeded: false,
    path: 'deterministic',
    rulesVersion: CLASSIFICATION_RULES_VERSION,
  };
}

export function validateAiClassificationOutput(value: unknown): AiClassificationOutput | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(',') !== 'clarification_needed,confidence,reason,type') return null;
  const type = record.type;
  if (typeof type !== 'string' || !REQUEST_TYPES.includes(type as DiagnosticRequestType))
    return null;
  if (
    typeof record.confidence !== 'number' ||
    !Number.isFinite(record.confidence) ||
    record.confidence < 0 ||
    record.confidence > 1
  )
    return null;
  if (typeof record.reason !== 'string' || !record.reason.trim() || record.reason.length > 500)
    return null;
  if (typeof record.clarification_needed !== 'boolean') return null;
  return {
    type: type as DiagnosticRequestType,
    confidence: record.confidence,
    reason: record.reason,
    clarification_needed: record.clarification_needed,
  };
}

/** AI is deliberately unreachable unless the offline result is ambiguous. */
export async function resolveProblemClassification(
  text: string,
  ai?: AiProblemClassifier,
): Promise<Classification> {
  const deterministic = classifyProblem(text);
  if (deterministic.status === 'classified' || !ai) return deterministic;
  try {
    const output = validateAiClassificationOutput(
      await ai.classify({ text, promptVersion: CLASSIFICATION_PROMPT_VERSION }),
    );
    if (!output || output.clarification_needed)
      return {
        ...ambiguous('AI_RESPONSE_INVALID_OR_NEEDS_CLARIFICATION', output ? 'accepted' : 'invalid'),
        promptVersion: CLASSIFICATION_PROMPT_VERSION,
        modelIdentifier: ai.modelIdentifier,
        path: 'ai',
      };
    return {
      type: output.type,
      status: 'classified',
      confidence: output.confidence,
      reason: output.reason,
      interpretation: interpretations[output.type],
      clarificationNeeded: false,
      path: 'ai',
      rulesVersion: CLASSIFICATION_RULES_VERSION,
      promptVersion: CLASSIFICATION_PROMPT_VERSION,
      modelIdentifier: ai.modelIdentifier,
      providerResult: 'accepted',
    };
  } catch {
    return {
      ...ambiguous('AI_PROVIDER_UNAVAILABLE', 'unavailable'),
      path: 'ai',
      promptVersion: CLASSIFICATION_PROMPT_VERSION,
      modelIdentifier: ai.modelIdentifier,
    };
  }
}

export function clarifyProblem(type: DiagnosticRequestType): Classification {
  return {
    type,
    status: 'classified',
    confidence: 1,
    reason: `USER_CLARIFICATION:${type}`,
    interpretation: interpretations[type],
    clarificationNeeded: false,
    path: 'clarification',
    rulesVersion: CLASSIFICATION_RULES_VERSION,
  };
}
