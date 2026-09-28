import type { ApiError } from '@vibework/contracts';
import { buildServer } from './server.js';

export type { ApiError };
export { buildServer };

if (process.env.NODE_ENV !== 'test') {
  const app = buildServer();
  const port = Number(process.env.API_PORT ?? 3000);
  // Native VPS deployments are reverse-proxied by Nginx. Binding loopback also
  // avoids Fastify enumerating every network interface just to format a log line.
  const host = process.env.API_HOST === '0.0.0.0' ? '127.0.0.1' : process.env.API_HOST ?? '127.0.0.1';
  await app.listen({ host, port });

  const close = async () => {
    await app.close();
    process.exit(0);
  };
  process.once('SIGTERM', () => void close());
  process.once('SIGINT', () => void close());
}
