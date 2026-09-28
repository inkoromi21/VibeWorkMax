import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const runtimeFiles = [
  'apps/api/src/index.ts',
  'apps/worker/src/index.ts',
  'apps/web/src/main.tsx',
  'packages/domain/src/index.ts',
];

describe('runtime boundaries', () => {
  it('does not import legacy or Python runtime', () => {
    for (const file of runtimeFiles) {
      const source = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
      expect(source).not.toMatch(/from ['"].*legacy|child_process|python/i);
    }
  });
});
