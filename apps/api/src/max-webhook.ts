import { createHash, timingSafeEqual } from 'node:crypto';
import {
  ApplicationError,
  assertMaxIdentityEncryptionKey,
  encryptMaxRecipient,
} from '@vibework/shared';
import type { Pool } from 'pg';

/** Narrow provider representation; MAX names the event field `update_type`. */
export interface MaxUpdate {
  event_id?: string;
  update_id?: string | number;
  update_type?: string;
  type?: string;
  timestamp?: number;
  user_id?: string | number;
  chat_id?: string | number;
  text?: string;
  callback_id?: string;
  payload?: string;
  user?: { user_id?: string | number };
  message?: {
    id?: string | number;
    text?: string;
    body?: { mid?: string | number; text?: string };
    sender?: { user_id?: string | number };
  };
  callback?: { callback_id?: string; payload?: string; user?: { user_id?: string | number } };
}

export type MaxProviderEventIdField = 'event_id' | 'update_id' | 'event_specific';

export interface StoredMaxUpdate {
  eventId: string;
  /** True only when MAX supplied a durable ID rather than a local fingerprint. */
  hasProviderEventId: boolean;
  type: string;
  actorId: string;
  /** AES-GCM envelope; undefined only when MAX delivery is disabled. */
  encryptedRecipient?: string;
  text?: string;
  callback?: string;
  callbackId?: string;
}

export interface PersistedMaxWebhookEvent {
  inserted: boolean;
  /** A prior queue handoff failed and this delivery may safely try again. */
  needsQueue: boolean;
}

export interface MaxWebhookStore {
  persist(update: StoredMaxUpdate): Promise<PersistedMaxWebhookEvent>;
  markQueued(eventId: string): Promise<void>;
}

export interface MaxWebhookMetrics {
  observeLatencyMs(value: number): void;
  increment(name: 'accepted' | 'duplicate' | 'rejected' | 'queue_failed'): void;
}

export class NoopMaxWebhookMetrics implements MaxWebhookMetrics {
  observeLatencyMs(): void {
    /* intentionally disabled */
  }
  increment(): void {
    /* intentionally disabled */
  }
}

/** Explicit test/local metric sink; it never captures request payloads. */
export class MemoryMaxWebhookMetrics implements MaxWebhookMetrics {
  readonly latenciesMs: number[] = [];
  readonly counters = new Map<'accepted' | 'duplicate' | 'rejected' | 'queue_failed', number>();

  observeLatencyMs(value: number): void {
    this.latenciesMs.push(value);
  }

  increment(name: 'accepted' | 'duplicate' | 'rejected' | 'queue_failed'): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + 1);
  }
}

export function assertMaxWebhookConfiguration(input: {
  publicBaseUrl?: string;
  secret?: string;
  token?: string;
  identityEncryptionKey?: string;
  providerEventIdField?: string;
}): void {
  if (!input.token || !input.secret || !/^[A-Za-z0-9_-]{5,256}$/.test(input.secret)) {
    throw new ApplicationError({
      code: 'MAX_WEBHOOK_CONFIGURATION_INVALID',
      message: 'MAX webhook не настроен',
      statusCode: 503,
    });
  }
  let url: URL;
  try {
    url = new URL(input.publicBaseUrl ?? '');
  } catch {
    throw new ApplicationError({
      code: 'MAX_WEBHOOK_CONFIGURATION_INVALID',
      message: 'MAX webhook не настроен',
      statusCode: 503,
    });
  }
  if (url.protocol !== 'https:' || (url.port !== '' && url.port !== '443')) {
    throw new ApplicationError({
      code: 'MAX_WEBHOOK_CONFIGURATION_INVALID',
      message: 'MAX webhook не настроен',
      statusCode: 503,
    });
  }
  try {
    assertMaxIdentityEncryptionKey(input.identityEncryptionKey);
  } catch {
    throw new ApplicationError({
      code: 'MAX_WEBHOOK_CONFIGURATION_INVALID',
      message: 'MAX webhook не настроен',
      statusCode: 503,
    });
  }
  if (
    input.providerEventIdField !== 'event_id' &&
    input.providerEventIdField !== 'update_id' &&
    input.providerEventIdField !== 'event_specific'
  )
    throw new ApplicationError({
      code: 'MAX_PROVIDER_EVENT_ID_UNCONFIRMED',
      message: 'Поле идентификатора события MAX не подтверждено',
      statusCode: 503,
    });
}

function digestActor(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableFingerprint(parts: readonly (string | number | undefined)[]): string {
  return `derived:${createHash('sha256')
    .update(parts.map((part) => String(part ?? '')).join('\u0000'))
    .digest('hex')}`;
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function actorId(source: MaxUpdate): string | undefined {
  const value =
    source.user_id ??
    source.user?.user_id ??
    source.message?.sender?.user_id ??
    source.callback?.user?.user_id;
  return value === undefined ? undefined : String(value);
}

function messageId(source: MaxUpdate): string | number | undefined {
  return source.message?.body?.mid ?? source.message?.id;
}

/** Constant-time equality also for secrets of unequal length. */
export function verifyMaxWebhookSecret(
  actual: string | undefined,
  expected: string | undefined,
): boolean {
  if (!actual || !expected) return false;
  return timingSafeEqual(
    createHash('sha256').update(actual).digest(),
    createHash('sha256').update(expected).digest(),
  );
}

export function parseMaxUpdate(
  value: unknown,
  identityEncryptionKey?: string,
  providerEventIdField?: MaxProviderEventIdField,
): StoredMaxUpdate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApplicationError({
      code: 'INVALID_MAX_UPDATE',
      message: 'Повреждённое событие MAX',
      statusCode: 400,
    });
  }
  const source = value as MaxUpdate;
  const type = stringField(source.update_type) ?? stringField(source.type);
  const actor = actorId(source);
  const eventSpecificCallbackId =
    stringField(source.callback?.callback_id) ?? stringField(source.callback_id);
  const providerId = providerEventIdField
    ? providerEventIdField === 'event_id'
      ? stringField(source.event_id)
      : providerEventIdField === 'update_id'
        ? source.update_id === undefined
          ? undefined
          : String(source.update_id)
        : type === 'message_created' && messageId(source) !== undefined
          ? `message:${String(messageId(source))}`
          : type === 'message_callback' && eventSpecificCallbackId
            ? `callback:${eventSpecificCallbackId}`
            : undefined
    : (stringField(source.event_id) ??
      (source.update_id === undefined ? undefined : String(source.update_id)));
  // MAX sends message text and its durable mid inside message.body.
  const text =
    stringField(source.text) ??
    stringField(source.message?.body?.text) ??
    stringField(source.message?.text);
  const callback = stringField(source.payload) ?? stringField(source.callback?.payload);
  const callbackId = stringField(source.callback_id) ?? stringField(source.callback?.callback_id);
  if (
    !type ||
    !actor ||
    type.length > 100 ||
    (text !== undefined && text.length > 4_000) ||
    (callback !== undefined && callback.length > 512)
  ) {
    throw new ApplicationError({
      code: 'INVALID_MAX_UPDATE',
      message: 'Повреждённое событие MAX',
      statusCode: 400,
    });
  }
  const eventId =
    providerId ??
    stableFingerprint([
      type,
      source.timestamp,
      source.chat_id,
      actor,
      messageId(source),
      callbackId,
    ]);
  if (!/^(?:[A-Za-z0-9._:-]{1,200}|derived:[a-f0-9]{64})$/.test(eventId)) {
    throw new ApplicationError({
      code: 'INVALID_MAX_UPDATE',
      message: 'Повреждённое событие MAX',
      statusCode: 400,
    });
  }
  return {
    eventId,
    hasProviderEventId: providerId !== undefined,
    type,
    actorId: actor,
    ...(identityEncryptionKey === undefined
      ? {}
      : { encryptedRecipient: encryptMaxRecipient(actor, identityEncryptionKey) }),
    ...(text === undefined ? {} : { text }),
    ...(callback === undefined ? {} : { callback }),
    ...(callbackId === undefined ? {} : { callbackId }),
  };
}

export class MemoryMaxWebhookStore implements MaxWebhookStore {
  readonly events = new Map<string, StoredMaxUpdate>();
  private readonly queued = new Set<string>();

  persist(update: StoredMaxUpdate): Promise<PersistedMaxWebhookEvent> {
    const existing = this.events.has(update.eventId);
    if (!existing) this.events.set(update.eventId, update);
    return Promise.resolve({ inserted: !existing, needsQueue: !this.queued.has(update.eventId) });
  }

  markQueued(eventId: string): Promise<void> {
    this.queued.add(eventId);
    return Promise.resolve();
  }
}

export class PostgresMaxWebhookStore implements MaxWebhookStore {
  constructor(private readonly pool: Pool) {}

  async persist(update: StoredMaxUpdate): Promise<PersistedMaxWebhookEvent> {
    const payload: Record<string, unknown> = {
      ...(update.text === undefined ? {} : { text: update.text }),
      ...(update.callback === undefined ? {} : { callback: update.callback }),
      ...(update.callbackId === undefined ? {} : { callback_id: update.callbackId }),
    };
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query(
        `INSERT INTO max_webhook_events(event_id, actor_id_hash, event_type, payload, encrypted_recipient)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT(event_id) DO NOTHING`,
        [
          update.eventId,
          digestActor(update.actorId),
          update.type,
          payload,
          update.encryptedRecipient ?? null,
        ],
      );
      if (inserted.rowCount === 1) {
        await client.query(
          `INSERT INTO max_webhook_job_outbox(event_id, status) VALUES ($1, 'PENDING') ON CONFLICT(event_id) DO NOTHING`,
          [update.eventId],
        );
      }
      const pending = await client.query<{ status: string }>(
        `SELECT status FROM max_webhook_job_outbox WHERE event_id = $1 FOR UPDATE`,
        [update.eventId],
      );
      await client.query('COMMIT');
      return {
        inserted: inserted.rowCount === 1,
        needsQueue: pending.rows[0]?.status === 'PENDING',
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async markQueued(eventId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE max_webhook_events SET status = 'QUEUED' WHERE event_id = $1 AND status = 'RECEIVED'`,
        [eventId],
      );
      await client.query(
        `UPDATE max_webhook_job_outbox SET status = 'QUEUED', queued_at = now() WHERE event_id = $1 AND status = 'PENDING'`,
        [eventId],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
