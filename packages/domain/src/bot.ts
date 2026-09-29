import { createHash } from 'node:crypto';
import { demoDiagnosticCatalog, selectApprovedDiagnosticTemplates } from '@vibework/content';
import { ApplicationError, newUuid, type AttemptId, type ConversationId } from '@vibework/shared';
import type { Pool, PoolClient } from 'pg';
import { classifyProblem, type Classification } from './classification.js';
import {
  PostgresProblemDiagnosticRepository,
  type MinimumDiagnosticProfile,
} from './problem-diagnostic.js';
import { DiagnosticApplicationService } from './diagnostics.js';
import type { DiagnosticResult } from './diagnostic-adaptive.js';

/**
 * Bot-first aggregate. It deliberately keeps provider message details out of the
 * domain model: adapters turn provider updates into this small command shape.
 */
export const BOT_STATES = [
  'ENTRY',
  'AGE',
  'CONSENT',
  'PROBLEM',
  'CLARIFY',
  'CONFIRM_PROBLEM',
  'PROFILE',
  'DIAGNOSIS',
  'RESULT',
  'GOAL',
  'LEARNING',
  'ATTEMPT',
  'PAUSED',
  'CONTINUATION',
] as const;
export type BotConversationState = (typeof BOT_STATES)[number];

export interface BotConversation {
  id: ConversationId;
  actorId: string;
  state: BotConversationState;
  revision: number;
  data: Record<string, unknown>;
  updatedAt: string;
}
/** Kept separate from dialogue state so the bot and mini app share a durable position. */
export interface LearningState {
  currentStepId: string | null;
  position: number;
  version: number;
}

export interface BotCommand {
  eventId: string;
  actorId: string;
  kind: 'START' | 'MESSAGE' | 'CALLBACK' | 'SYSTEM';
  text?: string;
  callback?: string;
  systemEvent?: NotificationEvent;
}

export interface BotButton {
  label: string;
  payload: string;
}
export interface BotReply {
  text: string;
  buttons?: BotButton[];
  miniApp?: { label: string; url: string };
}
export interface BotTransition {
  replies: BotReply[];
  jobs: { type: 'max.process' | 'course.build' | 'attempt.grade'; key: string }[];
}

export interface ConsentPolicy {
  enabled: boolean;
  version?: string;
  minAge?: number;
  representativeRequiredUnder?: number;
  privacyUrl?: string;
  termsUrl?: string;
  agePolicyVersion?: string;
}

/**
 * Legal data is deliberately opt-in: a partial environment must not turn on
 * personal-data processing.  Values are configuration only and are never
 * copied to logs or client callbacks.
 */
export function consentPolicyFromEnvironment(
  env: Record<string, string | undefined> = process.env,
): ConsentPolicy {
  const minAge = Number(env.MIN_AGE);
  const representativeRequiredUnder = Number(env.REPRESENTATIVE_CONSENT_UNDER);
  const version = env.CONSENT_DOCUMENT_VERSION;
  const privacyUrl = env.PRIVACY_POLICY_URL;
  const termsUrl = env.TERMS_OF_USE_URL;
  const agePolicyVersion = env.AGE_POLICY_VERSION;
  const enabled = Boolean(
    version &&
    privacyUrl &&
    termsUrl &&
    agePolicyVersion &&
    Number.isInteger(minAge) &&
    minAge >= 0 &&
    Number.isInteger(representativeRequiredUnder) &&
    representativeRequiredUnder >= minAge,
  );
  if (!enabled || !version || !privacyUrl || !termsUrl || !agePolicyVersion)
    return { enabled: false };
  return {
    enabled: true,
    version,
    privacyUrl,
    termsUrl,
    agePolicyVersion,
    minAge,
    representativeRequiredUnder,
  };
}

export interface BotRepository {
  get(actorId: string): Promise<BotConversation | null>;
  /** Returns false for an already processed provider event. */
  transact(
    eventId: string,
    actorId: string,
    apply: (current: BotConversation | null) => BotConversation,
  ): Promise<{ conversation: BotConversation; duplicate: boolean }>;
  saveProblem(
    actorId: string,
    rawText: string,
    interpretation: Classification,
    profile: MinimumDiagnosticProfile,
  ): Promise<{
    sessionId?: string;
    question?: {
      questionInstanceId: string;
      sessionRevision: number;
      publicQuestion: Record<string, unknown>;
    };
  }>;
  grantAdditionalConsent?(
    actorId: string,
    sessionId: string,
  ): Promise<
    | {
        questionInstanceId: string;
        sessionRevision: number;
        publicQuestion: Record<string, unknown>;
      }
    | undefined
  >;
  finishDiagnostic?(
    actorId: string,
    sessionId: string,
    reason: 'USER_FINISHED' | 'PAUSED',
  ): Promise<DiagnosticResult | undefined>;
  resumeDiagnostic?(actorId: string, sessionId: string): Promise<void>;
  saveAnswer(input: {
    actorId: string;
    questionId: string;
    idempotencyKey: string;
    kind: 'CHOICE' | 'TEXT' | 'SKIP' | 'DONT_KNOW';
    value: string[] | string | null;
    diagnosticSessionId?: string;
    questionInstanceId?: string;
    sessionRevision?: number;
  }): Promise<{
    created: boolean;
    question?: {
      questionInstanceId: string;
      sessionRevision: number;
      publicQuestion: Record<string, unknown>;
    };
    stoppedReason?: string;
  }>;
  saveAttempt(input: {
    actorId: string;
    key: string;
    answer: string;
    assistance: 'NONE' | 'SOLUTION';
  }): Promise<{ id: AttemptId; created: boolean }>;
  saveDispute(actorId: string, attemptId: string, reason: string): Promise<boolean>;
  saveGoal(actorId: string, text: string): Promise<boolean>;
  saveConsent(actorId: string, version: string, age: number): Promise<void>;
  recordStepOpened(actorId: string, stepId: string, position: number): Promise<boolean>;
  saveNotification(eventId: string): Promise<boolean>;
}

function now(): string {
  return new Date().toISOString();
}
function conversation(actorId: string): BotConversation {
  return {
    id: newUuid<ConversationId>(),
    actorId,
    state: 'ENTRY',
    revision: 0,
    data: {},
    updatedAt: now(),
  };
}
function next(
  current: BotConversation,
  state: BotConversationState,
  data = current.data,
): BotConversation {
  return { ...current, state, revision: current.revision + 1, data, updatedAt: now() };
}

/** Short opaque callbacks: revision + action code, with no user or domain data. */
const actionCodes = {
  consent: 'c',
  decline: 'd',
  newProblem: 'n',
  continue: 'o',
  confirm: 'y',
  edit: 'e',
  restart: 'r',
  unknown: 'u',
  skip: 's',
  pause: 'p',
  finish: 'f',
  more: 'm',
  goal: 'g',
  lesson: 'l',
  practice: 'a',
  solution: 'x',
  retry: 't',
  dispute: 'q',
  details: 'i',
  choice: 'z',
  direction: 'v',
  knowledge: 'k',
  skill: 'h',
  practiceReadiness: 'w',
  school: 'j',
  student: 'b',
} as const;
type Action = keyof typeof actionCodes;
const actionByCode = new Map<string, Action>(
  Object.entries(actionCodes).map(([action, code]) => [code, action as Action]),
);
function callback(revision: number, action: Action): string {
  return `b${revision.toString(36)}${actionCodes[action]}`;
}
function parseCallback(
  value: string | undefined,
): { revision: number; action: Action; choice?: string } | null {
  const choice = /^b([0-9a-z]+)z([0-9a-z])$/.exec(value ?? '');
  if (choice) {
    const [, revisionText, choiceValue] = choice;
    if (revisionText && choiceValue)
      return { revision: Number.parseInt(revisionText, 36), action: 'choice', choice: choiceValue };
  }
  if (!value || !/^b[0-9a-z]+[a-z]$/.test(value)) return null;
  const action = actionByCode.get(value.slice(-1));
  const revision = Number.parseInt(value.slice(1, -1), 36);
  return action && Number.isSafeInteger(revision) ? { revision, action } : null;
}
function buttons(c: BotConversation, entries: [string, Action][]): BotButton[] {
  return entries.map(([label, action]) => ({ label, payload: callback(c.revision, action) }));
}
function reply(text: string, current?: BotConversation, entries?: [string, Action][]): BotReply {
  return { text, ...(current && entries ? { buttons: buttons(current, entries) } : {}) };
}

const fallbackDiagnosticQuestions = [
  {
    id: 'q1',
    kind: 'CHOICE',
    prompt: 'Что уже пробовали?',
    options: ['Самостоятельно', 'С помощью преподавателя', 'Пока не пробовал'],
  },
  {
    id: 'q2',
    kind: 'CHOICE',
    prompt: 'Насколько уверенно получается?',
    options: ['Уверенно', 'Иногда', 'Пока не получается'],
  },
  { id: 'q3', kind: 'TEXT', prompt: 'Коротко опишите один пример.' },
  {
    id: 'q4',
    kind: 'CHOICE',
    prompt: 'Что важнее в первом шаге?',
    options: ['Понять основу', 'Разобрать ошибку', 'Попрактиковаться'],
  },
  {
    id: 'q5',
    kind: 'CHOICE',
    prompt: 'Какой формат удобнее?',
    options: ['Короткий пример', 'Задача', 'Пояснение'],
  },
  { id: 'q6', kind: 'TEXT', prompt: 'Решите маленькую практическую задачу текстом.' },
  {
    id: 'q7',
    kind: 'CHOICE',
    prompt: 'Нужен ли разбор перед следующей задачей?',
    options: ['Да', 'Нет', 'Не знаю'],
  },
  {
    id: 'q8',
    kind: 'CHOICE',
    prompt: 'Готовы завершить диагностику?',
    options: ['Да, достаточно', 'Продолжить'],
  },
  {
    id: 'q9',
    kind: 'CHOICE',
    prompt: 'Дополнительный вопрос: что вызывает трудность?',
    options: ['Термины', 'Порядок действий', 'Проверка ответа'],
  },
  { id: 'q10', kind: 'TEXT', prompt: 'Приведите ещё один короткий пример.' },
  {
    id: 'q11',
    kind: 'CHOICE',
    prompt: 'Что хотите потренировать первым?',
    options: ['Основу', 'Пример', 'Самостоятельное решение'],
  },
  {
    id: 'q12',
    kind: 'CHOICE',
    prompt: 'Последний уточняющий вопрос: продолжим курсом?',
    options: ['Да', 'Пока нет'],
  },
] as const;
function diagnosticQuestionsFor(c: BotConversation) {
  const classification = c.data.classification as Classification | undefined;
  if (!classification?.type) return fallbackDiagnosticQuestions;
  return selectApprovedDiagnosticTemplates(demoDiagnosticCatalog, classification.type)
    .slice(0, 12)
    .map((template) => ({
      id: template.id,
      kind: template.kind === 'TEXT' ? 'TEXT' : 'CHOICE',
      prompt: template.prompt,
      ...(template.options.length ? { options: template.options } : {}),
    }));
}
function diagnosisReply(c: BotConversation): BotReply {
  const index = Number(c.data.questionIndex ?? 0);
  const diagnosticQuestions = diagnosticQuestionsFor(c);
  const canonical = c.data.canonicalQuestion as
    { publicQuestion?: { prompt?: string; options?: { label: string }[] } } | undefined;
  const q = canonical?.publicQuestion
    ? {
        id: 'canonical',
        kind: canonical.publicQuestion.options?.length ? 'CHOICE' : 'TEXT',
        prompt: canonical.publicQuestion.prompt ?? '',
        options: canonical.publicQuestion.options?.map((option) => option.label) ?? [],
      }
    : (diagnosticQuestions[Math.min(index, diagnosticQuestions.length - 1)] ??
      diagnosticQuestions[0]);
  const label =
    index >= 8
      ? 'Это дополнительный вопрос; можно завершить в любой момент.'
      : 'Количество вопросов адаптивно; можно пропустить или поставить паузу.';
  const choiceButtons =
    'options' in q
      ? q.options.map((option, optionIndex) => ({
          label: option,
          payload: `${callback(c.revision, 'choice')}${optionIndex.toString(36)}`,
        }))
      : [];
  const controlButtons = buttons(c, [
    ['Не знаю', 'unknown'],
    ['Пропустить', 'skip'],
    ['Пауза', 'pause'],
    ...(index >= 7 ? [['Завершить', 'finish'] as [string, Action]] : []),
  ]);
  return { text: `${label}\n\n${q.prompt}`, buttons: [...choiceButtons, ...controlButtons] };
}

export class BotService {
  constructor(
    private readonly repository: BotRepository,
    private readonly policy: ConsentPolicy = { enabled: false },
    private readonly miniAppUrl?: string,
  ) {}

  async handle(command: BotCommand): Promise<BotTransition> {
    if (command.kind === 'SYSTEM') return this.handleSystem(command);
    const result = await this.repository.transact(command.eventId, command.actorId, (existing) => {
      const c = existing ?? conversation(command.actorId);
      return this.reduce(c, command);
    });
    if (result.duplicate) return { replies: [], jobs: [] };
    const c = result.conversation;
    const transition = await this.present(c, command);
    return transition;
  }

  private reduce(c: BotConversation, command: BotCommand): BotConversation {
    const text = command.text?.trim();
    if (command.kind === 'START' || text === '/start' || text === 'начать')
      return next(c, 'ENTRY', {});
    if (text === 'отмена' || text === '/cancel') return next(c, 'CONTINUATION', {});
    if (text === 'прогресс' || text === '/progress') return next(c, 'CONTINUATION', c.data);
    if (text === 'помощь' || text === '/help') return next(c, c.state, { ...c.data, help: true });
    if (text === 'продолжить' || text === '/continue')
      return next(c, c.state === 'PAUSED' ? 'DIAGNOSIS' : 'CONTINUATION', c.data);
    const parsed = parseCallback(command.callback);
    if (command.kind === 'CALLBACK') {
      if (parsed?.revision !== c.revision)
        return next(c, 'CONTINUATION', { ...c.data, stale: true });
      return this.reduceAction(c, parsed.action, parsed.choice);
    }
    if (!text) return next(c, 'CONTINUATION', { ...c.data, unsupported: true });
    if (c.state === 'AGE') {
      const age = Number(text.replace(/^age:/i, ''));
      if (!Number.isInteger(age) || age < 0 || age > 120)
        return next(c, 'AGE', { ...c.data, invalidAge: true });
      return next(c, 'CONSENT', { ...c.data, age });
    }
    if (c.state === 'PROBLEM' || c.state === 'CLARIFY') {
      if (text.length > 1000) return next(c, c.state, { ...c.data, tooLong: true });
      const classification = classifyProblem(text);
      return next(c, classification.status === 'ambiguous' ? 'CLARIFY' : 'CONFIRM_PROBLEM', {
        ...c.data,
        draftText: text,
        classification,
      });
    }
    if (c.state === 'DIAGNOSIS') return next(c, 'DIAGNOSIS', { ...c.data, textAnswer: text });
    if (c.state === 'ATTEMPT') return next(c, 'ATTEMPT', { ...c.data, attemptAnswer: text });
    return next(c, 'CONTINUATION', { ...c.data, unsupported: true });
  }

  private reduceAction(c: BotConversation, action: Action, choice?: string): BotConversation {
    const permitted: Record<Action, readonly BotConversationState[]> = {
      consent: ['ENTRY'],
      decline: ['ENTRY'],
      newProblem: ['CONSENT', 'CONTINUATION'],
      continue: ['CONSENT', 'PAUSED', 'CONTINUATION'],
      confirm: ['CONFIRM_PROBLEM'],
      edit: ['CONFIRM_PROBLEM', 'RESULT', 'GOAL'],
      restart: ['PROBLEM', 'CLARIFY', 'CONFIRM_PROBLEM', 'ATTEMPT', 'CONTINUATION'],
      direction: ['CLARIFY'],
      knowledge: ['CLARIFY'],
      skill: ['CLARIFY'],
      practiceReadiness: ['CLARIFY'],
      school: ['PROFILE'],
      student: ['PROFILE'],
      unknown: ['DIAGNOSIS'],
      skip: ['DIAGNOSIS'],
      pause: ['DIAGNOSIS'],
      finish: ['DIAGNOSIS'],
      more: ['DIAGNOSIS'],
      goal: ['RESULT', 'GOAL'],
      lesson: ['LEARNING'],
      practice: ['LEARNING'],
      solution: ['ATTEMPT'],
      retry: ['ATTEMPT'],
      dispute: ['ATTEMPT'],
      details: ['RESULT', 'ATTEMPT'],
      choice: ['DIAGNOSIS'],
    };
    if (!permitted[action].includes(c.state))
      return next(c, 'CONTINUATION', { ...c.data, stale: true });
    switch (action) {
      case 'consent':
        return next(c, 'AGE', {});
      case 'decline':
        return next(c, 'ENTRY', { declined: true });
      case 'newProblem':
        return next(c, 'PROBLEM', {});
      case 'continue':
        return next(
          c,
          c.state === 'PAUSED' ? 'DIAGNOSIS' : 'CONTINUATION',
          c.state === 'PAUSED' ? { ...c.data, resumeDiagnostic: true } : c.data,
        );
      case 'edit':
        return next(c, 'PROBLEM', {});
      case 'restart':
        return next(c, 'PROBLEM', {});
      case 'confirm':
        return c.state === 'CONFIRM_PROBLEM'
          ? next(c, 'PROFILE', c.data)
          : next(c, 'CONTINUATION', { ...c.data, stale: true });
      case 'direction':
      case 'knowledge':
      case 'skill':
      case 'practiceReadiness': {
        const type =
          action === 'direction'
            ? 'DIRECTION'
            : action === 'knowledge'
              ? 'KNOWLEDGE_GAP'
              : action === 'skill'
                ? 'SKILL'
                : 'PRACTICE_READINESS';
        const classification: Classification = {
          type,
          status: 'classified',
          confidence: 1,
          reason: `USER_CLARIFICATION:${type}`,
          interpretation:
            type === 'DIRECTION'
              ? 'Похоже, вы хотите выбрать направление.'
              : type === 'KNOWLEDGE_GAP'
                ? 'Похоже на конкретный пробел в знаниях.'
                : type === 'SKILL'
                  ? 'Похоже, вы хотите освоить навык.'
                  : 'Похоже на подготовку к практике.',
          clarificationNeeded: false,
          path: 'clarification',
          rulesVersion: 'problem-classifier-rules-v1',
        };
        return next(c, 'CONFIRM_PROBLEM', { ...c.data, classification });
      }
      case 'school':
      case 'student':
        return next(c, 'DIAGNOSIS', {
          ...c.data,
          diagnosticProfile: { educationTrack: action },
          questionIndex: 0,
          answerCount: 0,
          diagnosticCatalogVersion: demoDiagnosticCatalog.version,
          problemConfirmed: true,
        });
      case 'unknown':
      case 'skip':
        return next(c, 'DIAGNOSIS', {
          ...c.data,
          answerKind: action === 'skip' ? 'SKIP' : 'DONT_KNOW',
        });
      case 'pause':
        return next(c, 'PAUSED', { ...c.data, pauseDiagnostic: true });
      case 'finish':
        return next(c, 'RESULT', { ...c.data, finishDiagnostic: true });
      case 'more':
        return next(c, 'DIAGNOSIS', {
          ...c.data,
          additionalConsent: true,
          additionalConsentJustGranted: true,
          awaitingAdditionalConsent: false,
        });
      case 'goal':
        return c.state === 'RESULT'
          ? next(c, 'GOAL', c.data)
          : next(c, 'LEARNING', { ...c.data, goalConfirmed: true, page: 0 });
      case 'lesson':
        return next(c, 'LEARNING', { ...c.data, page: Math.min(2, Number(c.data.page ?? 0) + 1) });
      case 'practice':
        return next(c, 'ATTEMPT', { ...c.data, solutionShown: false });
      case 'solution':
        return next(c, 'ATTEMPT', { ...c.data, solutionShown: true });
      case 'retry':
        return next(c, 'ATTEMPT', { ...c.data, attemptAnswer: undefined, solutionShown: false });
      case 'dispute':
        return next(c, 'CONTINUATION', { ...c.data, disputeRequested: true });
      case 'details':
        return next(c, 'CONTINUATION', c.data);
      case 'choice':
        return next(c, 'DIAGNOSIS', {
          ...c.data,
          answerKind: 'CHOICE',
          answerValue: choice === undefined ? [] : [choice],
        });
    }
  }

  private async present(c: BotConversation, command: BotCommand): Promise<BotTransition> {
    const jobs: BotTransition['jobs'] = [];
    if (c.data.stale === true)
      return {
        replies: [
          reply('Эта кнопка уже устарела. Я вернул вас к последнему сохранённому шагу.', c, [
            ['Продолжить', 'continue'],
          ]),
        ],
        jobs,
      };
    if (c.data.help === true)
      return {
        replies: [
          reply(this.helpFor(c.state), c, [
            ['Продолжить', 'continue'],
            ['Отмена', 'restart'],
          ]),
        ],
        jobs,
      };
    if (c.data.unsupported === true)
      return {
        replies: [
          reply(
            'Не удалось применить это сообщение. Можно продолжить с последнего сохранённого шага.',
            c,
            [
              ['Продолжить', 'continue'],
              ['Начать заново', 'restart'],
            ],
          ),
        ],
        jobs,
      };
    if (c.state === 'ENTRY') {
      if (c.data.declined === true)
        return {
          replies: [
            reply(
              'Без согласия я не обрабатываю данные и не создаю профиль. Вы можете вернуться, когда будете готовы.',
              c,
              [['Начать', 'consent']],
            ),
          ],
          jobs,
        };
      if (!this.policy.enabled)
        return {
          replies: [
            reply(
              'Сейчас обработка данных не включена: требуемые документы и возрастные правила ещё не предоставлены. Профиль не создан.',
            ),
          ],
          jobs,
        };
      const links = [this.policy.privacyUrl, this.policy.termsUrl].filter((url): url is string =>
        Boolean(url),
      );
      return {
        replies: [
          reply(
            `Я помогу понять следующий учебный шаг. Перед началом нужно подтвердить согласие на обработку данных${links.length ? ` и ознакомиться с документами: ${links.join(' ')}` : ''}.`,
            c,
            [
              ['Согласиться и продолжить', 'consent'],
              ['Отказаться', 'decline'],
            ],
          ),
        ],
        jobs,
      };
    }
    if (c.state === 'AGE')
      return {
        replies: [
          reply('Укажите возраст числом. Это нужно только для проверки правил доступа.', c),
        ],
        jobs,
      };
    if (c.state === 'CONSENT') {
      const age = Number(c.data.age);
      if (this.policy.minAge !== undefined && age < this.policy.minAge)
        return {
          replies: [
            reply(
              'Этот сценарий сейчас недоступен для указанного возраста. Данные не сохраняются.',
            ),
          ],
          jobs,
        };
      if (
        this.policy.representativeRequiredUnder !== undefined &&
        age < this.policy.representativeRequiredUnder
      )
        return {
          replies: [
            reply(
              'Для продолжения требуется согласие законного представителя по утверждённому правилу. Пока профиль не создан.',
            ),
          ],
          jobs,
        };
      if (this.policy.version)
        await this.repository.saveConsent(c.actorId, this.policy.version, age);
      return {
        replies: [
          reply(
            `Согласие версии ${this.policy.version ?? 'не указана'} сохранится вместе с вашим выбором. С чем нужна помощь?`,
            c,
            [
              ['Новая проблема', 'newProblem'],
              ['Продолжить незавершённое', 'continue'],
            ],
          ),
        ],
        jobs,
      };
    }
    if (c.state === 'PROBLEM')
      return {
        replies: [
          reply(
            c.data.tooLong === true
              ? 'Сообщение слишком длинное. Сократите его до 1000 символов.'
              : 'Опишите свободным текстом, с чем нужна помощь. Например: «не понимаю дроби».',
            c,
            [['Отмена', 'restart']],
          ),
        ],
        jobs,
      };
    if (c.state === 'CLARIFY')
      return {
        replies: [
          reply(
            `${(c.data.classification as Classification | undefined)?.interpretation ?? 'Уточните запрос.'} Выберите, какой результат вам нужен.`,
            c,
            [
              ['Выбрать направление', 'direction'],
              ['Закрыть пробел', 'knowledge'],
              ['Освоить навык', 'skill'],
              ['Подготовиться к практике', 'practiceReadiness'],
              ['Начать заново', 'restart'],
            ],
          ),
        ],
        jobs,
      };
    if (c.state === 'CONFIRM_PROBLEM') {
      const classified = c.data.classification as Classification;
      return {
        replies: [
          reply(`${classified.interpretation}\nПодтвердите, что я понял правильно.`, c, [
            ['Подтвердить', 'confirm'],
            ['Изменить', 'edit'],
            ['Начать заново', 'restart'],
          ]),
        ],
        jobs,
      };
    }
    if (c.state === 'PROFILE')
      return {
        replies: [
          reply('Для короткой диагностики укажите текущий учебный контекст.', c, [
            ['Школа', 'school'],
            ['Колледж или вуз', 'student'],
          ]),
        ],
        jobs,
      };
    if (c.state === 'DIAGNOSIS') {
      if (c.data.resumeDiagnostic === true && typeof c.data.diagnosticSessionId === 'string') {
        await this.repository.resumeDiagnostic?.(c.actorId, c.data.diagnosticSessionId);
        const resumed = next(c, 'DIAGNOSIS', { ...c.data, resumeDiagnostic: false });
        await this.repository.transact(`resume:${command.eventId}`, c.actorId, () => resumed);
        return this.present(resumed, command);
      }
      if (c.data.problemConfirmed === true) {
        const rawText = c.data.draftText;
        const interpretation = c.data.classification;
        const profile = c.data.diagnosticProfile as MinimumDiagnosticProfile | undefined;
        const saved =
          typeof rawText === 'string' &&
          interpretation &&
          typeof interpretation === 'object' &&
          profile
            ? await this.repository.saveProblem(
                c.actorId,
                rawText,
                interpretation as Classification,
                profile,
              )
            : {};
        const confirmed = next(c, 'DIAGNOSIS', {
          ...c.data,
          problemConfirmed: false,
          ...(saved.sessionId === undefined ? {} : { diagnosticSessionId: saved.sessionId }),
          ...(saved.question === undefined ? {} : { canonicalQuestion: saved.question }),
        });
        await this.repository.transact(`problem:${command.eventId}`, c.actorId, () => confirmed);
        return this.present(confirmed, command);
      }
      if (c.data.additionalConsentJustGranted === true) {
        const sessionId = c.data.diagnosticSessionId;
        const issued =
          typeof sessionId === 'string'
            ? await this.repository.grantAdditionalConsent?.(c.actorId, sessionId)
            : undefined;
        const consented = next(c, 'DIAGNOSIS', {
          ...c.data,
          additionalConsentJustGranted: false,
          awaitingAdditionalConsent: false,
          ...(issued ? { canonicalQuestion: issued } : {}),
        });
        await this.repository.transact(`consent:${command.eventId}`, c.actorId, () => consented);
        return this.present(consented, command);
      }
      const count = Number(c.data.answerCount ?? 0);
      if (c.data.awaitingAdditionalConsent === true)
        return {
          replies: [
            reply(
              'Основные 8 вопросов завершены. Разрешаете задать до 4 дополнительных уточняющих вопросов?',
              c,
              [
                ['Да, продолжить', 'more'],
                ['Завершить', 'finish'],
              ],
            ),
          ],
          jobs,
        };
      if (c.data.answerKind || c.data.textAnswer) {
        const index = Number(c.data.questionIndex ?? 0);
        const diagnosticQuestions = diagnosticQuestionsFor(c);
        const q =
          diagnosticQuestions[Math.min(index, diagnosticQuestions.length - 1)] ??
          diagnosticQuestions[0];
        const savedAnswer = await this.repository.saveAnswer({
          actorId: c.actorId,
          questionId: q.id,
          idempotencyKey: `${c.id}:${String(c.revision)}`,
          kind:
            c.data.answerKind === 'SKIP'
              ? 'SKIP'
              : c.data.answerKind === 'DONT_KNOW'
                ? 'DONT_KNOW'
                : c.data.answerKind === 'CHOICE'
                  ? 'CHOICE'
                  : 'TEXT',
          value:
            c.data.answerKind === 'CHOICE'
              ? ((c.data.answerValue as string[] | undefined) ?? [])
              : ((c.data.textAnswer as string | undefined) ?? null),
          ...(typeof c.data.diagnosticSessionId === 'string'
            ? { diagnosticSessionId: c.data.diagnosticSessionId }
            : {}),
          ...(c.data.canonicalQuestion && typeof c.data.canonicalQuestion === 'object'
            ? {
                questionInstanceId: String(
                  (c.data.canonicalQuestion as { questionInstanceId?: unknown }).questionInstanceId,
                ),
                sessionRevision: Number(
                  (c.data.canonicalQuestion as { sessionRevision?: unknown }).sessionRevision,
                ),
              }
            : {}),
        });
        const nextCount = count + 1;
        const continueDiagnosis =
          nextCount < 8 || (c.data.additionalConsent === true && nextCount < 12);
        const needsConsent = nextCount === 8 && c.data.additionalConsent !== true;
        const advanced = next(c, continueDiagnosis || needsConsent ? 'DIAGNOSIS' : 'RESULT', {
          ...c.data,
          questionIndex: index + 1,
          answerCount: nextCount,
          awaitingAdditionalConsent: needsConsent,
          answerKind: undefined,
          answerValue: undefined,
          textAnswer: undefined,
          canonicalQuestion: savedAnswer.question,
          finishDiagnostic: !continueDiagnosis && !needsConsent,
        });
        await this.repository.transact(`advance:${command.eventId}`, c.actorId, () => advanced);
        return this.present(advanced, command);
      }
      return { replies: [diagnosisReply(c)], jobs };
    }
    if (c.state === 'PAUSED')
      return (async () => {
        if (c.data.pauseDiagnostic === true && typeof c.data.diagnosticSessionId === 'string')
          await this.repository.finishDiagnostic?.(c.actorId, c.data.diagnosticSessionId, 'PAUSED');
        return {
          replies: [
            reply('Пауза сохранена. Вернуться можно в любой момент.', c, [
              ['Продолжить', 'continue'],
            ]),
          ],
          jobs,
        };
      })();
    if (c.state === 'RESULT') {
      const canonicalResult =
        c.data.finishDiagnostic === true && typeof c.data.diagnosticSessionId === 'string'
          ? await this.repository.finishDiagnostic?.(
              c.actorId,
              c.data.diagnosticSessionId,
              'USER_FINISHED',
            )
          : undefined;
      const summary = canonicalResult
        ? [
            `Подтверждено: ${String(canonicalResult.known.length)}`,
            `Требует работы: ${String(canonicalResult.gaps.length)}`,
            `Пока неизвестно: ${String(canonicalResult.unknown.length)}`,
            canonicalResult.explanation,
          ].join('\n')
        : 'Канонический результат пока не сформирован; знания не считаются подтверждёнными.';
      return {
        replies: [
          reply(
            `${summary}\nПервый шаг — короткая практика по выбранной теме. Точность в процентах не заявляется.`,
            c,
            [
              ['Подтвердить цель', 'goal'],
              ['Изменить цель', 'edit'],
              ['Подробнее', 'details'],
            ],
          ),
        ],
        jobs,
      };
    }
    if (c.state === 'GOAL')
      return {
        replies: [
          reply(
            'Цель: выполнить первый короткий шаг по подтверждённой проблеме. Подтвердите её — сборка курса займёт некоторое время.',
            c,
            [
              ['Подтвердить цель', 'goal'],
              ['Изменить цель', 'edit'],
            ],
          ),
        ],
        jobs,
      };
    if (c.state === 'LEARNING') {
      if (c.data.goalConfirmed === true) {
        const created = await this.repository.saveGoal(c.actorId, 'first-learning-step');
        if (created) jobs.push({ type: 'course.build', key: `goal:${c.actorId}` });
        const recorded = next(c, 'LEARNING', { ...c.data, goalConfirmed: false, goalSaved: true });
        await this.repository.transact(`goal:${command.eventId}`, c.actorId, () => recorded);
        const rendered = await this.present(recorded, command);
        return { replies: rendered.replies, jobs: [...jobs, ...rendered.jobs] };
      }
      const page = Number(c.data.page ?? 0);
      await this.repository.recordStepOpened(c.actorId, 'demo-first-step', page);
      const pages = [
        'Шаг: основа\nПочему: ответы показали, что нужен короткий первый шаг.\nЦель: применить правило в одном примере.',
        'Пример\nРазберите пример по шагам и сверяйте каждый шаг с условием.',
        'Короткая практика\nОтветьте своими словами; решение станет доступно только после попытки.',
      ];
      return {
        replies: [
          {
            ...reply(
              pages[page] ?? pages[0] ?? 'Материал временно недоступен.',
              c,
              page < pages.length - 1
                ? [
                    ['Следующий фрагмент', 'lesson'],
                    ['Практика', 'practice'],
                  ]
                : [['Практика', 'practice']],
            ),
            ...(this.miniAppUrl
              ? { miniApp: { label: 'Открыть полный урок', url: this.miniAppUrl } }
              : {}),
          },
        ],
        jobs,
      };
    }
    if (c.state === 'ATTEMPT') {
      if (typeof c.data.attemptAnswer === 'string') {
        const saved = await this.repository.saveAttempt({
          actorId: c.actorId,
          key: `${c.id}:${String(c.revision)}`,
          answer: c.data.attemptAnswer,
          assistance: c.data.solutionShown === true ? 'SOLUTION' : 'NONE',
        });
        const recorded = next(c, 'ATTEMPT', {
          ...c.data,
          attemptAnswer: undefined,
          lastAttemptId: saved.id,
        });
        await this.repository.transact(`attempt:${command.eventId}`, c.actorId, () => recorded);
        jobs.push({ type: 'attempt.grade', key: `attempt:${saved.id}` });
        return {
          replies: [
            reply(
              'Попытка принята и проверяется по версии рубрики. Полное решение пока не раскрываю.',
              recorded,
              [
                ['Попробовать снова', 'retry'],
                ['Объяснить ошибку', 'solution'],
                ['Оспорить', 'dispute'],
                ['Подробнее', 'details'],
              ],
            ),
          ],
          jobs,
        };
      }
      const text =
        c.data.solutionShown === true
          ? 'Подсказка: сначала выделите условие и выполните один проверяемый шаг. Эта попытка не будет считаться независимой.'
          : 'Практика: напишите короткий ответ. Решение откроется только после попытки.';
      return {
        replies: [
          reply(text, c, [
            ['Объяснить ошибку', 'solution'],
            ['Отмена', 'restart'],
          ]),
        ],
        jobs,
      };
    }
    if (c.data.disputeRequested === true && typeof c.data.lastAttemptId === 'string')
      await this.repository.saveDispute(
        c.actorId,
        c.data.lastAttemptId,
        'Пользователь оспорил результат в MAX-боте',
      );
    return {
      replies: [
        reply(
          c.data.disputeRequested === true
            ? 'Спор по попытке создан без раскрытия лишних данных. Пока можно продолжить обучение.'
            : 'Продолжим с последнего сохранённого шага.',
          c,
          [
            ['Новая проблема', 'newProblem'],
            ['Продолжить', 'continue'],
          ],
        ),
      ],
      jobs,
    };
  }

  private async handleSystem(command: BotCommand): Promise<BotTransition> {
    const event = command.systemEvent;
    if (!event || !(await this.repository.saveNotification(command.eventId)))
      return { replies: [], jobs: [] };
    const label: Record<NotificationEvent, string> = {
      'plan.published': 'План готов. Можно продолжить с актуального шага.',
      'attempt.graded': 'Проверка попытки готова. Можно посмотреть следующий шаг.',
      'route.changed': 'Маршрут обновлён. Откройте актуальный следующий шаг.',
      'dispute.resolved': 'Спор обновлён. Доступно следующее действие.',
      'certificate.ready': 'Сертификат готов. Откройте сохранённое действие.',
    };
    const c = (await this.repository.get(command.actorId)) ?? conversation(command.actorId);
    return { replies: [reply(label[event], c, [['Продолжить', 'continue']])], jobs: [] };
  }
  private helpFor(state: BotConversationState): string {
    return `Сейчас этап: ${state}. Можно продолжить, отменить текущий ввод или начать новую проблему.`;
  }
}

export type NotificationEvent =
  'plan.published' | 'attempt.graded' | 'route.changed' | 'dispute.resolved' | 'certificate.ready';

/** In-process fake used only in unit tests; a caller can reuse the same instance after a restart. */
export class MemoryBotRepository implements BotRepository {
  private readonly conversations = new Map<string, BotConversation>();
  private readonly events = new Set<string>();
  private readonly answers = new Set<string>();
  private readonly attempts = new Map<string, AttemptId>();
  private readonly goals = new Set<string>();
  private readonly notifications = new Set<string>();
  private readonly openedSteps = new Set<string>();
  get(actorId: string): Promise<BotConversation | null> {
    return Promise.resolve(this.conversations.get(actorId) ?? null);
  }
  transact(
    eventId: string,
    actorId: string,
    apply: (current: BotConversation | null) => BotConversation,
  ): Promise<{ conversation: BotConversation; duplicate: boolean }> {
    if (this.events.has(eventId))
      return Promise.resolve({
        conversation: this.conversations.get(actorId) ?? conversation(actorId),
        duplicate: true,
      });
    const saved = apply(this.conversations.get(actorId) ?? null);
    this.events.add(eventId);
    this.conversations.set(actorId, saved);
    return Promise.resolve({ conversation: saved, duplicate: false });
  }
  saveProblem(): Promise<{ sessionId?: string }> {
    return Promise.resolve({});
  }
  saveAnswer(input: {
    actorId: string;
    questionId: string;
    idempotencyKey: string;
  }): Promise<{ created: boolean }> {
    const key = `${input.actorId}:${input.questionId}:${input.idempotencyKey}`;
    if (this.answers.has(key)) return Promise.resolve({ created: false });
    this.answers.add(key);
    return Promise.resolve({ created: true });
  }
  saveAttempt(input: {
    actorId: string;
    key: string;
  }): Promise<{ id: AttemptId; created: boolean }> {
    const key = `${input.actorId}:${input.key}`;
    const existing = this.attempts.get(key);
    if (existing) return Promise.resolve({ id: existing, created: false });
    const id = newUuid<AttemptId>();
    this.attempts.set(key, id);
    return Promise.resolve({ id, created: true });
  }
  saveDispute(): Promise<boolean> {
    return Promise.resolve(true);
  }
  saveGoal(actorId: string): Promise<boolean> {
    if (this.goals.has(actorId)) return Promise.resolve(false);
    this.goals.add(actorId);
    return Promise.resolve(true);
  }
  saveConsent(): Promise<void> {
    return Promise.resolve();
  }
  recordStepOpened(actorId: string, stepId: string, position: number): Promise<boolean> {
    const key = `${actorId}:${stepId}:${String(position)}`;
    if (this.openedSteps.has(key)) return Promise.resolve(false);
    this.openedSteps.add(key);
    return Promise.resolve(true);
  }
  saveNotification(eventId: string): Promise<boolean> {
    if (this.notifications.has(eventId)) return Promise.resolve(false);
    this.notifications.add(eventId);
    return Promise.resolve(true);
  }
}

/** PostgreSQL implementation; every state change is guarded by a processed-event row. */
export class PostgresBotRepository implements BotRepository {
  constructor(
    private readonly pool: Pool,
    private readonly transactionClient?: PoolClient,
  ) {}
  private get db(): Pick<Pool, 'query'> {
    return this.transactionClient ?? this.pool;
  }
  private get diagnostics(): DiagnosticApplicationService {
    return new DiagnosticApplicationService(
      this.pool,
      demoDiagnosticCatalog,
      this.transactionClient,
    );
  }
  private async userIdForActor(actorId: string): Promise<string> {
    const actorHash = actorDigest(actorId);
    const client = this.transactionClient ?? (await this.pool.connect());
    const ownsTransaction = this.transactionClient === undefined;
    try {
      if (ownsTransaction) await client.query('BEGIN');
      const known = await client.query<{ user_id: string }>(
        'SELECT user_id FROM max_user_identities WHERE actor_id_hash=$1 FOR UPDATE',
        [actorHash],
      );
      const userId = known.rows[0]?.user_id ?? newUuid();
      if (!known.rows[0]) {
        await client.query('INSERT INTO users(id) VALUES ($1) ON CONFLICT DO NOTHING', [userId]);
        await client.query(
          'INSERT INTO max_user_identities(user_id,actor_id_hash) VALUES ($1,$2) ON CONFLICT(actor_id_hash) DO NOTHING',
          [userId, actorHash],
        );
      }
      if (ownsTransaction) await client.query('COMMIT');
      return userId;
    } catch (error) {
      if (ownsTransaction) await client.query('ROLLBACK');
      throw error;
    } finally {
      if (ownsTransaction) client.release();
    }
  }
  async get(actorId: string): Promise<BotConversation | null> {
    const result = await this.db.query<{
      id: ConversationId;
      state: BotConversationState;
      revision: number;
      data: Record<string, unknown>;
      updated_at: Date;
    }>(
      `SELECT id, state, revision, data, updated_at FROM bot_conversations WHERE actor_id_hash = $1`,
      [actorDigest(actorId)],
    );
    const row = result.rows[0];
    return row
      ? {
          id: row.id,
          actorId,
          state: row.state,
          revision: row.revision,
          data: row.data,
          updatedAt: row.updated_at.toISOString(),
        }
      : null;
  }
  async transact(
    eventId: string,
    actorId: string,
    apply: (current: BotConversation | null) => BotConversation,
  ): Promise<{ conversation: BotConversation; duplicate: boolean }> {
    const actorHash = actorDigest(actorId);
    const client = this.transactionClient ?? (await this.pool.connect());
    const ownsTransaction = this.transactionClient === undefined;
    try {
      if (ownsTransaction) await client.query('BEGIN');
      const event = await client.query(
        `INSERT INTO bot_processed_events(event_id, actor_id_hash) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING event_id`,
        [eventId, actorHash],
      );
      const currentResult = await client.query<{
        id: ConversationId;
        state: BotConversationState;
        revision: number;
        data: Record<string, unknown>;
        updated_at: Date;
      }>(
        `SELECT id, state, revision, data, updated_at FROM bot_conversations WHERE actor_id_hash = $1 FOR UPDATE`,
        [actorHash],
      );
      const row = currentResult.rows[0];
      let current: BotConversation | null = row
        ? {
            id: row.id,
            actorId,
            state: row.state,
            revision: row.revision,
            data: row.data,
            updatedAt: row.updated_at.toISOString(),
          }
        : null;
      if (event.rowCount !== 1) {
        if (ownsTransaction) await client.query('COMMIT');
        return { conversation: current ?? conversation(actorId), duplicate: true };
      }
      if (
        current &&
        (current.state === 'DIAGNOSIS' || current.state === 'PAUSED') &&
        typeof current.data.diagnosticSessionId === 'string'
      ) {
        const canonical = await client.query<{
          status: string;
          question_count: number;
          additional_consent_at: Date | null;
          question_instance_id: string | null;
          public_payload: Record<string, unknown> | null;
        }>(
          `SELECT s.status,s.question_count,s.additional_consent_at,
                  q.id AS question_instance_id,q.public_payload
           FROM diagnostic_sessions s
           LEFT JOIN LATERAL (
             SELECT qi.id,qi.public_payload FROM diagnostic_question_instances qi
             LEFT JOIN diagnostic_answer_submissions a ON a.question_instance_id=qi.id
             WHERE qi.session_id=s.id AND a.id IS NULL ORDER BY qi.ordinal DESC LIMIT 1
           ) q ON true WHERE s.id=$1`,
          [current.data.diagnosticSessionId],
        );
        const session = canonical.rows[0];
        if (session) {
          const question =
            session.question_instance_id && session.public_payload
              ? {
                  questionInstanceId: session.question_instance_id,
                  sessionRevision: Number(session.public_payload.session_revision),
                  publicQuestion: session.public_payload,
                }
              : undefined;
          current = {
            ...current,
            state:
              session.status === 'COMPLETED' || session.status === 'COMPLETED_PARTIAL'
                ? 'RESULT'
                : session.status === 'PAUSED'
                  ? 'PAUSED'
                  : 'DIAGNOSIS',
            data: {
              ...current.data,
              answerCount: session.question_count,
              questionIndex: session.question_count,
              additionalConsent: session.additional_consent_at !== null,
              awaitingAdditionalConsent:
                session.status === 'IN_PROGRESS' &&
                session.question_count >= 8 &&
                session.additional_consent_at === null,
              canonicalQuestion: question,
              ...(session.status === 'COMPLETED' || session.status === 'COMPLETED_PARTIAL'
                ? { finishDiagnostic: true }
                : {}),
            },
          };
        }
      }
      const updated = apply(current);
      await client.query(
        `INSERT INTO bot_conversations(id, actor_id_hash, state, revision, data) VALUES ($1,$2,$3,$4,$5) ON CONFLICT(actor_id_hash) DO UPDATE SET state = EXCLUDED.state, revision = EXCLUDED.revision, data = EXCLUDED.data`,
        [updated.id, actorHash, updated.state, updated.revision, updated.data],
      );
      if (ownsTransaction) await client.query('COMMIT');
      return { conversation: updated, duplicate: false };
    } catch (error) {
      if (ownsTransaction) await client.query('ROLLBACK');
      throw error;
    } finally {
      if (ownsTransaction) client.release();
    }
  }
  async saveProblem(
    actorId: string,
    rawText: string,
    interpretation: Classification,
    profile: MinimumDiagnosticProfile,
  ): Promise<{ sessionId?: string }> {
    const userId = await this.userIdForActor(actorId);
    const created = await new PostgresProblemDiagnosticRepository(
      this.pool,
      this.transactionClient,
    ).createConfirmedSession({
      userId,
      rawText,
      classification: interpretation,
      profile,
    });
    const issued = await this.diagnostics.issueNext({
      sessionId: created.sessionId,
      userId,
    });
    return {
      sessionId: created.sessionId,
      ...(issued.kind === 'QUESTION' ? { question: issued } : {}),
    };
  }
  async grantAdditionalConsent(actorId: string, sessionId: string) {
    return this.diagnostics.grantAdditionalConsentAndIssue({
      sessionId,
      userId: await this.userIdForActor(actorId),
    });
  }
  async finishDiagnostic(
    actorId: string,
    sessionId: string,
    reason: 'USER_FINISHED' | 'PAUSED',
  ): Promise<DiagnosticResult | undefined> {
    const userId = await this.userIdForActor(actorId);
    const status = await this.db.query<{ status: string }>(
      'SELECT status FROM diagnostic_sessions WHERE id=$1 AND user_id=$2',
      [sessionId, userId],
    );
    if (status.rows[0]?.status !== 'IN_PROGRESS') {
      const existing = await this.db.query<{ payload: DiagnosticResult }>(
        `SELECT r.payload FROM diagnostic_results r
         JOIN diagnostic_sessions s ON s.id=r.session_id
         WHERE r.session_id=$1 AND s.user_id=$2 ORDER BY r.created_at DESC LIMIT 1`,
        [sessionId, userId],
      );
      return existing.rows[0]?.payload;
    }
    const finished = await this.diagnostics.finish({
      sessionId,
      userId,
      policies: [],
      stoppingReason: reason,
      evaluatedAt: new Date().toISOString(),
    });
    return finished.result;
  }
  async resumeDiagnostic(actorId: string, sessionId: string): Promise<void> {
    await this.diagnostics.resume({
      sessionId,
      userId: await this.userIdForActor(actorId),
    });
  }
  async saveAnswer(input: {
    actorId: string;
    questionId: string;
    idempotencyKey: string;
    kind: 'CHOICE' | 'TEXT' | 'SKIP' | 'DONT_KNOW';
    value: string[] | string | null;
    diagnosticSessionId?: string;
    questionInstanceId?: string;
    sessionRevision?: number;
  }): Promise<{
    created: boolean;
    question?: {
      questionInstanceId: string;
      sessionRevision: number;
      publicQuestion: Record<string, unknown>;
    };
    stoppedReason?: string;
  }> {
    if (input.diagnosticSessionId) {
      const sessionRevision = input.sessionRevision;
      if (
        !input.questionInstanceId ||
        typeof sessionRevision !== 'number' ||
        !Number.isInteger(sessionRevision)
      )
        throw new Error('Canonical diagnostic question reference is required');
      const userId = await this.userIdForActor(input.actorId);
      const progress = await this.diagnostics.answerAndIssue({
        sessionId: input.diagnosticSessionId,
        userId,
        questionInstanceId: input.questionInstanceId,
        expectedRevision: sessionRevision,
        idempotencyKey: input.idempotencyKey,
        kind: input.kind,
        value: input.value,
      });
      return progress.questionInstanceId
        ? {
            created: progress.created,
            question: {
              questionInstanceId: progress.questionInstanceId,
              sessionRevision: progress.sessionRevision,
              publicQuestion: progress.publicQuestion ?? {},
            },
          }
        : {
            created: progress.created,
            ...(progress.stoppedReason ? { stoppedReason: progress.stoppedReason } : {}),
          };
    }
    const result = await this.db.query(
      `INSERT INTO bot_answer_submissions(id, actor_id_hash, question_id, idempotency_key, answer_kind, answer_value) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
      [
        newUuid(),
        actorDigest(input.actorId),
        input.questionId,
        actorDigest(input.idempotencyKey),
        input.kind,
        input.value,
      ],
    );
    return { created: result.rowCount === 1 };
  }
  async saveAttempt(input: {
    actorId: string;
    key: string;
    answer: string;
    assistance: 'NONE' | 'SOLUTION';
  }): Promise<{ id: AttemptId; created: boolean }> {
    const userId = await this.userIdForActor(input.actorId);
    const rubric = await this.db.query<{ id: string }>(
      `SELECT id::text FROM content_catalog_versions
       WHERE kind='RUBRIC' AND logical_id='demo-rubric' AND status='PUBLISHED'
       ORDER BY version DESC LIMIT 1`,
    );
    const rubricVersion = rubric.rows[0]?.id;
    if (!rubricVersion) throw new Error('Published rubric is required');
    const result = await this.db.query<{ id: AttemptId }>(
      `INSERT INTO bot_attempts(id, actor_id_hash, idempotency_key, answer_text, rubric_version,
        independent_pass_eligible) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT(actor_id_hash, idempotency_key) DO NOTHING RETURNING id`,
      [
        newUuid<AttemptId>(),
        actorDigest(input.actorId),
        actorDigest(input.key),
        input.answer,
        rubricVersion,
        input.assistance === 'NONE',
      ],
    );
    const created = result.rows[0];
    if (created) {
      await this.db.query(
        `INSERT INTO attempts(id,user_id,route_id,task_version_id,rubric_version,assistance_level,
          independent_pass_eligible,answer_payload,idempotency_key)
         VALUES ($1,$2,(SELECT id FROM learning_routes WHERE user_id=$2 AND status='ACTIVE'),
          (SELECT id::text FROM content_catalog_versions WHERE kind='TASK_TEMPLATE' AND logical_id='demo-task' AND status='PUBLISHED' ORDER BY version DESC LIMIT 1),
          $7,
          $3,$4,$5,$6)`,
        [
          created.id,
          userId,
          input.assistance,
          input.assistance === 'NONE',
          { text: input.answer },
          actorDigest(input.key),
          rubricVersion,
        ],
      );
      await this.db.query(
        `INSERT INTO review_versions(id,attempt_id,version,rubric_version,status,payload)
         VALUES ($1,$2,1,
          $3,'PENDING',$4)`,
        [newUuid(), created.id, rubricVersion, { reason: 'DETERMINISTIC_REVIEW_PENDING' }],
      );
      return { id: created.id, created: true };
    }
    const existing = await this.db.query<{ id: AttemptId }>(
      `SELECT id FROM bot_attempts WHERE actor_id_hash = $1 AND idempotency_key = $2`,
      [actorDigest(input.actorId), actorDigest(input.key)],
    );
    const previous = existing.rows[0];
    if (!previous)
      throw new ApplicationError({
        code: 'ATTEMPT_IDEMPOTENCY_LOOKUP_FAILED',
        message: 'Попытка временно недоступна',
        statusCode: 503,
        retryable: true,
      });
    return { id: previous.id, created: false };
  }
  async saveDispute(actorId: string, attemptId: string, reason: string): Promise<boolean> {
    const userId = await this.userIdForActor(actorId);
    const disputeId = newUuid();
    const result = await this.db.query(
      `INSERT INTO disputes(id,user_id,attempt_id,reason)
       SELECT $1,$2,a.id,$4 FROM attempts a WHERE a.id=$3 AND a.user_id=$2`,
      [disputeId, userId, attemptId, reason],
    );
    if (result.rowCount === 1)
      await this.db.query(
        `INSERT INTO bot_disputes(id,attempt_id,status) VALUES ($1,$2,'OPEN') ON CONFLICT DO NOTHING`,
        [disputeId, attemptId],
      );
    return result.rowCount === 1;
  }
  async saveGoal(actorId: string, text: string): Promise<boolean> {
    const actorHash = actorDigest(actorId);
    const userId = await this.userIdForActor(actorId);
    const goalId = newUuid();
    const result = await this.db.query(
      `INSERT INTO bot_goals(id, actor_id_hash, version, text) VALUES ($1,$2,(SELECT COALESCE(MAX(version),0)+1 FROM bot_goals WHERE actor_id_hash=$2),$3) ON CONFLICT(actor_id_hash, version) DO NOTHING`,
      [goalId, actorHash, text],
    );
    if (result.rowCount === 1)
      await this.db.query(
        `INSERT INTO goals(id,user_id,payload,version)
         VALUES ($1,$2,$3,(SELECT COALESCE(MAX(version),0)+1 FROM goals WHERE user_id=$2))`,
        [goalId, userId, { text, source: 'MAX_BOT' }],
      );
    return result.rowCount === 1;
  }
  async saveConsent(actorId: string, version: string, age: number): Promise<void> {
    const userId = await this.userIdForActor(actorId);
    const client = this.transactionClient ?? (await this.pool.connect());
    const ownsTransaction = this.transactionClient === undefined;
    try {
      if (ownsTransaction) await client.query('BEGIN');
      await client.query(
        `INSERT INTO profile_versions(id,user_id,version,payload)
         VALUES ($1,$2,(SELECT COALESCE(MAX(version),0)+1 FROM profile_versions WHERE user_id=$2),$3)`,
        [newUuid(), userId, { age }],
      );
      await client.query(
        `INSERT INTO consents(id,user_id,consent_type,document_version,granted,occurred_at)
         VALUES ($1,$2,'PERSONAL_DATA',$3,true,now())
         ON CONFLICT(user_id,consent_type,document_version)
         DO UPDATE SET granted=true,occurred_at=now(),version=consents.version+1`,
        [newUuid(), userId, version],
      );
      await client.query(
        `INSERT INTO bot_consents(id, actor_id_hash, document_version)
         VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [newUuid(), actorDigest(actorId), version],
      );
      if (ownsTransaction) await client.query('COMMIT');
    } catch (error) {
      if (ownsTransaction) await client.query('ROLLBACK');
      throw error;
    } finally {
      if (ownsTransaction) client.release();
    }
  }
  async recordStepOpened(actorId: string, stepId: string, position: number): Promise<boolean> {
    const actorHash = actorDigest(actorId);
    const result = await this.db.query(
      `INSERT INTO bot_step_open_events(actor_id_hash, step_id, position) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [actorHash, stepId, position],
    );
    await this.db.query(
      `INSERT INTO bot_learning_state(actor_id_hash, current_step_id, position, version) VALUES ($1,$2,$3,1) ON CONFLICT(actor_id_hash) DO UPDATE SET current_step_id=EXCLUDED.current_step_id, position=EXCLUDED.position, version=bot_learning_state.version+1, updated_at=now()`,
      [actorHash, stepId, position],
    );
    return result.rowCount === 1;
  }
  async saveNotification(eventId: string): Promise<boolean> {
    const result = await this.db.query(
      `INSERT INTO bot_notification_events(event_id, actor_id_hash) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [eventId, actorDigest('notification')],
    );
    return result.rowCount === 1;
  }
}

export function actorDigest(value: string): string {
  // Worker storage already exposes only the provider identity digest. Keeping
  // an existing digest stable makes bot and mini-app resolve the same user.
  if (/^[a-f0-9]{64}$/i.test(value)) return value.toLowerCase();
  return createHash('sha256').update(value).digest('hex');
}
export function assertValidOpaqueCallback(value: string): void {
  if (!parseCallback(value))
    throw new ApplicationError({
      code: 'INVALID_CALLBACK',
      message: 'Недопустимое действие',
      statusCode: 409,
    });
}
