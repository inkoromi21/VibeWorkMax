import { describe, expect, it } from 'vitest';
import { demoDiagnosticCatalog, type DiagnosticCatalog } from '@vibework/content';
import type { DiagnosticContext, Evidence, MasteryPolicy } from '@vibework/contracts';
import {
  buildDiagnosticResult,
  selectNextDiagnosticQuestion,
  type DiagnosticEvidenceRecord,
} from '../src/index.js';

const context: DiagnosticContext = {
  schema_version: '4.0',
  session_id: 'diagnostic-session',
  problem_id: 'problem',
  problem_version: 1,
  profile_version: 1,
  evidence_revision: 0,
  goal_type: 'KNOWLEDGE_GAP',
  confirmed_goal: 'Понять тему',
  completeness: 'COMPLETED_PARTIAL',
  competencies: [],
  interests: [],
  constraints: {
    age_group: 'unknown',
    role: 'STUDENT',
    device: 'PHONE',
    tools: [],
    session_minutes: 10,
    weekly_minutes: null,
    deadline: null,
    language: 'ru',
    paid_resources_allowed: null,
    preferred_format: null,
  },
  evidence_ids: [],
  unresolved_questions: [],
  recommended_entry: {
    competency_id: 'diagnostic.topic',
    reason: {
      kind: 'EXPLORATION',
      explanation: 'Проверить по фактам.',
      evidence_ids: [],
      assumption_reason: null,
    },
  },
  method_versions: ['diagnostic-planner-v1'],
};

const allowed = demoDiagnosticCatalog.templates
  .filter(
    (template) =>
      template.requestType === 'KNOWLEDGE_GAP' &&
      template.status === 'PUBLISHED' &&
      template.approvalStatus === 'APPROVED',
  )
  .map((template) => template.id);

function select(overrides: Partial<Parameters<typeof selectNextDiagnosticQuestion>[0]> = {}) {
  return selectNextDiagnosticQuestion({
    context,
    catalog: demoDiagnosticCatalog,
    allowedTemplateVersionIds: allowed,
    status: 'IN_PROGRESS',
    evidence: [],
    history: [],
    preferences: {},
    limits: { mainQuestionLimit: 8, hardQuestionLimit: 12, additionalConsent: false },
    seed: 'fixture-seed',
    ...overrides,
  });
}

function policy(competencyId: string): MasteryPolicy {
  return {
    policy_version: 'diagnostic-policy-v1',
    competency_id: competencyId,
    required_criteria: ['response'],
    required_independent_families: 1,
    minimum_difficulty: 1,
    allowed_assistance: ['NONE'],
    validity_days: 30,
    requires_integrative_task: false,
    compatible_rubric_versions: ['diagnostic-rubric-v1'],
    foundation_criteria: ['response'],
  };
}

function evidence(overrides: Partial<Evidence> = {}): Evidence {
  return {
    evidence_id: 'evidence-1',
    user_id: 'user-1',
    competency_id: 'diagnostic.topic',
    criterion_id: 'response',
    observed_result: 'PASS',
    evidence_kind: 'EXPLANATION',
    task_family_id: 'family-1',
    task_version_id: 'template-1',
    rubric_version: 'diagnostic-rubric-v1',
    difficulty: 1,
    assistance_level: 'NONE',
    assessment_kind: 'LOCAL',
    source_ref: 'answer-1',
    status: 'ACTIVE',
    created_at: '2026-09-27T00:00:00.000Z',
    evidence_excerpt: null,
    ...overrides,
  };
}

function record(
  input: Evidence,
  overrides: Partial<DiagnosticEvidenceRecord> = {},
): DiagnosticEvidenceRecord {
  return {
    evidence: input,
    questionInstanceId: 'question-1',
    answerSubmissionId: 'answer-1',
    role: 'ASSESSMENT',
    disclosed: false,
    ...overrides,
  };
}

describe('adaptive diagnostic selector', () => {
  it('selects only approved snapshot templates, excludes issued instances, and is seed-reproducible', () => {
    const first = select();
    const second = select();
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      kind: 'QUESTION',
      question: { template: { id: 'gap-topic-v1' }, instanceId: 'gap-topic-v1:base' },
    });
    const next = select({
      history: [
        {
          instanceId: 'gap-topic-v1:base',
          templateVersionId: 'gap-topic-v1',
          area: 'topic',
          outcome: 'UNKNOWN',
        },
      ],
    });
    expect(next).toMatchObject({
      kind: 'QUESTION',
      question: { template: { id: 'gap-attempt-v1' } },
    });
    expect(
      select({
        evidence: [evidence({ observed_result: 'PASS', evidence_kind: 'SELF_REPORT' })],
      }),
    ).toMatchObject({ kind: 'QUESTION', question: { template: { id: 'gap-topic-v1' } } });
  });

  it('changes area after two consecutive failed questions in the same area', () => {
    const topic = demoDiagnosticCatalog.templates.find(
      (template) => template.id === 'gap-topic-v1',
    );
    if (!topic) throw new Error('Missing gap-topic fixture');
    const alternateTopic = { ...topic, id: 'gap-topic-followup-v1', priority: 11 };
    const catalog: DiagnosticCatalog = {
      ...demoDiagnosticCatalog,
      templates: [...demoDiagnosticCatalog.templates, alternateTopic],
    };
    const decision = select({
      catalog,
      allowedTemplateVersionIds: [...allowed, alternateTopic.id],
      history: [
        {
          instanceId: 'gap-topic-v1:base',
          templateVersionId: 'gap-topic-v1',
          area: 'topic',
          outcome: 'FAILURE',
        },
        {
          instanceId: 'gap-topic-followup-v1:base',
          templateVersionId: alternateTopic.id,
          area: 'topic',
          outcome: 'FAILURE',
        },
      ],
    });
    expect(decision).toMatchObject({
      kind: 'QUESTION',
      question: { template: { area: 'prior_attempt' } },
    });
  });

  it('stops at consent and hard limits instead of looping', () => {
    expect(
      select({
        history: Array.from({ length: 8 }, (_, index) => ({
          instanceId: `i-${String(index)}`,
          templateVersionId: `t-${String(index)}`,
          area: `a-${String(index)}`,
          outcome: 'UNKNOWN' as const,
        })),
      }),
    ).toEqual({ kind: 'STOP', reason: 'ADDITIONAL_CONSENT_REQUIRED' });
    expect(
      select({
        history: Array.from({ length: 12 }, (_, index) => ({
          instanceId: `i-${String(index)}`,
          templateVersionId: `t-${String(index)}`,
          area: `a-${String(index)}`,
          outcome: 'UNKNOWN' as const,
        })),
        limits: { mainQuestionLimit: 8, hardQuestionLimit: 12, additionalConsent: true },
      }),
    ).toEqual({ kind: 'STOP', reason: 'HARD_LIMIT' });
  });
});

describe('deterministic diagnostic result', () => {
  it('keeps skip, unknown and preference outside knowledge scoring', () => {
    const result = buildDiagnosticResult({
      context,
      session: { id: context.session_id, status: 'IN_PROGRESS' },
      evidence: [
        record(evidence({ evidence_id: 'skip' }), { role: 'UNKNOWN' }),
        record(evidence({ evidence_id: 'preference' }), { role: 'PREFERENCE' }),
      ],
      policies: [policy('diagnostic.topic')],
      stoppingReason: 'USER_FINISHED',
      evaluatedAt: '2026-09-27T00:00:01.000Z',
      catalogVersion: 'catalog-v1',
      methodVersion: 'method-v1',
      templateVersion: 'templates-v1',
    });
    expect(result.status).toBe('COMPLETED_PARTIAL');
    expect(result.unknown).toHaveLength(1);
    expect(result.gaps).toHaveLength(0);
  });

  it('marks disclosed solution evidence as contaminated and never as independent knowledge', () => {
    const result = buildDiagnosticResult({
      context,
      session: { id: context.session_id, status: 'IN_PROGRESS' },
      evidence: [record(evidence({ assistance_level: 'SOLUTION' }), { disclosed: true })],
      policies: [policy('diagnostic.topic')],
      stoppingReason: 'ALL_TARGETS_RESOLVED',
      evaluatedAt: '2026-09-27T00:00:01.000Z',
      catalogVersion: 'catalog-v1',
      methodVersion: 'method-v1',
      templateVersion: 'templates-v1',
    });
    expect(result.status).toBe('COMPLETED_PARTIAL');
    expect(result.known).toHaveLength(0);
    expect(result.unknown[0]?.evidence_ids).toEqual([]);
  });

  it('derives known, gap and paused statuses only from policy-qualified evidence', () => {
    const result = buildDiagnosticResult({
      context,
      session: { id: context.session_id, status: 'PAUSED' },
      evidence: [
        record(evidence({ evidence_id: 'known', competency_id: 'diagnostic.known' })),
        record(
          evidence({
            evidence_id: 'gap',
            competency_id: 'diagnostic.gap',
            observed_result: 'FAIL',
          }),
        ),
      ],
      policies: [
        policy('diagnostic.known'),
        policy('diagnostic.gap'),
        policy('diagnostic.unknown'),
      ],
      stoppingReason: 'PAUSED',
      evaluatedAt: '2026-09-27T00:00:01.000Z',
      catalogVersion: 'catalog-v1',
      methodVersion: 'method-v1',
      templateVersion: 'templates-v1',
    });
    expect(result.status).toBe('PAUSED');
    expect(result.known.map((value) => value.competency_id)).toEqual(['diagnostic.known']);
    expect(result.gaps.map((value) => value.competency_id)).toEqual(['diagnostic.gap']);
    expect(result.unknown.map((value) => value.competency_id)).toEqual(['diagnostic.unknown']);
    expect(result.references.answerSubmissionIds).toEqual(['answer-1', 'answer-1']);
  });
});
