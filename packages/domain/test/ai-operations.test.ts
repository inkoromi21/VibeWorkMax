import { describe, expect, it } from 'vitest';
import { validateTemplateDomainOutput } from '../src/index.js';

describe('structured template domain boundary', () => {
  it('rejects model-invented IDs and URLs after JSON Schema accepts their shape', () => {
    expect(
      validateTemplateDomainOutput(
        { explanation: 'text', referenceIds: ['unknown-id'], urls: ['https://evil.example'] },
        { allowedIds: ['known-id'], allowedUrls: ['https://approved.example'] },
      ),
    ).toEqual({ valid: false, reason: 'UNKNOWN_ID:referenceIds' });
    expect(
      validateTemplateDomainOutput(
        { explanation: 'text', referenceIds: ['known-id'], urls: ['https://approved.example'] },
        { allowedIds: ['known-id'], allowedUrls: ['https://approved.example'] },
      ),
    ).toEqual({ valid: true });
  });
});
