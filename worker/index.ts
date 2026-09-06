import { PART_SIZE, type CreateUpload } from '../shared/contracts';
import { authenticated, authMode, clientHash, digest, errorResponse, fail, GOOGLE_COOKIE, googleIdentity, googleSettings, issueCookie, json, jsonBody, passwordMatches, policy, randomToken, requireUploadAuth, responseHeaders, sameOrigin, uploadConfigured, validateUpload, type Env } from './core';
import { type DownloadStart, type LeaseHandle, type PartStart } from './state';
import { stateCall } from './rpc';
import { finishGoogle, startGoogle } from './google';
export { stateCall } from './rpc';
import { createLeaseGuard } from './lease';
export { DropState } from './state';

function leaseGuard(env: Env, initial: LeaseHandle) {
  return createLeaseGuard(initial, lease => stateCall<LeaseHandle>(env, { action: 'renew', lease }));
}

async function uploadToken(request: Request, env: Env) {
  const token = request.headers.get('Authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  if (!token) fail(401, 'UPLOAD_TOKEN_REQUIRED', '缺少本次上传凭证。');
  return digest(env, 'upload', token);
}

async function uploadPart(request: Request, env: Env, id: string, number: number) {
  const lengthHeader = request.headers.get('Content-Length');
  const length = lengthHeader === null ? null : Number(lengthHeader);
  const start = await stateCall<PartStart>(env, {
    action: 'part-start', id, number, length, tokenHash: await uploadToken(request, env),
  });
  if (start.cached) {
    await request.body?.cancel();
    return json(start.cached);
  }
  const lease = start.lease!;
  const guard = leaseGuard(env, lease);
  try {
    const stream = new FixedLengthStream(start.size);
    const body = request.body ?? new ReadableStream<Uint8Array>({ start(c) { c.close(); } });
    const pumping = body.pipeTo(stream.writable, { signal: guard.signal });
    const writing = start.multipartId
      ? env.FILES.resumeMultipartUpload(start.key, start.multipartId).uploadPart(number, stream.readable)
      : env.FILES.put(start.key, stream.readable, { httpMetadata: { contentType: 'application/octet-stream' } });
    // Observe both immediately so a truncated body cannot become an unhandled rejection.
    const [, part] = await Promise.all([pumping, writing]).catch(error => {
      guard.abort();
      throw error;
    });
    if (guard.signal.aborted) fail(410, 'LEASE_EXPIRED', '上传会话已失效。');
    if (!part) fail(503, 'STORAGE_ERROR', '分片保存失败，请重试。');
    return json(await stateCall(env, { action: 'part-finish', lease: lease.id, etag: part.etag }));
  } finally {
    guard.stop();
    // If this callback cannot run, the persisted lease expires on its own.
    await stateCall(env, { action: 'release', lease: lease.id }).catch(() => undefined);
  }
}

async function download(request: Request, env: Env, ctx: ExecutionContext, ticket: string) {
  if (request.headers.has('Range')) fail(416, 'RANGE_UNSUPPORTED', '暂不支持断点续传，请重新下载。');
  if (!/^[a-f0-9]{64}$/.test(ticket)) fail(410, 'TICKET_EXPIRED', '下载凭证已失效。');
  const ip = await clientHash(request, env);
  const start = await stateCall<DownloadStart>(env, { action: 'reserve', ip, ticketHash: await digest(env, 'ticket', ticket) });
  const guard = leaseGuard(env, start.lease);
  let object: R2ObjectBody | null = null;
  let streaming = false;
  try {
    object = await env.FILES.get(start.key);
    if (!object || object.size !== start.size) fail(503, 'FILE_UNAVAILABLE', '文件暂时无法读取，未扣除下载次数，请重试。');
    if (guard.signal.aborted) fail(410, 'LEASE_EXPIRED', '下载准备超时，请重试。');
    const headers = responseHeaders({
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(object.size),
      'Content-Disposition': `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(start.name).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`,
      'Accept-Ranges': 'none',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    });
    const stream = new FixedLengthStream(object.size);
    const response = new Response(stream.readable, { headers });
    guard.update(await stateCall<LeaseHandle>(env, { action: 'commit', lease: start.lease.id }));
    const pumping = object.body.pipeTo(stream.writable, { signal: guard.signal });
    streaming = true;
    ctx.waitUntil(pumping.catch(() => undefined).finally(async () => {
      guard.stop();
      await stateCall(env, { action: 'release', lease: start.lease.id }).catch(() => undefined);
    }));
    return response;
  } finally {
    if (!streaming) {
      guard.stop();
      await object?.body.cancel().catch(() => undefined);
      await stateCall(env, { action: 'release', lease: start.lease.id, beforeSend: true }).catch(() => undefined);
    }
  }
}

async function api(request: Request, env: Env, ctx: ExecutionContext) {
  const { pathname } = new URL(request.url);
  // The sole cross-site API exception validates its browser-bound, one-use state.
  if (request.method === 'GET' && pathname === '/api/auth/google/callback') return finishGoogle(request, env);
  sameOrigin(request);
  if (request.method === 'POST' && pathname === '/api/auth/google/start') return startGoogle(request, env);
  if (request.method === 'POST' && pathname === '/api/auth/logout') return json({ authenticated: false }, 200,
    { 'Set-Cookie': `${GOOGLE_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0` });
  if (request.method === 'GET' && pathname === '/api/config') {
    const limits = policy(env);
    const ip = await clientHash(request, env);
    const [cooldowns, uploadAuthenticated] = await Promise.all([
      stateCall<Record<string, number>>(env, { action: 'cooldowns', ip }), authenticated(request, env),
    ]);
    const configured = uploadConfigured(env);
    return json({ ...limits, ...cooldowns, uploadAuthenticated, uploadConfigured: configured,
      uploadEmail: limits.uploadAuthMode === 'google' && uploadAuthenticated ? await googleIdentity(request, env) : null,
      googleLoginOrigin: limits.uploadAuthMode === 'google' && configured ? googleSettings(env).redirect.origin : null,
      serverTime: Date.now() });
  }
  if (request.method === 'POST' && pathname === '/api/upload-auth') {
    if (authMode(env) === 'google') fail(403, 'GOOGLE_REQUIRED', '本站仅允许授权的 Google 账号上传。');
    if (!policy(env).uploadPasswordRequired) return json({ authenticated: true });
    const body = await jsonBody<{ password: unknown }>(request);
    const [ip, valid] = await Promise.all([clientHash(request, env), passwordMatches(env, body.password)]);
    await stateCall(env, { action: 'auth', ip, valid });
    return json({ authenticated: true }, 200, { 'Set-Cookie': await issueCookie(request, env) });
  }
  if (request.method === 'POST' && pathname === '/api/uploads') {
    await requireUploadAuth(request, env);
    const body = validateUpload(await jsonBody<CreateUpload>(request), env);
    const token = randomToken();
    const [codeHash, tokenHash] = await Promise.all([digest(env, 'code', body.code), digest(env, 'upload', token)]);
    const session = await stateCall<object>(env, { action: 'create', file: {
      id: crypto.randomUUID(), name: body.name, size: body.size, ttlSeconds: body.ttlSeconds,
      downloadLimit: body.downloads, codeHash, tokenHash,
    } });
    return json({ ...session, token, partSize: PART_SIZE }, 201);
  }
  const partRoute = pathname.match(/^\/api\/uploads\/([a-f0-9-]{36})\/parts\/(\d+)$/);
  if (partRoute && request.method === 'PUT') return uploadPart(request, env, partRoute[1], Number(partRoute[2]));
  const uploadRoute = pathname.match(/^\/api\/uploads\/([a-f0-9-]{36})(\/complete)?$/);
  if (uploadRoute && ((request.method === 'POST' && uploadRoute[2]) || (request.method === 'DELETE' && !uploadRoute[2]))) {
    const action = request.method === 'DELETE' ? 'cancel' : 'complete';
    return json(await stateCall(env, { action, id: uploadRoute[1], tokenHash: await uploadToken(request, env) }));
  }
  if (pathname === '/api/downloads/prepare' && request.method === 'POST') {
    const body = await jsonBody<{ code: unknown }>(request);
    const code = typeof body.code === 'string' && /^\d{6,12}$/.test(body.code) ? body.code : '';
    const ticket = randomToken();
    const [ip, codeHash, ticketHash] = await Promise.all([
      clientHash(request, env), digest(env, 'code', code), digest(env, 'ticket', ticket),
    ]);
    await stateCall(env, { action: 'prepare', ip, codeHash, ticketHash });
    return json({ ticket, expiresIn: 60 });
  }
  const downloadRoute = pathname.match(/^\/api\/downloads\/([^/]+)$/);
  if (downloadRoute && request.method === 'GET') return download(request, env, ctx, downloadRoute[1]);
  return json({ error: 'NOT_FOUND', message: '接口不存在或不支持此请求方法。' }, 404);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try { return await api(request, env, ctx); }
    catch (error) {
      const response = errorResponse(error);
      if (request.headers.get('Sec-Fetch-Dest') === 'iframe' && url.pathname.startsWith('/api/downloads/')) {
        const payload = await response.json();
        const nonce = crypto.randomUUID();
        const headers = responseHeaders({
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; frame-ancestors 'self'`,
        });
        if (response.headers.has('Retry-After')) headers.set('Retry-After', response.headers.get('Retry-After')!);
        return new Response(`<!doctype html><meta charset="utf-8"><title>下载提示</title><script nonce="${nonce}">parent.postMessage(${JSON.stringify({ type: 'lite-drop:download-error', payload }).replace(/</g, '\\u003c')}, ${JSON.stringify(url.origin)});</script>`, { status: response.status, headers });
      }
      return response;
    }
  },
} satisfies ExportedHandler<Env>;
