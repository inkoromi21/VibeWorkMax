import {
  BotService,
  PostgresBotRepository,
  type BotCommand,
  type BotReply,
  type BotTransition,
  type ConsentPolicy,
} from '@vibework/domain';
import { newUuid } from '@vibework/shared';
import type { Pool } from 'pg';

interface StoredEvent {
  event_id: string;
  event_type: string;
  payload: { text?: string; callback?: string };
  actor_id_hash: string;
}
interface StoredEventWithStatus extends StoredEvent {
  status: string;
}
export interface BotReplyTransport {
  deliver(input: {
    deliveryId: string;
    actorHash: string;
    text: string;
    buttons: { label: string; payload: string }[];
  }): Promise<void>;
}
/** Safe default while MAX credentials or legal policy are unavailable. */
export class DisabledBotReplyTransport implements BotReplyTransport {
  deliver(): Promise<void> {
    return Promise.resolve();
  }
}
export class MemoryBotReplyTransport implements BotReplyTransport {
  readonly sent: {
    deliveryId: string;
    actorHash: string;
    text: string;
    buttons: { label: string; payload: string }[];
  }[] = [];
  deliver(input: {
    deliveryId: string;
    actorHash: string;
    text: string;
    buttons: { label: string; payload: string }[];
  }): Promise<void> {
    if (!this.sent.some((item) => item.deliveryId === input.deliveryId)) this.sent.push(input);
    return Promise.resolve();
  }
}
export async function processMaxUpdate(
  pool: Pool,
  eventId: string,
  transport: BotReplyTransport,
  policy: ConsentPolicy,
): Promise<BotTransition | null> {
  const client = await pool.connect();
  let row: StoredEventWithStatus | undefined;
  try {
    await client.query('BEGIN');
    const event = await client.query<StoredEventWithStatus>(
      `SELECT event_id, event_type, payload, actor_id_hash, status FROM max_webhook_events WHERE event_id = $1 FOR UPDATE`,
      [eventId],
    );
    row = event.rows[0];
    if (!row || row.status === 'PROCESSED') {
      await client.query('COMMIT');
      return null;
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  // The processor receives no original platform identifier: storage retains only its hash.
  const command: BotCommand =
    row.event_type === 'bot_started'
      ? { eventId: row.event_id, actorId: row.actor_id_hash, kind: 'START' }
      : row.event_type === 'message_callback'
        ? {
            eventId: row.event_id,
            actorId: row.actor_id_hash,
            kind: 'CALLBACK',
            ...(row.payload.callback === undefined ? {} : { callback: row.payload.callback }),
          }
        : {
            eventId: row.event_id,
            actorId: row.actor_id_hash,
            kind: 'MESSAGE',
            ...(row.payload.text === undefined ? {} : { text: row.payload.text }),
          };
  const transition = await new BotService(
    new PostgresBotRepository(pool),
    policy,
    process.env.MAX_MINI_APP_URL,
  ).handle(command);
  await persistEffects(pool, row, transition);
  await dispatchReplies(pool, row.actor_id_hash, eventId, transport);
  await pool.query(
    `UPDATE max_webhook_events SET status = 'PROCESSED', processed_at = now() WHERE event_id = $1 AND status <> 'PROCESSED'`,
    [eventId],
  );
  return { replies: [], jobs: await pendingJobs(pool, eventId) };
}

async function persistEffects(
  pool: Pool,
  event: StoredEventWithStatus,
  transition: BotTransition,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [ordinal, item] of transition.replies.entries()) {
      await client.query(
        `INSERT INTO bot_reply_outbox(id, event_id, ordinal, actor_id_hash, message)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT(event_id, ordinal) DO NOTHING`,
        [newUuid(), event.event_id, ordinal, event.actor_id_hash, safeReply(item)],
      );
    }
    for (const job of transition.jobs) {
      if (job.type !== 'course.build' && job.type !== 'attempt.grade') continue;
      await client.query(
        `INSERT INTO bot_transition_job_outbox(event_id, job_type, job_key) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [event.event_id, job.type, job.key],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function safeReply(item: BotReply): {
  text: string;
  buttons: { label: string; payload: string }[];
} {
  return { text: item.text, buttons: item.buttons ?? [] };
}

async function dispatchReplies(
  pool: Pool,
  actorHash: string,
  eventId: string,
  transport: BotReplyTransport,
): Promise<void> {
  const result = await pool.query<{
    id: string;
    message: { text: string; buttons?: { label: string; payload: string }[] };
  }>(
    `SELECT id, message FROM bot_reply_outbox WHERE event_id = $1 AND status = 'PENDING' ORDER BY ordinal`,
    [eventId],
  );
  for (const row of result.rows) {
    await transport.deliver({
      deliveryId: row.id,
      actorHash,
      text: row.message.text,
      buttons: row.message.buttons ?? [],
    });
    await pool.query(
      `UPDATE bot_reply_outbox SET status = 'DELIVERED', delivered_at = now() WHERE id = $1 AND status = 'PENDING'`,
      [row.id],
    );
  }
}

async function pendingJobs(pool: Pool, eventId: string): Promise<BotTransition['jobs']> {
  const result = await pool.query<{ job_type: 'course.build' | 'attempt.grade'; job_key: string }>(
    `SELECT job_type, job_key FROM bot_transition_job_outbox WHERE event_id = $1 ORDER BY job_type`,
    [eventId],
  );
  return result.rows.map((row) => ({ type: row.job_type, key: row.job_key }));
}

/** Deterministic demo review; it intentionally does not infer a correct answer. */
export async function gradeAttempt(pool: Pool, reference: string): Promise<void> {
  if (!reference.startsWith('attempt:')) return;
  const attemptId = reference.slice('attempt:'.length);
  const attempt = await pool.query<{ id: string; rubric_version: string }>(
    `SELECT id, rubric_version FROM bot_attempts WHERE id = $1 FOR UPDATE`,
    [attemptId],
  );
  const row = attempt.rows[0];
  if (!row) return;
  await pool.query(
    `INSERT INTO bot_reviews(id, attempt_id, rubric_version, status, summary)
     VALUES ($1,$2,$3,'READY',$4) ON CONFLICT(attempt_id) DO NOTHING`,
    [
      newUuid(),
      row.id,
      row.rubric_version,
      'Попытка сохранена. Следующий шаг: сравнить ход решения с критерием версии рубрики.',
    ],
  );
  await pool.query(
    `UPDATE bot_attempts SET status = 'GRADED' WHERE id = $1 AND status = 'QUEUED'`,
    [row.id],
  );
}
