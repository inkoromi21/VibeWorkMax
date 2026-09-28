import { demoDiagnosticCatalog } from '@vibework/content';
import { validateContract, type DiagnosticContext } from '@vibework/contracts';
import { newUuid } from '@vibework/shared';
import type { Pool } from 'pg';
import type { Classification } from './classification.js';
import {
  buildDiagnosticPlan,
  createDiagnosticContextSnapshot,
  PostgresDiagnosticSessionRepository,
  recordClassificationDecision,
  type DiagnosticPlan,
} from './diagnostics.js';

export interface MinimumDiagnosticProfile {
  educationTrack: 'school' | 'student';
  /** Self-reported labels are only used for a direction request. */
  interestIds?: readonly string[];
}

export interface CanonicalDiagnosticSession {
  problemId: string;
  problemVersionId: string;
  problemVersion: number;
  profileVersionId: string;
  profileVersion: number;
  classificationDecisionId: string;
  classificationEventId: string;
  sessionId: string;
  plan: DiagnosticPlan;
}

/** Shared canonical flow for MAX bot and mini-app. */
export class PostgresProblemDiagnosticRepository {
  private readonly sessions: PostgresDiagnosticSessionRepository;

  constructor(private readonly pool: Pool) {
    this.sessions = new PostgresDiagnosticSessionRepository(pool);
  }

  async createConfirmedSession(input: {
    userId: string;
    rawText: string;
    classification: Classification;
    profile: MinimumDiagnosticProfile;
    traceId?: string;
  }): Promise<CanonicalDiagnosticSession> {
    if (input.classification.status !== 'classified' || !input.classification.type)
      throw new Error('A confirmed classification is required before creating a session');
    if (!input.rawText.trim() || input.rawText.length > 1_000)
      throw new Error('Problem text must contain 1 to 1000 characters');
    if (input.profile.interestIds && input.profile.interestIds.length > 3)
      throw new Error('No more than three interests may be used for diagnostics');

    const ids = await this.createProblemAndProfile(input);
    const decision = await recordClassificationDecision(this.pool, {
      userId: input.userId,
      problemVersionId: ids.problemVersionId,
      problemVersion: ids.problemVersion,
      classification: input.classification,
      ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
    });
    const sessionId = newUuid();
    const interests =
      input.classification.type === 'DIRECTION'
        ? (input.profile.interestIds ?? []).map((label) => ({
            label,
            source: 'self_report' as const,
          }))
        : [];
    const context: DiagnosticContext = {
      schema_version: '4.0',
      session_id: sessionId,
      problem_id: ids.problemId,
      problem_version: ids.problemVersion,
      profile_version: ids.profileVersion,
      evidence_revision: 0,
      goal_type: input.classification.type,
      // Raw problem text belongs only to the immutable problem-version payload.
      confirmed_goal: input.classification.interpretation,
      completeness: 'COMPLETED_PARTIAL',
      competencies: [],
      interests,
      constraints: {
        age_group: 'unknown',
        role: input.profile.educationTrack === 'school' ? 'SCHOOL' : 'STUDENT',
        device: 'UNKNOWN',
        tools: [],
        session_minutes: 6,
        weekly_minutes: null,
        deadline: null,
        language: 'ru',
        paid_resources_allowed: null,
        preferred_format: null,
      },
      evidence_ids: [],
      unresolved_questions: [],
      recommended_entry: {
        competency_id: 'diagnostic.first-step',
        reason: {
          kind: 'EXPLORATION',
          explanation: 'Нужна короткая диагностика перед первым шагом.',
          evidence_ids: [],
          assumption_reason: null,
        },
      },
      method_versions: ['diagnostic-planner-v1'],
    };
    if (!validateContract('DiagnosticContext', context).valid)
      throw new Error('Unable to create a valid DiagnosticContext');
    const snapshot = createDiagnosticContextSnapshot({
      context,
      classification: input.classification,
      decisionEventId: decision.eventId,
      catalog: demoDiagnosticCatalog,
      usedProfile: {
        profileVersion: ids.profileVersion,
        educationTrack: input.profile.educationTrack,
        interestIds:
          input.classification.type === 'DIRECTION' ? [...(input.profile.interestIds ?? [])] : [],
      },
      sessionMinutes: 6,
    });
    const plan = buildDiagnosticPlan(snapshot, demoDiagnosticCatalog);
    await this.sessions.create({
      sessionId,
      userId: input.userId,
      problemVersionId: ids.problemVersionId,
      classificationDecisionId: decision.decisionId,
      plan,
    });
    return {
      ...ids,
      classificationDecisionId: decision.decisionId,
      classificationEventId: decision.eventId,
      sessionId,
      plan,
    };
  }

  private async createProblemAndProfile(input: {
    userId: string;
    rawText: string;
    profile: MinimumDiagnosticProfile;
  }): Promise<
    Pick<
      CanonicalDiagnosticSession,
      'problemId' | 'problemVersionId' | 'problemVersion' | 'profileVersionId' | 'profileVersion'
    >
  > {
    const problemId = newUuid();
    const problemVersionId = newUuid();
    const profileVersionId = newUuid();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const user = await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [
        input.userId,
      ]);
      if (user.rowCount !== 1) throw new Error('Diagnostic user does not exist');
      const previous = await client.query<{ version: number }>(
        'SELECT COALESCE(MAX(version),0)::integer AS version FROM profile_versions WHERE user_id=$1',
        [input.userId],
      );
      const profileVersion = (previous.rows[0]?.version ?? 0) + 1;
      await client.query('INSERT INTO problems(id,user_id) VALUES ($1,$2)', [
        problemId,
        input.userId,
      ]);
      await client.query(
        'INSERT INTO problem_versions(id,problem_id,version,payload) VALUES ($1,$2,1,$3)',
        [problemVersionId, problemId, { raw_text: input.rawText.trim() }],
      );
      await client.query(
        'INSERT INTO profile_versions(id,user_id,version,payload) VALUES ($1,$2,$3,$4)',
        [
          profileVersionId,
          input.userId,
          profileVersion,
          {
            education_track: input.profile.educationTrack,
            interests: input.profile.interestIds ?? [],
            source: 'diagnostic-minimum-v1',
          },
        ],
      );
      await client.query('COMMIT');
      return { problemId, problemVersionId, problemVersion: 1, profileVersionId, profileVersion };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
