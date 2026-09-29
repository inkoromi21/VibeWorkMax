import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { isAbsolute, join } from 'node:path';
import { ApplicationError } from '@vibework/shared';
import type { Pool } from 'pg';

const MAX_BYTES = 5 * 1024 * 1024;
const MIME_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg', 'text/plain']);
type ScanVerdict = 'CLEAN' | 'INFECTED' | 'UNAVAILABLE';
type AttachmentStatus = 'QUARANTINED' | 'SCANNING' | 'ACCEPTED' | 'REJECTED';

export interface AttachmentScanner {
  scan(bytes: Buffer): Promise<ScanVerdict>;
}

export interface AttachmentRepository {
  reserve(input: {
    id: string;
    userId: string;
    attemptId: string;
    objectKey: string;
    byteSize: number;
    sha256: string;
    mimeType: string;
    idempotencyKey: string;
  }): Promise<{ id: string; status: AttachmentStatus; inserted: boolean }>;
  setStatus(id: string, status: AttachmentStatus, scanResult: ScanVerdict): Promise<void>;
}

export interface AttachmentStorage {
  put(id: string, bytes: Buffer): Promise<void>;
  release(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  readQuarantine(id: string): Promise<Buffer>;
}

export class LocalAttachmentStorage implements AttachmentStorage {
  constructor(private readonly root: string) {
    if (!isAbsolute(root)) throw new Error('ATTACHMENT_LOCAL_DIR must be absolute');
  }

  private path(status: 'quarantine' | 'accepted', id: string): string {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid attachment ID');
    return join(this.root, status, id);
  }

  async put(id: string, bytes: Buffer): Promise<void> {
    await mkdir(join(this.root, 'quarantine'), { recursive: true, mode: 0o700 });
    await writeFile(this.path('quarantine', id), bytes, { flag: 'wx', mode: 0o600 });
  }

  async release(id: string): Promise<void> {
    await mkdir(join(this.root, 'accepted'), { recursive: true, mode: 0o700 });
    await rename(this.path('quarantine', id), this.path('accepted', id));
  }

  async remove(id: string): Promise<void> {
    await rm(this.path('quarantine', id), { force: true });
  }

  readQuarantine(id: string): Promise<Buffer> {
    return readFile(this.path('quarantine', id));
  }
}

export class ClamAvScanner implements AttachmentScanner {
  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly enabled: boolean,
  ) {}

  scan(bytes: Buffer): Promise<ScanVerdict> {
    if (!this.enabled || !this.host || !Number.isInteger(this.port) || this.port < 1)
      return Promise.resolve('UNAVAILABLE');
    return new Promise((resolve) => {
      const socket = createConnection({ host: this.host, port: this.port });
      let settled = false;
      let response = '';
      const finish = (verdict: ScanVerdict) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(verdict);
      };
      socket.setTimeout(5_000, () => finish('UNAVAILABLE'));
      socket.on('error', () => finish('UNAVAILABLE'));
      socket.on('connect', () => {
        const size = Buffer.alloc(4);
        size.writeUInt32BE(bytes.length);
        socket.write(Buffer.from('zINSTREAM\0'));
        socket.write(size);
        socket.write(bytes);
        socket.end(Buffer.alloc(4));
      });
      socket.on('data', (chunk: Buffer) => {
        response += chunk.toString('utf8');
        if (response.length > 4096) finish('UNAVAILABLE');
      });
      socket.on('end', () => {
        if (/FOUND\0?$/.test(response)) finish('INFECTED');
        else if (/OK\0?$/.test(response)) finish('CLEAN');
        else finish('UNAVAILABLE');
      });
      socket.on('close', () => finish('UNAVAILABLE'));
    });
  }
}

export class PostgresAttachmentRepository implements AttachmentRepository {
  constructor(private readonly pool: Pool) {}

  async reserve(input: {
    id: string;
    userId: string;
    attemptId: string;
    objectKey: string;
    byteSize: number;
    sha256: string;
    mimeType: string;
    idempotencyKey: string;
  }): Promise<{ id: string; status: AttachmentStatus; inserted: boolean }> {
    const inserted = await this.pool.query<{ id: string; status: AttachmentStatus }>(
      `INSERT INTO mini_app_attachments(id,user_id,attempt_id,status,object_key,byte_size,sha256,mime_type,idempotency_key)
       SELECT $1,$2,a.id,'QUARANTINED',$4,$5,$6,$7,$8
       FROM attempts a WHERE a.id=$3 AND a.user_id=$2
       ON CONFLICT (user_id,idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
       RETURNING id,status`,
      [
        input.id,
        input.userId,
        input.attemptId,
        input.objectKey,
        input.byteSize,
        input.sha256,
        input.mimeType,
        input.idempotencyKey,
      ],
    );
    if (inserted.rowCount === 1) return { id: input.id, status: 'QUARANTINED', inserted: true };
    const existing = await this.pool.query<{
      id: string;
      status: AttachmentStatus;
      attempt_id: string;
      sha256: string;
    }>(
      `SELECT id,status,attempt_id,sha256 FROM mini_app_attachments
       WHERE user_id=$1 AND idempotency_key=$2`,
      [input.userId, input.idempotencyKey],
    );
    const row = existing.rows[0];
    if (row?.attempt_id === input.attemptId && row.sha256 === input.sha256)
      return { id: row.id, status: row.status, inserted: false };
    if (row)
      throw new ApplicationError({
        code: 'IDEMPOTENCY_CONFLICT',
        message: 'Ключ запроса уже использован для другого файла',
        statusCode: 409,
      });
    throw new ApplicationError({
      code: 'ATTEMPT_NOT_FOUND',
      message: 'Попытка не найдена',
      statusCode: 404,
    });
  }

  async setStatus(id: string, status: AttachmentStatus, scanResult: ScanVerdict): Promise<void> {
    await this.pool.query(
      `UPDATE mini_app_attachments
       SET status=$2,scan_result=$3,scanned_at=now(),
           object_key=CASE WHEN $2='ACCEPTED' THEN 'accepted/' || id::text ELSE object_key END
       WHERE id=$1`,
      [id, status, scanResult],
    );
  }
}

export class AttachmentService {
  constructor(
    private readonly repository: AttachmentRepository,
    private readonly storage: AttachmentStorage,
    private readonly scanner: AttachmentScanner,
  ) {}

  async upload(input: {
    userId: string;
    attemptId: string;
    mimeType: string;
    contentBase64: string;
    idempotencyKey: string;
  }): Promise<{ id: string; status: AttachmentStatus; reason?: string }> {
    if (!MIME_TYPES.has(input.mimeType) || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.contentBase64))
      throw new ApplicationError({
        code: 'INVALID_ATTACHMENT',
        message: 'Неподдерживаемый тип или кодировка файла',
        statusCode: 422,
      });
    const bytes = Buffer.from(input.contentBase64, 'base64');
    if (
      bytes.length === 0 ||
      bytes.length > MAX_BYTES ||
      bytes.toString('base64') !== input.contentBase64
    )
      throw new ApplicationError({
        code: 'INVALID_ATTACHMENT',
        message: 'Файл пустой, повреждён или слишком большой',
        statusCode: 422,
      });
    const id = randomUUID();
    const reservation = await this.repository.reserve({
      id,
      userId: input.userId,
      attemptId: input.attemptId,
      objectKey: `quarantine/${id}`,
      byteSize: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      mimeType: input.mimeType,
      idempotencyKey: input.idempotencyKey,
    });
    if (!reservation.inserted) return { id: reservation.id, status: reservation.status };
    try {
      await this.storage.put(id, bytes);
    } catch (error) {
      await this.repository.setStatus(id, 'REJECTED', 'UNAVAILABLE');
      throw error;
    }
    const verdict = await this.scanner.scan(bytes);
    if (verdict === 'UNAVAILABLE')
      return { id, status: 'QUARANTINED', reason: 'SCANNER_UNAVAILABLE' };
    if (verdict === 'INFECTED') {
      await this.storage.remove(id);
      await this.repository.setStatus(id, 'REJECTED', verdict);
      return { id, status: 'REJECTED', reason: 'MALWARE_DETECTED' };
    }
    await this.repository.setStatus(id, 'SCANNING', verdict);
    await this.storage.release(id);
    await this.repository.setStatus(id, 'ACCEPTED', verdict);
    return { id, status: 'ACCEPTED' };
  }
}
