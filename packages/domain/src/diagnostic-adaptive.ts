import {
  selectApprovedDiagnosticTemplates,
  type DiagnosticCatalog,
  type QuestionTemplateVersion,
} from '@vibework/content';
import type {
  CompetencyEstimate,
  DiagnosticContext,
  Evidence,
  MasteryPolicy,
} from '@vibework/contracts';

export const DIAGNOSTIC_SELECTOR_VERSION = 'diagnostic-selector-v1';
export const DIAGNOSTIC_RESULT_VERSION = 'diagnostic-result-v1';
export const DIAGNOSTIC_MAX_CONSECUTIVE_AREA_FAILURES = 2 as const;

export type DiagnosticProgressStatus = 'IN_PROGRESS' | 'PAUSED' | 'COMPLETED' | 'COMPLETED_PARTIAL';
export type DiagnosticAnswerOutcome = 'SUCCESS' | 'FAILURE' | 'UNKNOWN' | 'SKIPPED';

export interface DiagnosticQuestionHistory {
  instanceId: string;
  templateVersionId: string;
  area: string;
  outcome: DiagnosticAnswerOutcome | null;
}

export interface DiagnosticSelectorPreferences {
  preferredAreas?: readonly string[];
  /** A method is fixed by a server-approved session snapshot, never by an LLM. */
  fixedMethodVersion?: string;
}

export interface DiagnosticSelectorLimits {
  mainQuestionLimit: number;
  hardQuestionLimit: number;
  additionalConsent: boolean;
}

export interface SelectNextDiagnosticQuestionInput {
  context: DiagnosticContext;
  catalog: DiagnosticCatalog;
  allowedTemplateVersionIds: readonly string[];
  status: DiagnosticProgressStatus;
  evidence: readonly Evidence[];
  history: readonly DiagnosticQuestionHistory[];
  preferences: DiagnosticSelectorPreferences;
  limits: DiagnosticSelectorLimits;
  seed: string;
}

export interface SelectedDiagnosticQuestion {
  template: QuestionTemplateVersion;
  instanceId: string;
  selectorVersion: typeof DIAGNOSTIC_SELECTOR_VERSION;
}

export type NextDiagnosticQuestionDecision =
  | { kind: 'QUESTION'; question: SelectedDiagnosticQuestion }
  | {
      kind: 'STOP';
      reason: 'PAUSED' | 'HARD_LIMIT' | 'ADDITIONAL_CONSENT_REQUIRED' | 'NO_ELIGIBLE_QUESTION';
    };

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function instanceIdFor(template: QuestionTemplateVersion): string {
  return `${template.id}:base`;
}

function trailingFailuresInArea(history: readonly DiagnosticQuestionHistory[]): {
  area: string | null;
  count: number;
} {
  const answered = history.filter((entry) => entry.outcome !== null);
  const last = answered.at(-1);
  if (last?.outcome !== 'FAILURE') return { area: null, count: 0 };
  let count = 0;
  for (let index = answered.length - 1; index >= 0; index -= 1) {
    const entry = answered[index];
    if (entry?.area !== last.area || entry.outcome !== 'FAILURE') break;
    count += 1;
  }
  return { area: last.area, count };
}

/**
 * Selects only a snapshot-approved template.  It has no hidden cache: all
 * ordering, issue history, preferences, limits and the tie-breaking seed are
 * supplied by the caller.
 */
export function selectNextDiagnosticQuestion(
  input: SelectNextDiagnosticQuestionInput,
): NextDiagnosticQuestionDecision {
  if (input.status === 'PAUSED') return { kind: 'STOP', reason: 'PAUSED' };
  if (input.status === 'COMPLETED' || input.status === 'COMPLETED_PARTIAL')
    return { kind: 'STOP', reason: 'NO_ELIGIBLE_QUESTION' };
  const issuedCount = input.history.length;
  if (issuedCount >= input.limits.hardQuestionLimit) return { kind: 'STOP', reason: 'HARD_LIMIT' };
  if (issuedCount >= input.limits.mainQuestionLimit && !input.limits.additionalConsent)
    return { kind: 'STOP', reason: 'ADDITIONAL_CONSENT_REQUIRED' };

  const issuedInstanceIds = new Set(input.history.map((entry) => entry.instanceId));
  const allowedIds = new Set(input.allowedTemplateVersionIds);
  const recentFailures = trailingFailuresInArea(input.history);
  const hasAlternativeArea = selectApprovedDiagnosticTemplates(
    input.catalog,
    input.context.goal_type,
  ).some(
    (template) =>
      allowedIds.has(template.id) &&
      template.area !== recentFailures.area &&
      !issuedInstanceIds.has(instanceIdFor(template)),
  );
  const preferredAreas = new Set(input.preferences.preferredAreas ?? []);
  const resolvedAreas = new Set(
    input.evidence
      .filter(
        (evidence) =>
          evidence.status === 'ACTIVE' &&
          evidence.observed_result === 'PASS' &&
          evidence.evidence_kind !== 'SELF_REPORT' &&
          evidence.assistance_level !== 'SOLUTION',
      )
      .map((evidence) => evidence.competency_id.replace(/^diagnostic\./, '')),
  );
  const candidates = selectApprovedDiagnosticTemplates(input.catalog, input.context.goal_type)
    .filter((template) => allowedIds.has(template.id))
    .filter((template) => !resolvedAreas.has(template.area))
    .filter(
      (template) =>
        template.educationTracks === undefined ||
        (input.context.constraints.role === 'SCHOOL'
          ? template.educationTracks.includes('school')
          : template.educationTracks.includes('student')),
    )
    .filter(
      (template) =>
        input.preferences.fixedMethodVersion === undefined ||
        template.methodVersion === input.preferences.fixedMethodVersion,
    )
    .filter((template) => !issuedInstanceIds.has(instanceIdFor(template)))
    .filter(
      (template) =>
        !(
          hasAlternativeArea &&
          recentFailures.count >= DIAGNOSTIC_MAX_CONSECUTIVE_AREA_FAILURES &&
          template.area === recentFailures.area
        ),
    )
    .sort(
      (left, right) =>
        Number(preferredAreas.has(right.area)) - Number(preferredAreas.has(left.area)) ||
        left.priority - right.priority ||
        stableHash(`${input.seed}:${left.id}`) - stableHash(`${input.seed}:${right.id}`) ||
        left.id.localeCompare(right.id),
    );
  const template = candidates[0];
  if (!template) return { kind: 'STOP', reason: 'NO_ELIGIBLE_QUESTION' };
  return {
    kind: 'QUESTION',
    question: {
      template,
      instanceId: instanceIdFor(template),
      selectorVersion: DIAGNOSTIC_SELECTOR_VERSION,
    },
  };
}

export interface DiagnosticEvidenceRecord {
  evidence: Evidence;
  questionInstanceId: string | null;
  answerSubmissionId: string | null;
  /** Preference, skip and unknown records are retained but never score mastery. */
  role: 'ASSESSMENT' | 'PREFERENCE' | 'UNKNOWN';
  disclosed: boolean;
}

export interface DiagnosticResultInput {
  context: DiagnosticContext;
  session: { id: string; status: DiagnosticProgressStatus };
  evidence: readonly DiagnosticEvidenceRecord[];
  policies: readonly MasteryPolicy[];
  stoppingReason:
    | 'ALL_TARGETS_RESOLVED'
    | 'HARD_LIMIT'
    | 'NO_ELIGIBLE_QUESTION'
    | 'ADDITIONAL_CONSENT_REQUIRED'
    | 'USER_FINISHED'
    | 'PAUSED';
  evaluatedAt: string;
  catalogVersion: string;
  methodVersion: string;
  templateVersion: string;
}

export interface DiagnosticResultReferences {
  questionInstanceIds: readonly string[];
  answerSubmissionIds: readonly string[];
  evidenceIds: readonly string[];
  contextSessionId: string;
  catalogVersion: string;
  methodVersion: string;
  templateVersion: string;
  policyVersions: readonly string[];
}

export interface DiagnosticResult {
  resultVersion: typeof DIAGNOSTIC_RESULT_VERSION;
  status: 'COMPLETED' | 'COMPLETED_PARTIAL' | 'PAUSED';
  context: DiagnosticContext;
  known: readonly CompetencyEstimate[];
  gaps: readonly CompetencyEstimate[];
  unknown: readonly CompetencyEstimate[];
  explanation: string;
  references: DiagnosticResultReferences;
}

function evidenceIsUsable(
  record: DiagnosticEvidenceRecord,
  policy: MasteryPolicy,
  evaluatedAt: string,
): boolean {
  const evidence = record.evidence;
  if (record.role !== 'ASSESSMENT' || record.disclosed || evidence.status !== 'ACTIVE')
    return false;
  if (!policy.allowed_assistance.includes(evidence.assistance_level)) return false;
  if (evidence.difficulty < policy.minimum_difficulty) return false;
  if (!policy.compatible_rubric_versions.includes(evidence.rubric_version)) return false;
  const createdAt = Date.parse(evidence.created_at);
  const asOf = Date.parse(evaluatedAt);
  return (
    Number.isFinite(createdAt) &&
    Number.isFinite(asOf) &&
    createdAt >= asOf - policy.validity_days * 86_400_000
  );
}

function estimateCompetency(
  policy: MasteryPolicy,
  evidenceRecords: readonly DiagnosticEvidenceRecord[],
  evaluatedAt: string,
): CompetencyEstimate {
  const usable = evidenceRecords
    .filter((record) => record.evidence.competency_id === policy.competency_id)
    .filter((record) => evidenceIsUsable(record, policy, evaluatedAt))
    .sort(
      (left, right) =>
        left.evidence.created_at.localeCompare(right.evidence.created_at) ||
        left.evidence.evidence_id.localeCompare(right.evidence.evidence_id),
    );
  const byCriterion = new Map<string, Evidence>();
  for (const record of usable) byCriterion.set(record.evidence.criterion_id, record.evidence);
  const required = [...policy.required_criteria].sort();
  const passed = required.filter(
    (criterion) => byCriterion.get(criterion)?.observed_result === 'PASS',
  );
  const failed = required.filter((criterion) => {
    const result = byCriterion.get(criterion)?.observed_result;
    return result === 'FAIL' || result === 'PARTIAL';
  });
  const unobserved = required.filter((criterion) => !byCriterion.has(criterion));
  const passingEvidence = usable.filter((record) => record.evidence.observed_result === 'PASS');
  const independentFamilies = new Set(
    passingEvidence.map((record) => record.evidence.task_family_id),
  );
  const integrativeSatisfied =
    !policy.requires_integrative_task ||
    passingEvidence.some((record) => record.evidence.assessment_kind === 'INTEGRATIVE');
  const demonstrated =
    passed.length === required.length &&
    independentFamilies.size >= policy.required_independent_families &&
    integrativeSatisfied;
  const foundationFailure = failed.some((criterion) =>
    policy.foundation_criteria.includes(criterion),
  );
  const mastery_state = demonstrated
    ? 'demonstrated'
    : foundationFailure
      ? 'needs_foundation'
      : usable.length > 0
        ? 'developing'
        : 'unknown';
  return {
    competency_id: policy.competency_id,
    mastery_state,
    evidence_sufficiency: demonstrated
      ? 'sufficient'
      : usable.length > 0
        ? 'limited'
        : 'insufficient',
    policy_version: policy.policy_version,
    evidence_ids: usable.map((record) => record.evidence.evidence_id),
    passed_criteria: passed,
    failed_criteria: failed,
    unobserved_criteria: unobserved,
    open_conflict: false,
    evaluated_at: evaluatedAt,
  };
}

/** Builds a fact-only result; answer content and answer keys never enter its explanation. */
export function buildDiagnosticResult(input: DiagnosticResultInput): DiagnosticResult {
  const estimates = input.policies
    .slice()
    .sort((left, right) => left.competency_id.localeCompare(right.competency_id))
    .map((policy) => estimateCompetency(policy, input.evidence, input.evaluatedAt));
  const known = estimates.filter((estimate) => estimate.mastery_state === 'demonstrated');
  const gaps = estimates.filter(
    (estimate) => estimate.mastery_state !== 'demonstrated' && estimate.mastery_state !== 'unknown',
  );
  const unknown = estimates.filter((estimate) => estimate.mastery_state === 'unknown');
  const allResolved = unknown.length === 0 && gaps.length === 0;
  const status =
    input.session.status === 'PAUSED' || input.stoppingReason === 'PAUSED'
      ? 'PAUSED'
      : input.stoppingReason === 'ALL_TARGETS_RESOLVED' && allResolved
        ? 'COMPLETED'
        : 'COMPLETED_PARTIAL';
  const evidenceIds = input.evidence.map((record) => record.evidence.evidence_id).sort();
  const questionInstanceIds = input.evidence
    .map((record) => record.questionInstanceId)
    .filter((value): value is string => value !== null)
    .sort();
  const answerSubmissionIds = input.evidence
    .map((record) => record.answerSubmissionId)
    .filter((value): value is string => value !== null)
    .sort();
  const context: DiagnosticContext = {
    ...structuredClone(input.context),
    completeness: status === 'COMPLETED' ? 'COMPLETED' : 'COMPLETED_PARTIAL',
    competencies: estimates,
    evidence_ids: evidenceIds,
    method_versions: [...new Set([...input.context.method_versions, input.methodVersion])].sort(),
  };
  return {
    resultVersion: DIAGNOSTIC_RESULT_VERSION,
    status,
    context,
    known,
    gaps,
    unknown,
    explanation: `Результат основан на ${String(evidenceIds.length)} evidence records: подтверждено ${String(known.length)}, требует развития ${String(gaps.length)}, неизвестно ${String(unknown.length)}.`,
    references: {
      questionInstanceIds,
      answerSubmissionIds,
      evidenceIds,
      contextSessionId: input.context.session_id,
      catalogVersion: input.catalogVersion,
      methodVersion: input.methodVersion,
      templateVersion: input.templateVersion,
      policyVersions: input.policies.map((policy) => policy.policy_version).sort(),
    },
  };
}
