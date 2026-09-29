import {
  ApplicationError,
  newUuid,
  type AuditEventId,
  type EventId,
  type GoalId,
  type OutboxId,
  type UserId,
} from '@vibework/shared';
import type { Pool, PoolClient } from 'pg';

const FORBIDDEN_PAYLOAD_KEY =
  /(answer|text|content|credential|token|secret|password|initdata|diagnostic)/i;
function assertSafeValue(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertSafeValue(item);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_PAYLOAD_KEY.test(key))
      throw new ApplicationError({
        code: 'UNSAFE_OUTBOX_PAYLOAD',
        message: 'Outbox payload contains sensitive data',
        statusCode: 422,
      });
    assertSafeValue(child);
  }
}

export function assertSafeNotificationPayload(payload: Record<string, unknown>): void {
  assertSafeValue(payload);
}

export async function recordGoalDecision(
  pool: Pool,
  input: {
    userId: UserId;
    actorType: 'USER' | 'SYSTEM';
    goalPayload: Record<string, unknown>;
    notificationPayload: Record<string, unknown>;
  },
): Promise<{ goalId: GoalId; eventId: EventId }> {
  const client = await pool.connect();
  const goalId = newUuid<GoalId>();
  const eventId = newUuid<EventId>();
  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO goals(id, user_id, payload) VALUES ($1, $2, $3)', [
      goalId,
      input.userId,
      input.goalPayload,
    ]);
    assertSafeNotificationPayload(input.notificationPayload);
    await client.query(
      `INSERT INTO decision_events(event_id, actor_type, actor_id, action, target_type, target_id, target_version) VALUES ($1, $2, $3, 'GOAL_CREATED', 'GOAL', $4, 1)`,
      [eventId, input.actorType, input.actorType === 'USER' ? input.userId : null, goalId],
    );
    await client.query(
      `INSERT INTO audit_events(id, event_id, actor_type, actor_id, action, target_type, target_id, target_version, result) VALUES ($1, $2, $3, $4, 'GOAL_CREATED', 'GOAL', $5, 1, 'SUCCEEDED')`,
      [
        newUuid<AuditEventId>(),
        eventId,
        input.actorType,
        input.actorType === 'USER' ? input.userId : null,
        goalId,
      ],
    );
    await client.query(
      `INSERT INTO notification_outbox(id, event_id, event_type, payload) VALUES ($1, $2, 'GOAL_CREATED', $3)`,
      [newUuid<OutboxId>(), eventId, input.notificationPayload],
    );
    await client.query('COMMIT');
    return { goalId, eventId };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export interface NotificationTransport {
  deliver(eventId: EventId, eventType: string, payload: Record<string, unknown>): Promise<void>;
}
interface ClaimedOutbox {
  id: OutboxId;
  eventId: EventId;
  eventType: string;
  payload: Record<string, unknown>;
  attempts: number;
}

async function claim(
  client: PoolClient,
  workerId: string,
  limit: number,
): Promise<ClaimedOutbox[]> {
  await client.query('BEGIN');
  try {
    const result = await client.query<{
      id: OutboxId;
      event_id: EventId;
      event_type: string;
      payload: Record<string, unknown>;
      attempts: number;
    }>(
      `WITH candidates AS (SELECT id FROM notification_outbox WHERE ((status IN ('PENDING', 'FAILED') AND available_at <= now()) OR (status = 'PROCESSING' AND locked_at < now() - interval '5 minutes')) ORDER BY available_at, created_at FOR UPDATE SKIP LOCKED LIMIT $1) UPDATE notification_outbox AS o SET status = 'PROCESSING', locked_at = now(), locked_by = $2, attempts = attempts + 1 FROM candidates WHERE o.id = candidates.id RETURNING o.id, o.event_id, o.event_type, o.payload, o.attempts`,
      [limit, workerId],
    );
    await client.query('COMMIT');
    return result.rows.map((row) => ({
      id: row.id,
      eventId: row.event_id,
      eventType: row.event_type,
      payload: row.payload,
      attempts: row.attempts,
    }));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

export async function dispatchOutboxBatch(
  pool: Pool,
  transport: NotificationTransport,
  workerId: string,
  options: { limit?: number; maxAttempts?: number } = {},
): Promise<number> {
  const client = await pool.connect();
  let rows: ClaimedOutbox[];
  try {
    rows = await claim(client, workerId, options.limit ?? 20);
  } finally {
    client.release();
  }
  for (const row of rows) {
    try {
      const preference = await notificationPreference(pool, row.payload);
      if (!preference.allowed) {
        if (preference.reason === 'QUIET_HOURS') {
          await pool.query(
            `UPDATE notification_outbox SET status='PENDING',available_at=now()+($2 * interval '1 second'),
               attempts=GREATEST(attempts-1,0),locked_at=NULL,locked_by=NULL,last_error_code='QUIET_HOURS'
             WHERE id=$1 AND status='PROCESSING'`,
            [row.id, preference.deferSeconds],
          );
          continue;
        }
        await pool.query(
          `UPDATE notification_outbox SET status='DELIVERED',delivered_at=now(),locked_at=NULL,
             locked_by=NULL,last_error_code=$2 WHERE id=$1 AND status='PROCESSING'`,
          [row.id, preference.reason],
        );
        continue;
      }
      await transport.deliver(row.eventId, row.eventType, row.payload);
      await pool.query(
        `UPDATE notification_outbox SET status = 'DELIVERED', delivered_at = now(), locked_at = NULL, locked_by = NULL, last_error_code = NULL WHERE id = $1 AND status = 'PROCESSING'`,
        [row.id],
      );
    } catch {
      const terminal = row.attempts >= (options.maxAttempts ?? 5);
      await pool.query(
        `UPDATE notification_outbox SET status = $2, available_at = now() + ($3 * interval '1 second'), locked_at = NULL, locked_by = NULL, last_error_code = 'DELIVERY_FAILED' WHERE id = $1 AND status = 'PROCESSING'`,
        [row.id, terminal ? 'DEAD' : 'FAILED', Math.min(300, 2 ** row.attempts)],
      );
    }
  }
  return rows.length;
}

async function notificationPreference(
  pool: Pool,
  payload: Record<string, unknown>,
  now = new Date(),
): Promise<
  | { allowed: true }
  | { allowed: false; reason: 'PREFERENCE_DISABLED' }
  | { allowed: false; reason: 'QUIET_HOURS'; deferSeconds: number }
> {
  const userId = payload.userId;
  if (typeof userId !== 'string' || !/^[a-f0-9-]{36}$/i.test(userId)) return { allowed: true };
  const result = await pool.query<{
    enabled: boolean;
    quiet_hours: { start?: string; end?: string; utcOffsetMinutes?: number };
  }>('SELECT enabled,quiet_hours FROM notification_preferences WHERE user_id=$1', [userId]);
  const row = result.rows[0];
  if (!row) return { allowed: true };
  if (!row.enabled) return { allowed: false, reason: 'PREFERENCE_DISABLED' };
  const { start, end, utcOffsetMinutes } = row.quiet_hours;
  if (!start || !end || !Number.isInteger(utcOffsetMinutes)) return { allowed: true };
  const minutes =
    (now.getUTCHours() * 60 + now.getUTCMinutes() + (utcOffsetMinutes ?? 0) + 1_440) % 1_440;
  const parse = (value: string) => {
    const match = /^(\d{2}):(\d{2})$/.exec(value);
    if (!match) return null;
    const hours = Number(match[1]);
    const minute = Number(match[2]);
    return hours < 24 && minute < 60 ? hours * 60 + minute : null;
  };
  const from = parse(start);
  const to = parse(end);
  if (from === null || to === null || from === to) return { allowed: true };
  const quiet = from < to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
  return quiet
    ? {
        allowed: false,
        reason: 'QUIET_HOURS',
        deferSeconds: ((to - minutes + 1_440) % 1_440 || 1_440) * 60,
      }
    : { allowed: true };
}

export class MemoryNotificationTransport implements NotificationTransport {
  readonly delivered = new Set<EventId>();
  sideEffects = 0;
  fail = false;
  deliver(eventId: EventId): Promise<void> {
    if (this.fail) return Promise.reject(new Error('mock unavailable'));
    if (this.delivered.has(eventId)) return Promise.resolve();
    this.delivered.add(eventId);
    this.sideEffects += 1;
    return Promise.resolve();
  }
}
export class DisabledNotificationTransport implements NotificationTransport {
  deliver(): Promise<void> {
    return Promise.reject(new Error('notification transport disabled'));
  }
}
