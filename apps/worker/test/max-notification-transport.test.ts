import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import type { EventId } from '@vibework/shared';
import { MaxNotificationTransport } from '../src/max-notification-transport.js';

describe('MAX notification transport', () => {
  it('resolves the recipient at delivery time and sends only an event-specific notice', async () => {
    const pool = {
      query: vi.fn(() => Promise.resolve({ rows: [{ encrypted_recipient: 'encrypted' }] })),
    } as unknown as Pool;
    const replies = { deliver: vi.fn(() => Promise.resolve()) };
    const transport = new MaxNotificationTransport(pool, replies);
    await transport.deliver('event-1' as EventId, 'ROUTE_PUBLISHED', {
      userId: '00000000-0000-4000-8000-000000000001',
      routeId: 'route-1',
    });
    expect(replies.deliver).toHaveBeenCalledWith({
      deliveryId: 'event-1',
      encryptedRecipient: 'encrypted',
      text: 'Ваш учебный маршрут готов. Откройте приложение, чтобы посмотреть следующий шаг.',
      buttons: [],
    });
  });
});
