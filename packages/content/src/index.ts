import { randomUUID } from 'node:crypto';
import { Ajv, type ValidateFunction } from 'ajv';
import type { Pool } from 'pg';

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

export const CATALOG_RECORD_KINDS = [
  'COMPETENCY',
  'LEARNING_BLOCK',
  'TASK_TEMPLATE',
  'RUBRIC',
  'SOURCE_RECORD',
  'METHOD_VERSION',
] as const;
export type CatalogRecordKind = (typeof CATALOG_RECORD_KINDS)[number];

const nonempty = { type: 'string', minLength: 1 } as const;
const versionId = { type: 'string', format: 'uuid' } as const;
const payloadSchemas = {
  COMPETENCY: {
    type: 'object',
    required: ['title'],
    properties: { title: nonempty },
    additionalProperties: true,
  },
  LEARNING_BLOCK: {
    type: 'object',
    required: ['title', 'durationMinutes', 'competencyVersionId'],
    properties: {
      title: nonempty,
      durationMinutes: { type: 'integer', minimum: 1 },
      competencyVersionId: versionId,
    },
    additionalProperties: true,
  },
  TASK_TEMPLATE: {
    type: 'object',
    required: ['title', 'learningBlockVersionId', 'rubricVersionId'],
    properties: { title: nonempty, learningBlockVersionId: versionId, rubricVersionId: versionId },
    additionalProperties: true,
  },
  RUBRIC: {
    type: 'object',
    required: ['criteria'],
    properties: {
      criteria: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          required: ['id', 'description'],
          properties: { id: nonempty, description: nonempty },
          additionalProperties: true,
        },
      },
    },
    additionalProperties: true,
  },
  SOURCE_RECORD: {
    type: 'object',
    required: ['synthetic'],
    properties: { synthetic: { type: 'boolean' } },
    additionalProperties: true,
  },
  METHOD_VERSION: {
    type: 'object',
    required: ['name'],
    properties: { name: nonempty },
    additionalProperties: true,
  },
} as const;
const ajv = new Ajv({ allErrors: true });
ajv.addFormat('uuid', /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
const payloadValidators = Object.fromEntries(
  Object.entries(payloadSchemas).map(([kind, schema]) => [kind, ajv.compile(schema)]),
) as Record<CatalogRecordKind, ValidateFunction>;

export interface CatalogVersionRecord {
  id: string;
  kind: CatalogRecordKind;
  logicalId: string;
  version: number;
  status: ContentStatus;
  dataMode: 'DEMO_SYNTHETIC' | 'VERIFIED_SOURCE';
  payload: Record<string, unknown>;
  sourceUrl: string | null;
  license: string | null;
  provenance: string;
  checkedAt: string;
  expertApproval: ApprovalStatus;
}

export function validateCatalogRecord(
  record: Omit<CatalogVersionRecord, 'id' | 'version'>,
): string[] {
  const errors: string[] = [];
  if (!CATALOG_RECORD_KINDS.includes(record.kind)) errors.push('INVALID_KIND');
  else if (!payloadValidators[record.kind](record.payload)) errors.push('INVALID_PAYLOAD');
  if (!record.logicalId.trim()) errors.push('MISSING_LOGICAL_ID');
  if (!record.provenance.trim()) errors.push('MISSING_PROVENANCE');
  if (!Number.isFinite(Date.parse(record.checkedAt))) errors.push('INVALID_CHECKED_AT');
  if (record.dataMode === 'VERIFIED_SOURCE' && !record.sourceUrl) errors.push('MISSING_SOURCE_URL');
  if (record.sourceUrl) {
    try {
      const source = new URL(record.sourceUrl);
      if (source.protocol !== 'https:') errors.push('INVALID_SOURCE_URL');
    } catch {
      errors.push('INVALID_SOURCE_URL');
    }
  }
  if (record.dataMode === 'VERIFIED_SOURCE' && !record.license?.trim())
    errors.push('MISSING_LICENSE');
  if (record.status === 'PUBLISHED' && record.expertApproval !== 'APPROVED')
    errors.push('EXPERT_APPROVAL_REQUIRED');
  return errors;
}

function collectVersionReferences(value: unknown): {
  references: { id: string; key: string }[];
  invalid: boolean;
} {
  const isUuid = (candidate: unknown): candidate is string =>
    typeof candidate === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate);
  const references: { id: string; key: string }[] = [];
  let invalid = false;
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    if (!candidate || typeof candidate !== 'object') return;
    for (const [key, child] of Object.entries(candidate as Record<string, unknown>)) {
      if (key.endsWith('VersionId')) {
        if (isUuid(child)) references.push({ id: child, key });
        else invalid = true;
      } else if (key.endsWith('VersionIds')) {
        if (Array.isArray(child) && child.every(isUuid))
          for (const item of child) references.push({ id: item, key });
        else invalid = true;
      }
      visit(child);
    }
  };
  visit(value);
  return { references, invalid };
}

/** Immutable PostgreSQL catalog versions with explicit publish/archive transitions. */
export class PostgresContentCatalogRepository {
  constructor(private readonly pool: Pool) {}

  async import(record: Omit<CatalogVersionRecord, 'id' | 'version' | 'status'>) {
    const errors = validateCatalogRecord({ ...record, status: 'DRAFT' });
    if (errors.length) throw new Error(`Invalid catalog record: ${errors.join(',')}`);
    const id = randomUUID();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `content:${record.kind}:${record.logicalId}`,
      ]);
      const result = await client.query<CatalogVersionRecord>(
        `INSERT INTO content_catalog_versions(
        id,kind,logical_id,version,status,data_mode,payload,source_url,license,provenance,checked_at,expert_approval)
       VALUES ($1,$2,$3,(SELECT COALESCE(MAX(version),0)+1 FROM content_catalog_versions
         WHERE kind=$2 AND logical_id=$3),'DRAFT',$4,$5,$6,$7,$8,$9,$10)
       RETURNING id,kind,logical_id AS "logicalId",version,status,data_mode AS "dataMode",payload,
         source_url AS "sourceUrl",license,provenance,checked_at AS "checkedAt",
         expert_approval AS "expertApproval"`,
        [
          id,
          record.kind,
          record.logicalId,
          record.dataMode,
          record.payload,
          record.sourceUrl,
          record.license,
          record.provenance,
          record.checkedAt,
          record.expertApproval,
        ],
      );
      const imported = result.rows[0];
      if (!imported) throw new Error('Catalog record was not imported');
      await client.query('COMMIT');
      return imported;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async validate(id: string): Promise<{ valid: boolean; errors: string[] }> {
    const record = await this.preview(id);
    const errors = record ? validateCatalogRecord(record) : ['NOT_FOUND'];
    if (record) {
      const references = collectVersionReferences(record.payload);
      if (references.invalid) errors.push('INVALID_VERSION_REFERENCE');
      if (references.references.length) {
        const linked = await this.pool.query<{ id: string; kind: CatalogRecordKind }>(
          `SELECT id,kind FROM content_catalog_versions WHERE id = ANY($1::uuid[]) AND status='PUBLISHED'`,
          [references.references.map((reference) => reference.id)],
        );
        const published = new Map(linked.rows.map((row) => [row.id, row.kind]));
        const expectedKinds: Record<string, CatalogRecordKind> = {
          competencyVersionId: 'COMPETENCY',
          learningBlockVersionId: 'LEARNING_BLOCK',
          rubricVersionId: 'RUBRIC',
          taskTemplateVersionId: 'TASK_TEMPLATE',
          sourceRecordVersionId: 'SOURCE_RECORD',
          methodVersionId: 'METHOD_VERSION',
        };
        for (const reference of references.references) {
          const kind = published.get(reference.id);
          if (!kind) errors.push(`UNPUBLISHED_REFERENCE:${reference.id}`);
          else if (expectedKinds[reference.key] && expectedKinds[reference.key] !== kind)
            errors.push(`INVALID_REFERENCE_KIND:${reference.key}`);
        }
      }
    }
    return { valid: errors.length === 0, errors };
  }

  async preview(id: string): Promise<CatalogVersionRecord | null> {
    const result = await this.pool.query<CatalogVersionRecord>(
      `SELECT id,kind,logical_id AS "logicalId",version,status,data_mode AS "dataMode",payload,
        source_url AS "sourceUrl",license,provenance,checked_at AS "checkedAt",
        expert_approval AS "expertApproval" FROM content_catalog_versions WHERE id=$1`,
      [id],
    );
    return result.rows[0] ?? null;
  }

  async publish(id: string): Promise<void> {
    const validation = await this.validate(id);
    if (!validation.valid)
      throw new Error(`Catalog record is not publishable: ${validation.errors.join(',')}`);
    const result = await this.pool.query(
      `UPDATE content_catalog_versions SET status='PUBLISHED',published_at=now()
       WHERE id=$1 AND status='DRAFT' AND expert_approval='APPROVED'`,
      [id],
    );
    if (result.rowCount !== 1) throw new Error('Only an approved draft can be published');
  }

  async archive(id: string): Promise<void> {
    const result = await this.pool.query(
      "UPDATE content_catalog_versions SET status='ARCHIVED',archived_at=now() WHERE id=$1 AND status='PUBLISHED'",
      [id],
    );
    if (result.rowCount !== 1) throw new Error('Only a published version can be archived');
  }
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

export function contentInfrastructureReady(input: {
  databaseAvailable: boolean;
  publishedRecordCount: number;
}): boolean {
  return input.databaseAvailable && input.publishedRecordCount > 0;
}
