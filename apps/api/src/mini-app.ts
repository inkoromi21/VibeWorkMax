import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ApplicationError, newUuid } from '@vibework/shared';
import type { Pool } from 'pg';
import {
  actorDigest,
  clarifyProblem,
  classifyProblem,
  PostgresProblemDiagnosticRepository,
  type Classification,
  type MinimumDiagnosticProfile,
  PostgresDiagnosticSessionRepository,
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
  canonicalDiagnostic?: { sessionId: string; problemVersionId: string };
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
}

interface CanonicalDiagnosticStore {
  createCanonicalDiagnostic(input: {
    userId: string;
    rawText: string;
    classification: Classification;
    profile: MinimumDiagnosticProfile;
  }): Promise<{ sessionId: string; problemVersionId: string }>;
  saveCanonicalAnswer(input: {
    userId: string;
    sessionId: string;
    kind: 'CHOICE' | 'TEXT' | 'SKIP' | 'DONT_KNOW';
    value: string[] | string | null;
  }): Promise<void>;
  grantCanonicalConsent(input: { userId: string; sessionId: string }): Promise<void>;
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
  constructor(private readonly pool: Pool) {}
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
    const result = await this.pool.query<{ state: MiniAppState }>(
      'SELECT state FROM mini_app_states WHERE user_id=$1',
      [userId],
    );
    return result.rows[0]?.state ?? initialState();
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
  }): Promise<{ sessionId: string; problemVersionId: string }> {
    const created = await new PostgresProblemDiagnosticRepository(this.pool).createConfirmedSession(
      input,
    );
    return { sessionId: created.sessionId, problemVersionId: created.problemVersionId };
  }

  saveCanonicalAnswer(input: {
    userId: string;
    sessionId: string;
    kind: 'CHOICE' | 'TEXT' | 'SKIP' | 'DONT_KNOW';
    value: string[] | string | null;
  }): Promise<void> {
    return new PostgresDiagnosticSessionRepository(this.pool).saveAnswer(input);
  }

  grantCanonicalConsent(input: { userId: string; sessionId: string }): Promise<void> {
    return new PostgresDiagnosticSessionRepository(this.pool).grantAdditionalConsent(input);
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

export interface MiniAppPluginOptions {
  store: MiniAppStore;
  botToken?: string;
  allowDevAuth?: boolean;
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
      questions: diagnosticQuestionsFor(state.problem?.classification),
      certificate: { available: false, reason: 'Цель ещё не подтверждена сервером' },
      opportunities: [],
    };
  });
  app.put<{ Body: { text?: string; revision?: number } }>(
    '/mini-app/problem-draft',
    async (request) => {
      const session = await sessionFrom(request, options.store);
      assertMutation(request, session);
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
      assertMutation(request, session);
      const text = request.body.text?.trim() ?? '';
      if (!text || text.length > 1_000)
        throw new ApplicationError({
          code: 'INVALID_PROBLEM',
          message: 'Опишите проблему от 1 до 1000 символов',
          statusCode: 422,
        });
      return {
        state: await options.store.updateState(
          session.userId,
          Number(request.body.revision),
          (state) => ({
            ...state,
            problemDraft: text,
            problem: {
              text,
              classification: classifyProblem(text),
              version: (state.problem?.version ?? 0) + 1,
            },
          }),
        ),
      };
    },
  );
  app.post<{ Body: { type?: string; revision?: number } }>(
    '/mini-app/problems/clarification',
    async (request) => {
      const session = await sessionFrom(request, options.store);
      assertMutation(request, session);
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
    assertMutation(request, session);
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
    return {
      state: await options.store.updateState(session.userId, current.revision, (state) => ({
        ...state,
        diagnosticProfile: profile,
        ...(canonical === undefined ? {} : { canonicalDiagnostic: canonical }),
      })),
    };
  });
  app.post<{
    Body: {
      answer?: unknown;
      action?: DiagnosticAction;
      revision?: number;
    };
  }>('/mini-app/diagnosis', async (request) => {
    const session = await sessionFrom(request, options.store);
    assertMutation(request, session);
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
    if (canonical && supportsCanonicalDiagnostics(options.store)) {
      if (action === 'more' && current.diagnostic.index >= 8)
        await options.store.grantCanonicalConsent({
          sessionId: canonical.sessionId,
          userId: session.userId,
        });
      if (['answer', 'skip', 'unknown'].includes(action)) {
        const question = diagnosticQuestionsFor(current.problem?.classification)[
          current.diagnostic.index
        ];
        const kind =
          action === 'skip'
            ? 'SKIP'
            : action === 'unknown'
              ? 'DONT_KNOW'
              : question?.kind === 'single' || question?.kind === 'preference'
                ? 'CHOICE'
                : 'TEXT';
        await options.store.saveCanonicalAnswer({
          sessionId: canonical.sessionId,
          userId: session.userId,
          kind,
          value:
            action === 'answer'
              ? typeof request.body.answer === 'string'
                ? request.body.answer
                : null
              : null,
        });
      }
    }
    const state = await options.store.updateState(
      session.userId,
      Number(request.body.revision),
      (current) => {
        if (action === 'pause')
          return { ...current, diagnostic: { ...current.diagnostic, paused: true } };
        if (action === 'resume')
          return { ...current, diagnostic: { ...current.diagnostic, paused: false } };
        if (action === 'more') {
          if (current.diagnostic.index < 8)
            throw new ApplicationError({
              code: 'CONSENT_NOT_AVAILABLE',
              message: 'Основные вопросы ещё не завершены',
              statusCode: 422,
            });
          return { ...current, diagnostic: { ...current.diagnostic, additionalConsent: true } };
        }
        if (action === 'finish') {
          const next = { ...current, diagnostic: { ...current.diagnostic, completed: true } };
          return { ...next, result: buildResult(next) };
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
          ...current,
          diagnostic: {
            index,
            answers,
            paused: false,
            completed: index >= 12,
            additionalConsent: current.diagnostic.additionalConsent,
          },
        };
        return next.diagnostic.completed ? { ...next, result: buildResult(next) } : next;
      },
    );
    return {
      state,
      question:
        diagnosticQuestionsFor(state.problem?.classification)[state.diagnostic.index] ?? null,
    };
  });
  app.post<{ Body: { text?: string; revision?: number } }>('/mini-app/goals', async (request) => {
    const session = await sessionFrom(request, options.store);
    assertMutation(request, session);
    const text = request.body.text?.trim() ?? '';
    if (!text || text.length > 1_000)
      throw new ApplicationError({
        code: 'INVALID_GOAL',
        message: 'Укажите цель',
        statusCode: 422,
      });
    return {
      state: await options.store.updateState(
        session.userId,
        Number(request.body.revision),
        (state) => {
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
        },
      ),
    };
  });
  app.post<{ Body: { answer?: string; revision?: number } }>(
    '/mini-app/attempts',
    async (request) => {
      const session = await sessionFrom(request, options.store);
      assertMutation(request, session);
      if (!request.body.answer?.trim())
        throw new ApplicationError({
          code: 'INVALID_ATTEMPT',
          message: 'Введите ответ перед отправкой',
          statusCode: 422,
        });
      const state = await options.store.updateState(
        session.userId,
        Number(request.body.revision),
        (current) => ({ ...current, attemptCount: current.attemptCount + 1 }),
      );
      return {
        state,
        review: {
          status: 'NEEDS_REVIEW',
          rubric: 'DEMO',
          feedback: 'Ответ сохранён для проверки. История попыток не изменяется.',
        },
      };
    },
  );
  app.put<{ Body: { enabled?: boolean; revision?: number } }>(
    '/mini-app/notification-preferences',
    async (request) => {
      const session = await sessionFrom(request, options.store);
      assertMutation(request, session);
      return {
        state: await options.store.updateState(
          session.userId,
          Number(request.body.revision),
          (state) => ({ ...state, notificationsEnabled: Boolean(request.body.enabled) }),
        ),
      };
    },
  );
}
