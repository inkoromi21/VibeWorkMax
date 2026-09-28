import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { contractNames, validateContract } from '../src/index.js';

const fixtures = JSON.parse(
  readFileSync(new URL('../source/fixtures.json', import.meta.url), 'utf8'),
) as { contexts: unknown[] };

describe('MAX 4.0 contracts', () => {
  it('exposes all 21 definitions', () => {
    expect(contractNames).toHaveLength(21);
    for (const name of contractNames) {
      expect(() => validateContract(name, null)).not.toThrow();
    }
  });

  it('accepts a provided DiagnosticContext fixture', () => {
    const result = validateContract('DiagnosticContext', fixtures.contexts[0]);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('rejects an invalid DiagnosticContext', () => {
    const result = validateContract('DiagnosticContext', { unexpected: true });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
