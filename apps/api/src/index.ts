import type { ApiError } from '@vibework/contracts';
import { buildServer } from './server.js';

export type { ApiError };
export { buildServer };

if (process.env.NODE_ENV !== 'test') {
  const app = buildServer();
  const port = Number(process.env.API_PORT ?? 3000);
  // Containers must be reachable from the reverse-proxy container. Native
  // systemd deployments set API_HOST=127.0.0.1 explicitly in the unit.
  const host = process.env.API_HOST ?? '0.0.0.0';
  await app.listen({ host, port });

  const close = async () => {
    await app.close();
    process.exit(0);
  };
  process.once('SIGTERM', () => void close());
  process.once('SIGINT', () => void close());
}
