import type { NotificationTransport } from '@vibework/domain';
import type { EventId } from '@vibework/shared';
import type { Pool } from 'pg';
import type { BotReplyTransport } from './max-bot.js';

/** Resolves the recipient only at delivery time, after notification preferences are checked. */
export class MaxNotificationTransport implements NotificationTransport {
  constructor(
    private readonly pool: Pool,
    private readonly replies: BotReplyTransport,
  ) {}

  async deliver(
    eventId: EventId,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (typeof payload.userId !== 'string') throw new Error('NOTIFICATION_USER_UNAVAILABLE');
    const result = await this.pool.query<{ encrypted_recipient: string | null }>(
      `SELECT encrypted_recipient FROM max_user_identities
       WHERE user_id=$1 AND encrypted_recipient IS NOT NULL
       ORDER BY created_at DESC LIMIT 1`,
      [payload.userId],
    );
    const recipient = result.rows[0]?.encrypted_recipient;
    if (!recipient) throw new Error('NOTIFICATION_RECIPIENT_UNAVAILABLE');
    const text =
      eventType === 'ROUTE_PUBLISHED'
        ? 'Ваш учебный маршрут готов. Откройте приложение, чтобы посмотреть следующий шаг.'
        : eventType === 'GOAL_CREATED'
          ? 'Ваша цель сохранена. Следующий шаг появится после подготовки маршрута.'
          : null;
    if (!text) throw new Error('UNSUPPORTED_NOTIFICATION_TYPE');
    await this.replies.deliver({
      deliveryId: eventId,
      encryptedRecipient: recipient,
      text,
      buttons: [],
    });
  }
}
