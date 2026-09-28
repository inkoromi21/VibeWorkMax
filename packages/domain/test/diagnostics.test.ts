import { describe, expect, it } from 'vitest';
import { demoDiagnosticCatalog } from '@vibework/content';
import {
  assertDiagnosticAnswerAllowed,
  buildDiagnosticPlan,
  clarifyProblem,
  createDiagnosticContextSnapshot,
  questionForProgress,
} from '../src/index.js';
import type { DiagnosticContext } from '@vibework/contracts';

const context: DiagnosticContext = {
  schema_version: '4.0',
  session_id: 'session-1',
  problem_id: 'problem-1',
  problem_version: 1,
  profile_version: 1,
  evidence_revision: 0,
  goal_type: 'KNOWLEDGE_GAP',
  confirmed_goal: 'Понять дроби',
  completeness: 'COMPLETED_PARTIAL',
  competencies: [],
  interests: [],
  constraints: {
    age_group: 'unknown',
    role: 'STUDENT',
    device: 'PHONE',
    tools: [],
    session_minutes: 5,
    weekly_minutes: null,
    deadline: null,
    language: 'ru',
    paid_resources_allowed: null,
    preferred_format: null,
  },
  evidence_ids: [],
  unresolved_questions: [],
  recommended_entry: {
    competency_id: 'var.update',
    reason: {
      kind: 'EXPLORATION',
      explanation: 'Начать с примера',
      evidence_ids: [],
      assumption_reason: null,
    },
  },
  method_versions: ['diagnostic-planner-v1'],
};

function snapshot(type: Parameters<typeof clarifyProblem>[0]) {
  return createDiagnosticContextSnapshot({
    context: { ...context, goal_type: type },
    classification: clarifyProblem(type),
    decisionEventId: 'event-1',
    catalog: demoDiagnosticCatalog,
    templateVersion: 'fixture-v1',
    sessionMinutes: 5,
  });
}

describe('diagnostic planner', () => {
  it.each(['DIRECTION', 'KNOWLEDGE_GAP', 'SKILL', 'PRACTICE_READINESS'] as const)(
    'plans each confirmed type reproducibly',
    (type) => {
      const first = buildDiagnosticPlan(snapshot(type), demoDiagnosticCatalog);
      const second = buildDiagnosticPlan(snapshot(type), demoDiagnosticCatalog);
      expect(first).toEqual(second);
      expect(first.areas).toHaveLength(8);
      expect(first.areas.every((area) => Boolean(area.reason && area.evidenceRole))).toBe(true);
    },
  );

  it('uses only approved published templates and keeps knowledge gaps non-career', () => {
    const plan = buildDiagnosticPlan(snapshot('KNOWLEDGE_GAP'), demoDiagnosticCatalog);
    expect(plan.areas.some((area) => /career|професс/i.test(area.question.templateVersionId))).toBe(
      false,
    );
    expect(plan.areas.some((area) => /draft|archived/.test(area.question.templateVersionId))).toBe(
      false,
    );
  });

  it('requires consent after the main limit and blocks the thirteenth answer', () => {
    expect(() =>
      assertDiagnosticAnswerAllowed({ answeredCount: 8, additionalConsent: false }),
    ).toThrow('consent');
    expect(() =>
      assertDiagnosticAnswerAllowed({ answeredCount: 8, additionalConsent: true }),
    ).not.toThrow();
    expect(() =>
      assertDiagnosticAnswerAllowed({ answeredCount: 12, additionalConsent: true }),
    ).toThrow('hard');
    const plan = buildDiagnosticPlan(snapshot('SKILL'), demoDiagnosticCatalog);
    expect(questionForProgress(plan, 8, false)).toBeNull();
    expect(questionForProgress(plan, 8, true)).not.toBeNull();
  });

  it('deeply freezes its snapshot and refuses a different catalog version', () => {
    const value = snapshot('DIRECTION');
    expect(Object.isFrozen(value.context.constraints)).toBe(true);
    expect(() =>
      buildDiagnosticPlan(value, { ...demoDiagnosticCatalog, version: 'other' }),
    ).toThrow('does not match');
  });

  it('uses the versioned education context only for direction template selection', () => {
    const make = (educationTrack: 'school' | 'student') =>
      createDiagnosticContextSnapshot({
        context: { ...context, goal_type: 'DIRECTION' },
        classification: clarifyProblem('DIRECTION'),
        decisionEventId: `event-${educationTrack}`,
        catalog: demoDiagnosticCatalog,
        usedProfile: { profileVersion: 1, educationTrack, interestIds: [] },
      });
    expect(make('school').templateVersionIds).toContain('direction-school-context-v1');
    expect(make('student').templateVersionIds).toContain('direction-student-context-v1');
  });
});
