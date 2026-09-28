import type { Redis } from 'ioredis';

const MAX_API_BASE = 'https://platform-api2.max.ru';

export interface MaxTransportResponse {
  status: number;
  headers: Record<string, string | undefined>;
  body: unknown;
}
export interface MaxTransport {
  request(input: {
    method: 'POST' | 'PUT';
    url: string;
    headers: Record<string, string>;
    body?: unknown;
    timeoutMs: number;
  }): Promise<MaxTransportResponse>;
}

/** Shared deployments can provide a Redis implementation; tests use memory. */
export interface MaxRateLimiter {
  wait(destination: string): Promise<void>;
}

/** Keeps a deliberate margin below MAX's 30 rps global limit and 2 rps/chat. */
export class MemoryMaxRateLimiter implements MaxRateLimiter {
  private nextGlobalAt = 0;
  private readonly nextDestinationAt = new Map<string, number>();

  async wait(destination: string): Promise<void> {
    const now = Date.now();
    const scheduled = Math.max(
      now,
      this.nextGlobalAt,
      this.nextDestinationAt.get(destination) ?? 0,
    );
    this.nextGlobalAt = scheduled + Math.ceil(1_000 / 29);
    this.nextDestinationAt.set(destination, scheduled + 500);
    if (scheduled > now) await new Promise((resolve) => setTimeout(resolve, scheduled - now));
  }
}

/** Redis window limiter shared by API and worker processes in enabled mode. */
export class RedisMaxRateLimiter implements MaxRateLimiter {
  constructor(
    private readonly redis: Pick<Redis, 'eval'>,
    private readonly prefix = 'max:rate',
  ) {}

  async wait(destination: string): Promise<void> {
    for (;;) {
      const bucket = Math.floor(Date.now() / 1_000);
      const globalKey = `${this.prefix}:global:${String(bucket)}`;
      const destinationKey = `${this.prefix}:destination:${createHashKey(destination)}:${String(bucket)}`;
      const result = (await this.redis.eval(
        `local g = redis.call('INCR', KEYS[1]); if g == 1 then redis.call('PEXPIRE', KEYS[1], 1100) end
         local d = redis.call('INCR', KEYS[2]); if d == 1 then redis.call('PEXPIRE', KEYS[2], 1100) end
         return {g, d}`,
        2,
        globalKey,
        destinationKey,
      )) as [number, number];
      if (result[0] <= 29 && result[1] <= 2) return;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(1, 1_000 - (Date.now() % 1_000))),
      );
    }
  }
}

function createHashKey(value: string): string {
  // Destinations are identifiers, but never expose them in Redis key listings.
  let hash = 0;
  for (let index = 0; index < value.length; index += 1)
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  return (hash >>> 0).toString(36);
}
export class MaxProviderError extends Error {
  constructor(
    readonly code:
      | 'TIMEOUT'
      | 'RATE_LIMITED'
      | 'UNAVAILABLE'
      | 'MALFORMED_RESPONSE'
      | 'REJECTED'
      | 'CIRCUIT_OPEN',
    readonly retryable: boolean,
    readonly requestId?: string,
  ) {
    super(code);
    this.name = 'MaxProviderError';
  }
}

export class FetchMaxTransport implements MaxTransport {
  async request(input: {
    method: 'POST' | 'PUT';
    url: string;
    headers: Record<string, string>;
    body?: unknown;
    timeoutMs: number;
  }): Promise<MaxTransportResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), input.timeoutMs);
    try {
      const response = await fetch(input.url, {
        method: input.method,
        headers: input.headers,
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
        signal: controller.signal,
      });
      const contentType = response.headers.get('content-type') ?? '';
      const body: unknown = contentType.includes('application/json')
        ? await response.json().catch(() => null)
        : null;
      return {
        status: response.status,
        headers: { 'x-request-id': response.headers.get('x-request-id') ?? undefined },
        body,
      };
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError')
        throw new MaxProviderError('TIMEOUT', true);
      throw new MaxProviderError('UNAVAILABLE', true);
    } finally {
      clearTimeout(timer);
    }
  }
}

interface Circuit {
  failures: number;
  openUntil: number;
}
export class MaxApiClient {
  private readonly circuit: Circuit = { failures: 0, openUntil: 0 };
  constructor(
    private readonly token: string,
    private readonly transport: MaxTransport = new FetchMaxTransport(),
    private readonly timeoutMs = 5_000,
    private readonly limiter: MaxRateLimiter = new MemoryMaxRateLimiter(),
  ) {}

  async sendMessage(input: {
    userId?: number | string;
    chatId?: number;
    text: string;
    attachments?: unknown[];
  }): Promise<{ requestId?: string }> {
    if ((input.userId === undefined) === (input.chatId === undefined))
      throw new MaxProviderError('REJECTED', false);
    const target =
      input.userId === undefined ? `chat:${String(input.chatId)}` : `user:${String(input.userId)}`;
    const result = await this.call(
      '/messages',
      'POST',
      input.userId === undefined ? { chat_id: input.chatId ?? 0 } : { user_id: input.userId ?? 0 },
      { text: input.text, ...(input.attachments ? { attachments: input.attachments } : {}) },
      false,
      target,
    );
    return result.requestId === undefined ? {} : { requestId: result.requestId };
  }
  async editMessage(input: {
    messageId: string;
    text: string;
    attachments?: unknown[];
  }): Promise<{ requestId?: string }> {
    const result = await this.call(
      '/messages',
      'PUT',
      { message_id: input.messageId },
      { text: input.text, ...(input.attachments ? { attachments: input.attachments } : {}) },
      true,
      `message:${input.messageId}`,
    );
    return result.requestId === undefined ? {} : { requestId: result.requestId };
  }
  async answerCallback(input: {
    callbackId: string;
    message?: { text: string };
  }): Promise<{ requestId?: string }> {
    const result = await this.call(
      '/answers',
      'POST',
      { callback_id: input.callbackId },
      input.message ? { message: input.message } : {},
      false,
      `callback:${input.callbackId}`,
    );
    return result.requestId === undefined ? {} : { requestId: result.requestId };
  }
  async createUpload(
    type: 'image' | 'video' | 'audio' | 'file',
  ): Promise<{ requestId?: string; url: string }> {
    // Upload URLs are single-use resources, so retrying creation can orphan one.
    const result = await this.call(
      '/uploads',
      'POST',
      { type },
      undefined,
      false,
      `upload:${type}`,
    );
    if (
      !result.body ||
      typeof result.body !== 'object' ||
      typeof (result.body as { url?: unknown }).url !== 'string'
    )
      throw new MaxProviderError('MALFORMED_RESPONSE', false, result.requestId);
    return {
      ...(result.requestId === undefined ? {} : { requestId: result.requestId }),
      url: (result.body as { url: string }).url,
    };
  }

  private async call(
    path: string,
    method: 'POST' | 'PUT',
    query: Record<string, string | number>,
    body: unknown,
    safeRetry: boolean,
    destination: string,
  ): Promise<{ requestId?: string; body: unknown }> {
    if (Date.now() < this.circuit.openUntil) throw new MaxProviderError('CIRCUIT_OPEN', true);
    const url = new URL(path, MAX_API_BASE);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
    // The token exists only in this header and is never copied to a URL, error or log object.
    const headers = { Authorization: this.token, 'Content-Type': 'application/json' };
    const attempts = safeRetry ? 3 : 1;
    let last: MaxProviderError | undefined;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      await this.limiter.wait(destination);
      try {
        const response = await this.transport.request({
          method,
          url: url.toString(),
          headers,
          ...(body === undefined ? {} : { body }),
          timeoutMs: this.timeoutMs,
        });
        const requestId = response.headers['x-request-id'];
        if (response.status >= 200 && response.status < 300) {
          this.circuit.failures = 0;
          return { ...(requestId === undefined ? {} : { requestId }), body: response.body };
        }
        const error =
          response.status === 429
            ? new MaxProviderError('RATE_LIMITED', true, requestId)
            : response.status === 503
              ? new MaxProviderError('UNAVAILABLE', true, requestId)
              : new MaxProviderError('REJECTED', false, requestId);
        if (!error.retryable || !safeRetry || attempt === attempts - 1) throw error;
        last = error;
      } catch (error) {
        const normalized =
          error instanceof MaxProviderError ? error : new MaxProviderError('UNAVAILABLE', true);
        if (!normalized.retryable || !safeRetry || attempt === attempts - 1) {
          this.recordFailure(normalized);
          throw normalized;
        }
        last = normalized;
      }
      await new Promise((resolve) => setTimeout(resolve, 50 * 2 ** attempt));
    }
    throw last ?? new MaxProviderError('UNAVAILABLE', true);
  }
  private recordFailure(error: MaxProviderError): void {
    if (error.code === 'REJECTED' || error.code === 'MALFORMED_RESPONSE') return;
    this.circuit.failures += 1;
    if (this.circuit.failures >= 3) this.circuit.openUntil = Date.now() + 1_000;
  }
}

/** Scriptable transport for tests and disabled development mode. */
export class MockMaxTransport implements MaxTransport {
  readonly calls: { method: string; url: string; headers: Record<string, string> }[] = [];
  constructor(private readonly responses: (MaxTransportResponse | Error)[]) {}
  request(input: {
    method: 'POST' | 'PUT';
    url: string;
    headers: Record<string, string>;
  }): Promise<MaxTransportResponse> {
    this.calls.push(input);
    const next = this.responses.shift();
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next ?? { status: 200, headers: {}, body: {} });
  }
}
