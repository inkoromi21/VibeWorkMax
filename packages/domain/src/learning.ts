import { newUuid } from '@vibework/shared';
import type { Pool } from 'pg';
import type { TemplateOperationResult } from './ai-operations.js';
import { actorDigest } from './bot.js';

/** Builds a minimal immutable candidate and publishes it in one transaction. */
export class PostgresLearningRepository {
  constructor(private readonly pool: Pool) {}

  async buildAndPublishForActor(
    actorId: string,
    lesson?: TemplateOperationResult,
  ): Promise<{ routeId: string; version: number }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const context = await client.query<{
        user_id: string;
        goal_id: string;
        goal_version: number;
        goal_payload: Record<string, unknown>;
        result_id: string;
        result_payload: Record<string, unknown>;
      }>(
        `SELECT i.user_id,g.id AS goal_id,g.version AS goal_version,g.payload AS goal_payload,
                r.id AS result_id,r.payload AS result_payload
         FROM max_user_identities i
         JOIN LATERAL (SELECT * FROM goals WHERE user_id=i.user_id ORDER BY version DESC LIMIT 1) g ON true
         JOIN LATERAL (
           SELECT dr.* FROM diagnostic_results dr
           JOIN diagnostic_sessions ds ON ds.id=dr.session_id
           WHERE ds.user_id=i.user_id ORDER BY dr.created_at DESC LIMIT 1
         ) r ON true
         WHERE i.actor_id_hash=$1 FOR UPDATE OF i`,
        [actorDigest(actorId)],
      );
      const row = context.rows[0];
      if (!row) throw new Error('Published diagnostic result and goal are required');
      const existing = await client.query<{ id: string; version: number }>(
        `SELECT id,version FROM learning_routes
         WHERE user_id=$1 AND goal_id=$2 AND diagnostic_result_id=$3 AND status='ACTIVE'
         ORDER BY version DESC LIMIT 1`,
        [row.user_id, row.goal_id, row.result_id],
      );
      if (existing.rows[0]) {
        await client.query('COMMIT');
        return { routeId: existing.rows[0].id, version: existing.rows[0].version };
      }
      const catalog = await client.query<{
        id: string;
        kind: 'LEARNING_BLOCK' | 'METHOD_VERSION';
        logical_id: string;
        version: number;
      }>(
        `SELECT id,kind,logical_id,version FROM content_catalog_versions
         WHERE status='PUBLISHED' AND
           ((kind='LEARNING_BLOCK' AND logical_id='demo-learning-block') OR
            (kind='METHOD_VERSION' AND logical_id='course-builder'))
         ORDER BY version DESC`,
      );
      const learningBlock = catalog.rows.find((item) => item.kind === 'LEARNING_BLOCK');
      const method = catalog.rows.find((item) => item.kind === 'METHOD_VERSION');
      if (!learningBlock || !method) throw new Error('Published demo catalog is incomplete');
      const nextVersionResult = await client.query<{ version: number }>(
        'SELECT COALESCE(MAX(version),0)+1 AS version FROM learning_routes WHERE user_id=$1',
        [row.user_id],
      );
      const version = nextVersionResult.rows[0]?.version ?? 1;
      const routeId = newUuid();
      const lessonTitle = typeof lesson?.value.title === 'string' ? lesson.value.title : null;
      const lessonSteps = Array.isArray(lesson?.value.steps)
        ? lesson.value.steps.filter((step): step is string => typeof step === 'string')
        : [];
      const payload = {
        schemaVersion: 'learning-route-v1',
        contentMode: 'DEMO_SYNTHETIC',
        inputs: {
          diagnosticResultId: row.result_id,
          goalId: row.goal_id,
          goalVersion: row.goal_version,
          catalogVersion: 'demo-content-catalog-v1',
          methodVersionId: method.id,
          methodVersion: method.version,
        },
        steps: [
          {
            id: 'demo-first-step-v1',
            learningBlockVersionId: learningBlock.id,
            title: lessonTitle ?? 'Разобрать основу',
            reason: 'Первый короткий проверяемый шаг выбран из опубликованного demo-каталога.',
            durationMinutes: 15,
            ...(lesson
              ? {
                  lesson: {
                    steps: lessonSteps,
                    referenceIds: lesson.value.referenceIds,
                    urls: lesson.value.urls,
                    provenance: lesson.provenance,
                    usedFallback: lesson.usedFallback,
                    ...(lesson.fallbackReason ? { fallbackReason: lesson.fallbackReason } : {}),
                  },
                }
              : {}),
          },
        ],
      };
      await client.query(
        `INSERT INTO learning_routes(id,user_id,diagnostic_result_id,goal_id,version,status,payload)
         VALUES ($1,$2,$3,$4,$5,'CANDIDATE',$6)`,
        [routeId, row.user_id, row.result_id, row.goal_id, version, payload],
      );
      await client.query(
        `UPDATE learning_routes SET status='SUPERSEDED'
         WHERE user_id=$1 AND status='ACTIVE'`,
        [row.user_id],
      );
      await client.query(
        `UPDATE learning_routes SET status='ACTIVE',published_at=now()
         WHERE id=$1 AND status='CANDIDATE'`,
        [routeId],
      );
      await client.query(
        `INSERT INTO learning_positions(user_id,route_id,step_id,position,revision)
         VALUES ($1,$2,'demo-first-step-v1',0,1)
         ON CONFLICT(user_id) DO UPDATE SET route_id=EXCLUDED.route_id,
           step_id=EXCLUDED.step_id,position=0,revision=learning_positions.revision+1,updated_at=now()`,
        [row.user_id, routeId],
      );
      const eventId = newUuid();
      await client.query(
        `INSERT INTO decision_events(event_id,actor_type,action,target_type,target_id,target_version,metadata)
         VALUES ($1,'SYSTEM','ROUTE_PUBLISHED','LEARNING_ROUTE',$2,$3,$4)`,
        [eventId, routeId, version, { goalId: row.goal_id, diagnosticResultId: row.result_id }],
      );
      await client.query(
        `INSERT INTO audit_events(id,event_id,actor_type,action,target_type,target_id,target_version,result,metadata)
         VALUES ($1,$2,'SYSTEM','ROUTE_PUBLISHED','LEARNING_ROUTE',$3,$4,'SUCCEEDED',$5)`,
        [newUuid(), eventId, routeId, version, { contentMode: 'DEMO_SYNTHETIC' }],
      );
      await client.query(
        `INSERT INTO notification_outbox(id,event_id,event_type,payload)
         VALUES ($1,$2,'ROUTE_PUBLISHED',$3)`,
        [newUuid(), eventId, { userId: row.user_id, routeId, routeVersion: version }],
      );
      await client.query('COMMIT');
      return { routeId, version };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
