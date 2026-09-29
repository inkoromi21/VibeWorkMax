import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ApplicationError, newUuid, normalizeIdempotencyKey } from '@vibework/shared';
import type { Pool } from 'pg';
import {
  actorDigest,
  clarifyProblem,
  classifyProblem,
  resolveProblemClassification,
  PostgresProblemDiagnosticRepository,
  type Classification,
  type AiProblemClassifier,
  type DiagnosticResult,
  type MinimumDiagnosticProfile,
  DiagnosticApplicationService,
  PostgresAccessPolicy,
  type AccessDecision,
  type ConsentPolicy,
} from '@vibework/domain';
import {
  demoDiagnosticCatalog,
  REQUEST_TYPES,
  selectApprovedDiagnosticTemplates,
} from '@vibework/content';

const SESSION_COOKIE = 'max_session';
const SESSION_TTL_SECONDS = 60 * 60;
const CLOCK_SKEW_SECONDS = 60;

export interface VerifiedLaunch {
  maxUserId: string;
  issuedAt: number;
}

function reject(code: string, message: string, statusCode = 401): never {
  throw new ApplicationError({ code, message, statusCode });
}

/** Parses initData without URLSearchParams so duplicate input can never be silently collapsed. */
function parsePairs(value: string): [string, string][] {
  if (!value || value.length > 16_384) reject('INVALID_INIT_DATA', 'Некорректные данные запуска');
  const pairs: [string, string][] = [];
  const names = new Set<string>();
  for (const fragment of value.split('&')) {
    const separator = fragment.indexOf('=');
    if (separator <= 0) reject('MALFORMED_INIT_DATA', 'Некорректные параметры запуска');
    const name = fragment.slice(0, separator);
    const encoded = fragment.slice(separator + 1);
    if (!/^[A-Za-z0-9_]+$/.test(name) || names.has(name))
      reject('DUPLICATE_INIT_DATA_PARAMETER', 'Повторяющийся параметр запуска');
    names.add(name);
    try {
      pairs.push([name, decodeURIComponent(encoded)]);
    } catch {
      reject('MALFORMED_INIT_DATA', 'Некорректное кодирование параметров запуска');
    }
  }
  return pairs;
}

export function verifyMaxInitData(
  initData: string,
  botToken: string,
  now = Date.now(),
): VerifiedLaunch {
  if (!botToken) reject('MAX_AUTH_DISABLED', 'Вход через MAX временно недоступен', 503);
  const pairs = parsePairs(initData);
  const hash = pairs.find(([name]) => name === 'hash')?.[1];
  if (!hash || !/^[a-f0-9]{64}$/i.test(hash))
    reject('MISSING_INIT_DATA_HASH', 'Подпись запуска отсутствует');
  const launchParams = pairs
    .filter(([name]) => name !== 'hash')
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}=${value}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(launchParams).digest('hex');
  const equal = timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(hash, 'hex'));
  if (!equal) reject('INVALID_INIT_DATA_HASH', 'Подпись запуска недействительна');
  const authDate = pairs.find(([name]) => name === 'auth_date')?.[1];
  if (!authDate || !/^\d{1,12}$/.test(authDate))
    reject('INVALID_AUTH_DATE', 'Дата авторизации недействительна');
  const issuedAt = Number(authDate);
  const ageSeconds = Math.floor(now / 1_000) - issuedAt;
  if (ageSeconds > SESSION_TTL_SECONDS || ageSeconds < -CLOCK_SKEW_SECONDS)
    reject('EXPIRED_INIT_DATA', 'Срок действия данных запуска истёк');
  const user = pairs.find(([name]) => name === 'user')?.[1];
  try {
    const parsed = JSON.parse(user ?? '') as { id?: number | string };
    const maxUserId = String(parsed.id ?? '');
    if (!/^\d{1,20}$/.test(maxUserId)) throw new Error('invalid id');
    return { maxUserId, issuedAt };
  } catch {
    return reject('INVALID_INIT_DATA_USER', 'Пользователь запуска не подтверждён');
  }
}

export interface MiniAppState {
  revision: number;
  problemDraft: string;
  problem: { text: string; classification: Classification; version: number } | null;
  diagnosticProfile?: MinimumDiagnosticProfile;
  canonicalDiagnostic?: {
    sessionId: string;
    problemVersionId: string;
    sessionRevision: number;
    questionInstanceId: string | null;
    publicQuestion: Record<string, unknown> | null;
  };
  diagnostic: {
    index: number;
    answers: Record<string, unknown>;
    paused: boolean;
    completed: boolean;
    additionalConsent: boolean;
  };
  result: {
    version: number;
    evidenceSufficiency: 'LIMITED' | 'PARTIAL';
    findings: { label: string; status: 'KNOWN' | 'GAP' | 'UNKNOWN' }[];
    source: string;
  } | null;
  goal: { text: string; version: number } | null;
  route: {
    version: number;
    status: 'ACTIVE';
    goalVersion: number;
    contentMode: 'DEMO';
    step: { title: string; rationale: string; durationMinutes: number };
  } | null;
  attemptCount: number;
  notificationsEnabled: boolean;
}

function diagnosticQuestionsFor(classification: Classification | undefined) {
  if (!classification?.type) return [];
  return selectApprovedDiagnosticTemplates(demoDiagnosticCatalog, classification.type)
    .slice(0, 12)
    .map((template) => ({
      id: template.id,
      kind:
        template.kind === 'CHOICE'
          ? 'single'
          : template.kind === 'PREFERENCE'
            ? 'preference'
            : 'short',
      prompt: template.prompt,
      ...(template.options.length ? { options: [...template.options] } : {}),
    }));
}

/** Exported for the current mini-app client; values always come from approved content. */
export const diagnosticQuestions = diagnosticQuestionsFor(classifyProblem('хочу научиться навыку'));

type DiagnosticAction = 'answer' | 'skip' | 'unknown' | 'pause' | 'resume' | 'finish' | 'more';

function buildResult(state: MiniAppState): NonNullable<MiniAppState['result']> {
  const answered = Object.keys(state.diagnostic.answers).length;
  return {
    version: (state.result?.version ?? 0) + 1,
    evidenceSufficiency: answered >= 3 ? 'PARTIAL' : 'LIMITED',
    findings: [
      {
        label: state.problem?.classification.interpretation ?? 'Формулировка запроса',
        status: 'KNOWN',
      },
      { label: 'Нужен короткий проверяемый первый шаг', status: 'GAP' },
      { label: 'Остальные навыки пока не проверены', status: 'UNKNOWN' },
    ],
    source: 'Ответы в диагностике; DEMO-интерпретация без production-рубрики.',
  };
}

function presentationResult(
  state: MiniAppState,
  canonical?: DiagnosticResult,
): NonNullable<MiniAppState['result']> {
  if (!canonical) return buildResult(state);
  return {
    version: (state.result?.version ?? 0) + 1,
    evidenceSufficiency: canonical.status === 'COMPLETED' ? 'PARTIAL' : 'LIMITED',
    findings: [
      ...canonical.known.map((item) => ({ label: item.competency_id, status: 'KNOWN' as const })),
      ...canonical.gaps.map((item) => ({ label: item.competency_id, status: 'GAP' as const })),
      ...canonical.unknown.map((item) => ({
        label: item.competency_id,
        status: 'UNKNOWN' as const,
      })),
    ],
    source: canonical.explanation,
  };
}

function initialState(): MiniAppState {
  return {
    revision: 0,
    problemDraft: '',
    problem: null,
    diagnostic: {
      index: 0,
      answers: {},
      paused: false,
      completed: false,
      additionalConsent: false,
    },
    result: null,
    goal: null,
    route: null,
    attemptCount: 0,
    notificationsEnabled: true,
  };
}

export interface SessionRecord {
  id: string;
  userId: string;
  csrf: string;
  expiresAt: Date;
}
export interface MiniAppStore {
  createSession(subject: string): Promise<SessionRecord>;
  getSession(id: string): Promise<SessionRecord | null>;
  rotateCsrf(id: string): Promise<string>;
  revokeSession(id: string): Promise<void>;
  getState(userId: string): Promise<MiniAppState>;
  updateState(
    userId: string,
    expectedRevision: number,
    apply: (state: MiniAppState) => MiniAppState,
  ): Promise<MiniAppState>;
  accessDecision?(userId: string): Promise<AccessDecision>;
  assertAccess?(userId: string): Promise<void>;
}

interface CanonicalDiagnosticStore {
  createCanonicalDiagnostic(input: {
    userId: string;
    rawText: string;
    classification: Classification;
    profile: MinimumDiagnosticProfile;
  }): Promise<NonNullable<MiniAppState['canonicalDiagnostic']>>;
  saveCanonicalAnswer(input: {
    userId: string;
    sessionId: string;
    questionInstanceId: string;
    expectedRevision: number;
    idempotencyKey: string;
    kind: 'CHOICE' | 'TEXT' | 'SKIP' | 'DONT_KNOW';
    value: string[] | string | null;
  }): Promise<{
    sessionRevision: number;
    questionInstanceId: string | null;
    publicQuestion: Record<string, unknown> | null;
    stoppedReason?: string;
  }>;
  grantCanonicalConsent(input: { userId: string; sessionId: string }): Promise<{
    sessionRevision: number;
    questionInstanceId: string;
    publicQuestion: Record<string, unknown>;
  }>;
  finishCanonicalDiagnostic(input: {
    userId: string;
    sessionId: string;
    reason: 'USER_FINISHED' | 'PAUSED' | 'HARD_LIMIT' | 'NO_ELIGIBLE_QUESTION';
  }): Promise<DiagnosticResult>;
  resumeCanonicalDiagnostic(input: { userId: string; sessionId: string }): Promise<void>;
  saveGoalAndPublishRoute(input: {
    userId: string;
    text: string;
    expectedRevision: number;
  }): Promise<{
    goal: NonNullable<MiniAppState['goal']>;
    route: NonNullable<MiniAppState['route']>;
    state: MiniAppState;
  }>;
  saveAttemptAndReview(input: {
    userId: string;
    answer: string;
    idempotencyKey: string;
    assistanceLevel: 'NONE' | 'HINT' | 'SOLUTION';
    expectedRevision: number;
  }): Promise<{
    attemptId: string;
    reviewId: string;
    independentPassEligible: boolean;
    status: 'PENDING' | 'READY';
    rubricVersion: string;
    feedback: string;
    state: MiniAppState;
  }>;
  getLatestReview(input: { userId: string; attemptId: string }): Promise<{
    reviewId: string;
    version: number;
    status: 'PENDING' | 'READY';
    rubricVersion: string;
    feedback: string;
  } | null>;
  saveNotificationPreference(input: {
    userId: string;
    enabled: boolean;
    expectedRevision: number;
  }): Promise<MiniAppState>;
  getActiveRoute(userId: string): Promise<Record<string, unknown> | null>;
  assertRevision(userId: string, expectedRevision: number): Promise<void>;
  getProgress(userId: string): Promise<Record<string, unknown>>;
  createExportRequest(userId: string): Promise<{ id: string; status: 'READY' }>;
  getReadyExport(input: { userId: string; requestId: string }): Promise<Record<string, unknown>>;
  createDeletionRequest(userId: string): Promise<{ id: string; status: 'PENDING_POLICY' }>;
  createDispute(input: {
    userId: string;
    attemptId: string;
    reason: string;
  }): Promise<{ id: string }>;
}

function supportsCanonicalDiagnostics(
  store: MiniAppStore,
): store is MiniAppStore & CanonicalDiagnosticStore {
  return 'createCanonicalDiagnostic' in store;
}

export class MemoryMiniAppStore implements MiniAppStore {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly states = new Map<string, MiniAppState>();
  createSession(subject: string): Promise<SessionRecord> {
    const record = {
      id: newUuid(),
      userId: subject,
      csrf: randomBytes(24).toString('base64url'),
      expiresAt: new Date(Date.now() + SESSION_TTL_SECONDS * 1_000),
    };
    this.sessions.set(record.id, record);
    return Promise.resolve(record);
  }
  getSession(id: string): Promise<SessionRecord | null> {
    const record = this.sessions.get(id);
    return Promise.resolve(record && record.expiresAt > new Date() ? record : null);
  }
  async rotateCsrf(id: string): Promise<string> {
    const session = await this.getSession(id);
    if (!session)
      throw new ApplicationError({
        code: 'SESSION_EXPIRED',
        message: 'Сессия истекла',
        statusCode: 401,
      });
    const csrf = randomBytes(24).toString('base64url');
    this.sessions.set(id, { ...session, csrf });
    return csrf;
  }
  revokeSession(id: string): Promise<void> {
    this.sessions.delete(id);
    return Promise.resolve();
  }
  getState(userId: string): Promise<MiniAppState> {
    return Promise.resolve(this.states.get(userId) ?? initialState());
  }
  async updateState(
    userId: string,
    expectedRevision: number,
    apply: (state: MiniAppState) => MiniAppState,
  ): Promise<MiniAppState> {
    const state = await this.getState(userId);
    if (state.revision !== expectedRevision)
      throw new ApplicationError({
        code: 'REVISION_CONFLICT',
        message: 'Данные изменились в другом окне',
        statusCode: 409,
        currentRevision: state.revision,
      });
    const next = { ...apply(state), revision: state.revision + 1 };
    this.states.set(userId, next);
    return next;
  }
}

/** Durable store: the state document is version-locked; immutable records live in the additive tables. */
export class PostgresMiniAppStore implements MiniAppStore {
  private readonly accessPolicy: PostgresAccessPolicy | undefined;
  private readonly diagnostics: DiagnosticApplicationService;
  constructor(
    private readonly pool: Pool,
    consentPolicy?: ConsentPolicy,
  ) {
    this.accessPolicy = consentPolicy ? new PostgresAccessPolicy(pool, consentPolicy) : undefined;
    this.diagnostics = new DiagnosticApplicationService(pool, demoDiagnosticCatalog);
  }
  accessDecision(userId: string): Promise<AccessDecision> {
    return this.accessPolicy?.decide(userId) ?? Promise.resolve({ allowed: true });
  }
  assertAccess(userId: string): Promise<void> {
    return this.accessPolicy?.assertAllowed(userId) ?? Promise.resolve();
  }
  async createSession(subject: string): Promise<SessionRecord> {
    const client = await this.pool.connect();
    const session = {
      id: newUuid(),
      userId: '',
      csrf: randomBytes(24).toString('base64url'),
      expiresAt: new Date(Date.now() + SESSION_TTL_SECONDS * 1_000),
    };
    try {
      await client.query('BEGIN');
      const actorHash = actorDigest(subject);
      const existing = await client.query<{ user_id: string }>(
        'SELECT user_id FROM max_user_identities WHERE actor_id_hash=$1',
        [actorHash],
      );
      session.userId = existing.rows[0]?.user_id ?? newUuid();
      if (!existing.rows[0]) {
        await client.query('INSERT INTO users(id) VALUES ($1)', [session.userId]);
        await client.query(
          'INSERT INTO max_user_identities(user_id, actor_id_hash) VALUES ($1,$2)',
          [session.userId, actorHash],
        );
      }
      await client.query('INSERT INTO sessions(id,user_id,expires_at) VALUES ($1,$2,$3)', [
        session.id,
        session.userId,
        session.expiresAt,
      ]);
      await client.query(
        'INSERT INTO mini_app_session_secrets(session_id,csrf_hash) VALUES ($1,$2)',
        [session.id, actorDigest(session.csrf)],
      );
      await client.query('COMMIT');
      return session;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async getSession(id: string): Promise<SessionRecord | null> {
    const result = await this.pool.query<{ user_id: string; expires_at: Date; csrf: string }>(
      `SELECT s.user_id,s.expires_at,m.csrf_hash AS csrf FROM sessions s JOIN mini_app_session_secrets m ON m.session_id=s.id WHERE s.id=$1 AND s.revoked_at IS NULL AND s.expires_at>now()`,
      [id],
    );
    const row = result.rows[0];
    // The caller compares the submitted token against its hash through a dedicated check below.
    return row ? { id, userId: row.user_id, csrf: row.csrf, expiresAt: row.expires_at } : null;
  }
  async rotateCsrf(id: string): Promise<string> {
    const csrf = randomBytes(24).toString('base64url');
    const result = await this.pool.query(
      'UPDATE mini_app_session_secrets SET csrf_hash=$2 WHERE session_id=$1',
      [id, actorDigest(csrf)],
    );
    if (result.rowCount !== 1)
      throw new ApplicationError({
        code: 'SESSION_EXPIRED',
        message: 'Сессия истекла',
        statusCode: 401,
      });
    return csrf;
  }
  async revokeSession(id: string): Promise<void> {
    await this.pool.query('UPDATE sessions SET revoked_at=now() WHERE id=$1', [id]);
  }
  async getState(userId: string): Promise<MiniAppState> {
    const [
      stored,
      goalResult,
      routeResult,
      attemptResult,
      preferenceResult,
      diagnosticResult,
      activeDiagnosticResult,
    ] = await Promise.all([
      this.pool.query<{ state: MiniAppState }>(
        'SELECT state FROM mini_app_states WHERE user_id=$1',
        [userId],
      ),
      this.pool.query<{ version: number; payload: { text?: string } }>(
        'SELECT version,payload FROM goals WHERE user_id=$1 ORDER BY version DESC LIMIT 1',
        [userId],
      ),
      this.pool.query<{ version: number; payload: Record<string, unknown> }>(
        "SELECT version,payload FROM learning_routes WHERE user_id=$1 AND status='ACTIVE'",
        [userId],
      ),
      this.pool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM attempts WHERE user_id=$1',
        [userId],
      ),
      this.pool.query<{ enabled: boolean }>(
        'SELECT enabled FROM notification_preferences WHERE user_id=$1',
        [userId],
      ),
      this.pool.query<{ payload: DiagnosticResult }>(
        `SELECT r.payload FROM diagnostic_results r
           JOIN diagnostic_sessions s ON s.id=r.session_id
           WHERE s.user_id=$1 ORDER BY r.created_at DESC LIMIT 1`,
        [userId],
      ),
      this.pool.query<{
        session_id: string;
        problem_version_id: string;
        revision: number;
        question_count: number;
        status: 'IN_PROGRESS' | 'PAUSED';
        snapshot: {
          classification?: Omit<Classification, 'interpretation' | 'clarificationNeeded'>;
          context?: { confirmed_goal?: string };
          usedProfile?: {
            educationTrack: 'school' | 'student' | null;
            interestIds: readonly string[];
          };
        };
        problem_payload: { raw_text?: string };
        question_instance_id: string | null;
        public_payload: Record<string, unknown> | null;
      }>(
        `SELECT s.id AS session_id,s.problem_version_id,s.revision,s.question_count,s.status,
                  s.snapshot,pv.payload AS problem_payload,q.id AS question_instance_id,
                  q.public_payload
           FROM diagnostic_sessions s
           JOIN problem_versions pv ON pv.id=s.problem_version_id
           LEFT JOIN LATERAL (
             SELECT qi.id,qi.public_payload FROM diagnostic_question_instances qi
             LEFT JOIN diagnostic_answer_submissions a ON a.question_instance_id=qi.id
             WHERE qi.session_id=s.id AND a.id IS NULL ORDER BY qi.ordinal DESC LIMIT 1
           ) q ON true
           WHERE s.user_id=$1 AND s.status IN ('IN_PROGRESS','PAUSED')
           ORDER BY s.created_at DESC LIMIT 1`,
        [userId],
      ),
    ]);
    const base = stored.rows[0]?.state ?? initialState();
    const goal = goalResult.rows[0];
    const route = routeResult.rows[0];
    const routePayload = route?.payload as
      | {
          inputs?: { goalVersion?: number };
          contentMode?: string;
          steps?: {
            title?: string;
            rationale?: string;
            reason?: string;
            durationMinutes?: number;
          }[];
        }
      | undefined;
    const step = routePayload?.steps?.[0];
    const canonicalResult = diagnosticResult.rows[0]?.payload;
    const activeDiagnostic = activeDiagnosticResult.rows[0];
    const activeClassification = activeDiagnostic?.snapshot.classification;
    return {
      ...base,
      ...(activeDiagnostic && activeClassification
        ? {
            problem: {
              text: activeDiagnostic.problem_payload.raw_text ?? '',
              classification: {
                ...activeClassification,
                interpretation:
                  activeDiagnostic.snapshot.context?.confirmed_goal ?? 'Подтверждённый запрос',
                clarificationNeeded: false,
              },
              version: 1,
            },
            ...(activeDiagnostic.snapshot.usedProfile?.educationTrack
              ? {
                  diagnosticProfile: {
                    educationTrack: activeDiagnostic.snapshot.usedProfile.educationTrack,
                    interestIds: activeDiagnostic.snapshot.usedProfile.interestIds,
                  },
                }
              : {}),
            canonicalDiagnostic: {
              sessionId: activeDiagnostic.session_id,
              problemVersionId: activeDiagnostic.problem_version_id,
              sessionRevision: activeDiagnostic.revision,
              questionInstanceId: activeDiagnostic.question_instance_id,
              publicQuestion: activeDiagnostic.public_payload,
            },
            diagnostic: {
              ...base.diagnostic,
              index: activeDiagnostic.question_count,
              paused: activeDiagnostic.status === 'PAUSED',
              completed: false,
            },
          }
        : {}),
      ...(goal?.payload.text ? { goal: { text: goal.payload.text, version: goal.version } } : {}),
      ...(route && step
        ? {
            route: {
              version: route.version,
              status: 'ACTIVE' as const,
              goalVersion: routePayload.inputs?.goalVersion ?? goal?.version ?? 1,
              contentMode: 'DEMO' as const,
              step: {
                title: step.title ?? 'Следующий шаг',
                rationale: step.rationale ?? step.reason ?? 'Шаг опубликован сервером.',
                durationMinutes: step.durationMinutes ?? 15,
              },
            },
          }
        : {}),
      attemptCount: Number(attemptResult.rows[0]?.count ?? base.attemptCount),
      notificationsEnabled: preferenceResult.rows[0]?.enabled ?? base.notificationsEnabled,
      ...(canonicalResult ? { result: presentationResult(base, canonicalResult) } : {}),
    };
  }
  async updateState(
    userId: string,
    expectedRevision: number,
    apply: (state: MiniAppState) => MiniAppState,
  ): Promise<MiniAppState> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<{ state: MiniAppState }>(
        'SELECT state FROM mini_app_states WHERE user_id=$1 FOR UPDATE',
        [userId],
      );
      const state = result.rows[0]?.state ?? initialState();
      if (state.revision !== expectedRevision)
        throw new ApplicationError({
          code: 'REVISION_CONFLICT',
          message: 'Данные изменились в другом окне',
          statusCode: 409,
          currentRevision: state.revision,
        });
      const next = { ...apply(state), revision: state.revision + 1 };
      await client.query(
        `INSERT INTO mini_app_states(user_id,state) VALUES ($1,$2) ON CONFLICT(user_id) DO UPDATE SET state=EXCLUDED.state,updated_at=now()`,
        [userId, next],
      );
      await client.query('COMMIT');
      return next;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async createCanonicalDiagnostic(input: {
    userId: string;
    rawText: string;
    classification: Classification;
    profile: MinimumDiagnosticProfile;
  }): Promise<NonNullable<MiniAppState['canonicalDiagnostic']>> {
    const created = await new PostgresProblemDiagnosticRepository(this.pool).createConfirmedSession(
      input,
    );
    const issued = await this.diagnostics.issueNext({
      sessionId: created.sessionId,
      userId: input.userId,
    });
    if (issued.kind === 'STOP') throw new Error('Diagnostic catalog has no eligible question');
    return {
      sessionId: created.sessionId,
      problemVersionId: created.problemVersionId,
      sessionRevision: issued.sessionRevision,
      questionInstanceId: issued.questionInstanceId,
      publicQuestion: issued.publicQuestion,
    };
  }

  saveCanonicalAnswer(input: {
    userId: string;
    sessionId: string;
    questionInstanceId: string;
    expectedRevision: number;
    idempotencyKey: string;
    kind: 'CHOICE' | 'TEXT' | 'SKIP' | 'DONT_KNOW';
    value: string[] | string | null;
  }): Promise<{
    sessionRevision: number;
    questionInstanceId: string | null;
    publicQuestion: Record<string, unknown> | null;
    stoppedReason?: string;
  }> {
    return this.saveAndIssue(input);
  }

  private async saveAndIssue(input: {
    userId: string;
    sessionId: string;
    questionInstanceId: string;
    expectedRevision: number;
    idempotencyKey: string;
    kind: 'CHOICE' | 'TEXT' | 'SKIP' | 'DONT_KNOW';
    value: string[] | string | null;
  }) {
    return this.diagnostics.answerAndIssue(input);
  }

  grantCanonicalConsent(input: { userId: string; sessionId: string }) {
    return this.diagnostics.grantAdditionalConsentAndIssue(input);
  }

  async finishCanonicalDiagnostic(input: {
    userId: string;
    sessionId: string;
    reason: 'USER_FINISHED' | 'PAUSED' | 'HARD_LIMIT' | 'NO_ELIGIBLE_QUESTION';
  }): Promise<DiagnosticResult> {
    const finished = await this.diagnostics.finish({
      sessionId: input.sessionId,
      userId: input.userId,
      policies: [],
      stoppingReason: input.reason,
      evaluatedAt: new Date().toISOString(),
    });
    return finished.result;
  }

  resumeCanonicalDiagnostic(input: { userId: string; sessionId: string }): Promise<void> {
    return this.diagnostics.resume(input);
  }

  async saveGoalAndPublishRoute(input: { userId: string; text: string; expectedRevision: number }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `learning-route:${input.userId}`,
      ]);
      const stored = await client.query<{ state: MiniAppState }>(
        'SELECT state FROM mini_app_states WHERE user_id=$1 FOR UPDATE',
        [input.userId],
      );
      const current = stored.rows[0]?.state ?? initialState();
      if (current.revision !== input.expectedRevision)
        throw new ApplicationError({
          code: 'REVISION_CONFLICT',
          message: 'Данные изменились в другом окне',
          statusCode: 409,
          currentRevision: current.revision,
        });
      const result = await client.query<{ id: string; payload: DiagnosticResult }>(
        `SELECT r.id,r.payload FROM diagnostic_results r
         JOIN diagnostic_sessions s ON s.id=r.session_id
         WHERE s.user_id=$1 ORDER BY r.created_at DESC LIMIT 1`,
        [input.userId],
      );
      const resultId = result.rows[0]?.id;
      if (!resultId) throw new Error('Diagnostic result is required');
      const catalog = await client.query<{
        id: string;
        kind: 'LEARNING_BLOCK' | 'METHOD_VERSION';
        version: number;
      }>(
        `SELECT id,kind,version FROM content_catalog_versions
         WHERE status='PUBLISHED' AND
           ((kind='LEARNING_BLOCK' AND logical_id='demo-learning-block') OR
            (kind='METHOD_VERSION' AND logical_id='course-builder'))
         ORDER BY version DESC`,
      );
      const learningBlock = catalog.rows.find((item) => item.kind === 'LEARNING_BLOCK');
      const method = catalog.rows.find((item) => item.kind === 'METHOD_VERSION');
      if (!learningBlock || !method) throw new Error('Published demo catalog is incomplete');
      const versionRow = await client.query<{ version: number }>(
        'SELECT COALESCE(MAX(version),0)+1 AS version FROM goals WHERE user_id=$1',
        [input.userId],
      );
      const goalVersion = versionRow.rows[0]?.version ?? 1;
      const goalId = newUuid();
      await client.query('INSERT INTO goals(id,user_id,payload,version) VALUES ($1,$2,$3,$4)', [
        goalId,
        input.userId,
        { text: input.text, source: 'MINI_APP' },
        goalVersion,
      ]);
      const routeVersionRow = await client.query<{ version: number }>(
        'SELECT COALESCE(MAX(version),0)+1 AS version FROM learning_routes WHERE user_id=$1',
        [input.userId],
      );
      const routeVersion = routeVersionRow.rows[0]?.version ?? 1;
      const routeId = newUuid();
      const step = {
        title: 'Разобрать основу',
        rationale: 'Первый проверяемый шаг из опубликованного demo-каталога.',
        durationMinutes: 15,
      };
      const payload = {
        schemaVersion: 'learning-route-v1',
        contentMode: 'DEMO_SYNTHETIC',
        inputs: {
          diagnosticResultId: resultId,
          goalId,
          goalVersion,
          catalogVersion: 'demo-content-catalog-v1',
          methodVersionId: method.id,
          methodVersion: method.version,
        },
        steps: [{ id: 'demo-first-step-v1', learningBlockVersionId: learningBlock.id, ...step }],
      };
      await client.query(
        `INSERT INTO learning_routes(id,user_id,diagnostic_result_id,goal_id,version,status,payload)
         VALUES ($1,$2,$3,$4,$5,'CANDIDATE',$6)`,
        [routeId, input.userId, resultId, goalId, routeVersion, payload],
      );
      await client.query(
        "UPDATE learning_routes SET status='SUPERSEDED' WHERE user_id=$1 AND status='ACTIVE'",
        [input.userId],
      );
      await client.query(
        "UPDATE learning_routes SET status='ACTIVE',published_at=now() WHERE id=$1",
        [routeId],
      );
      await client.query(
        `INSERT INTO learning_positions(user_id,route_id,step_id,position,revision)
         VALUES ($1,$2,'demo-first-step-v1',0,1)
         ON CONFLICT(user_id) DO UPDATE SET route_id=EXCLUDED.route_id,step_id=EXCLUDED.step_id,
           position=0,revision=learning_positions.revision+1,updated_at=now()`,
        [input.userId, routeId],
      );
      const eventId = newUuid();
      await client.query(
        `INSERT INTO decision_events(event_id,actor_type,actor_id,action,target_type,target_id,target_version,metadata)
         VALUES ($1,'SYSTEM',NULL,'ROUTE_PUBLISHED','LEARNING_ROUTE',$2,$3,$4)`,
        [eventId, routeId, routeVersion, { goalId, diagnosticResultId: resultId }],
      );
      await client.query(
        `INSERT INTO audit_events(id,event_id,actor_type,action,target_type,target_id,target_version,result,metadata)
         VALUES ($1,$2,'SYSTEM','ROUTE_PUBLISHED','LEARNING_ROUTE',$3,$4,'SUCCEEDED',$5)`,
        [newUuid(), eventId, routeId, routeVersion, { contentMode: 'DEMO_SYNTHETIC' }],
      );
      await client.query(
        `INSERT INTO notification_outbox(id,event_id,event_type,payload)
         VALUES ($1,$2,'ROUTE_PUBLISHED',$3)`,
        [newUuid(), eventId, { userId: input.userId, routeId, routeVersion }],
      );
      const goal = { text: input.text, version: goalVersion };
      const route = {
        version: routeVersion,
        status: 'ACTIVE' as const,
        goalVersion,
        contentMode: 'DEMO' as const,
        step,
      };
      const state: MiniAppState = {
        ...current,
        revision: current.revision + 1,
        result: current.result ?? presentationResult(current, result.rows[0]?.payload),
        goal,
        route,
      };
      await client.query(
        `INSERT INTO mini_app_states(user_id,state) VALUES ($1,$2)
         ON CONFLICT(user_id) DO UPDATE SET state=EXCLUDED.state,updated_at=now()`,
        [input.userId, state],
      );
      await client.query('COMMIT');
      return { goal, route, state };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async saveAttemptAndReview(input: {
    userId: string;
    answer: string;
    idempotencyKey: string;
    assistanceLevel: 'NONE' | 'HINT' | 'SOLUTION';
    expectedRevision: number;
  }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const stored = await client.query<{ state: MiniAppState }>(
        'SELECT state FROM mini_app_states WHERE user_id=$1 FOR UPDATE',
        [input.userId],
      );
      const current = stored.rows[0]?.state ?? initialState();
      const replay = await client.query<{
        attempt_id: string;
        independent_pass_eligible: boolean;
        review_id: string;
        rubric_version: string;
        status: 'PENDING' | 'READY';
        payload: { feedback?: string; summary?: string };
      }>(
        `SELECT a.id AS attempt_id,a.independent_pass_eligible,rv.id AS review_id,
                rv.rubric_version,rv.status,rv.payload
         FROM attempts a JOIN review_versions rv ON rv.attempt_id=a.id
         WHERE a.user_id=$1 AND a.idempotency_key=$2
         ORDER BY rv.version DESC LIMIT 1`,
        [input.userId, input.idempotencyKey],
      );
      const replayed = replay.rows[0];
      if (replayed) {
        await client.query('COMMIT');
        return {
          attemptId: replayed.attempt_id,
          reviewId: replayed.review_id,
          independentPassEligible: replayed.independent_pass_eligible,
          status: replayed.status,
          rubricVersion: replayed.rubric_version,
          feedback:
            replayed.payload.feedback ?? replayed.payload.summary ?? 'Попытка ожидает проверки.',
          state: current,
        };
      }
      if (current.revision !== input.expectedRevision)
        throw new ApplicationError({
          code: 'REVISION_CONFLICT',
          message: 'Данные изменились в другом окне',
          statusCode: 409,
          currentRevision: current.revision,
        });
      const route = await client.query<{ id: string }>(
        "SELECT id FROM learning_routes WHERE user_id=$1 AND status='ACTIVE' FOR UPDATE",
        [input.userId],
      );
      const routeId = route.rows[0]?.id;
      if (!routeId) throw new Error('Active route is required');
      const catalog = await client.query<{
        id: string;
        kind: 'TASK_TEMPLATE' | 'RUBRIC';
      }>(
        `SELECT id,kind FROM content_catalog_versions
         WHERE status='PUBLISHED' AND
           ((kind='TASK_TEMPLATE' AND logical_id='demo-task') OR
            (kind='RUBRIC' AND logical_id='demo-rubric'))
         ORDER BY version DESC`,
      );
      const task = catalog.rows.find((item) => item.kind === 'TASK_TEMPLATE');
      const rubric = catalog.rows.find((item) => item.kind === 'RUBRIC');
      if (!task || !rubric) throw new Error('Published task catalog is incomplete');
      const attemptId = newUuid();
      const created = await client.query<{ id: string }>(
        `INSERT INTO attempts(id,user_id,route_id,task_version_id,rubric_version,assistance_level,
          independent_pass_eligible,answer_payload,idempotency_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT(user_id,idempotency_key) DO NOTHING RETURNING id`,
        [
          attemptId,
          input.userId,
          routeId,
          task.id,
          rubric.id,
          input.assistanceLevel,
          input.assistanceLevel === 'NONE',
          { text: input.answer },
          input.idempotencyKey,
        ],
      );
      const effectiveAttemptId =
        created.rows[0]?.id ??
        (
          await client.query<{ id: string }>(
            'SELECT id FROM attempts WHERE user_id=$1 AND idempotency_key=$2',
            [input.userId, input.idempotencyKey],
          )
        ).rows[0]?.id;
      if (!effectiveAttemptId) throw new Error('Attempt idempotency lookup failed');
      const reviewId = newUuid();
      const feedback = 'Попытка сохранена и ожидает проверки.';
      const review = await client.query<{ id: string }>(
        `INSERT INTO review_versions(id,attempt_id,version,rubric_version,status,payload)
         VALUES ($1,$2,1,$3,'PENDING',$4)
         ON CONFLICT(attempt_id,version) DO NOTHING RETURNING id`,
        [reviewId, effectiveAttemptId, rubric.id, { feedback, reason: 'REVIEW_QUEUED' }],
      );
      const effectiveReviewId =
        review.rows[0]?.id ??
        (
          await client.query<{ id: string }>(
            'SELECT id FROM review_versions WHERE attempt_id=$1 AND version=1',
            [effectiveAttemptId],
          )
        ).rows[0]?.id;
      if (!effectiveReviewId) throw new Error('Review idempotency lookup failed');
      await client.query(
        `INSERT INTO attempt_grade_outbox(attempt_id) VALUES ($1) ON CONFLICT DO NOTHING`,
        [effectiveAttemptId],
      );
      const state: MiniAppState = {
        ...current,
        revision: current.revision + 1,
        attemptCount: current.attemptCount + (created.rowCount === 1 ? 1 : 0),
      };
      await client.query(
        `INSERT INTO mini_app_states(user_id,state) VALUES ($1,$2)
         ON CONFLICT(user_id) DO UPDATE SET state=EXCLUDED.state,updated_at=now()`,
        [input.userId, state],
      );
      await client.query('COMMIT');
      return {
        attemptId: effectiveAttemptId,
        reviewId: effectiveReviewId,
        independentPassEligible: input.assistanceLevel === 'NONE',
        status: 'PENDING' as const,
        rubricVersion: rubric.id,
        feedback,
        state,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getLatestReview(input: { userId: string; attemptId: string }) {
    const result = await this.pool.query<{
      review_id: string;
      version: number;
      status: 'PENDING' | 'READY';
      rubric_version: string;
      payload: { feedback?: string; summary?: string };
    }>(
      `SELECT rv.id AS review_id,rv.version,rv.status,rv.rubric_version,rv.payload
       FROM attempts a JOIN review_versions rv ON rv.attempt_id=a.id
       WHERE a.id=$1 AND a.user_id=$2 ORDER BY rv.version DESC LIMIT 1`,
      [input.attemptId, input.userId],
    );
    const review = result.rows[0];
    return review
      ? {
          reviewId: review.review_id,
          version: review.version,
          status: review.status,
          rubricVersion: review.rubric_version,
          feedback:
            review.payload.feedback ?? review.payload.summary ?? 'Попытка ожидает проверки.',
        }
      : null;
  }

  async saveNotificationPreference(input: {
    userId: string;
    enabled: boolean;
    expectedRevision: number;
  }): Promise<MiniAppState> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const stored = await client.query<{ state: MiniAppState }>(
        'SELECT state FROM mini_app_states WHERE user_id=$1 FOR UPDATE',
        [input.userId],
      );
      const current = stored.rows[0]?.state ?? initialState();
      if (current.revision !== input.expectedRevision)
        throw new ApplicationError({
          code: 'REVISION_CONFLICT',
          message: 'Данные изменились в другом окне',
          statusCode: 409,
          currentRevision: current.revision,
        });
      await client.query(
        `INSERT INTO notification_preferences(user_id,enabled) VALUES ($1,$2)
       ON CONFLICT(user_id) DO UPDATE SET enabled=EXCLUDED.enabled,
         revision=notification_preferences.revision+1,updated_at=now()`,
        [input.userId, input.enabled],
      );
      const state = {
        ...current,
        revision: current.revision + 1,
        notificationsEnabled: input.enabled,
      };
      await client.query(
        `INSERT INTO mini_app_states(user_id,state) VALUES ($1,$2)
         ON CONFLICT(user_id) DO UPDATE SET state=EXCLUDED.state,updated_at=now()`,
        [input.userId, state],
      );
      await client.query('COMMIT');
      return state;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getActiveRoute(userId: string): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query<{
      id: string;
      version: number;
      payload: Record<string, unknown>;
      published_at: Date;
    }>(
      `SELECT id,version,payload,published_at FROM learning_routes
       WHERE user_id=$1 AND status='ACTIVE'`,
      [userId],
    );
    const route = result.rows[0];
    return route
      ? {
          id: route.id,
          version: route.version,
          status: 'ACTIVE',
          payload: route.payload,
          publishedAt: route.published_at.toISOString(),
        }
      : null;
  }

  async assertRevision(userId: string, expectedRevision: number): Promise<void> {
    const result = await this.pool.query<{ state: MiniAppState }>(
      'SELECT state FROM mini_app_states WHERE user_id=$1',
      [userId],
    );
    const revision = result.rows[0]?.state.revision ?? 0;
    if (revision !== expectedRevision)
      throw new ApplicationError({
        code: 'REVISION_CONFLICT',
        message: 'Данные изменились в другом окне',
        statusCode: 409,
        currentRevision: revision,
      });
  }

  async getProgress(userId: string): Promise<Record<string, unknown>> {
    const result = await this.pool.query<{
      route_id: string | null;
      route_version: number | null;
      step_id: string | null;
      position: number | null;
      revision: number | null;
      attempts: string;
      ready_reviews: string;
    }>(
      `SELECT r.id AS route_id,r.version AS route_version,p.step_id,p.position,p.revision,
        (SELECT count(*) FROM attempts a WHERE a.user_id=$1)::text AS attempts,
        (SELECT count(*) FROM review_versions rv JOIN attempts a ON a.id=rv.attempt_id
          WHERE a.user_id=$1 AND rv.status='READY')::text AS ready_reviews
       FROM (SELECT 1) seed
       LEFT JOIN learning_routes r ON r.user_id=$1 AND r.status='ACTIVE'
       LEFT JOIN learning_positions p ON p.user_id=$1`,
      [userId],
    );
    const row = result.rows[0];
    return {
      route: row?.route_id
        ? { id: row.route_id, version: row.route_version, status: 'ACTIVE' }
        : null,
      position: row?.step_id
        ? { stepId: row.step_id, index: row.position, revision: row.revision }
        : null,
      evidence: {
        attempts: Number(row?.attempts ?? 0),
        readyReviews: Number(row?.ready_reviews ?? 0),
      },
      certificate: { available: false, reason: 'Критерии сертификата ещё не утверждены' },
      opportunities: { available: false, reason: 'Источник возможностей не подключён', items: [] },
    };
  }

  async createExportRequest(userId: string) {
    const id = newUuid();
    const exportData = await this.pool.query<{
      goals: unknown;
      routes: unknown;
      attempts: unknown;
      disputes: unknown;
    }>(
      `SELECT
        COALESCE((SELECT jsonb_agg(to_jsonb(g) - 'user_id') FROM goals g WHERE g.user_id=$1),'[]') AS goals,
        COALESCE((SELECT jsonb_agg(to_jsonb(r) - 'user_id') FROM learning_routes r WHERE r.user_id=$1),'[]') AS routes,
        COALESCE((SELECT jsonb_agg(to_jsonb(a) - 'user_id') FROM attempts a WHERE a.user_id=$1),'[]') AS attempts,
        COALESCE((SELECT jsonb_agg(to_jsonb(d) - 'user_id') FROM disputes d WHERE d.user_id=$1),'[]') AS disputes`,
      [userId],
    );
    await this.pool.query(
      `INSERT INTO mini_app_export_requests(id,user_id,status,payload,ready_at,expires_at)
       VALUES ($1,$2,'READY',$3,now(),now()+interval '24 hours')`,
      [id, userId, { version: 1, exportedAt: new Date().toISOString(), ...exportData.rows[0] }],
    );
    return { id, status: 'READY' as const };
  }

  async getReadyExport(input: { userId: string; requestId: string }) {
    const result = await this.pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM mini_app_export_requests
       WHERE id=$1 AND user_id=$2 AND status='READY' AND expires_at>now()`,
      [input.requestId, input.userId],
    );
    const payload = result.rows[0]?.payload;
    if (!payload) throw new Error('Export is not ready or has expired');
    return payload;
  }

  async createDeletionRequest(userId: string) {
    const id = newUuid();
    await this.pool.query(
      "INSERT INTO mini_app_deletion_requests(id,user_id,status) VALUES ($1,$2,'PENDING_POLICY')",
      [id, userId],
    );
    return { id, status: 'PENDING_POLICY' as const };
  }

  async createDispute(input: { userId: string; attemptId: string; reason: string }) {
    const id = newUuid();
    const result = await this.pool.query(
      `INSERT INTO disputes(id,user_id,attempt_id,reason)
       SELECT $1,$2,a.id,$4 FROM attempts a WHERE a.id=$3 AND a.user_id=$2`,
      [id, input.userId, input.attemptId, input.reason],
    );
    if (result.rowCount !== 1) throw new Error('Attempt does not belong to user');
    return { id };
  }
}

function sessionFrom(request: FastifyRequest, store: MiniAppStore): Promise<SessionRecord> {
  const id = request.cookies[SESSION_COOKIE];
  if (!id)
    return Promise.reject(
      new ApplicationError({
        code: 'UNAUTHENTICATED',
        message: 'Нужно открыть приложение через защищённую сессию',
        statusCode: 401,
      }),
    );
  return store.getSession(id).then((session) => {
    if (!session)
      throw new ApplicationError({
        code: 'SESSION_EXPIRED',
        message: 'Сессия истекла, откройте приложение заново',
        statusCode: 401,
      });
    return session;
  });
}

function assertMutation(request: FastifyRequest, session: SessionRecord): void {
  const token = request.headers['x-csrf-token'];
  const expected = session.csrf;
  const supplied =
    typeof token === 'string' && /^[a-f0-9]{64}$/i.test(expected) ? actorDigest(token) : token;
  const matches =
    typeof supplied === 'string' &&
    expected.length === supplied.length &&
    timingSafeEqual(Buffer.from(expected), Buffer.from(supplied));
  if (!matches)
    throw new ApplicationError({
      code: 'INVALID_CSRF',
      message: 'Запрос не подтверждён',
      statusCode: 403,
    });
  if (!request.headers['idempotency-key'])
    throw new ApplicationError({
      code: 'MISSING_IDEMPOTENCY_KEY',
      message: 'Нужен ключ идемпотентности',
      statusCode: 400,
    });
}

async function authorizeMutation(
  request: FastifyRequest,
  session: SessionRecord,
  store: MiniAppStore,
): Promise<void> {
  assertMutation(request, session);
  await store.assertAccess?.(session.userId);
}

export interface MiniAppPluginOptions {
  store: MiniAppStore;
  botToken?: string;
  allowDevAuth?: boolean;
  problemClassifierFactory?: (
    userId: string,
    revision: number,
    text: string,
  ) => AiProblemClassifier;
  attachmentService?: {
    upload(input: {
      userId: string;
      attemptId: string;
      mimeType: string;
      contentBase64: string;
      idempotencyKey: string;
    }): Promise<{ id: string; status: string; reason?: string }>;
  };
}

export function registerMiniAppRoutes(app: FastifyInstance, options: MiniAppPluginOptions): void {
  const setCookie = (reply: FastifyReply, session: SessionRecord) =>
    reply.setCookie(SESSION_COOKIE, session.id, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      expires: session.expiresAt,
    });
  app.post<{ Body: { initData?: string } }>('/mini-app/session', async (request, reply) => {
    const launch = verifyMaxInitData(request.body.initData ?? '', options.botToken ?? '');
    const session = await options.store.createSession(launch.maxUserId);
    setCookie(reply, session);
    return reply
      .status(201)
      .send({ csrfToken: session.csrf, expiresAt: session.expiresAt.toISOString() });
  });
  app.post('/mini-app/dev-session', async (_request, reply) => {
    if (!options.allowDevAuth || process.env.NODE_ENV === 'production')
      throw new ApplicationError({
        code: 'DEV_AUTH_DISABLED',
        message: 'Тестовый вход отключён',
        statusCode: 404,
      });
    const session = await options.store.createSession('dev-local-user');
    setCookie(reply, session);
    return reply
      .status(201)
      .send({ csrfToken: session.csrf, expiresAt: session.expiresAt.toISOString(), demo: true });
  });
  app.delete('/mini-app/session', async (request, reply) => {
    const session = await sessionFrom(request, options.store);
    assertMutation(request, session);
    await options.store.revokeSession(session.id);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.status(204).send();
  });
  app.get('/mini-app/bootstrap', async (request) => {
    const session = await sessionFrom(request, options.store);
    const state = await options.store.getState(session.userId);
    const csrfToken = await options.store.rotateCsrf(session.id);
    return {
      state,
      csrfToken,
      access:
        (await options.store.accessDecision?.(session.userId)) ?? ({ allowed: true } as const),
      questions: diagnosticQuestionsFor(state.problem?.classification),
      certificate: { available: false, reason: 'Цель ещё не подтверждена сервером' },
      opportunities: [],
    };
  });
  app.put<{ Body: { text?: string; revision?: number } }>(
    '/mini-app/problem-draft',
    async (request) => {
      const session = await sessionFrom(request, options.store);
      await authorizeMutation(request, session, options.store);
      const text = request.body.text?.trim() ?? '';
      if (text.length > 1_000)
        throw new ApplicationError({
          code: 'INVALID_PROBLEM',
          message: 'Описание должно быть короче 1000 символов',
          statusCode: 422,
        });
      return {
        state: await options.store.updateState(
          session.userId,
          Number(request.body.revision),
          (state) => ({ ...state, problemDraft: text }),
        ),
      };
    },
  );
  app.post<{ Body: { text?: string; revision?: number } }>(
    '/mini-app/problems',
    async (request) => {
      const session = await sessionFrom(request, options.store);
      await authorizeMutation(request, session, options.store);
      const text = request.body.text?.trim() ?? '';
      if (!text || text.length > 1_000)
        throw new ApplicationError({
          code: 'INVALID_PROBLEM',
          message: 'Опишите проблему от 1 до 1000 символов',
          statusCode: 422,
        });
      const expectedRevision = Number(request.body.revision);
      const current = await options.store.getState(session.userId);
      if (current.revision !== expectedRevision)
        throw new ApplicationError({
          code: 'REVISION_CONFLICT',
          message: 'Данные изменились в другом окне',
          statusCode: 409,
          currentRevision: current.revision,
        });
      const classification = await resolveProblemClassification(
        text,
        options.problemClassifierFactory?.(session.userId, expectedRevision, text),
      );
      return {
        state: await options.store.updateState(session.userId, expectedRevision, (state) => ({
          ...state,
          problemDraft: text,
          problem: {
            text,
            classification,
            version: (state.problem?.version ?? 0) + 1,
          },
        })),
      };
    },
  );
  app.post<{ Body: { type?: string; revision?: number } }>(
    '/mini-app/problems/clarification',
    async (request) => {
      const session = await sessionFrom(request, options.store);
      await authorizeMutation(request, session, options.store);
      const type = request.body.type;
      if (
        typeof type !== 'string' ||
        !REQUEST_TYPES.includes(type as (typeof REQUEST_TYPES)[number])
      )
        throw new ApplicationError({
          code: 'INVALID_REQUEST_TYPE',
          message: 'Выберите один из четырёх типов запроса',
          statusCode: 422,
        });
      const selectedType = type as (typeof REQUEST_TYPES)[number];
      return {
        state: await options.store.updateState(
          session.userId,
          Number(request.body.revision),
          (state) => {
            const problem = state.problem;
            if (problem?.classification.status !== 'ambiguous')
              throw new ApplicationError({
                code: 'CLARIFICATION_NOT_REQUIRED',
                message: 'Уточнение сейчас не требуется',
                statusCode: 409,
              });
            return {
              ...state,
              problem: { ...problem, classification: clarifyProblem(selectedType) },
            };
          },
        ),
      };
    },
  );
  app.post<{
    Body: { educationTrack?: 'school' | 'student'; interestIds?: unknown; revision?: number };
  }>('/mini-app/diagnostic-profile', async (request) => {
    const session = await sessionFrom(request, options.store);
    await authorizeMutation(request, session, options.store);
    const educationTrack = request.body.educationTrack;
    if (educationTrack !== 'school' && educationTrack !== 'student')
      throw new ApplicationError({
        code: 'INVALID_DIAGNOSTIC_PROFILE',
        message: 'Укажите учебный контекст и не более трёх интересов',
        statusCode: 422,
      });
    const profile: MinimumDiagnosticProfile = {
      educationTrack,
      ...(Array.isArray(request.body.interestIds)
        ? {
            interestIds: request.body.interestIds.filter(
              (value): value is string => typeof value === 'string',
            ),
          }
        : {}),
    };
    if ((profile.interestIds?.length ?? 0) > 3)
      throw new ApplicationError({
        code: 'INVALID_DIAGNOSTIC_PROFILE',
        message: 'Укажите учебный контекст и не более трёх интересов',
        statusCode: 422,
      });
    const current = await options.store.getState(session.userId);
    if (current.revision !== Number(request.body.revision))
      throw new ApplicationError({
        code: 'REVISION_CONFLICT',
        message: 'Данные изменились в другом окне',
        statusCode: 409,
        currentRevision: current.revision,
      });
    const classification = current.problem?.classification;
    if (!current.problem || !classification?.type)
      throw new ApplicationError({
        code: 'CLARIFICATION_REQUIRED',
        message: 'Сначала подтвердите тип запроса',
        statusCode: 422,
      });
    const canonical = supportsCanonicalDiagnostics(options.store)
      ? await options.store.createCanonicalDiagnostic({
          userId: session.userId,
          rawText: current.problem.text,
          classification,
          profile,
        })
      : undefined;
    const state = await options.store.updateState(session.userId, current.revision, (state) => ({
      ...state,
      diagnosticProfile: profile,
      ...(canonical === undefined ? {} : { canonicalDiagnostic: canonical }),
    }));
    return {
      state,
      ...(state.canonicalDiagnostic
        ? {
            session_id: state.canonicalDiagnostic.sessionId,
            question_instance_id: state.canonicalDiagnostic.questionInstanceId,
            session_revision: state.canonicalDiagnostic.sessionRevision,
            public_question: state.canonicalDiagnostic.publicQuestion,
          }
        : {}),
    };
  });
  app.post<{
    Body: {
      answer?: unknown;
      action?: DiagnosticAction;
      revision?: number;
      questionInstanceId?: string;
      sessionRevision?: number;
    };
  }>('/mini-app/diagnosis', async (request) => {
    const session = await sessionFrom(request, options.store);
    await authorizeMutation(request, session, options.store);
    const action = request.body.action ?? 'answer';
    const current = await options.store.getState(session.userId);
    if (current.revision !== Number(request.body.revision))
      throw new ApplicationError({
        code: 'REVISION_CONFLICT',
        message: 'Данные изменились в другом окне',
        statusCode: 409,
        currentRevision: current.revision,
      });
    const canonical = current.canonicalDiagnostic;
    let canonicalProgress:
      Awaited<ReturnType<CanonicalDiagnosticStore['saveCanonicalAnswer']>> | undefined;
    let canonicalResult: DiagnosticResult | undefined;
    if (canonical && supportsCanonicalDiagnostics(options.store)) {
      if (action === 'pause')
        canonicalResult = await options.store.finishCanonicalDiagnostic({
          sessionId: canonical.sessionId,
          userId: session.userId,
          reason: 'PAUSED',
        });
      if (action === 'resume')
        await options.store.resumeCanonicalDiagnostic({
          sessionId: canonical.sessionId,
          userId: session.userId,
        });
      if (action === 'finish')
        canonicalResult = await options.store.finishCanonicalDiagnostic({
          sessionId: canonical.sessionId,
          userId: session.userId,
          reason: 'USER_FINISHED',
        });
      if (action === 'more' && current.diagnostic.index >= 8)
        canonicalProgress = await options.store.grantCanonicalConsent({
          sessionId: canonical.sessionId,
          userId: session.userId,
        });
      if (['answer', 'skip', 'unknown'].includes(action)) {
        if (
          request.body.questionInstanceId !== canonical.questionInstanceId ||
          request.body.sessionRevision !== canonical.sessionRevision
        )
          throw new ApplicationError({
            code: 'DIAGNOSTIC_QUESTION_CONFLICT',
            message: 'Вопрос изменился; обновите диагностику',
            statusCode: 409,
          });
        const questionKind = canonical.publicQuestion?.question_kind;
        const kind =
          action === 'skip'
            ? 'SKIP'
            : action === 'unknown'
              ? 'DONT_KNOW'
              : questionKind === 'SINGLE_CHOICE' || questionKind === 'PREFERENCE'
                ? 'CHOICE'
                : 'TEXT';
        canonicalProgress = await options.store.saveCanonicalAnswer({
          sessionId: canonical.sessionId,
          userId: session.userId,
          questionInstanceId: canonical.questionInstanceId,
          expectedRevision: canonical.sessionRevision,
          idempotencyKey: String(request.headers['idempotency-key']),
          kind,
          value:
            action === 'answer'
              ? typeof request.body.answer === 'string'
                ? request.body.answer
                : null
              : null,
        });
        if (
          canonicalProgress.stoppedReason === 'HARD_LIMIT' ||
          canonicalProgress.stoppedReason === 'NO_ELIGIBLE_QUESTION'
        )
          canonicalResult = await options.store.finishCanonicalDiagnostic({
            sessionId: canonical.sessionId,
            userId: session.userId,
            reason: canonicalProgress.stoppedReason,
          });
      }
    }
    const currentState = current;
    const state = await options.store.updateState(
      session.userId,
      Number(request.body.revision),
      (stored) => {
        const current = {
          ...stored,
          ...(canonical ? { canonicalDiagnostic: canonical } : {}),
          ...(currentState.problem ? { problem: currentState.problem } : {}),
          diagnostic: currentState.diagnostic,
        };
        let withCanonical = current;
        if (canonicalProgress) {
          const activeCanonical = current.canonicalDiagnostic;
          if (!activeCanonical) throw new Error('Canonical diagnostic state is unavailable');
          withCanonical = {
            ...current,
            canonicalDiagnostic: {
              ...activeCanonical,
              sessionRevision: canonicalProgress.sessionRevision,
              questionInstanceId: canonicalProgress.questionInstanceId,
              publicQuestion: canonicalProgress.publicQuestion,
            },
          };
        }
        if (action === 'pause')
          return { ...withCanonical, diagnostic: { ...current.diagnostic, paused: true } };
        if (action === 'resume')
          return { ...withCanonical, diagnostic: { ...current.diagnostic, paused: false } };
        if (action === 'more') {
          if (current.diagnostic.index < 8)
            throw new ApplicationError({
              code: 'CONSENT_NOT_AVAILABLE',
              message: 'Основные вопросы ещё не завершены',
              statusCode: 422,
            });
          return {
            ...withCanonical,
            diagnostic: { ...current.diagnostic, additionalConsent: true },
          };
        }
        if (action === 'finish') {
          const next = {
            ...withCanonical,
            diagnostic: { ...current.diagnostic, completed: true },
          };
          return { ...next, result: presentationResult(next, canonicalResult) };
        }
        if (canonical) {
          const next = {
            ...withCanonical,
            diagnostic: {
              ...current.diagnostic,
              index: current.diagnostic.index + 1,
              paused: false,
              completed: canonicalResult !== undefined,
            },
          };
          return canonicalResult
            ? { ...next, result: presentationResult(next, canonicalResult) }
            : next;
        }
        if (!current.problem?.classification.type)
          throw new ApplicationError({
            code: 'CLARIFICATION_REQUIRED',
            message: 'Сначала уточните тип запроса',
            statusCode: 422,
          });
        if (current.diagnostic.index >= 8 && !current.diagnostic.additionalConsent)
          throw new ApplicationError({
            code: 'ADDITIONAL_CONSENT_REQUIRED',
            message: 'Нужно согласие на дополнительные вопросы',
            statusCode: 409,
          });
        if (current.diagnostic.index >= 12)
          throw new ApplicationError({
            code: 'DIAGNOSTIC_HARD_LIMIT',
            message: 'Достигнут лимит 12 вопросов',
            statusCode: 409,
          });
        const questions = diagnosticQuestionsFor(current.problem.classification);
        const question = questions[current.diagnostic.index];
        const answers = question
          ? {
              ...current.diagnostic.answers,
              [question.id]: action === 'answer' ? request.body.answer : action,
            }
          : current.diagnostic.answers;
        const index = Math.min(current.diagnostic.index + 1, 12);
        const next = {
          ...withCanonical,
          diagnostic: {
            index,
            answers,
            paused: false,
            completed: index >= 12,
            additionalConsent: current.diagnostic.additionalConsent,
          },
        };
        return next.diagnostic.completed
          ? { ...next, result: presentationResult(next, canonicalResult) }
          : next;
      },
    );
    const question = state.canonicalDiagnostic
      ? state.canonicalDiagnostic.publicQuestion
      : (diagnosticQuestionsFor(state.problem?.classification)[state.diagnostic.index] ?? null);
    return {
      state,
      question,
      ...(state.canonicalDiagnostic
        ? {
            session_id: state.canonicalDiagnostic.sessionId,
            question_instance_id: state.canonicalDiagnostic.questionInstanceId,
            session_revision: state.canonicalDiagnostic.sessionRevision,
            public_question: question,
          }
        : {}),
    };
  });
  app.post<{ Body: { text?: string; revision?: number } }>('/mini-app/goals', async (request) => {
    const session = await sessionFrom(request, options.store);
    await authorizeMutation(request, session, options.store);
    const text = request.body.text?.trim() ?? '';
    if (!text || text.length > 1_000)
      throw new ApplicationError({
        code: 'INVALID_GOAL',
        message: 'Укажите цель',
        statusCode: 422,
      });
    const canonical = supportsCanonicalDiagnostics(options.store)
      ? await options.store.saveGoalAndPublishRoute({
          userId: session.userId,
          text,
          expectedRevision: Number(request.body.revision),
        })
      : undefined;
    return {
      state:
        canonical?.state ??
        (await options.store.updateState(session.userId, Number(request.body.revision), (state) => {
          if (!state.result)
            throw new ApplicationError({
              code: 'RESULT_REQUIRED',
              message: 'Сначала завершите диагностику',
              statusCode: 422,
            });
          const goal = { text, version: (state.goal?.version ?? 0) + 1 };
          return {
            ...state,
            goal,
            route: {
              version: (state.route?.version ?? 0) + 1,
              status: 'ACTIVE',
              goalVersion: goal.version,
              contentMode: 'DEMO',
              step: {
                title: 'Разобрать основу',
                rationale:
                  state.result.findings.find((finding) => finding.status === 'GAP')?.label ??
                  'Выбрать первый проверяемый шаг',
                durationMinutes: 15,
              },
            },
          };
        })),
    };
  });
  app.post<{ Body: { answer?: string; revision?: number } }>(
    '/mini-app/attempts',
    async (request) => {
      const session = await sessionFrom(request, options.store);
      await authorizeMutation(request, session, options.store);
      if (!request.body.answer?.trim())
        throw new ApplicationError({
          code: 'INVALID_ATTEMPT',
          message: 'Введите ответ перед отправкой',
          statusCode: 422,
        });
      const canonicalReview = supportsCanonicalDiagnostics(options.store)
        ? await options.store.saveAttemptAndReview({
            userId: session.userId,
            answer: request.body.answer.trim(),
            idempotencyKey: String(request.headers['idempotency-key']),
            assistanceLevel: 'NONE',
            expectedRevision: Number(request.body.revision),
          })
        : undefined;
      const state =
        canonicalReview?.state ??
        (await options.store.updateState(
          session.userId,
          Number(request.body.revision),
          (current) => ({ ...current, attemptCount: current.attemptCount + 1 }),
        ));
      return {
        state,
        review: {
          status: 'NEEDS_REVIEW',
          rubric: 'DEMO',
          rubricVersion: 'demo-rubric-v1',
          feedback: 'Ответ сохранён для проверки. История попыток не изменяется.',
          ...(canonicalReview
            ? {
                attemptId: canonicalReview.attemptId,
                reviewId: canonicalReview.reviewId,
                independentPassEligible: canonicalReview.independentPassEligible,
                status: canonicalReview.status,
                rubricVersion: canonicalReview.rubricVersion,
                feedback: canonicalReview.feedback,
              }
            : {}),
        },
      };
    },
  );
  app.get<{ Params: { attemptId: string } }>(
    '/mini-app/attempts/:attemptId/review',
    async (request) => {
      const session = await sessionFrom(request, options.store);
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          request.params.attemptId,
        )
      )
        throw new ApplicationError({
          code: 'INVALID_ATTEMPT',
          message: 'Некорректный идентификатор попытки',
          statusCode: 422,
        });
      if (!supportsCanonicalDiagnostics(options.store))
        throw new ApplicationError({
          code: 'REVIEW_UNAVAILABLE',
          message: 'Проверка попытки недоступна',
          statusCode: 503,
        });
      const review = await options.store.getLatestReview({
        userId: session.userId,
        attemptId: request.params.attemptId,
      });
      if (!review)
        throw new ApplicationError({
          code: 'REVIEW_NOT_FOUND',
          message: 'Проверка попытки не найдена',
          statusCode: 404,
        });
      return review;
    },
  );
  app.put<{ Body: { enabled?: boolean; revision?: number } }>(
    '/mini-app/notification-preferences',
    async (request) => {
      const session = await sessionFrom(request, options.store);
      await authorizeMutation(request, session, options.store);
      if (supportsCanonicalDiagnostics(options.store))
        return {
          state: await options.store.saveNotificationPreference({
            userId: session.userId,
            enabled: Boolean(request.body.enabled),
            expectedRevision: Number(request.body.revision),
          }),
        };
      return {
        state: await options.store.updateState(
          session.userId,
          Number(request.body.revision),
          (state) => ({ ...state, notificationsEnabled: Boolean(request.body.enabled) }),
        ),
      };
    },
  );
  app.get('/mini-app/progress', async (request) => {
    const session = await sessionFrom(request, options.store);
    if (!supportsCanonicalDiagnostics(options.store))
      return {
        route: null,
        position: null,
        evidence: { attempts: 0, readyReviews: 0 },
        certificate: { available: false, reason: 'Серверное хранилище не подключено' },
        opportunities: { available: false, reason: 'Источник не подключён', items: [] },
      };
    return options.store.getProgress(session.userId);
  });
  app.get('/mini-app/routes/active', async (request) => {
    const session = await sessionFrom(request, options.store);
    if (!supportsCanonicalDiagnostics(options.store)) return { route: null };
    return { route: await options.store.getActiveRoute(session.userId) };
  });
  app.post<{ Body: { revision?: number } }>('/mini-app/export-requests', async (request, reply) => {
    const session = await sessionFrom(request, options.store);
    await authorizeMutation(request, session, options.store);
    if (!supportsCanonicalDiagnostics(options.store))
      throw new ApplicationError({
        code: 'EXPORT_UNAVAILABLE',
        message: 'Экспорт недоступен без серверного хранилища',
        statusCode: 503,
      });
    await options.store.assertRevision(session.userId, Number(request.body.revision));
    return reply.status(202).send(await options.store.createExportRequest(session.userId));
  });
  app.get<{ Params: { requestId: string } }>(
    '/mini-app/export-requests/:requestId/download',
    async (request, reply) => {
      const session = await sessionFrom(request, options.store);
      if (!supportsCanonicalDiagnostics(options.store))
        throw new ApplicationError({
          code: 'EXPORT_UNAVAILABLE',
          message: 'Экспорт недоступен без серверного хранилища',
          statusCode: 503,
        });
      const payload = await options.store.getReadyExport({
        userId: session.userId,
        requestId: request.params.requestId,
      });
      return reply
        .header('content-type', 'application/json; charset=utf-8')
        .header(
          'content-disposition',
          `attachment; filename="vibework-export-${request.params.requestId}.json"`,
        )
        .header('cache-control', 'private, no-store')
        .send(payload);
    },
  );
  app.post<{ Body: { revision?: number } }>(
    '/mini-app/deletion-requests',
    async (request, reply) => {
      const session = await sessionFrom(request, options.store);
      await authorizeMutation(request, session, options.store);
      if (!supportsCanonicalDiagnostics(options.store))
        throw new ApplicationError({
          code: 'DELETION_UNAVAILABLE',
          message: 'Запрос удаления недоступен без серверного хранилища',
          statusCode: 503,
        });
      await options.store.assertRevision(session.userId, Number(request.body.revision));
      return reply.status(202).send(await options.store.createDeletionRequest(session.userId));
    },
  );
  app.post<{ Body: { attemptId?: string; reason?: string; revision?: number } }>(
    '/mini-app/disputes',
    async (request, reply) => {
      const session = await sessionFrom(request, options.store);
      await authorizeMutation(request, session, options.store);
      const attemptId = request.body.attemptId?.trim();
      const reason = request.body.reason?.trim();
      if (!attemptId || !reason || reason.length > 2_000)
        throw new ApplicationError({
          code: 'INVALID_DISPUTE',
          message: 'Укажите попытку и причину спора',
          statusCode: 422,
        });
      if (!supportsCanonicalDiagnostics(options.store))
        throw new ApplicationError({
          code: 'DISPUTE_UNAVAILABLE',
          message: 'Спор недоступен без серверного хранилища',
          statusCode: 503,
        });
      await options.store.assertRevision(session.userId, Number(request.body.revision));
      return reply
        .status(201)
        .send(await options.store.createDispute({ userId: session.userId, attemptId, reason }));
    },
  );
  app.post<{
    Body: {
      attemptId?: string;
      mimeType?: string;
      contentBase64?: string;
      revision?: number;
    };
  }>('/mini-app/attachments', { bodyLimit: 7 * 1024 * 1024 }, async (request, reply) => {
    const session = await sessionFrom(request, options.store);
    await authorizeMutation(request, session, options.store);
    const attemptId = request.body.attemptId?.trim();
    const mimeType = request.body.mimeType?.trim();
    const contentBase64 = request.body.contentBase64;
    if (!attemptId || !/^[0-9a-f-]{36}$/.test(attemptId) || !mimeType || !contentBase64)
      throw new ApplicationError({
        code: 'INVALID_ATTACHMENT',
        message: 'Некорректные данные файла',
        statusCode: 422,
      });
    if (!supportsCanonicalDiagnostics(options.store) || !options.attachmentService)
      throw new ApplicationError({
        code: 'ATTACHMENT_UNAVAILABLE',
        message: 'Файлы недоступны без серверного хранилища',
        statusCode: 503,
      });
    await options.store.assertRevision(session.userId, Number(request.body.revision));
    const result = await options.attachmentService.upload({
      userId: session.userId,
      attemptId,
      mimeType,
      contentBase64,
      idempotencyKey: normalizeIdempotencyKey(request.headers['idempotency-key']),
    });
    return reply.status(result.status === 'ACCEPTED' ? 201 : 202).send(result);
  });
}
