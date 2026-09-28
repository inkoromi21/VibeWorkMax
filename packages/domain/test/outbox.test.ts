import { describe, expect, it } from 'vitest';

import { assertSafeNotificationPayload } from '../src/index.js';

describe('outbox payload privacy', () => {
  it('accepts allowlisted structural notification data', () => {
    expect(() =>
      assertSafeNotificationPayload({
        event_id: 'event-id',
        recipients: [{ channel: 'mock', enabled: true }],
      }),
    ).not.toThrow();
  });

  it('rejects sensitive fields nested inside arrays', () => {
    expect(() =>
      assertSafeNotificationPayload({
        recipients: [{ metadata: { raw_text: 'private user response' } }],
      }),
    ).toThrowError('Outbox payload contains sensitive data');
  });
});
