import { describe, expect, it } from 'vitest';
import { MaxApiClient, MaxProviderError, MockMaxTransport } from '../src/max-client.js';

describe('MAX API client', () => {
  it('uses Authorization only and handles a successful send', async () => {
    const transport = new MockMaxTransport([
      { status: 200, headers: { 'x-request-id': 'provider-1' }, body: {} },
    ]);
    const client = new MaxApiClient('private-token', transport);
    await expect(client.sendMessage({ userId: 7, text: 'hello' })).resolves.toEqual({
      requestId: 'provider-1',
    });
    expect(transport.calls[0]?.headers.Authorization).toBe('private-token');
    expect(transport.calls[0]?.url).not.toContain('private-token');
    expect(transport.calls[0]?.url).toContain('platform-api2.max.ru/messages');
  });
  it('retries only safe operations for 429 and 503', async () => {
    const safe = new MockMaxTransport([
      { status: 429, headers: {}, body: {} },
      { status: 503, headers: {}, body: {} },
      { status: 200, headers: {}, body: {} },
    ]);
    await expect(
      new MaxApiClient('token', safe).editMessage({ messageId: '1', text: 'x' }),
    ).resolves.toBeDefined();
    expect(safe.calls).toHaveLength(3);
    const unsafe = new MockMaxTransport([{ status: 429, headers: {}, body: {} }]);
    await expect(
      new MaxApiClient('token', unsafe).sendMessage({ userId: 1, text: 'x' }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(unsafe.calls).toHaveLength(1);
  });
  it('normalizes timeout and malformed responses', async () => {
    const timed = new MockMaxTransport([new MaxProviderError('TIMEOUT', true)]);
    await expect(
      new MaxApiClient('token', timed).sendMessage({ userId: 1, text: 'x' }),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
    const malformed = new MockMaxTransport([{ status: 200, headers: {}, body: { no_url: true } }]);
    await expect(new MaxApiClient('token', malformed).createUpload('file')).rejects.toMatchObject({
      code: 'MALFORMED_RESPONSE',
    });
  });

  it('does not retry upload creation because upload URLs are single-use', async () => {
    const transport = new MockMaxTransport([{ status: 503, headers: {}, body: {} }]);
    await expect(new MaxApiClient('token', transport).createUpload('file')).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    });
    expect(transport.calls).toHaveLength(1);
  });
});
