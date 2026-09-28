import {
  selectApprovedDiagnosticTemplates,
  type DiagnosticCatalog,
  type QuestionTemplateVersion,
} from '@vibework/content';
import type { DiagnosticContext, Evidence, MasteryPolicy } from '@vibework/contracts';
import { newUuid } from '@vibework/shared';
import type { Pool } from 'pg';
import type { Classification } from './classification.js';
import {
  buildDiagnosticResult,
  selectNextDiagnosticQuestion,
  type DiagnosticEvidenceRecord,
  type DiagnosticResult,
  type DiagnosticSelectorPreferences,
} from './diagnostic-adaptive.js';

export const DIAGNOSTIC_MAIN_LIMIT = 8 as const;
export const DIAGNOSTIC_HARD_LIMIT = 12 as const;
export const DIAGNOSTIC_PLANNER_VERSION = 'diagnostic-planner-v1';
export const DIAGNOSTIC_TEMPLATE_SELECTION_VERSION = 'diagnostic-template-selection-v1';

export interface DiagnosticSessionConstraints {
  sessionMinutes: number | null;
  mainQuestionLimit: typeof DIAGNOSTIC_MAIN_LIMIT;
  hardQuestionLimit: typeof DIAGNOSTIC_HARD_LIMIT;
}

export interface DiagnosticContextSnapshot {
  snapshotVersion: 'diagnostic-context-snapshot-v1';
  context: DiagnosticContext;
  classification: Pick<
    Classification,
    | 'type'
    | 'status'
    | 'confidence'
    | 'reason'
    | 'path'
    | 'rulesVersion'
    | 'promptVersion'
    | 'modelIdentifier'
    | 'providerResult'
  > & { decisionEventId: string };
  catalogVersion: string;
  methodVersion: string;
  templateVersion: string;
  /** Exact published template versions selected at planning time. */
  templateVersionIds: readonly string[];
  usedProfile: Readonly<{
    profileVersion: number;
    educationTrack: 'school' | 'student' | null;
    interestIds: readonly string[];
  }>;
  constraints: DiagnosticSessionConstraints;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function immutableCopy<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function approvedTemplatesForSnapshot(
  catalog: DiagnosticCatalog,
  type: NonNullable<Classification['type']>,
  educationTrack: DiagnosticContextSnapshot['usedProfile']['educationTrack'],
): readonly QuestionTemplateVersion[] {
  return selectApprovedDiagnosticTemplates(catalog, type).filter(
    (template) =>
      template.educationTracks === undefined ||
      (educationTrack !== null && template.educationTracks.includes(educationTrack)),
  );
}

export interface DiagnosticPlanArea {
  area: string;
  reason: string;
  evidenceRole: string;
  constraints: readonly string[];
  question: {
    instanceId: string;
    templateVersionId: string;
    prompt: string;
    kind: QuestionTemplateVersion['kind'];
    options: readonly string[];
    estimatedSeconds: number;
  };
}

export interface DiagnosticPlan {
  planVersion: 'diagnostic-plan-v1';
  plannerVersion: typeof DIAGNOSTIC_PLANNER_VERSION;
  snapshot: DiagnosticContextSnapshot;
  areas: readonly DiagnosticPlanArea[];
  additionalAreas: readonly DiagnosticPlanArea[];
  estimatedMinutes: number;
  mainQuestionLimit: typeof DIAGNOSTIC_MAIN_LIMIT;
  hardQuestionLimit: typeof DIAGNOSTIC_HARD_LIMIT;
}

function toArea(template: QuestionTemplateVersion, ordinal: number): DiagnosticPlanArea {
  return {
    area: template.area,
    reason: template.reason,
    evidenceRole: template.evidenceRole,
    constraints: template.constraints,
    question: {
      instanceId: `${template.id}:${String(ordinal + 1)}`,
      templateVersionId: template.id,
      prompt: template.prompt,
      kind: template.kind,
      options: template.options,
      estimatedSeconds: template.estimatedSeconds,
    },
  };
}

export function createDiagnosticContextSnapshot(input: {
  context: DiagnosticContext;
  classification: Classification;
  decisionEventId: string;
  catalog: DiagnosticCatalog;
  templateVersion?: string;
  usedProfile?: DiagnosticContextSnapshot['usedProfile'];
  sessionMinutes?: number | null;
}): DiagnosticContextSnapshot {
  if (input.classification.status !== 'classified' || !input.classification.type)
    throw new Error('A confirmed classification is required before planning');
  const usedProfile = input.usedProfile ?? {
    profileVersion: input.context.profile_version,
    educationTrack: null,
    interestIds: [],
  };
  if (usedProfile.profileVersion !== input.context.profile_version)
    throw new Error('Diagnostic profile version must match the context');
  const templates = approvedTemplatesForSnapshot(
    input.catalog,
    input.classification.type,
    usedProfile.educationTrack,
  );
  if (templates.length < DIAGNOSTIC_HARD_LIMIT)
    throw new Error('The approved catalog does not contain enough template versions');
  return immutableCopy({
    snapshotVersion: 'diagnostic-context-snapshot-v1',
    context: input.context,
    classification: {
      type: input.classification.type,
      status: input.classification.status,
      confidence: input.classification.confidence,
      reason: input.classification.reason,
      path: input.classification.path,
      rulesVersion: input.classification.rulesVersion,
      decisionEventId: input.decisionEventId,
      ...(input.classification.promptVersion === undefined
        ? {}
        : { promptVersion: input.classification.promptVersion }),
      ...(input.classification.modelIdentifier === undefined
        ? {}
        : { modelIdentifier: input.classification.modelIdentifier }),
      ...(input.classification.providerResult === undefined
        ? {}
        : { providerResult: input.classification.providerResult }),
    },
    catalogVersion: input.catalog.version,
    methodVersion: DIAGNOSTIC_PLANNER_VERSION,
    templateVersion: input.templateVersion ?? DIAGNOSTIC_TEMPLATE_SELECTION_VERSION,
    templateVersionIds: templates.slice(0, DIAGNOSTIC_HARD_LIMIT).map((template) => template.id),
    usedProfile,
    constraints: {
      sessionMinutes: input.sessionMinutes ?? null,
      mainQuestionLimit: DIAGNOSTIC_MAIN_LIMIT,
      hardQuestionLimit: DIAGNOSTIC_HARD_LIMIT,
    },
  });
}

/** Builds the same queue for the same snapshot and catalog, without reading mutable state. */
export function buildDiagnosticPlan(
  snapshot: DiagnosticContextSnapshot,
  catalog: DiagnosticCatalog,
): DiagnosticPlan {
  const type = snapshot.classification.type;
  if (!type) throw new Error('An ambiguous classification cannot be planned');
  if (catalog.version !== snapshot.catalogVersion)
    throw new Error('The supplied catalog does not match the diagnostic snapshot');
  const approved = new Map(
    selectApprovedDiagnosticTemplates(catalog, type).map((template) => [template.id, template]),
  );
  const templates = snapshot.templateVersionIds.map((id) => approved.get(id));
  if (templates.some((template) => template === undefined))
    throw new Error('A snapshot template is not approved in the supplied catalog version');
  const selected = templates as QuestionTemplateVersion[];
  if (selected.length !== DIAGNOSTIC_HARD_LIMIT)
    throw new Error('A diagnostic snapshot must contain exactly twelve template versions');
  const mainCount = DIAGNOSTIC_MAIN_LIMIT;
  const areas = selected.slice(0, mainCount).map(toArea);
  const additionalAreas = selected
    .slice(mainCount, DIAGNOSTIC_HARD_LIMIT)
    .map((template, index) => toArea(template, mainCount + index));
  const estimatedSeconds = areas.reduce((total, area) => total + area.question.estimatedSeconds, 0);
  return immutableCopy({
    planVersion: 'diagnostic-plan-v1',
    plannerVersion: DIAGNOSTIC_PLANNER_VERSION,
    snapshot,
    areas: Object.freeze(areas),
    additionalAreas: Object.freeze(additionalAreas),
    estimatedMinutes: estimatedSeconds / 60,
    mainQuestionLimit: DIAGNOSTIC_MAIN_LIMIT,
    hardQuestionLimit: DIAGNOSTIC_HARD_LIMIT,
  });
}

export function questionForProgress(
  plan: DiagnosticPlan,
  answeredCount: number,
  additionalConsent: boolean,
): DiagnosticPlanArea | null {
  if (answeredCount < 0 || answeredCount >= DIAGNOSTIC_HARD_LIMIT) return null;
  if (answeredCount < plan.areas.length) return plan.areas[answeredCount] ?? null;
  if (!additionalConsent) return null;
  return plan.additionalAreas[answeredCount - plan.areas.length] ?? null;
}

/** Server-side guard; frontend controls only presentation, never this invariant. */
export function assertDiagnosticAnswerAllowed(input: {
  answeredCount: number;
  additionalConsent: boolean;
}): void {
  if (input.answeredCount >= DIAGNOSTIC_HARD_LIMIT)
    throw new Error('Diagnostic hard question limit reached');
  if (input.answeredCount >= DIAGNOSTIC_MAIN_LIMIT && !input.additionalConsent)
    throw new Error('Additional diagnostic-question consent required');
}

/** PostgreSQL boundary for immutable snapshots and server-enforced question limits. */
export class PostgresDiagnosticSessionRepository {
  constructor(private readonly pool: Pool) {}

  async create(input: {
    sessionId?: string;
    userId: string;
    problemVersionId: string;
    classificationDecisionId: string;
    plan: DiagnosticPlan;
    parentSessionId?: string;
    parentResultId?: string;
  }): Promise<string> {
    const sessionId = input.sessionId ?? newUuid();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO diagnostic_sessions(id,user_id,problem_version_id,classification_decision_id,snapshot,plan,catalog_version,method_version,template_version,parent_session_id,parent_result_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          sessionId,
          input.userId,
          input.problemVersionId,
          input.classificationDecisionId,
          input.plan.snapshot,
          input.plan,
          input.plan.snapshot.catalogVersion,
          input.plan.snapshot.methodVersion,
          input.plan.snapshot.templateVersion,
          input.parentSessionId ?? null,
          input.parentResultId ?? null,
        ],
      );
      await client.query('COMMIT');
      return sessionId;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async grantAdditionalConsent(input: { sessionId: string; userId: string }): Promise<void> {
    const result = await this.pool.query(
      `UPDATE diagnostic_sessions SET additional_consent_at=COALESCE(additional_consent_at,now()) WHERE id=$1 AND user_id=$2 AND question_count >= $3`,
      [input.sessionId, input.userId, DIAGNOSTIC_MAIN_LIMIT],
    );
    if (result.rowCount !== 1) throw new Error('Additional consent is not available yet');
  }

  async issueNextQuestion(input: {
    sessionId: string;
    userId: string;
    catalog: DiagnosticCatalog;
    seed: string;
    preferences?: DiagnosticSelectorPreferences;
  }): Promise<
    | { kind: 'QUESTION'; questionInstanceId: string; publicQuestion: Record<string, unknown> }
    | { kind: 'STOP'; reason: string }
  > {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const session = await client.query<{
        status: 'IN_PROGRESS' | 'PAUSED' | 'COMPLETED' | 'COMPLETED_PARTIAL';
        question_count: number;
        additional_consent_at: Date | null;
        revision: number;
        snapshot: DiagnosticContextSnapshot;
      }>(
        `SELECT status,question_count,additional_consent_at,revision,snapshot
         FROM diagnostic_sessions WHERE id=$1 AND user_id=$2 FOR UPDATE`,
        [input.sessionId, input.userId],
      );
      const row = session.rows[0];
      if (!row) throw new Error('Diagnostic session not found');
      const outstanding = await client.query<{
        id: string;
        public_payload: Record<string, unknown>;
      }>(
        `SELECT q.id,q.public_payload FROM diagnostic_question_instances q
         LEFT JOIN diagnostic_answer_submissions a ON a.question_instance_id=q.id
         WHERE q.session_id=$1 AND a.id IS NULL ORDER BY q.ordinal DESC LIMIT 1`,
        [input.sessionId],
      );
      if (outstanding.rowCount === 1) {
        const outstandingQuestion = outstanding.rows[0];
        if (!outstandingQuestion) throw new Error('Outstanding diagnostic question is unavailable');
        await client.query('COMMIT');
        return {
          kind: 'QUESTION',
          questionInstanceId: outstandingQuestion.id,
          publicQuestion: outstandingQuestion.public_payload,
        };
      }
      const historyRows = await client.query<{
        id: string;
        instance_key: string;
        template_version_id: string;
        area: string;
        answer_kind: 'CHOICE' | 'TEXT' | 'SKIP' | 'DONT_KNOW' | null;
      }>(
        `SELECT q.id,q.instance_key,q.template_version_id,q.area,a.answer_kind
         FROM diagnostic_question_instances q
         LEFT JOIN diagnostic_answer_submissions a ON a.question_instance_id=q.id
         WHERE q.session_id=$1 ORDER BY q.ordinal`,
        [input.sessionId],
      );
      const evidenceRows = await client.query<{
        question_instance_id: string | null;
        evidence: Evidence;
        role: DiagnosticEvidenceRecord['role'];
        disclosed: boolean;
      }>(
        `SELECT question_instance_id,evidence,role,disclosed
         FROM diagnostic_evidence_records WHERE session_id=$1 ORDER BY created_at,id`,
        [input.sessionId],
      );
      const assessedOutcomeByQuestion = new Map<string, 'SUCCESS' | 'FAILURE'>();
      for (const evidenceRecord of evidenceRows.rows) {
        if (
          evidenceRecord.question_instance_id === null ||
          evidenceRecord.role !== 'ASSESSMENT' ||
          evidenceRecord.disclosed
        )
          continue;
        if (evidenceRecord.evidence.observed_result === 'PASS')
          assessedOutcomeByQuestion.set(evidenceRecord.question_instance_id, 'SUCCESS');
        if (
          evidenceRecord.evidence.observed_result === 'FAIL' ||
          evidenceRecord.evidence.observed_result === 'PARTIAL'
        )
          assessedOutcomeByQuestion.set(evidenceRecord.question_instance_id, 'FAILURE');
      }
      const decision = selectNextDiagnosticQuestion({
        context: row.snapshot.context,
        catalog: input.catalog,
        allowedTemplateVersionIds: row.snapshot.templateVersionIds,
        status: row.status,
        evidence: evidenceRows.rows.map((entry) => entry.evidence),
        history: historyRows.rows.map((entry) => ({
          instanceId: entry.instance_key,
          templateVersionId: entry.template_version_id,
          area: entry.area,
          outcome:
            assessedOutcomeByQuestion.get(entry.id) ??
            (entry.answer_kind === null
              ? null
              : entry.answer_kind === 'SKIP'
                ? 'SKIPPED'
                : 'UNKNOWN'),
        })),
        preferences: input.preferences ?? {},
        limits: {
          mainQuestionLimit: row.snapshot.constraints.mainQuestionLimit,
          hardQuestionLimit: row.snapshot.constraints.hardQuestionLimit,
          additionalConsent: row.additional_consent_at !== null,
        },
        seed: input.seed,
      });
      if (decision.kind === 'STOP') {
        await client.query('COMMIT');
        return decision;
      }
      const template = decision.question.template;
      const questionInstanceId = newUuid();
      const publicQuestion = {
        question_instance_id: questionInstanceId,
        session_revision: row.revision,
        question_kind:
          template.kind === 'CHOICE'
            ? 'SINGLE_CHOICE'
            : template.kind === 'PREFERENCE'
              ? 'PREFERENCE'
              : 'SHORT_TEXT',
        prompt: template.prompt,
        options: template.options.map((label, index) => ({ id: String(index + 1), label })),
        public_criteria: [],
        estimated_seconds: template.estimatedSeconds,
      };
      await client.query(
        `INSERT INTO diagnostic_question_instances(id,session_id,ordinal,template_version_id,instance_key,area,reason,evidence_role,constraints,public_payload,issued_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())`,
        [
          questionInstanceId,
          input.sessionId,
          historyRows.rows.length,
          template.id,
          decision.question.instanceId,
          template.area,
          template.reason,
          template.evidenceRole,
          JSON.stringify(template.constraints),
          publicQuestion,
        ],
      );
      await client.query('COMMIT');
      return { kind: 'QUESTION', questionInstanceId, publicQuestion };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async saveAnswer(input: {
    sessionId: string;
    userId: string;
    kind: 'CHOICE' | 'TEXT' | 'SKIP' | 'DONT_KNOW';
    value: string[] | string | null;
    assistanceReported?: 'NONE' | 'HINT' | 'SOLUTION';
  }): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const session = await client.query<{
        question_count: number;
        additional_consent_at: Date | null;
        status: string;
      }>(
        'SELECT question_count,additional_consent_at,status FROM diagnostic_sessions WHERE id=$1 AND user_id=$2 FOR UPDATE',
        [input.sessionId, input.userId],
      );
      const row = session.rows[0];
      if (!row) throw new Error('Diagnostic session not found');
      if (row.status !== 'IN_PROGRESS')
        throw new Error('Diagnostic session is not accepting answers');
      assertDiagnosticAnswerAllowed({
        answeredCount: row.question_count,
        additionalConsent: row.additional_consent_at !== null,
      });
      const question = await client.query<{
        id: string;
        template_version_id: string;
        area: string;
        evidence_role: string;
      }>(
        'SELECT id,template_version_id,area,evidence_role FROM diagnostic_question_instances WHERE session_id=$1 AND ordinal=$2',
        [input.sessionId, row.question_count],
      );
      const questionInstanceId = question.rows[0]?.id;
      if (!questionInstanceId) throw new Error('Diagnostic question is unavailable');
      const issuedQuestion = question.rows[0];
      if (!issuedQuestion) throw new Error('Diagnostic question is unavailable');
      const answerId = newUuid();
      const assistance = input.assistanceReported ?? 'NONE';
      const inserted = await client.query(
        `INSERT INTO diagnostic_answer_submissions(id,session_id,question_instance_id,answer_kind,answer_value,assistance_reported) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT(session_id,question_instance_id) DO NOTHING`,
        [
          answerId,
          input.sessionId,
          questionInstanceId,
          input.kind,
          input.value === null ? null : JSON.stringify(input.value),
          assistance,
        ],
      );
      if (inserted.rowCount !== 1) throw new Error('Diagnostic answer already submitted');
      const role =
        input.kind === 'SKIP' || input.kind === 'DONT_KNOW'
          ? 'UNKNOWN'
          : issuedQuestion.evidence_role.includes('preference')
            ? 'PREFERENCE'
            : 'UNKNOWN';
      const evidence: Evidence = {
        evidence_id: newUuid(),
        user_id: input.userId,
        competency_id: `diagnostic.${issuedQuestion.area}`,
        criterion_id: 'response',
        observed_result: 'NOT_ASSESSED',
        evidence_kind:
          role === 'PREFERENCE'
            ? 'SELF_REPORT'
            : input.kind === 'CHOICE'
              ? 'CHOICE'
              : 'EXPLANATION',
        task_family_id: issuedQuestion.template_version_id,
        task_version_id: issuedQuestion.template_version_id,
        rubric_version: 'diagnostic-unassessed-v1',
        difficulty: 1,
        assistance_level: assistance,
        assessment_kind: 'LOCAL',
        source_ref: answerId,
        status: 'ACTIVE',
        created_at: new Date().toISOString(),
        evidence_excerpt: null,
      };
      await client.query(
        `INSERT INTO diagnostic_evidence_records(id,session_id,question_instance_id,answer_submission_id,evidence,role,disclosed)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          newUuid(),
          input.sessionId,
          questionInstanceId,
          answerId,
          evidence,
          role,
          assistance === 'SOLUTION',
        ],
      );
      await client.query(
        'UPDATE diagnostic_sessions SET question_count=question_count+1 WHERE id=$1',
        [input.sessionId],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async recordAssessmentEvidence(input: {
    sessionId: string;
    userId: string;
    questionInstanceId: string;
    answerSubmissionId: string;
    evidence: Evidence;
    disclosed?: boolean;
  }): Promise<void> {
    const check = await this.pool.query<{
      assistance_reported: 'NONE' | 'HINT' | 'SOLUTION';
    }>(
      `SELECT a.assistance_reported FROM diagnostic_sessions s
       JOIN diagnostic_question_instances q ON q.session_id=s.id AND q.id=$3
       JOIN diagnostic_answer_submissions a ON a.session_id=s.id AND a.id=$4 AND a.question_instance_id=q.id
       WHERE s.id=$1 AND s.user_id=$2`,
      [input.sessionId, input.userId, input.questionInstanceId, input.answerSubmissionId],
    );
    const answer = check.rows[0];
    if (!answer) throw new Error('Diagnostic evidence does not belong to this session');
    await this.pool.query(
      `INSERT INTO diagnostic_evidence_records(id,session_id,question_instance_id,answer_submission_id,evidence,role,disclosed)
       VALUES ($1,$2,$3,$4,$5,'ASSESSMENT',$6)`,
      [
        newUuid(),
        input.sessionId,
        input.questionInstanceId,
        input.answerSubmissionId,
        input.evidence,
        Boolean(input.disclosed) ||
          input.evidence.assistance_level === 'SOLUTION' ||
          answer.assistance_reported === 'SOLUTION',
      ],
    );
  }

  async finish(input: {
    sessionId: string;
    userId: string;
    policies: readonly MasteryPolicy[];
    stoppingReason:
      | 'ALL_TARGETS_RESOLVED'
      | 'HARD_LIMIT'
      | 'NO_ELIGIBLE_QUESTION'
      | 'ADDITIONAL_CONSENT_REQUIRED'
      | 'USER_FINISHED'
      | 'PAUSED';
    evaluatedAt: string;
  }): Promise<{ resultId: string; result: DiagnosticResult }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const session = await client.query<{
        status: 'IN_PROGRESS' | 'PAUSED' | 'COMPLETED' | 'COMPLETED_PARTIAL';
        snapshot: DiagnosticContextSnapshot;
        catalog_version: string;
        method_version: string;
        template_version: string;
        parent_result_id: string | null;
      }>(
        `SELECT status,snapshot,catalog_version,method_version,template_version,parent_result_id
         FROM diagnostic_sessions WHERE id=$1 AND user_id=$2 FOR UPDATE`,
        [input.sessionId, input.userId],
      );
      const row = session.rows[0];
      if (!row) throw new Error('Diagnostic session not found');
      if (row.status === 'COMPLETED' || row.status === 'COMPLETED_PARTIAL')
        throw new Error('Diagnostic session already has a final result');
      const records = await client.query<{
        evidence: Evidence;
        question_instance_id: string | null;
        answer_submission_id: string | null;
        role: DiagnosticEvidenceRecord['role'];
        disclosed: boolean;
      }>(
        'SELECT evidence,question_instance_id,answer_submission_id,role,disclosed FROM diagnostic_evidence_records WHERE session_id=$1 ORDER BY created_at,id',
        [input.sessionId],
      );
      const result = buildDiagnosticResult({
        context: row.snapshot.context,
        session: { id: input.sessionId, status: row.status },
        evidence: records.rows.map((record) => ({
          evidence: record.evidence,
          questionInstanceId: record.question_instance_id,
          answerSubmissionId: record.answer_submission_id,
          role: record.role,
          disclosed: record.disclosed,
        })),
        policies: input.policies,
        stoppingReason: input.stoppingReason,
        evaluatedAt: input.evaluatedAt,
        catalogVersion: row.catalog_version,
        methodVersion: row.method_version,
        templateVersion: row.template_version,
      });
      const resultId = newUuid();
      await client.query(
        `INSERT INTO diagnostic_results(id,session_id,previous_result_id,status,payload)
         VALUES ($1,$2,$3,$4,$5)`,
        [resultId, input.sessionId, row.parent_result_id, result.status, result],
      );
      await client.query(
        `UPDATE diagnostic_sessions SET status=$2,finished_at=CASE WHEN $2='PAUSED' THEN NULL ELSE now() END,revision=revision+1
         WHERE id=$1`,
        [input.sessionId, result.status],
      );
      await client.query('COMMIT');
      return { resultId, result };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async resume(input: { sessionId: string; userId: string }): Promise<void> {
    const result = await this.pool.query(
      `UPDATE diagnostic_sessions SET status='IN_PROGRESS',revision=revision+1
       WHERE id=$1 AND user_id=$2 AND status='PAUSED'`,
      [input.sessionId, input.userId],
    );
    if (result.rowCount !== 1) throw new Error('Diagnostic session is not paused');
  }

  async reassess(input: {
    sessionId: string;
    userId: string;
    sessionIdForReassess?: string;
  }): Promise<string> {
    const parent = await this.pool.query<{
      problem_version_id: string;
      classification_decision_id: string;
      snapshot: DiagnosticContextSnapshot;
      plan: DiagnosticPlan;
      result_id: string | null;
    }>(
      `SELECT s.problem_version_id,s.classification_decision_id,s.snapshot,s.plan,
              (SELECT r.id FROM diagnostic_results r WHERE r.session_id=s.id ORDER BY r.created_at DESC LIMIT 1) AS result_id
       FROM diagnostic_sessions s WHERE s.id=$1 AND s.user_id=$2`,
      [input.sessionId, input.userId],
    );
    const row = parent.rows[0];
    if (!row?.result_id) throw new Error('A diagnostic result is required before reassessment');
    const sessionId = input.sessionIdForReassess ?? newUuid();
    const snapshot = structuredClone(row.snapshot);
    snapshot.context.session_id = sessionId;
    snapshot.context.evidence_revision = 0;
    const plan = structuredClone(row.plan);
    plan.snapshot = snapshot;
    return this.create({
      sessionId,
      userId: input.userId,
      problemVersionId: row.problem_version_id,
      classificationDecisionId: row.classification_decision_id,
      plan,
      parentSessionId: input.sessionId,
      parentResultId: row.result_id,
    });
  }
}

export function classificationDecisionMetadata(
  classification: Classification,
  traceId?: string,
): Record<string, unknown> {
  return {
    classification: {
      type: classification.type,
      status: classification.status,
      confidence: classification.confidence,
      reason: classification.reason,
      path: classification.path,
      rulesVersion: classification.rulesVersion,
      clarificationNeeded: classification.clarificationNeeded,
      ...(classification.promptVersion === undefined
        ? {}
        : { promptVersion: classification.promptVersion }),
      ...(classification.modelIdentifier === undefined
        ? {}
        : { modelIdentifier: classification.modelIdentifier }),
      ...(classification.providerResult === undefined
        ? {}
        : { providerResult: classification.providerResult }),
    },
    ...(traceId === undefined ? {} : { traceId }),
  };
}

/** Persists explainable classification provenance without copying raw request text into audit data. */
export async function recordClassificationDecision(
  pool: Pool,
  input: {
    userId: string | null;
    problemVersionId: string;
    problemVersion: number;
    classification: Classification;
    traceId?: string;
  },
): Promise<{ decisionId: string; eventId: string }> {
  const decisionId = newUuid();
  const eventId = newUuid();
  const client = await pool.connect();
  const metadata = classificationDecisionMetadata(input.classification, input.traceId);
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO decision_events(event_id,actor_type,actor_id,action,target_type,target_id,target_version,metadata) VALUES ($1,$2,$3,'PROBLEM_CLASSIFIED','PROBLEM_VERSION',$4,$5,$6)`,
      [
        eventId,
        input.userId ? 'USER' : 'SYSTEM',
        input.userId,
        input.problemVersionId,
        input.problemVersion,
        metadata,
      ],
    );
    await client.query(
      `INSERT INTO audit_events(id,event_id,actor_type,actor_id,action,target_type,target_id,target_version,result,metadata) VALUES ($1,$2,$3,$4,'PROBLEM_CLASSIFIED','PROBLEM_VERSION',$5,$6,'SUCCEEDED',$7)`,
      [
        newUuid(),
        eventId,
        input.userId ? 'USER' : 'SYSTEM',
        input.userId,
        input.problemVersionId,
        input.problemVersion,
        metadata,
      ],
    );
    await client.query(
      `INSERT INTO classification_decisions(id,event_id,problem_version_id,type,status,confidence,reason_code,path,rules_version,prompt_version,model_identifier,clarification_needed) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        decisionId,
        eventId,
        input.problemVersionId,
        input.classification.type,
        input.classification.status === 'classified' ? 'CLASSIFIED' : 'AMBIGUOUS',
        input.classification.confidence,
        input.classification.reason,
        input.classification.path,
        input.classification.rulesVersion,
        input.classification.promptVersion ?? null,
        input.classification.modelIdentifier ?? null,
        input.classification.clarificationNeeded,
      ],
    );
    await client.query('COMMIT');
    return { decisionId, eventId };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
