import { describe, expect, it } from 'vitest';
import {
  assertMaxIdentityEncryptionKey,
  decryptMaxRecipient,
  encryptMaxRecipient,
} from '../src/max-identity.js';

const key = Buffer.alloc(32, 7).toString('base64url');

describe('MAX recipient encryption', () => {
  it('round-trips only a versioned authenticated envelope', () => {
    const encrypted = encryptMaxRecipient('123456', key);
    expect(encrypted).toMatch(/^v1\./);
    expect(encrypted).not.toContain('123456');
    expect(decryptMaxRecipient(encrypted, key)).toBe('123456');
  });

  it('rejects invalid keys and tampered envelopes', () => {
    expect(() => assertMaxIdentityEncryptionKey('not-a-key')).toThrow();
    expect(() => decryptMaxRecipient('v1.invalid.invalid.invalid', key)).toThrow();
  });
});
