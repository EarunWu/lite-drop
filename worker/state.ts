import { DurableObject } from 'cloudflare:workers';
import { LEASE_MS, LOCK_MS, PART_SIZE, TICKET_MS, UPLOAD_TTL, type UploadResult } from '../shared/contracts';
import { fail, HttpError, siteLimits } from './core';
import { consumeBudget } from './quotas';

type FileStatus = 'creating' | 'uploading' | 'completing' | 'available' | 'deleting';
export interface StoredFile {
  id: string;
  codeHash: string;
  tokenHash: string;
  key: string;
  name: string;
  size: number;
  ttlSeconds: number;
  downloadLimit: number;
  remaining: number;
  createdAt: number;
  deadline: number;
  expiresAt: number;
  completedAt: number;
  status: FileStatus;
  multipartId: string | null;
  parts: Record<string, R2UploadedPart>;
  partAttempts?: Record<string, number>;
  completeAttempts?: number;
  cleanupAt: number;
  cleanupFailures: number;
  deletionReason: 'exhausted' | 'expired' | 'cancelled' | 'failed' | null;
}

interface Lease extends Record<string, SqlStorageValue> {
  id: string;
  file_id: string;
  kind: 'create' | 'part' | 'complete' | 'reservation' | 'download';
  part_number: number;
  due: number;
}

export interface LeaseHandle { id: string; due: number }
export interface PartStart {
  cached?: R2UploadedPart;
  key: string;
  multipartId: string | null;
  size: number;
  lease?: LeaseHandle;
}
export interface DownloadStart {
  key: string;
  name: string;
  size: number;
  lease: LeaseHandle;
}

export type Command =
  | { action: 'oauth-create'; id: string; ip: string; browser: string; verifier: string; nonce: string }
  | { action: 'oauth-consume'; id: string; ip: string; browser: string }
  | { action: 'cooldowns'; ip: string }
  | { action: 'auth'; ip: string; valid: boolean }
  | { action: 'create'; file: Pick<StoredFile, 'id' | 'codeHash' | 'tokenHash' | 'name' | 'size' | 'ttlSeconds' | 'downloadLimit'> }
  | { action: 'part-start'; id: string; tokenHash: string; number: number; length: number | null }
  | { action: 'part-finish'; lease: string; etag: string }
  | { action: 'complete' | 'cancel'; id: string; tokenHash: string }
  | { action: 'prepare'; ip: string; codeHash: string; ticketHash: string }
  | { action: 'reserve'; ip: string; ticketHash: string }
  | { action: 'commit' | 'renew'; lease: string }
  | { action: 'release'; lease: string; beforeSend?: boolean };

export type StateReply = { ok: true; data: unknown } | { ok: false; status: number; code: string; message: string; retryAfter?: number };

/** One coordinator per installation: every check-and-write below is synchronous.
 * R2 I/O is outside those critical sections, protected by persisted leases. */
export class DropState extends DurableObject<CloudflareBindings> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: CloudflareBindings) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS files (
        id TEXT PRIMARY KEY, code_hash TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL, due INTEGER NOT NULL, data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS files_due ON files(due);
      CREATE TABLE IF NOT EXISTS locks (id TEXT PRIMARY KEY, due INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS oauth_flows (id TEXT PRIMARY KEY, ip TEXT NOT NULL, browser TEXT NOT NULL, verifier TEXT NOT NULL, nonce TEXT NOT NULL, due INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS oauth_due ON oauth_flows(due);
      CREATE INDEX IF NOT EXISTS oauth_ip ON oauth_flows(ip);
      CREATE TABLE IF NOT EXISTS tickets (
        id TEXT PRIMARY KEY, file_id TEXT NOT NULL, ip TEXT NOT NULL, due INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS tickets_due ON tickets(due);
      CREATE TABLE IF NOT EXISTS leases (
        id TEXT PRIMARY KEY, file_id TEXT NOT NULL, kind TEXT NOT NULL,
        part_number INTEGER NOT NULL, due INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS leases_file ON leases(file_id);
      CREATE INDEX IF NOT EXISTS leases_due ON leases(due);
      CREATE TABLE IF NOT EXISTS budgets (id TEXT PRIMARY KEY, used INTEGER NOT NULL, due INTEGER NOT NULL);
    `);
  }

  async call(command: Command): Promise<StateReply> {
    try {
      let data: unknown;
      switch (command.action) {
        case 'oauth-create': data = this.createOAuth(command); break;
        case 'oauth-consume': data = this.consumeOAuth(command); break;
        case 'cooldowns': data = this.cooldowns(command.ip); break;
        case 'auth': data = this.auth(command.ip, command.valid); break;
        case 'create': data = await this.create(command.file); break;
        case 'part-start': data = this.startPart(command); break;
        case 'part-finish': data = this.finishPart(command.lease, command.etag); break;
        case 'complete': data = await this.complete(command.id, command.tokenHash); break;
        case 'cancel': data = this.cancel(command.id, command.tokenHash); break;
        case 'prepare': data = this.prepare(command); break;
        case 'reserve': data = this.reserve(command.ticketHash, command.ip); break;
        case 'commit': data = this.commit(command.lease); break;
        case 'renew': data = this.renew(command.lease); break;
        case 'release': data = this.release(command.lease, command.beforeSend); break;
      }
      return { ok: true, data };
    } catch (error) {
      if (error instanceof HttpError) {
        return { ok: false, status: error.status, code: error.code, message: error.message, retryAfter: error.retryAfter };
      }
      console.error('lite-drop: state operation failed');
      return { ok: false, status: 503, code: 'STORAGE_ERROR', message: '存储暂时不可用，请稍后重试。' };
    } finally { await this.rearm(); }
  }

  private file(id: string): StoredFile | undefined {
    const row = this.sql.exec<{ data: string }>('SELECT data FROM files WHERE id = ?', id).toArray()[0];
    return row ? JSON.parse(row.data) as StoredFile : undefined;
  }

  private save(file: StoredFile) {
    const due = file.status === 'available' ? file.expiresAt : file.status === 'deleting' ? file.cleanupAt : file.deadline;
    this.sql.exec('INSERT INTO files(id, code_hash, status, due, data) VALUES(?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status=excluded.status, due=excluded.due, data=excluded.data',
      file.id, file.codeHash, file.status, due, JSON.stringify(file));
  }

  private authorized(id: string, tokenHash: string) {
    const file = this.file(id);
    if (!file || file.tokenHash !== tokenHash) fail(404, 'UPLOAD_NOT_FOUND', '上传不存在或凭证无效。');
    return file;
  }

  private lease(id: string) {
    return this.sql.exec<Lease>('SELECT * FROM leases WHERE id = ?', id).toArray()[0];
  }

  private makeLease(fileId: string, kind: Lease['kind'], number = 0): LeaseHandle {
    const id = crypto.randomUUID();
    const due = Date.now() + LEASE_MS;
    this.sql.exec('INSERT INTO leases VALUES(?, ?, ?, ?, ?)', id, fileId, kind, number, due);
    return { id, due };
  }

  private liveLease(id: string) {
    const lease = this.lease(id);
    if (!lease || lease.due <= Date.now()) fail(410, 'LEASE_EXPIRED', '传输会话已失效，请重试。');
    return lease;
  }

  private blockUntil(kind: string, ip: string) {
    return this.sql.exec<{ due: number }>('SELECT due FROM locks WHERE id = ? AND due > ?', `${kind}:${ip}`, Date.now()).toArray()[0]?.due ?? 0;
  }

  private checkLock(kind: string, ip: string) {
    const due = this.blockUntil(kind, ip);
    if (due) throw new HttpError(429, 'LOCKED', '尝试过于频繁，请等待倒计时结束。', Math.max(1, Math.ceil((due - Date.now()) / 1000)));
  }

  private lock(kind: string, ip: string, message: string): never {
    this.sql.exec('INSERT INTO locks VALUES(?, ?) ON CONFLICT(id) DO UPDATE SET due=excluded.due', `${kind}:${ip}`, Date.now() + LOCK_MS);
    throw new HttpError(429, 'LOCKED', message, 60);
  }

  private cooldowns(ip: string) {
    return { uploadBlockedUntil: this.blockUntil('upload', ip), downloadBlockedUntil: this.blockUntil('download', ip) };
  }

  private auth(ip: string, valid: boolean) {
    this.checkLock('upload', ip);
    if (!valid) this.lock('upload', ip, '上传权限验证失败，请在 60 秒后重试。');
    return { authenticated: true };
  }

  private createOAuth(command: Extract<Command, { action: 'oauth-create' }>) {
    this.checkLock('upload', command.ip);
    this.sql.exec('DELETE FROM oauth_flows WHERE due <= ?', Date.now());
    const count = this.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM oauth_flows WHERE ip = ?', command.ip).one().count;
    if (count >= 5) this.lock('upload', command.ip, '登录尝试过于频繁，请在 60 秒后重试。');
    this.sql.exec('INSERT INTO oauth_flows VALUES(?, ?, ?, ?, ?, ?)', command.id, command.ip, command.browser, command.verifier, command.nonce, Date.now() + 600_000);
    return { created: true };
  }

  private consumeOAuth(command: Extract<Command, { action: 'oauth-consume' }>) {
    this.checkLock('upload', command.ip);
    return this.ctx.storage.transactionSync(() => {
      const row = this.sql.exec<{ browser: string; verifier: string; nonce: string; due: number }>('SELECT browser, verifier, nonce, due FROM oauth_flows WHERE id = ?', command.id).toArray()[0];
      if (!row || row.due <= Date.now() || row.browser !== command.browser) fail(403, 'OAUTH_STATE', '登录请求已失效，请重新登录。');
      this.sql.exec('DELETE FROM oauth_flows WHERE id = ?', command.id);
      return { verifier: row.verifier, nonce: row.nonce };
    });
  }

  private async create(input: Extract<Command, { action: 'create' }>['file']) {
    if (this.sql.exec('SELECT id FROM files WHERE code_hash = ?', input.codeHash).toArray().length) {
      fail(409, 'CODE_TAKEN', '这个接收码已被占用，请换一个。');
    }
    const file: StoredFile = {
      ...input, key: `files/${input.id}`, remaining: input.downloadLimit,
      createdAt: Date.now(), deadline: Date.now() + UPLOAD_TTL, expiresAt: 0, completedAt: 0,
      status: 'creating', multipartId: null, parts: {}, cleanupAt: 0, cleanupFailures: 0, deletionReason: null,
    };
    const lease = this.ctx.storage.transactionSync(() => {
      const limits = siteLimits(this.env);
      // All statuses retain their full reservation until R2 deletion succeeds.
      const usage = this.sql.exec<{ bytes: number; count: number }>("SELECT COALESCE(SUM(json_extract(data, '$.size')), 0) AS bytes, COUNT(*) AS count FROM files").one();
      if (usage.bytes > limits.maxStoredBytes - input.size) fail(429, 'STORAGE_LIMIT', '站点存储空间已满，请等待文件到期清理后再上传。');
      if (usage.count >= limits.maxActiveFiles) fail(429, 'FILE_COUNT_LIMIT', '站点文件数量已达上限，请等待清理后再上传。');
      consumeBudget(this.sql, limits, { uploads: 1, classA: file.size > 0 ? 1 : 0 });
      this.save(file);
      return this.makeLease(file.id, 'create');
    });
    await this.rearm(); // Persist recovery scheduling before external I/O.
    try {
      const multipart = file.size > 0 ? await this.env.FILES.createMultipartUpload(file.key, {
        httpMetadata: { contentType: 'application/octet-stream' },
      }) : null;
      const current = this.file(file.id)!;
      current.multipartId = multipart?.uploadId ?? null;
      if (current.status !== 'creating' || current.deadline <= Date.now()) {
        this.markDeleting(current);
        fail(410, 'UPLOAD_EXPIRED', '上传会话已失效。');
      }
      current.status = 'uploading';
      this.save(current);
      return { id: file.id, partSize: PART_SIZE, partCount: Math.max(1, Math.ceil(file.size / PART_SIZE)) };
    } catch (error) {
      const current = this.file(file.id);
      if (current) this.markDeleting(current);
      throw error;
    } finally { this.release(lease.id); }
  }

  private startPart(command: Extract<Command, { action: 'part-start' }>): PartStart {
    const file = this.authorized(command.id, command.tokenHash);
    if (file.status !== 'uploading' || file.deadline <= Date.now()) fail(410, 'UPLOAD_EXPIRED', '上传会话已失效或已完成。');
    const count = Math.max(1, Math.ceil(file.size / PART_SIZE));
    if (!Number.isInteger(command.number) || command.number < 1 || command.number > count) fail(400, 'INVALID_PART', '分片编号无效。');
    const size = Math.min(PART_SIZE, file.size - (command.number - 1) * PART_SIZE);
    if (command.length !== null && command.length !== size) fail(400, 'INVALID_PART_SIZE', '分片长度不符合文件大小。');
    const base = { key: file.key, multipartId: file.multipartId, size };
    if (file.parts[command.number]) return { ...base, cached: file.parts[command.number] };
    if (this.sql.exec('SELECT id FROM leases WHERE file_id = ? AND kind = ? AND part_number = ? AND due > ?', file.id, 'part', command.number, Date.now()).toArray().length) {
      throw new HttpError(409, 'PART_BUSY', '该分片正在上传，请稍后重试。', 1);
    }
    const limits = siteLimits(this.env);
    const attempts = file.partAttempts?.[command.number] ?? 0;
    if (attempts >= limits.maxPartAttempts) fail(429, 'PART_ATTEMPTS_EXHAUSTED', '该分片已达到重试上限，请取消后重新上传。');
    const active = this.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM leases WHERE file_id = ? AND kind = 'part' AND due > ?", file.id, Date.now()).one().count;
    if (active >= 3) throw new HttpError(409, 'UPLOAD_BUSY', '同时上传的分片不能超过 3 个，请稍后重试。', 1);
    const lease = this.ctx.storage.transactionSync(() => {
      consumeBudget(this.sql, limits, { classA: 1 });
      file.partAttempts ??= {};
      file.partAttempts[command.number] = attempts + 1;
      this.save(file);
      return this.makeLease(file.id, 'part', command.number);
    });
    return { ...base, lease };
  }

  private finishPart(id: string, etag: string) {
    const lease = this.liveLease(id);
    if (lease.kind !== 'part') fail(400, 'INVALID_LEASE', '传输会话无效。');
    const file = this.file(lease.file_id);
    if (!file || file.status !== 'uploading' || file.deadline <= Date.now()) fail(410, 'UPLOAD_EXPIRED', '上传已取消或过期。');
    const part = { partNumber: lease.part_number, etag };
    file.parts[lease.part_number] = part;
    this.save(file);
    this.release(id);
    return part;
  }

  private result(file: StoredFile): UploadResult {
    return { name: file.name, size: file.size, expiresAt: file.expiresAt, downloads: file.downloadLimit };
  }

  private async complete(id: string, tokenHash: string) {
    const file = this.authorized(id, tokenHash);
    if (file.completedAt) return this.result(file);
    if (file.deadline <= Date.now() || file.status === 'deleting' || file.status === 'creating') fail(410, 'UPLOAD_EXPIRED', '上传会话已失效。');
    if (this.sql.exec('SELECT id FROM leases WHERE file_id = ? AND due > ?', id, Date.now()).toArray().length) {
      throw new HttpError(409, 'UPLOAD_BUSY', '文件仍在处理中，请稍后重试。', 1);
    }
    const count = Math.max(1, Math.ceil(file.size / PART_SIZE));
    const parts = Array.from({ length: count }, (_, i) => file.parts[i + 1]);
    if (parts.some(part => !part)) fail(400, 'MISSING_PARTS', '文件尚未传输完整，请继续上传。');
    const limits = siteLimits(this.env);
    if ((file.completeAttempts ?? 0) >= limits.maxCompleteAttempts) fail(429, 'COMPLETE_ATTEMPTS_EXHAUSTED', '文件校验已达到重试上限，请取消后重新上传。');
    const lease = this.ctx.storage.transactionSync(() => {
      // Reserve both calls before HEAD: a recovered completion may use fewer.
      consumeBudget(this.sql, limits, { classB: 1, classA: file.multipartId ? 1 : 0 });
      file.completeAttempts = (file.completeAttempts ?? 0) + 1;
      file.status = 'completing';
      this.save(file);
      return this.makeLease(id, 'complete');
    });
    await this.rearm();
    try {
      // HEAD recovers a completed R2 write whose success response was lost.
      let object = await this.env.FILES.head(file.key);
      if (!object && file.multipartId) object = await this.env.FILES.resumeMultipartUpload(file.key, file.multipartId).complete(parts);
      if (!object || object.size !== file.size) {
        const current = this.file(id);
        if (current) this.markDeleting(current);
        fail(400, 'SIZE_MISMATCH', '实际文件大小校验失败，上传已清理。');
      }
      const current = this.file(id)!;
      if (current.status !== 'completing' || current.deadline <= Date.now()) {
        this.markDeleting(current);
        fail(410, 'UPLOAD_EXPIRED', '上传已取消或过期。');
      }
      current.completedAt = Date.now();
      current.expiresAt = current.completedAt + current.ttlSeconds * 1000;
      current.status = 'available';
      current.multipartId = null;
      current.parts = {};
      current.partAttempts = {};
      this.save(current);
      return this.result(current);
    } catch (error) {
      const current = this.file(id);
      if (current?.status === 'completing') { current.status = 'uploading'; this.save(current); }
      throw error;
    } finally { this.release(lease.id); }
  }

  private cancel(id: string, tokenHash: string) {
    const file = this.file(id);
    if (!file) return { cancelled: true };
    this.authorized(id, tokenHash);
    this.markDeleting(file, 'cancelled');
    return { cancelled: true };
  }

  private markDeleting(file: StoredFile, reason: StoredFile['deletionReason'] = 'failed') {
    file.status = 'deleting';
    file.deletionReason = reason;
    file.cleanupAt = Date.now();
    this.save(file);
    this.sql.exec('DELETE FROM tickets WHERE file_id = ?', file.id);
  }

  private slots(file: StoredFile) {
    const reserved = this.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM leases WHERE file_id = ? AND kind = ? AND due > ?', file.id, 'reservation', Date.now()).one().count;
    return file.remaining - reserved;
  }

  private available(file: StoredFile | undefined): file is StoredFile {
    return !!file && file.status === 'available' && file.expiresAt > Date.now() && this.slots(file) > 0;
  }

  private prepare(command: Extract<Command, { action: 'prepare' }>) {
    this.checkLock('download', command.ip);
    const row = this.sql.exec<{ id: string }>('SELECT id FROM files WHERE code_hash = ?', command.codeHash).toArray()[0];
    const file = row ? this.file(row.id) : undefined;
    if (!this.available(file)) this.lock('download', command.ip, '接收码无效或已失效，请在 60 秒后重试。');
    this.sql.exec('INSERT INTO tickets VALUES(?, ?, ?, ?)', command.ticketHash, file.id, command.ip, Date.now() + TICKET_MS);
    return { expiresIn: TICKET_MS / 1000 };
  }

  private reserve(ticketHash: string, ip: string): DownloadStart {
    this.checkLock('download', ip);
    const ticket = this.sql.exec<{ file_id: string; ip: string; due: number }>('SELECT * FROM tickets WHERE id = ?', ticketHash).toArray()[0];
    if (!ticket || ticket.ip !== ip || ticket.due <= Date.now()) fail(410, 'TICKET_EXPIRED', '下载凭证已失效，请重新输入接收码。');
    const file = this.file(ticket.file_id);
    if (!this.available(file)) fail(410, 'FILE_EXPIRED', '文件已失效，请重新输入接收码。');
    const lease = this.ctx.storage.transactionSync(() => {
      consumeBudget(this.sql, siteLimits(this.env), { downloads: 1, classB: 1 });
      this.sql.exec('DELETE FROM tickets WHERE id = ?', ticketHash);
      return this.makeLease(file.id, 'reservation');
    });
    return { key: file.key, name: file.name, size: file.size, lease };
  }

  private commit(id: string): LeaseHandle {
    const lease = this.liveLease(id);
    if (lease.kind !== 'reservation') fail(410, 'TICKET_USED', '下载凭证已使用。');
    const file = this.file(lease.file_id);
    if (!file || file.status !== 'available' || file.expiresAt <= Date.now() || file.remaining <= 0) fail(410, 'FILE_EXPIRED', '文件已失效。');
    file.remaining--;
    const due = Date.now() + LEASE_MS;
    this.sql.exec('UPDATE leases SET kind = ?, due = ? WHERE id = ?', 'download', due, id);
    if (file.remaining === 0) this.markDeleting(file, 'exhausted'); else this.save(file);
    return { id, due };
  }

  private renew(id: string): LeaseHandle {
    const lease = this.liveLease(id);
    const file = this.file(lease.file_id);
    if (!file || (lease.kind !== 'download' && (file.status === 'deleting' || (file.completedAt ? file.expiresAt : file.deadline) <= Date.now()))) {
      fail(410, 'LEASE_EXPIRED', '传输会话已失效。');
    }
    const due = Date.now() + LEASE_MS;
    this.sql.exec('UPDATE leases SET due = ? WHERE id = ?', due, id);
    return { id, due };
  }

  private release(id: string, beforeSend = false) {
    const lease = this.lease(id);
    // The trusted Worker calls this only if it never started piping the body.
    // It also covers an acknowledged durable commit whose RPC response was lost.
    if (beforeSend && lease?.kind === 'download') {
      const file = this.file(lease.file_id);
      if (file) {
        file.remaining = Math.min(file.downloadLimit, file.remaining + 1);
        if (file.status === 'deleting' && file.deletionReason === 'exhausted' && file.expiresAt > Date.now()) {
          file.status = 'available'; file.deletionReason = null;
        }
        this.save(file);
      }
    }
    this.sql.exec('DELETE FROM leases WHERE id = ?', id);
    return { released: true };
  }

  private async rearm() {
    // A pending delete with live streams waits on the stream lease, not an immediate alarm loop.
    const next = this.sql.exec<{ due: number | null }>(`
      SELECT MIN(due) AS due FROM (
        SELECT due FROM files WHERE status != 'deleting'
          OR NOT EXISTS (SELECT 1 FROM leases WHERE leases.file_id = files.id)
        UNION ALL SELECT due FROM leases
        UNION ALL SELECT due FROM locks
        UNION ALL SELECT due FROM tickets
        UNION ALL SELECT due FROM oauth_flows
      )`).one().due;
    if (next === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(Math.max(Date.now() + 100, next));
  }

  async alarm() {
    // Persist a watchdog before R2 I/O. A runtime termination must not leave an
    // unfinished cleanup depending solely on the platform's bounded retries.
    await this.ctx.storage.setAlarm(Date.now() + 60_000);
    try {
      const now = Date.now();
      this.sql.exec('DELETE FROM locks WHERE due <= ?', now);
      this.sql.exec('DELETE FROM oauth_flows WHERE due <= ?', now);
      this.sql.exec('DELETE FROM tickets WHERE due <= ?', now);
      this.sql.exec('DELETE FROM leases WHERE due <= ?', now);
      const expired = this.sql.exec<{ id: string }>('SELECT id FROM files WHERE status != ? AND due <= ? LIMIT 50', 'deleting', now).toArray();
      for (const { id } of expired) this.markDeleting(this.file(id)!, 'expired');
      const pending = this.sql.exec<{ id: string }>(`SELECT id FROM files WHERE status = 'deleting' AND due <= ?
        AND NOT EXISTS (SELECT 1 FROM leases WHERE leases.file_id = files.id) LIMIT 20`, Date.now()).toArray();
      for (const { id } of pending) {
        const file = this.file(id)!;
        try {
          if (file.multipartId) {
            try { await this.env.FILES.resumeMultipartUpload(file.key, file.multipartId).abort(); }
            catch (error) {
              if (!(error instanceof Error) || !/NoSuchUpload|does not exist|not found|already (?:been )?(?:aborted|completed)|10024/i.test(error.message)) throw error;
            }
          }
          await this.env.FILES.delete(file.key);
          this.sql.exec('DELETE FROM tickets WHERE file_id = ?', id);
          this.sql.exec('DELETE FROM files WHERE id = ?', id);
        } catch {
          file.cleanupFailures++;
          file.cleanupAt = Date.now() + Math.min(3_600_000, 5000 * 2 ** Math.min(file.cleanupFailures - 1, 10));
          this.save(file);
          console.error('lite-drop: cleanup deferred');
        }
      }
    } finally { await this.rearm(); }
  }
}
