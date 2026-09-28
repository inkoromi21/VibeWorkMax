/**
 * A deliberately small, versioned demo catalog.  It is not a claim of
 * expert validation: the approval is limited to allowing this fixture in the
 * isolated demo diagnostic flow.
 */
export const CONTENT_STATUSES = ['DRAFT', 'PUBLISHED', 'ARCHIVED'] as const;
export type ContentStatus = (typeof CONTENT_STATUSES)[number];
export const APPROVAL_STATUSES = ['PENDING', 'APPROVED'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];
export const REQUEST_TYPES = ['DIRECTION', 'KNOWLEDGE_GAP', 'SKILL', 'PRACTICE_READINESS'] as const;
export type DiagnosticRequestType = (typeof REQUEST_TYPES)[number];

export interface QuestionTemplateVersion {
  id: string;
  catalogVersion: string;
  methodVersion: string;
  status: ContentStatus;
  approvalStatus: ApprovalStatus;
  requestType: DiagnosticRequestType;
  area: string;
  reason: string;
  evidenceRole: string;
  prompt: string;
  kind: 'CHOICE' | 'TEXT' | 'PREFERENCE';
  options: readonly string[];
  estimatedSeconds: number;
  priority: number;
  constraints: readonly string[];
  /** A direction-only template may be tailored to an education track. */
  educationTracks?: readonly ('school' | 'student')[];
}

export interface DiagnosticCatalog {
  id: string;
  version: string;
  dataMode: 'DEMO_SYNTHETIC';
  templates: readonly QuestionTemplateVersion[];
}

const catalogVersion = 'diagnostic-demo-catalog-v1';
const methodVersion = 'diagnostic-planner-v1';
const template = (
  id: string,
  requestType: DiagnosticRequestType,
  area: string,
  reason: string,
  evidenceRole: string,
  prompt: string,
  kind: QuestionTemplateVersion['kind'],
  options: readonly string[],
  priority: number,
  constraints: readonly string[] = [],
): QuestionTemplateVersion => ({
  id,
  catalogVersion,
  methodVersion,
  status: 'PUBLISHED',
  approvalStatus: 'APPROVED',
  requestType,
  area,
  reason,
  evidenceRole,
  prompt,
  kind,
  options,
  estimatedSeconds: 45,
  priority,
  constraints,
});

const supplementaryPrompts: readonly (readonly [string, string])[] = [
  ['detail', 'Какая деталь здесь наиболее важна для вас?'],
  ['example_two', 'Приведите ещё один короткий пример.'],
  ['constraint', 'Есть ли ограничение, которое важно учесть?'],
  ['check', 'Что поможет понять, что первый шаг был полезен?'],
  ['support', 'Какая поддержка или источник сейчас доступен?'],
  ['alternative', 'Какой другой вариант вы готовы рассмотреть?'],
  ['risk', 'Что может помешать начать?'],
  ['finish', 'Какой результат вы хотите увидеть после первого шага?'],
];

function supplementaryTemplates(requestType: DiagnosticRequestType): QuestionTemplateVersion[] {
  return supplementaryPrompts.map(([area, prompt], index) =>
    template(
      `${requestType.toLowerCase()}-${area}-supplement-v1`,
      requestType,
      area,
      'Дополнительный вопрос используется только после основного плана и отдельного согласия.',
      'optional clarification',
      prompt,
      'TEXT',
      [],
      50 + index,
      ['additional-question-consent-required'],
    ),
  );
}

const catalogTemplates: readonly QuestionTemplateVersion[] = [
  template(
    'direction-interests-v1',
    'DIRECTION',
    'interests',
    'Нужно понять, что привлекает в деятельности.',
    'self-report preference',
    'Что вам интереснее пробовать?',
    'CHOICE',
    ['Разбирать задачи', 'Работать с людьми', 'Создавать и оформлять'],
    10,
  ),
  template(
    'direction-context-v1',
    'DIRECTION',
    'context',
    'Контекст помогает выбрать следующий исследовательский шаг.',
    'context constraint',
    'Где вы сейчас учитесь или готовитесь?',
    'TEXT',
    [],
    20,
  ),
  {
    ...template(
      'direction-school-context-v1',
      'DIRECTION',
      'education_context',
      'Учебный этап помогает выбрать безопасную ближайшую пробу.',
      'education context',
      'Какой вариант в школе вы готовы попробовать в ближайшее время?',
      'PREFERENCE',
      ['Кружок или факультатив', 'Мини-проект', 'Разговор с наставником'],
      15,
    ),
    educationTracks: ['school'],
  },
  {
    ...template(
      'direction-student-context-v1',
      'DIRECTION',
      'education_context',
      'Учебный этап помогает выбрать безопасную ближайшую пробу.',
      'education context',
      'Какой вариант в колледже или вузе вы готовы попробовать в ближайшее время?',
      'PREFERENCE',
      ['Учебный проект', 'Практика', 'Разговор с наставником'],
      15,
    ),
    educationTracks: ['student'],
  },
  template(
    'direction-experience-v1',
    'DIRECTION',
    'experience',
    'Реальный опыт полезнее предположений о подходящей роли.',
    'experience example',
    'Назовите одно занятие, которое вам понравилось или не понравилось.',
    'TEXT',
    [],
    30,
  ),
  template(
    'direction-next-step-v1',
    'DIRECTION',
    'next_step',
    'Нужен выполнимый следующий опыт.',
    'decision preference',
    'Какой первый шаг сейчас реалистичен?',
    'PREFERENCE',
    ['Короткая проба', 'Разбор направлений', 'Разговор с наставником'],
    40,
  ),
  template(
    'gap-topic-v1',
    'KNOWLEDGE_GAP',
    'topic',
    'Нужно зафиксировать конкретную тему, а не предполагать общий уровень.',
    'problem scope',
    'Какую тему или задачу нужно понять?',
    'TEXT',
    [],
    10,
  ),
  template(
    'gap-attempt-v1',
    'KNOWLEDGE_GAP',
    'prior_attempt',
    'Предыдущая попытка показывает, с чего начать объяснение.',
    'prior evidence',
    'Что вы уже пробовали?',
    'TEXT',
    [],
    20,
  ),
  template(
    'gap-example-v1',
    'KNOWLEDGE_GAP',
    'example',
    'Один пример помогает локализовать затруднение.',
    'concrete example',
    'Приведите короткий пример, где возникла трудность.',
    'TEXT',
    [],
    30,
  ),
  template(
    'gap-format-v1',
    'KNOWLEDGE_GAP',
    'format',
    'Формат первого шага должен соответствовать ограничению пользователя.',
    'format preference',
    'Как удобнее начать?',
    'PREFERENCE',
    ['С пояснения', 'С примера', 'С короткой задачи'],
    40,
  ),
  template(
    'skill-goal-v1',
    'SKILL',
    'target',
    'Навык нужно ограничить конкретным результатом.',
    'target definition',
    'Что именно вы хотите научиться делать?',
    'TEXT',
    [],
    10,
  ),
  template(
    'skill-experience-v1',
    'SKILL',
    'experience',
    'Стартовая практика помогает подобрать первый шаг.',
    'prior evidence',
    'Что уже получается или что пробовали?',
    'TEXT',
    [],
    20,
  ),
  template(
    'skill-constraints-v1',
    'SKILL',
    'constraints',
    'План должен учитывать доступное время и средства.',
    'session constraint',
    'Сколько времени есть на первую практику?',
    'CHOICE',
    ['5 минут', '15 минут', 'Больше 15 минут'],
    30,
  ),
  template(
    'skill-format-v1',
    'SKILL',
    'format',
    'Подходящий формат снижает барьер первого действия.',
    'format preference',
    'Какой формат предпочтителен?',
    'PREFERENCE',
    ['Показать пример', 'Дать упражнение', 'Разобрать по шагам'],
    40,
  ),
  template(
    'readiness-goal-v1',
    'PRACTICE_READINESS',
    'goal',
    'Нужно уточнить, к какой практике готовиться.',
    'target definition',
    'К какой практике, стажировке или собеседованию готовитесь?',
    'TEXT',
    [],
    10,
  ),
  template(
    'readiness-evidence-v1',
    'PRACTICE_READINESS',
    'evidence',
    'Опыт и проекты — проверяемые исходные данные.',
    'self-reported evidence',
    'Какие проекты, задания или опыт уже есть?',
    'TEXT',
    [],
    20,
  ),
  template(
    'readiness-gap-v1',
    'PRACTICE_READINESS',
    'concern',
    'Нужно отличить неизвестное от конкретного следующего действия.',
    'concern scope',
    'Что сейчас вызывает наибольшую трудность?',
    'CHOICE',
    ['Нет опыта', 'Нужна практика', 'Нужно подготовиться к разговору'],
    30,
  ),
  template(
    'readiness-next-step-v1',
    'PRACTICE_READINESS',
    'next_step',
    'Первый шаг должен быть выполнимым в текущих ограничениях.',
    'action preference',
    'Что полезнее сделать сначала?',
    'PREFERENCE',
    ['Собрать примеры опыта', 'Выполнить пробное задание', 'Подготовить рассказ о себе'],
    40,
  ),
  {
    ...template(
      'draft-never-select-v1',
      'SKILL',
      'draft',
      'Черновик.',
      'none',
      'Черновой вопрос',
      'TEXT',
      [],
      99,
    ),
    status: 'DRAFT',
    approvalStatus: 'PENDING',
  },
  {
    ...template(
      'archived-never-select-v1',
      'DIRECTION',
      'archived',
      'Архив.',
      'none',
      'Архивный вопрос',
      'TEXT',
      [],
      99,
    ),
    status: 'ARCHIVED',
  },
  ...REQUEST_TYPES.flatMap(supplementaryTemplates),
];

export const demoDiagnosticCatalog: DiagnosticCatalog = Object.freeze({
  id: 'diagnostic-demo',
  version: catalogVersion,
  dataMode: 'DEMO_SYNTHETIC',
  templates: Object.freeze(catalogTemplates),
});

export function selectApprovedDiagnosticTemplates(
  catalog: DiagnosticCatalog,
  requestType: DiagnosticRequestType,
): readonly QuestionTemplateVersion[] {
  return catalog.templates
    .filter(
      (candidate) =>
        candidate.requestType === requestType &&
        candidate.status === 'PUBLISHED' &&
        candidate.approvalStatus === 'APPROVED',
    )
    .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id));
}

export const contentInfrastructureReady = true;
