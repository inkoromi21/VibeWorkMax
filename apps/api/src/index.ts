import type { ApiError } from '@vibework/contracts';
import { buildServer } from './server.js';

export type { ApiError };
export { buildServer };

if (process.env.NODE_ENV !== 'test') {
  const app = buildServer();
  const port = Number(process.env.API_PORT ?? 3000);
  await app.listen({ host: process.env.API_HOST ?? '0.0.0.0', port });

  const close = async () => {
    await app.close();
    process.exit(0);
  };
  process.once('SIGTERM', () => void close());
  process.once('SIGINT', () => void close());
}
