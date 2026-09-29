import {
  BotService,
  PostgresBotRepository,
  type BotCommand,
  type BotReply,
  type BotTransition,
  type ConsentPolicy,
  type TemplateOperationResult,
} from '@vibework/domain';
import { newUuid } from '@vibework/shared';
import type { Pool, PoolClient } from 'pg';

interface StoredEvent {
  event_id: string;
  event_type: string;
  payload: { text?: string; callback?: string; callback_id?: string };
  actor_id_hash: string;
  encrypted_recipient: string | null;
}
interface StoredEventWithStatus extends StoredEvent {
  status: string;
}
export interface BotReplyTransport {
  deliver(input: {
    deliveryId: string;
    encryptedRecipient: string;
    text: string;
    buttons: { label: string; payload: string }[];
    miniApp?: { label: string; url: string };
  }): Promise<void>;
  acknowledgeCallback?(callbackId: string): Promise<void>;
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
    encryptedRecipient: string;
    text: string;
    buttons: { label: string; payload: string }[];
    miniApp?: { label: string; url: string };
  }[] = [];
  deliver(input: {
    deliveryId: string;
    encryptedRecipient: string;
    text: string;
    buttons: { label: string; payload: string }[];
    miniApp?: { label: string; url: string };
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
  let committed = false;
  try {
    await client.query('BEGIN');
    const event = await client.query<StoredEventWithStatus>(
      `SELECT event_id, event_type, payload, actor_id_hash, encrypted_recipient, status FROM max_webhook_events WHERE event_id = $1 FOR UPDATE`,
      [eventId],
    );
    row = event.rows[0];
    if (!row) {
      await client.query('COMMIT');
      committed = true;
      client.release();
      return null;
    }
    if (row.status === 'PROCESSED') {
      await client.query('COMMIT');
      committed = true;
      client.release();
      // The state transition and both outboxes were committed together. If the
      // worker crashed while publishing child jobs, the parent retry must replay
      // the durable job outbox. BullMQ job ids make this replay idempotent.
      return { replies: [], jobs: await pendingJobs(pool, eventId) };
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
      new PostgresBotRepository(pool, client),
      policy,
      process.env.MAX_MINI_APP_URL,
    ).handle(command);
    await persistEffects(pool, row, transition, client);
    await client.query('COMMIT');
    committed = true;
    client.release();
    await dispatchReplies(pool, row.encrypted_recipient, eventId, transport);
    // Acknowledging the pressed inline button only affects MAX's transient UI.
    // It must never prevent the durable next step from reaching the user.
    if (row.payload.callback_id && transport.acknowledgeCallback) {
      try {
        await transport.acknowledgeCallback(row.payload.callback_id);
      } catch {
        // The reply is already delivered and the callback expires quickly, so a
        // retry here can duplicate a provider-side notification. Keep processing.
      }
    }
    await pool.query(
      `UPDATE max_webhook_events SET status = 'PROCESSED', processed_at = now() WHERE event_id = $1 AND status <> 'PROCESSED'`,
      [eventId],
    );
    return { replies: [], jobs: await pendingJobs(pool, eventId) };
  } catch (error) {
    if (!committed) {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
    throw error;
  }
}

async function persistEffects(
  pool: Pool,
  event: StoredEventWithStatus,
  transition: BotTransition,
  transactionClient?: PoolClient,
): Promise<void> {
  const client = transactionClient ?? (await pool.connect());
  const ownsTransaction = transactionClient === undefined;
  try {
    if (ownsTransaction) await client.query('BEGIN');
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
    if (ownsTransaction) await client.query('COMMIT');
  } catch (error) {
    if (ownsTransaction) await client.query('ROLLBACK');
    throw error;
  } finally {
    if (ownsTransaction) client.release();
  }
}

function safeReply(item: BotReply): {
  text: string;
  buttons: { label: string; payload: string }[];
  miniApp?: { label: string; url: string };
} {
  return {
    text: item.text,
    buttons: item.buttons ?? [],
    ...(item.miniApp === undefined ? {} : { miniApp: item.miniApp }),
  };
}

async function dispatchReplies(
  pool: Pool,
  encryptedRecipient: string | null,
  eventId: string,
  transport: BotReplyTransport,
): Promise<void> {
  const result = await pool.query<{
    id: string;
    message: {
      text: string;
      buttons?: { label: string; payload: string }[];
      miniApp?: { label: string; url: string };
    };
  }>(
    `SELECT id, message FROM bot_reply_outbox
     WHERE event_id = $1 AND (status = 'PENDING' OR (status = 'SENDING' AND claimed_at < now() - interval '5 minutes'))
     ORDER BY ordinal`,
    [eventId],
  );
  for (const row of result.rows) {
    const claimed = await pool.query(
      `UPDATE bot_reply_outbox
       SET status = 'SENDING', claimed_at = now(), delivery_attempts = delivery_attempts + 1, last_error_code = NULL
       WHERE id = $1 AND (status = 'PENDING' OR (status = 'SENDING' AND claimed_at < now() - interval '5 minutes'))
       RETURNING id`,
      [row.id],
    );
    if (claimed.rowCount !== 1) continue;
    if (!encryptedRecipient) {
      await pool.query(
        `UPDATE bot_reply_outbox SET status = 'PENDING', claimed_at = NULL, last_error_code = 'RECIPIENT_UNAVAILABLE' WHERE id = $1`,
        [row.id],
      );
      throw new Error('MAX_RECIPIENT_UNAVAILABLE');
    }
    try {
      await transport.deliver({
        deliveryId: row.id,
        encryptedRecipient,
        text: row.message.text,
        buttons: row.message.buttons ?? [],
        ...(row.message.miniApp === undefined ? {} : { miniApp: row.message.miniApp }),
      });
      await pool.query(
        `UPDATE bot_reply_outbox SET status = 'DELIVERED', delivered_at = now(), claimed_at = NULL WHERE id = $1 AND status = 'SENDING'`,
        [row.id],
      );
    } catch (error) {
      await pool.query(
        `UPDATE bot_reply_outbox SET status = 'PENDING', claimed_at = NULL, last_error_code = $2 WHERE id = $1 AND status = 'SENDING'`,
        [row.id, error instanceof Error ? error.name.slice(0, 100) : 'MAX_DELIVERY_FAILED'],
      );
      throw error;
    }
  }
}

/** Replays replies committed before a worker crash, independently of BullMQ retries. */
export async function dispatchPendingBotReplies(
  pool: Pool,
  transport: BotReplyTransport,
): Promise<number> {
  const events = await pool.query<{ event_id: string; encrypted_recipient: string | null }>(
    `SELECT DISTINCT e.event_id,e.encrypted_recipient
     FROM bot_reply_outbox r JOIN max_webhook_events e ON e.event_id=r.event_id
     WHERE r.status='PENDING' OR (r.status='SENDING' AND r.claimed_at<now()-interval '5 minutes')
     ORDER BY e.event_id LIMIT 50`,
  );
  for (const event of events.rows) {
    await dispatchReplies(pool, event.encrypted_recipient, event.event_id, transport);
    await pool.query(
      `UPDATE max_webhook_events SET status='PROCESSED',processed_at=COALESCE(processed_at,now())
       WHERE event_id=$1 AND EXISTS(SELECT 1 FROM bot_processed_events WHERE event_id=$1)
         AND NOT EXISTS(SELECT 1 FROM bot_reply_outbox WHERE event_id=$1 AND status<>'DELIVERED')`,
      [event.event_id],
    );
  }
  return events.rowCount ?? 0;
}

async function pendingJobs(pool: Pool, eventId: string): Promise<BotTransition['jobs']> {
  const result = await pool.query<{ job_type: 'course.build' | 'attempt.grade'; job_key: string }>(
    `SELECT job_type, job_key FROM bot_transition_job_outbox WHERE event_id = $1 ORDER BY job_type`,
    [eventId],
  );
  return result.rows.map((row) => ({ type: row.job_type, key: row.job_key }));
}

/** Publishes an immutable review version for an owned canonical attempt. */
export async function gradeAttempt(
  pool: Pool,
  reference: string,
  feedback?: TemplateOperationResult,
): Promise<void> {
  if (!reference.startsWith('attempt:')) return;
  const attemptId = reference.slice('attempt:'.length);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const attempt = await client.query<{
      id: string;
      rubric_version: string;
      rubric_payload: { criteria?: { id?: string }[] };
    }>(
      `SELECT a.id,a.rubric_version,c.payload AS rubric_payload
       FROM attempts a JOIN content_catalog_versions c ON c.id::text=a.rubric_version
       WHERE a.id=$1 FOR UPDATE OF a`,
      [attemptId],
    );
    const row = attempt.rows[0];
    if (!row) {
      await client.query('COMMIT');
      return;
    }
    const existing = await client.query<{ version: number; status: string }>(
      `SELECT version,status FROM review_versions WHERE attempt_id=$1 ORDER BY version DESC LIMIT 1`,
      [row.id],
    );
    if (existing.rows[0]?.status === 'READY') {
      await client.query('COMMIT');
      return;
    }
    const summary =
      typeof feedback?.value.feedback === 'string'
        ? feedback.value.feedback
        : 'Попытка сохранена. Следующий шаг: сравнить ход решения с критерием версии рубрики.';
    await client.query(
      `INSERT INTO review_versions(id,attempt_id,version,rubric_version,status,payload)
       VALUES ($1,$2,$3,$4,'READY',$5)`,
      [
        newUuid(),
        row.id,
        (existing.rows[0]?.version ?? 0) + 1,
        row.rubric_version,
        {
          summary,
          feedback: summary,
          criterionResults: (row.rubric_payload.criteria ?? []).map((criterion) => ({
            criterionId: criterion.id,
            status: criterion.id === 'response-present' ? 'OBSERVED' : 'NOT_ASSESSED',
            note:
              criterion.id === 'response-present'
                ? 'Отправлен непустой ответ; правильность решения этим критерием не установлена.'
                : 'Недостаточно проверяемых данных для оценки критерия.',
          })),
          ...(typeof feedback?.value.nextStep === 'string'
            ? { nextStep: feedback.value.nextStep }
            : {}),
          ...(feedback
            ? {
                ai: {
                  provenance: feedback.provenance,
                  usedFallback: feedback.usedFallback,
                  ...(feedback.fallbackReason ? { fallbackReason: feedback.fallbackReason } : {}),
                },
              }
            : {}),
        },
      ],
    );
    await client.query(
      `INSERT INTO bot_reviews(id, attempt_id, rubric_version, status, summary)
       SELECT $1,$2,$3,'READY',$4 FROM bot_attempts WHERE id=$2
       ON CONFLICT(attempt_id) DO NOTHING`,
      [newUuid(), row.id, row.rubric_version, summary.slice(0, 1_000)],
    );
    await client.query(
      `UPDATE bot_attempts SET status = 'GRADED' WHERE id = $1 AND status = 'QUEUED'`,
      [row.id],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
