import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

function encryptionKey(value: string): Buffer {
  const key = Buffer.from(value, 'base64url');
  if (key.length !== KEY_BYTES)
    throw new Error('MAX_IDENTITY_ENCRYPTION_KEY must be a 32-byte base64url value');
  return key;
}

/** Verifies configuration without including a secret value in an error or log. */
export function assertMaxIdentityEncryptionKey(value: string | undefined): asserts value is string {
  if (!value) throw new Error('MAX_IDENTITY_ENCRYPTION_KEY is required');
  encryptionKey(value);
}

/**
 * Encrypts the provider recipient ID before it crosses the durable boundary.
 * The versioned envelope is safe to persist but must never be used as a lookup key.
 */
export function encryptMaxRecipient(value: string, keyValue: string): string {
  if (!/^[0-9]{1,19}$/.test(value)) throw new Error('MAX recipient ID is invalid');
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(keyValue), iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64url'), ciphertext.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.');
}

/** Decrypts only immediately before making a provider request. */
export function decryptMaxRecipient(envelope: string, keyValue: string): string {
  const [version, ivValue, ciphertextValue, tagValue, extra] = envelope.split('.');
  if (version !== VERSION || !ivValue || !ciphertextValue || !tagValue || extra)
    throw new Error('MAX recipient envelope is invalid');
  const iv = Buffer.from(ivValue, 'base64url');
  const tag = Buffer.from(tagValue, 'base64url');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES)
    throw new Error('MAX recipient envelope is invalid');
  try {
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(keyValue), iv);
    decipher.setAuthTag(tag);
    const value = Buffer.concat([
      decipher.update(Buffer.from(ciphertextValue, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
    if (!/^[0-9]{1,19}$/.test(value)) throw new Error('MAX recipient is invalid');
    return value;
  } catch {
    throw new Error('MAX recipient envelope is invalid');
  }
}
