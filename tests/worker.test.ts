import { env as runtimeEnv } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext, runInDurableObject, reset, evictDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { stateCall } from '../worker/index';
import { digest, type Env } from '../worker/core';
import { type StoredFile, type DownloadStart, type LeaseHandle, type DropState } from '../worker/state';
import { MAX_FILE_SIZE, PART_SIZE, type UploadSession, type UploadResult } from '../shared/contracts';

const bindings = runtimeEnv as unknown as Env;
const openEnv: Env = { ...bindings, UPLOAD_PASSWORD_REQUIRED: 'false' };
const contexts: ExecutionContext[] = [];
const stub = () => bindings.STATE.getByName('lite-drop-v1');

async function request(path: string, method = 'GET', body?: unknown, options: { env?: Env; ip?: string; cookie?: string; headers?: Record<string, string> } = {}) {
  const headers = new Headers({ 'CF-Connecting-IP': options.ip ?? '203.0.113.10', 'Origin': 'https://lite.test', ...options.headers });
  if (options.cookie) headers.set('Cookie', options.cookie);
  let payload: BodyInit | undefined;
  if (body instanceof Uint8Array || typeof body === 'string' || body instanceof ReadableStream) payload = body;
  else if (body !== undefined) { payload = JSON.stringify(body); headers.set('Content-Type', 'application/json'); }
  const ctx = createExecutionContext(); contexts.push(ctx);
  return worker.fetch(new Request(`https://lite.test${path}`, { method, headers, body: payload }), options.env ?? openEnv, ctx);
}

async function init(code = '00123456', size = 5, downloads = 1, ttlSeconds = 60) {
  const response = await request('/api/uploads', 'POST', { name: '测试文件.txt', code, size, downloads, ttlSeconds });
  expect(response.status, await response.clone().text()).toBe(201);
  return response.json<UploadSession>();
}

async function part(session: UploadSession, body: BodyInit = 'hello', number = 1, extra: Record<string, string> = {}) {
  return request(`/api/uploads/${session.id}/parts/${number}`, 'PUT', body, { headers: { Authorization: `Bearer ${session.token}`, ...extra } });
}

async function complete(session: UploadSession) {
  return request(`/api/uploads/${session.id}/complete`, 'POST', {}, { headers: { Authorization: `Bearer ${session.token}` } });
}

async function upload(code = '00123456', text = 'hello', downloads = 1) {
  const session = await init(code, new TextEncoder().encode(text).length, downloads);
  const response = await part(session, text);
  expect(response.status, await response.clone().text()).toBe(200);
  const finished = await complete(session);
  expect(finished.status, await finished.clone().text()).toBe(200);
  return session;
}

async function prepare(code = '00123456', ip?: string) {
  const response = await request('/api/downloads/prepare', 'POST', { code }, { ip });
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json<{ ticket: string }>()).ticket;
}

async function record(id: string) {
  return runInDurableObject(stub(), (_instance, state) => {
    const row = state.storage.sql.exec<{ data: string }>('SELECT data FROM files WHERE id = ?', id).toArray()[0];
    return row ? JSON.parse(row.data) as StoredFile : undefined;
  });
}

async function changeFile(id: string, values: Partial<StoredFile>, due?: number) {
  await runInDurableObject(stub(), (_instance, state) => {
    const row = state.storage.sql.exec<{ data: string }>('SELECT data FROM files WHERE id = ?', id).one();
    const file = { ...JSON.parse(row.data), ...values };
    state.storage.sql.exec('UPDATE files SET data = ?, status = ?, due = ? WHERE id = ?', JSON.stringify(file), file.status,
      due ?? (file.status === 'available' ? file.expiresAt : file.status === 'deleting' ? file.cleanupAt : file.deadline), id);
  });
}

const alarm = () => runInDurableObject(stub(), (instance: DropState) => instance.alarm());

async function budget(id: string, used?: number, due = Date.now() + 86_400_000) {
  return runInDurableObject(stub(), (_instance, state) => {
    if (used !== undefined) state.storage.sql.exec('INSERT INTO budgets VALUES(?, ?, ?) ON CONFLICT(id) DO UPDATE SET used=excluded.used, due=excluded.due', id, used, due);
    return state.storage.sql.exec<{ used: number; due: number }>('SELECT used, due FROM budgets WHERE id = ?', id).toArray()[0];
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(contexts.splice(0).map(ctx => waitOnExecutionContext(ctx)));
  await reset();
});

describe('upload authentication and persistent lockouts', () => {
  it('requires a password by default and issues a secure, expiring cookie', async () => {
    const denied = await request('/api/uploads', 'POST', {}, { env: bindings });
    expect(denied.status).toBe(401);
    const response = await request('/api/upload-auth', 'POST', { password: 'test-upload-password' }, { env: bindings });
    expect(response.status).toBe(200);
    const cookie = response.headers.get('Set-Cookie')!;
    expect(cookie).toContain('__Host-lite-drop-upload=');
    expect(cookie).toContain('HttpOnly; SameSite=Strict; Max-Age=3600; Secure');
    const config = await request('/api/config', 'GET', undefined, { env: bindings, cookie });
    expect((await config.json<any>()).uploadAuthenticated).toBe(true);
    const tampered = await request('/api/config', 'GET', undefined, { env: bindings, cookie: cookie.replace(/\.[a-f0-9]/, '.x') });
    expect((await tampered.json<any>()).uploadAuthenticated).toBe(false);
  });

  it('disables auth on both API and configuration when configured', async () => {
    const env = { ...openEnv, UPLOAD_PASSWORD: undefined };
    const config = await (await request('/api/config', 'GET', undefined, { env })).json<any>();
    expect(config.uploadPasswordRequired).toBe(false);
    expect(config.uploadAuthenticated).toBe(true);
    expect(config.uploadConfigured).toBe(true);
    expect((await request('/api/upload-auth', 'POST', {}, { env })).status).toBe(200);
    await init();
  });

  it('fails closed on missing password, invalid switches, and missing signing secret', async () => {
    expect((await request('/api/uploads', 'POST', {}, { env: { ...bindings, UPLOAD_PASSWORD: undefined } })).status).toBe(503);
    expect((await request('/api/config', 'GET', undefined, { env: { ...bindings, APP_SECRET: '' } })).status).toBe(503);
    expect((await request('/api/config', 'GET', undefined, { env: { ...bindings, UPLOAD_PASSWORD_REQUIRED: 'False' } })).status).toBe(503);
  });

  it('locks on the first failure, preserves the deadline across retries and eviction, and unlocks at the boundary', async () => {
    const wrong = await request('/api/upload-auth', 'POST', { password: 'wrong' }, { env: bindings });
    expect(wrong.status).toBe(429); expect(wrong.headers.get('Retry-After')).toBe('60');
    const first = (await (await request('/api/config')).json<any>()).uploadBlockedUntil;
    await evictDurableObject(stub());
    expect((await request('/api/upload-auth', 'POST', { password: 'test-upload-password' }, { env: bindings })).status).toBe(429);
    const second = (await (await request('/api/config')).json<any>()).uploadBlockedUntil;
    expect(second).toBe(first);
    expect((await request('/api/upload-auth', 'POST', { password: 'test-upload-password' }, { env: bindings, ip: '203.0.113.11' })).status).toBe(200);
    await runInDurableObject(stub(), (_i, state) => { state.storage.sql.exec('UPDATE locks SET due = ?', Date.now()); });
    expect((await request('/api/upload-auth', 'POST', { password: 'test-upload-password' }, { env: bindings })).status).toBe(200);
  });

  it('keeps the two lockouts independent and prevents parallel guessing after the first wrong attempt', async () => {
    await upload();
    await request('/api/upload-auth', 'POST', { password: 'wrong' }, { env: bindings });
    expect(await prepare()).toHaveLength(64);
    const results = await Promise.all(Array.from({ length: 12 }, () => request('/api/downloads/prepare', 'POST', { code: '99999999' })));
    expect(results.every(result => result.status === 429)).toBe(true);
    expect((await request('/api/downloads/prepare', 'POST', { code: '00123456' })).status).toBe(429);
    expect(await prepare('00123456', '203.0.113.12')).toHaveLength(64);
  });

  it('invalidates sessions after password rotation and never returns secrets in config', async () => {
    const response = await request('/api/upload-auth', 'POST', { password: 'test-upload-password' }, { env: bindings });
    const cookie = response.headers.get('Set-Cookie')!;
    const config = await (await request('/api/config', 'GET', undefined, { env: { ...bindings, UPLOAD_PASSWORD: 'new' }, cookie })).json<any>();
    expect(config.uploadAuthenticated).toBe(false);
    expect(JSON.stringify(config)).not.toContain('test-upload-password');
    expect(JSON.stringify(config)).not.toContain(bindings.APP_SECRET);
  });
});

describe('upload ownership, validation, multipart and publication', () => {
  it('preserves leading zeroes, reserves codes early, and stores only digests', async () => {
    const session = await init();
    expect((await request('/api/uploads', 'POST', { name: 'b', code: '00123456', size: 1, downloads: 1, ttlSeconds: 60 })).status).toBe(409);
    const stored = await record(session.id);
    expect(stored!.codeHash).toHaveLength(64);
    expect(JSON.stringify(stored)).not.toContain('00123456');
    expect(stored!.tokenHash).not.toBe(session.token);
    expect((await request('/api/downloads/prepare', 'POST', { code: '00123456' })).status).toBe(429);
  });

  it('accepts the exact size limit and rejects larger or invalid input before allocating a file', async () => {
    await init('00123456', MAX_FILE_SIZE);
    const base = { name: 'test', code: '22345678', size: MAX_FILE_SIZE + 1, downloads: 1, ttlSeconds: 60 };
    expect((await request('/api/uploads', 'POST', base)).status).toBe(413);
    for (const override of [{ size: -1 }, { size: 1.5 }, { code: '12345' }, { code: 'abcdef' }, { name: '../file' }, { ttlSeconds: 59 }, { downloads: 0 }, { downloads: 1.5 }]) {
      expect((await request('/api/uploads', 'POST', { ...base, size: 1, ...override })).status).toBeGreaterThanOrEqual(400);
    }
  });

  it('requires the upload-specific token, validates part numbers and refuses partial completion', async () => {
    const session = await init();
    expect((await request(`/api/uploads/${session.id}/parts/1`, 'PUT', 'hello')).status).toBe(401);
    expect((await request(`/api/uploads/${session.id}/parts/1`, 'PUT', 'hello', { headers: { Authorization: `Bearer ${'a'.repeat(64)}` } })).status).toBe(404);
    expect((await part(session, 'hello', 2)).status).toBe(400);
    expect((await complete(session)).status).toBe(400);
  });

  it('checks the streamed byte count even with a forged Content-Length', async () => {
    const session = await init();
    const long = await part(session, 'toolong', 1, { 'Content-Length': '5' });
    expect(long.status).toBeGreaterThanOrEqual(400);
    expect(Object.keys((await record(session.id))!.parts)).toHaveLength(0);
    const short = await part(session, 'hi', 1, { 'Content-Length': '5' });
    expect(short.status).toBeGreaterThanOrEqual(400);
    expect((await part(session)).status).toBe(200);
  });

  it('starts TTL at successful completion, deduplicates parts and completion, and supports zero-byte files', async () => {
    const session = await init();
    const first = await (await part(session)).json<any>();
    expect(await (await part(session)).json()).toEqual(first);
    const before = Date.now();
    const result = await (await complete(session)).json<UploadResult>();
    expect(result.expiresAt).toBeGreaterThanOrEqual(before + 60_000);
    expect(await (await complete(session)).json()).toEqual(result);
    const empty = await init('12345679', 0);
    expect((await part(empty, '')).status).toBe(200);
    expect((await complete(empty)).status).toBe(200);
    expect((await bindings.FILES.head(`files/${empty.id}`))!.size).toBe(0);
  });

  it('streams and assembles multiple parts in order regardless of arrival order', async () => {
    const session = await init('12345678', PART_SIZE + 3);
    const tail = await part(session, 'end', 2);
    expect(tail.status).toBe(200);
    expect((await part(session, new Uint8Array(PART_SIZE).fill(65))).status).toBe(200);
    expect((await complete(session)).status).toBe(200);
    const object = await bindings.FILES.get(`files/${session.id}`, { range: { offset: PART_SIZE - 2 } });
    expect(await object!.text()).toBe('AAend');
  });

  it('recovers completion after the R2 write succeeded but publication was interrupted', async () => {
    const session = await init(); await part(session);
    const stored = (await record(session.id))!;
    await bindings.FILES.resumeMultipartUpload(stored.key, stored.multipartId!).complete(Object.values(stored.parts));
    await changeFile(session.id, { status: 'completing' });
    expect((await complete(session)).status).toBe(200);
    expect((await record(session.id))!.status).toBe('available');
  });

  it('rejects cross-site mutations and unbounded JSON bodies', async () => {
    expect((await request('/api/uploads', 'POST', {}, { headers: { Origin: 'https://other.test' } })).status).toBe(403);
    expect((await request('/api/upload-auth', 'POST', { password: 'x'.repeat(9000) }, { env: bindings })).status).toBe(413);
    expect((await request('/api/upload-auth', 'POST', 'not-json', { env: bindings })).status).toBe(415);
  });
});

describe('strict download accounting and delivery', () => {
  it('does not count preparation, streams a native attachment, and consumes exactly once', async () => {
    const session = await upload('00123456', 'hello', 2);
    const ticket = await prepare();
    expect((await record(session.id))!.remaining).toBe(2);
    const response = await request(`/api/downloads/${ticket}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Disposition')).toContain("filename*=UTF-8''%E6%B5%8B");
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(await response.text()).toBe('hello');
    expect((await record(session.id))!.remaining).toBe(1);
    expect((await request(`/api/downloads/${ticket}`)).status).toBe(410);
  });

  it('allows only one contender to use the last download slot', async () => {
    await upload();
    const tickets = await Promise.all(Array.from({ length: 15 }, () => prepare()));
    const responses = await Promise.all(tickets.map(ticket => request(`/api/downloads/${ticket}`)));
    expect(responses.filter(response => response.status === 200)).toHaveLength(1);
    const bodies = await Promise.all(responses.map(response => response.text()));
    expect(bodies.filter(body => body === 'hello')).toHaveLength(1);
  });

  it('binds tickets to IPs, expires unused tickets, and rejects Range/HEAD without consuming the ticket', async () => {
    await upload();
    const ticket = await prepare();
    expect((await request(`/api/downloads/${ticket}`, 'GET', undefined, { ip: '203.0.113.88' })).status).toBe(410);
    expect((await request(`/api/downloads/${ticket}`, 'GET', undefined, { headers: { Range: 'bytes=1-' } })).status).toBe(416);
    expect((await request(`/api/downloads/${ticket}`, 'HEAD')).status).toBe(404);
    await runInDurableObject(stub(), (_i, state) => { state.storage.sql.exec('UPDATE tickets SET due = ?', Date.now() - 1); });
    expect((await request(`/api/downloads/${ticket}`)).status).toBe(410);
    expect(await (await request(`/api/downloads/${await prepare()}`)).text()).toBe('hello');
  });

  it('releases a pre-send reservation on storage failure without consuming a download', async () => {
    const session = await upload();
    const ticket = await prepare();
    const failing = { ...openEnv, FILES: { ...bindings.FILES, get: async () => { throw new Error('simulated outage'); } } as R2Bucket };
    expect((await request(`/api/downloads/${ticket}`, 'GET', undefined, { env: failing })).status).toBe(503);
    expect((await record(session.id))!.remaining).toBe(1);
    expect(await (await request(`/api/downloads/${await prepare()}`)).text()).toBe('hello');
  });

  it('does not refund a committed download when the client cancels', async () => {
    const session = await upload('00123456', 'cancel me', 2);
    const response = await request(`/api/downloads/${await prepare()}`);
    await response.body!.cancel();
    await Promise.all(contexts.map(ctx => waitOnExecutionContext(ctx)));
    expect((await record(session.id))!.remaining).toBe(1);
  });

  it('rolls back exactly once if a committed reservation acknowledgement is lost before sending', async () => {
    const session = await upload(); const ticket = await prepare();
    const failing = { ...openEnv, STATE: { getByName: () => ({ call: async (command: any) => {
      const reply = await stub().call(command);
      if (command.action === 'commit') throw new Error('commit response lost');
      return reply;
    } }) } as unknown as Env['STATE'] };
    expect((await request(`/api/downloads/${ticket}`, 'GET', undefined, { env: failing })).status).toBe(503);
    expect((await record(session.id))!.remaining).toBe(1);
    expect((await record(session.id))!.status).toBe('available');
    expect(await (await request(`/api/downloads/${await prepare()}`)).text()).toBe('hello');
  });

  it('does not start sending when expiry occurs while R2 is being opened', async () => {
    const session = await upload(); const ticket = await prepare();
    const delayed = { ...openEnv, FILES: { get: async (key: string) => {
      const object = await bindings.FILES.get(key);
      await changeFile(session.id, { expiresAt: Date.now() - 1 });
      return object;
    } } as unknown as R2Bucket };
    expect((await request(`/api/downloads/${ticket}`, 'GET', undefined, { env: delayed })).status).toBe(410);
    expect((await record(session.id))!.remaining).toBe(1);
  });

  it('rechecks expiry between preparing, reserving, and sending', async () => {
    const session = await upload(); const ticket = await prepare();
    await changeFile(session.id, { expiresAt: Date.now() - 1 });
    expect((await request(`/api/downloads/${ticket}`)).status).toBe(410);
    expect((await record(session.id))!.remaining).toBe(1);
  });
});

describe('durable cleanup and live-stream protection', () => {
  it('finishes a real response stream that crosses the file expiry', async () => {
    const session = await upload('00123456', 'hello', 2); const ticket = await prepare();
    let controller: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; c.enqueue(new TextEncoder().encode('he')); } });
    const delayed = { ...openEnv, FILES: { get: async () => ({ size: 5, body }) } as unknown as R2Bucket };
    const response = await request(`/api/downloads/${ticket}`, 'GET', undefined, { env: delayed });
    expect(response.status).toBe(200);
    await changeFile(session.id, { expiresAt: Date.now() - 1 });
    await alarm();
    expect(await bindings.FILES.head(`files/${session.id}`)).not.toBeNull();
    controller!.enqueue(new TextEncoder().encode('llo')); controller!.close();
    expect(await response.text()).toBe('hello');
    await Promise.all(contexts.map(ctx => waitOnExecutionContext(ctx)));
    await alarm();
    expect(await bindings.FILES.head(`files/${session.id}`)).toBeNull();
  });

  it('deletes an expired file without any download request and allows code reuse after deletion', async () => {
    const session = await upload();
    await changeFile(session.id, { expiresAt: Date.now() - 1 });
    await alarm();
    expect(await bindings.FILES.head(`files/${session.id}`)).toBeNull();
    expect(await record(session.id)).toBeUndefined();
    await init();
  });

  it('cleans abandoned and cancelled multipart uploads', async () => {
    const session = await init(); await part(session);
    await changeFile(session.id, { deadline: Date.now() - 1 });
    await alarm(); expect(await record(session.id)).toBeUndefined();
    const another = await init(); await part(another);
    expect((await request(`/api/uploads/${another.id}`, 'DELETE', undefined, { headers: { Authorization: `Bearer ${another.token}` } })).status).toBe(200);
    await alarm(); expect(await record(another.id)).toBeUndefined();
  });

  it('protects already-started streams at expiry/exhaustion and deletes after release', async () => {
    const session = await upload();
    const ticket = await prepare();
    const start = await stateCall<DownloadStart>(bindings, { action: 'reserve', ip: await digest(bindings, 'ip', '203.0.113.10'), ticketHash: await digest(bindings, 'ticket', ticket) });
    await stateCall(bindings, { action: 'commit', lease: start.lease.id });
    await changeFile(session.id, { expiresAt: Date.now() - 1 });
    await alarm();
    expect(await bindings.FILES.head(start.key)).not.toBeNull();
    const renewed = await stateCall<LeaseHandle>(bindings, { action: 'renew', lease: start.lease.id });
    expect(renewed.due).toBeGreaterThan(Date.now());
    expect((await request('/api/downloads/prepare', 'POST', { code: '00123456' })).status).toBe(429);
    await stateCall(bindings, { action: 'release', lease: start.lease.id });
    await alarm(); expect(await bindings.FILES.head(start.key)).toBeNull();
  });

  it('recovers stale stream leases after eviction and keeps consumed counts consumed', async () => {
    const session = await upload(); const ticket = await prepare();
    const start = await stateCall<DownloadStart>(bindings, { action: 'reserve', ip: await digest(bindings, 'ip', '203.0.113.10'), ticketHash: await digest(bindings, 'ticket', ticket) });
    await stateCall(bindings, { action: 'commit', lease: start.lease.id });
    await evictDurableObject(stub());
    expect((await record(session.id))!.remaining).toBe(0);
    await runInDurableObject(stub(), (_i, state) => { state.storage.sql.exec('UPDATE leases SET due = ?', Date.now() - 1); });
    await expect(stateCall(bindings, { action: 'renew', lease: start.lease.id })).rejects.toMatchObject({ status: 410 });
    await alarm(); expect(await record(session.id)).toBeUndefined();
  });

  it('persists deletion failures, retries after restart, and never revives an invalid code', async () => {
    const session = await upload();
    await changeFile(session.id, { expiresAt: Date.now() - 1 });
    await runInDurableObject(stub(), async (instance: DropState, _state) => {
      const bucket = (instance as any).env.FILES as R2Bucket;
      const mocked = vi.spyOn(bucket, 'delete').mockRejectedValueOnce(new Error('simulated failure'));
      try { await instance.alarm(); } finally { mocked.mockRestore(); }
    });
    const pending = (await record(session.id))!;
    expect(pending.status).toBe('deleting'); expect(pending.cleanupFailures).toBe(1);
    expect((await request('/api/downloads/prepare', 'POST', { code: '00123456' })).status).toBe(429);
    await evictDurableObject(stub());
    await changeFile(session.id, { cleanupAt: Date.now() - 1 });
    await alarm(); expect(await bindings.FILES.head(`files/${session.id}`)).toBeNull();
  });
});

describe('site-wide cost controls', () => {
  it('atomically reserves the full file size, survives eviction, and frees capacity only after successful cleanup', async () => {
    const files: UploadSession[] = [];
    for (let i = 0; i < 9; i++) files.push(await init(String(10000000 + i), MAX_FILE_SIZE));
    const results = await Promise.all([20, 21, 22].map(i => request('/api/uploads', 'POST', {
      name: 'reserve.bin', code: String(10000000 + i), size: MAX_FILE_SIZE, downloads: 1, ttlSeconds: 60,
    }, { ip: `203.0.113.${i}` })));
    expect(results.filter(r => r.status === 201)).toHaveLength(1);
    expect(results.filter(r => r.status === 429)).toHaveLength(2);
    await evictDurableObject(stub());
    const attempt = () => request('/api/uploads', 'POST', { name: 'full.bin', code: '87654321', size: MAX_FILE_SIZE, downloads: 1, ttlSeconds: 60 });
    expect((await (await attempt()).json<any>()).error).toBe('STORAGE_LIMIT');
    await request(`/api/uploads/${files[0].id}`, 'DELETE', undefined, { headers: { Authorization: `Bearer ${files[0].token}` } });
    expect((await attempt()).status).toBe(429);
    await runInDurableObject(stub(), async (instance: DropState) => {
      const storage = (instance as any).env.FILES as R2Bucket;
      const failing = vi.spyOn(storage, 'delete').mockRejectedValueOnce(new Error('delete unavailable'));
      try { await instance.alarm(); } finally { failing.mockRestore(); }
    });
    expect((await attempt()).status).toBe(429);
    await evictDurableObject(stub());
    await changeFile(files[0].id, { cleanupAt: Date.now() - 1 });
    await alarm();
    expect((await attempt()).status).toBe(201);
  });

  it('enforces a file count limit even for empty files', async () => {
    await init('00123456', 0);
    await runInDurableObject(stub(), async (instance: DropState) => {
      const config = (instance as any).env as Env;
      const previous = config.MAX_ACTIVE_FILES;
      config.MAX_ACTIVE_FILES = '1';
      try {
        const reply = await instance.call({ action: 'create', file: {
          id: crypto.randomUUID(), codeHash: 'different', tokenHash: 'different', name: 'empty', size: 0, ttlSeconds: 60, downloadLimit: 1,
        } });
        expect(reply).toMatchObject({ ok: false, status: 429, code: 'FILE_COUNT_LIMIT' });
      } finally { config.MAX_ACTIVE_FILES = previous; }
    });
  });

  it('limits upload starts across different IPs, retains the counter after eviction, and resets at the UTC day boundary', async () => {
    await budget('uploads:day', 49);
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => request('/api/uploads', 'POST', {
      name: 'a', code: String(10000000 + i), size: 0, downloads: 1, ttlSeconds: 60,
    }, { ip: `203.0.113.${i + 1}` })));
    expect(results.filter(r => r.status === 201)).toHaveLength(1);
    const blocked = results.find(r => r.status === 429)!;
    expect((await blocked.json<any>()).error).toBe('SITE_QUOTA_EXCEEDED');
    expect(Number(blocked.headers.get('Retry-After'))).toBeGreaterThan(0);
    await evictDurableObject(stub());
    expect((await budget('uploads:day')).used).toBe(50);
    await budget('uploads:day', 50, Date.now());
    await init('87654321', 0);
    expect((await budget('uploads:day')).used).toBe(1);
    expect(new Date((await budget('uploads:day')).due).getUTCHours()).toBe(0);
  });

  it('counts failed R2 attempts, caps each part at four attempts across eviction, and prevents further R2 calls', async () => {
    const session = await init();
    const write = vi.fn(async () => { throw new Error('R2 outage'); });
    const failing = { ...openEnv, FILES: { resumeMultipartUpload: () => ({ uploadPart: write }) } as unknown as R2Bucket };
    const send = () => request(`/api/uploads/${session.id}/parts/1`, 'PUT', 'hello', {
      env: failing, headers: { Authorization: `Bearer ${session.token}` },
    });
    for (let i = 0; i < 4; i++) expect((await send()).status).toBe(503);
    await evictDurableObject(stub());
    expect((await (await send()).json<any>()).error).toBe('PART_ATTEMPTS_EXHAUSTED');
    expect(write).toHaveBeenCalledTimes(4);
    expect((await budget('classA:day')).used).toBe(5);
  });

  it('does not charge cached parts or successful completion retries, and checks every budget before I/O', async () => {
    const session = await init(); await part(session);
    await budget('classA:month', 10_000);
    const dailyBefore = (await budget('classA:day')).used;
    expect((await part(session)).status).toBe(200);
    expect((await complete(session)).status).toBe(429);
    expect((await budget('classA:day')).used).toBe(dailyBefore);
    expect(await budget('classB:day')).toBeUndefined();
    expect((await record(session.id))!.completeAttempts).toBeUndefined();
    await budget('classA:month', 10_000, Date.now());
    expect((await complete(session)).status).toBe(200);
    const before = await budget('classB:day');
    await budget('classA:day', 1000);
    expect((await complete(session)).status).toBe(200);
    expect(await budget('classB:day')).toEqual(before);
    expect((await budget('classA:month')).used).toBe(1);
  });

  it('persists a maximum of four completion attempts when R2 HEAD repeatedly fails', async () => {
    const session = await init(); await part(session);
    const tokenHash = await digest(bindings, 'upload', session.token);
    await runInDurableObject(stub(), async (instance: DropState) => {
      const bucket = (instance as any).env.FILES as R2Bucket;
      const failing = vi.spyOn(bucket, 'head').mockRejectedValue(new Error('HEAD unavailable'));
      try {
        for (let i = 0; i < 4; i++) expect(await instance.call({ action: 'complete', id: session.id, tokenHash })).toMatchObject({ status: 503 });
        expect(await instance.call({ action: 'complete', id: session.id, tokenHash })).toMatchObject({ code: 'COMPLETE_ATTEMPTS_EXHAUSTED' });
        expect(failing).toHaveBeenCalledTimes(4);
      } finally { failing.mockRestore(); }
    });
    await evictDurableObject(stub());
    expect((await (await complete(session)).json<any>()).error).toBe('COMPLETE_ATTEMPTS_EXHAUSTED');
    expect((await budget('classB:day')).used).toBe(4);
  });

  it('enforces three concurrent parts on the server without charging rejected starts', async () => {
    const session = await init('00123456', PART_SIZE * 3 + 1);
    const tokenHash = await digest(bindings, 'upload', session.token);
    const starts = [];
    for (let number = 1; number <= 3; number++) starts.push(await stateCall<import('../worker/state').PartStart>(bindings, { action: 'part-start', id: session.id, tokenHash, number, length: PART_SIZE }));
    await expect(stateCall(bindings, { action: 'part-start', id: session.id, tokenHash, number: 4, length: 1 })).rejects.toMatchObject({ code: 'UPLOAD_BUSY' });
    expect((await budget('classA:day')).used).toBe(4);
    await stateCall(bindings, { action: 'release', lease: starts[0].lease!.id });
    await stateCall(bindings, { action: 'part-start', id: session.id, tokenHash, number: 4, length: 1 });
    expect((await budget('classA:day')).used).toBe(5);
  });

  it('allows only one concurrent download when the site has one remaining daily slot', async () => {
    const session = await upload('00123456', 'hello', 10);
    const tickets = await Promise.all(Array.from({ length: 10 }, () => prepare()));
    await budget('downloads:day', 999);
    const responses = await Promise.all(tickets.map(ticket => request(`/api/downloads/${ticket}`)));
    expect(responses.filter(r => r.status === 200)).toHaveLength(1);
    expect(responses.filter(r => r.status === 429)).toHaveLength(9);
    await Promise.all(responses.map(r => r.text()));
    expect((await record(session.id))!.remaining).toBe(9);
    await evictDurableObject(stub());
    expect((await budget('downloads:day')).used).toBe(1000);
  });

  it.each([['downloads:month', 20_000], ['classB:day', 2000], ['classB:month', 50_000]] as const)('blocks %s before opening R2, without consuming a ticket or a file download', async (counter, limit) => {
    const session = await upload(); const ticket = await prepare();
    await budget(counter, limit);
    const get = vi.fn(async () => null);
    const target = { ...openEnv, FILES: { get } as unknown as R2Bucket };
    const blocked = await request(`/api/downloads/${ticket}`, 'GET', undefined, { env: target, headers: { 'Sec-Fetch-Dest': 'iframe' } });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).not.toBeNull();
    expect(get).not.toHaveBeenCalled();
    expect((await record(session.id))!.remaining).toBe(1);
    await budget(counter, limit, Date.now());
    expect(await (await request(`/api/downloads/${ticket}`)).text()).toBe('hello');
  });

  it('never refunds global operation credits after a pre-send failure, while restoring the file download', async () => {
    const session = await upload();
    const failed = { ...openEnv, FILES: { get: async () => { throw new Error('R2 failure'); } } as unknown as R2Bucket };
    expect((await request(`/api/downloads/${await prepare()}`, 'GET', undefined, { env: failed })).status).toBe(503);
    expect((await budget('downloads:day')).used).toBe(1);
    expect((await budget('classB:day')).used).toBe(2);
    expect((await record(session.id))!.remaining).toBe(1);
    await budget('classA:day', 1000); await budget('classB:day', 2000);
    await request(`/api/uploads/${session.id}`, 'DELETE', undefined, { headers: { Authorization: `Bearer ${session.token}` } });
    await alarm();
    expect(await record(session.id)).toBeUndefined();
    expect(await bindings.FILES.head(`files/${session.id}`)).toBeNull();
  });

  it('publishes only configured limits and fails closed for invalid quota settings', async () => {
    const config = await (await request('/api/config')).json<any>();
    expect(config.siteLimits.maxStoredBytes).toBe(5_000_000_000);
    expect(config.siteLimits.maxPartAttempts).toBe(4);
    expect(config).not.toHaveProperty('budgets');
    for (const value of ['-1', 'NaN', '', '1.5']) {
      expect((await request('/api/config', 'GET', undefined, { env: { ...openEnv, MAX_STORED_BYTES: value } })).status).toBe(503);
    }
  });
});
