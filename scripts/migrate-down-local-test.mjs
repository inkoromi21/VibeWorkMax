import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl || process.env.MIGRATION_DOWN_LOCAL_TEST !== '1') {
  throw new Error('Local test rollback requires DATABASE_URL and MIGRATION_DOWN_LOCAL_TEST=1');
}
const target = new URL(databaseUrl);
if (
  !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) ||
  target.pathname !== '/phase1'
) {
  throw new Error('Refusing to roll back a database outside the local phase1 test container');
}
const count = readdirSync(new URL('../migrations/', import.meta.url)).filter((name) =>
  /^\d+_.*\.cjs$/.test(name),
).length;
if (count === 0) throw new Error('No migrations found');
const result = spawnSync(
  'pnpm',
  [
    'exec',
    'node-pg-migrate',
    'down',
    String(count),
    '--migrations-dir',
    'migrations',
    '--database-url-var',
    'DATABASE_URL',
  ],
  { cwd: root, env: process.env, stdio: 'inherit' },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
