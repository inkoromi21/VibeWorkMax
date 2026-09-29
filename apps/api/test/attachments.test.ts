import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AttachmentService,
  ClamAvScanner,
  LocalAttachmentStorage,
  type AttachmentRepository,
} from '../src/attachments.js';

const attemptId = '00000000-0000-4000-8000-000000000001';

class MemoryAttachmentRepository implements AttachmentRepository {
  created: { id: string; attemptId: string; objectKey: string } | null = null;
  statuses: string[] = [];

  reserve(input: {
    id: string;
    userId: string;
    attemptId: string;
    objectKey: string;
    byteSize: number;
    sha256: string;
    mimeType: string;
    idempotencyKey: string;
  }): Promise<{ id: string; status: 'QUARANTINED'; inserted: true }> {
    this.created = input;
    return Promise.resolve({ id: input.id, status: 'QUARANTINED', inserted: true });
  }

  setStatus(_id: string, status: string): Promise<void> {
    this.statuses.push(status);
    return Promise.resolve();
  }
}

describe('attachment quarantine lifecycle', () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function setup() {
    const root = await mkdtemp(join(tmpdir(), 'vibework-attachment-test-'));
    roots.push(root);
    return {
      root,
      storage: new LocalAttachmentStorage(root),
      repo: new MemoryAttachmentRepository(),
    };
  }

  it('keeps bytes private and quarantined when scanner is disabled', async () => {
    const { root, storage, repo } = await setup();
    const service = new AttachmentService(repo, storage, new ClamAvScanner('', 3310, false));
    const result = await service.upload({
      userId: 'user-1',
      attemptId,
      mimeType: 'text/plain',
      contentBase64: Buffer.from('synthetic answer').toString('base64'),
      idempotencyKey: 'upload-1',
    });
    expect(result).toMatchObject({ status: 'QUARANTINED', reason: 'SCANNER_UNAVAILABLE' });
    expect(repo.created?.attemptId).toBe(attemptId);
    expect(repo.statuses).toEqual([]);
    expect(await readFile(join(root, 'quarantine', result.id), 'utf8')).toBe('synthetic answer');
    await expect(readFile(join(root, 'accepted', result.id))).rejects.toThrow();
  });

  it('releases only a clean scan and rejects infected bytes', async () => {
    const { root, storage, repo } = await setup();
    const clean = new AttachmentService(repo, storage, { scan: () => Promise.resolve('CLEAN') });
    const accepted = await clean.upload({
      userId: 'user-1',
      attemptId,
      mimeType: 'text/plain',
      contentBase64: Buffer.from('safe').toString('base64'),
      idempotencyKey: 'upload-2',
    });
    expect(accepted.status).toBe('ACCEPTED');
    expect(repo.statuses).toEqual(['SCANNING', 'ACCEPTED']);
    expect(await readFile(join(root, 'accepted', accepted.id), 'utf8')).toBe('safe');

    const infected = new AttachmentService(repo, storage, {
      scan: () => Promise.resolve('INFECTED'),
    });
    const rejected = await infected.upload({
      userId: 'user-1',
      attemptId,
      mimeType: 'text/plain',
      contentBase64: Buffer.from('EICAR synthetic fixture').toString('base64'),
      idempotencyKey: 'upload-3',
    });
    expect(rejected).toMatchObject({ status: 'REJECTED', reason: 'MALWARE_DETECTED' });
    expect(repo.statuses.at(-1)).toBe('REJECTED');
    await expect(readFile(join(root, 'quarantine', rejected.id))).rejects.toThrow();
  });

  it('rejects unsupported, malformed and oversized files before storage', async () => {
    const { storage, repo } = await setup();
    const service = new AttachmentService(repo, storage, { scan: () => Promise.resolve('CLEAN') });
    const base = { userId: 'user-1', attemptId, mimeType: 'text/plain', idempotencyKey: 'invalid' };
    await expect(
      service.upload({ ...base, mimeType: 'application/x-executable', contentBase64: 'c2FmZQ==' }),
    ).rejects.toThrow();
    await expect(service.upload({ ...base, contentBase64: '!!!' })).rejects.toThrow();
    await expect(
      service.upload({
        ...base,
        contentBase64: Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64'),
      }),
    ).rejects.toThrow();
    expect(repo.created).toBeNull();
  });
});
