import { env as runtimeEnv } from 'cloudflare:workers';
import { createExecutionContext, reset, runInDurableObject, evictDurableObject } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import worker from '../worker/index';
import { authenticated, digest, googleSessionCookie, issueCookie, type Env } from '../worker/core';
import type { DropState } from '../worker/state';

const env: Env = { ...runtimeEnv as unknown as Env, UPLOAD_AUTH_MODE: 'google',
  GOOGLE_CLIENT_ID: 'test-google-client', GOOGLE_CLIENT_SECRET: 'test-google-secret',
  GOOGLE_REDIRECT_URI: 'https://lite.test/api/auth/google/callback', GOOGLE_ALLOWED_EMAILS: 'owner@example.com' };
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let jwk: Awaited<ReturnType<typeof exportJWK>>;
beforeAll(async () => { keys = await generateKeyPair('RS256', { extractable: true }); jwk = { ...await exportJWK(keys.publicKey), kid: 'test-key', alg: 'RS256', use: 'sig' }; });
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await reset(); });

function req(path: string, options: { method?: string; cookie?: string; ip?: string; env?: Env; crossSite?: boolean; origin?: string; body?: object } = {}) {
  const method = options.method ?? 'GET';
  const headers = new Headers({ 'CF-Connecting-IP': options.ip ?? '203.0.113.20',
    'Sec-Fetch-Site': options.crossSite ? 'cross-site' : 'same-origin' });
  if (method === 'POST') headers.set('Origin', options.origin ?? 'https://lite.test');
  if (options.cookie) headers.set('Cookie', options.cookie);
  if (options.body) headers.set('Content-Type', 'application/json');
  return worker.fetch(new Request(`https://lite.test${path}`, { method, headers, body: options.body ? JSON.stringify(options.body) : undefined }), options.env ?? env, createExecutionContext());
}

async function begin(ip?: string) {
  const response = await req('/api/auth/google/start', { method: 'POST', ip });
  expect(response.status).toBe(200);
  const cookie = response.headers.get('Set-Cookie')!.split(';')[0];
  const url = new URL((await response.json<{ url: string }>()).url);
  return { cookie, url, path: `/api/auth/google/callback?state=${url.searchParams.get('state')}&code=test-code` };
}

function provider(nonce: string, claims: JWTPayload = {}, badSignature = false) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
    if (String(url) === 'https://www.googleapis.com/oauth2/v3/certs') return Response.json({ keys: [jwk] });
    expect(String(url)).toBe('https://oauth2.googleapis.com/token');
    const body = options!.body as URLSearchParams;
    expect(body.get('client_secret')).toBe('test-google-secret');
    expect(body.get('redirect_uri')).toBe(env.GOOGLE_REDIRECT_URI);
    expect(body.get('code_verifier')).toMatch(/^[a-f0-9]{64}$/);
    const signingKey = badSignature ? (await generateKeyPair('RS256')).privateKey : keys.privateKey;
    const id_token = await new SignJWT({ email: 'owner@example.com', email_verified: true, nonce,
      iss: 'https://accounts.google.com', aud: 'test-google-client', sub: 'google-owner-id',
      iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, ...claims })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).sign(signingKey);
    return Response.json({ id_token });
  });
}

describe('Google upload authorization', () => {
  it('uses only identity scopes, PKCE and a browser-bound secure one-use flow; owner can upload', async () => {
    const flow = await begin();
    expect(flow.url.origin).toBe('https://accounts.google.com');
    expect(flow.url.searchParams.get('scope')).toBe('openid email');
    expect(flow.url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(flow.url.searchParams.get('code_challenge')).toMatch(/^[\w-]{43}$/);
    provider(flow.url.searchParams.get('nonce')!);
    const response = await req(flow.path, { cookie: flow.cookie, crossSite: true });
    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toBe('/#upload');
    const session = response.headers.getSetCookie().find(c => c.startsWith('__Host-lite-drop-google='))!;
    expect(session).toContain('HttpOnly; Secure; SameSite=Strict; Max-Age=3600');
    const cookie = session.split(';')[0];
    const config = await (await req('/api/config', { cookie })).json<{ uploadAuthenticated: boolean; uploadEmail: string }>();
    expect(config).toMatchObject({ uploadAuthenticated: true, uploadEmail: 'owner@example.com' });
    const upload = await req('/api/uploads', { method: 'POST', cookie, body: { name: 'owner.txt', size: 0, code: '00123456', ttlSeconds: 60, downloads: 1 } });
    expect(upload.status).toBe(201);
    const signedOut = await req('/api/auth/logout', { method: 'POST', cookie });
    expect(signedOut.headers.get('Set-Cookie')).toContain('Max-Age=0');
  });

  it.each([
    ['another email', { email: 'someone@gmail.com' }],
    ['Gmail alias', { email: 'owner+alias@example.com' }],
    ['unverified email', { email_verified: false }],
    ['string verification', { email_verified: 'true' }],
    ['wrong audience', { aud: 'another-client' }],
    ['wrong issuer', { iss: 'https://attacker.test' }],
    ['wrong nonce', { nonce: 'replayed' }],
    ['expired token', { exp: 1 }],
    ['wrong authorized party', { azp: 'another-client' }],
  ])('rejects %s and persists an independent 60-second upload lock', async (_label, claims) => {
    const flow = await begin(); provider(flow.url.searchParams.get('nonce')!, claims);
    const response = await req(flow.path, { cookie: flow.cookie, crossSite: true });
    expect(response.status).toBe(429); expect(response.headers.get('Retry-After')).toBe('60');
    expect(response.headers.getSetCookie().some(c => c.startsWith('__Host-lite-drop-google='))).toBe(false);
    const stub = env.STATE.getByName('lite-drop-v1'); await evictDurableObject(stub);
    const config = await (await req('/api/config')).json<{ uploadBlockedUntil: number; downloadBlockedUntil: number }>();
    expect(config.uploadBlockedUntil).toBeGreaterThan(Date.now()); expect(config.downloadBlockedUntil).toBe(0);
    const blocked = await req('/api/auth/google/start', { method: 'POST' }); expect(blocked.status).toBe(429);
    const unchanged = await (await req('/api/config')).json<{ uploadBlockedUntil: number }>();
    expect(unchanged.uploadBlockedUntil).toBe(config.uploadBlockedUntil);
    expect((await req('/api/auth/google/start', { method: 'POST', ip: '203.0.113.21' })).status).toBe(200);
  });

  it('rejects an invalid signature', async () => {
    const flow = await begin(); provider(flow.url.searchParams.get('nonce')!, {}, true);
    expect((await req(flow.path, { cookie: flow.cookie, crossSite: true })).status).toBe(429);
  });

  it('rejects password endpoint, old password cookie and disabled-password bypass in Google mode', async () => {
    const cookie = (await issueCookie(new Request('https://lite.test'), env)).split(';')[0];
    expect((await req('/api/upload-auth', { method: 'POST', body: { password: env.UPLOAD_PASSWORD } })).status).toBe(403);
    const config = await (await req('/api/config', { cookie, env: { ...env, UPLOAD_PASSWORD_REQUIRED: 'false' } })).json<{ uploadAuthenticated: boolean; uploadAuthMode: string }>();
    expect(config).toMatchObject({ uploadAuthenticated: false, uploadAuthMode: 'google' });
    expect((await req('/api/uploads', { method: 'POST', cookie, body: {} })).status).toBe(401);
  });

  it('fails closed for missing secret, empty allowlist and wrong callback origin', async () => {
    for (const override of [{ GOOGLE_CLIENT_SECRET: undefined }, { GOOGLE_ALLOWED_EMAILS: '' }]) {
      const changed = { ...env, ...override };
      expect((await (await req('/api/config', { env: changed })).json<{ uploadConfigured: boolean }>()).uploadConfigured).toBe(false);
      expect((await req('/api/uploads', { method: 'POST', env: changed, body: {} })).status).toBe(503);
    }
    expect((await req('/api/auth/google/start', { method: 'POST', env: { ...env, GOOGLE_REDIRECT_URI: 'https://other.test/api/auth/google/callback' } })).status).toBe(403);
    expect((await req('/api/auth/google/start', { method: 'POST', crossSite: true, origin: 'https://evil.test' })).status).toBe(403);
    expect((await req('/api/auth/logout', { method: 'POST', crossSite: true, origin: 'https://evil.test' })).status).toBe(403);
  });

  it('rejects missing or different browser cookie without consuming the genuine flow', async () => {
    const flow = await begin(); const fetch = provider(flow.url.searchParams.get('nonce')!);
    expect((await req(flow.path, { crossSite: true })).status).toBe(403);
    expect((await req(flow.path, { cookie: `__Host-lite-drop-oauth=${'a'.repeat(64)}`, crossSite: true })).status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
    expect((await req(flow.path, { cookie: flow.cookie, crossSite: true })).status).toBe(303);
  });

  it('atomically consumes the flow once under simultaneous callbacks and rejects replay', async () => {
    const flow = await begin(); provider(flow.url.searchParams.get('nonce')!);
    const responses = await Promise.all([req(flow.path, { cookie: flow.cookie, crossSite: true }), req(flow.path, { cookie: flow.cookie, crossSite: true })]);
    expect(responses.map(r => r.status).sort()).toEqual([303, 403]);
    expect((await req(flow.path, { cookie: flow.cookie, crossSite: true })).status).toBe(403);
  });

  it('expires flows, cleans them on alarms and allows login exactly after the IP lock expires', async () => {
    const flow = await begin();
    const stub = env.STATE.getByName('lite-drop-v1');
    await runInDurableObject(stub, (_instance, state) => { state.storage.sql.exec('UPDATE oauth_flows SET due = ?', Date.now() - 1); });
    expect((await req(flow.path, { cookie: flow.cookie, crossSite: true })).status).toBe(403);
    await runInDurableObject(stub, async (instance: DropState, state) => { await instance.alarm(); expect(state.storage.sql.exec('SELECT * FROM oauth_flows').toArray()).toHaveLength(0); });
    const ip = await digest(env, 'ip', '203.0.113.20');
    await runInDurableObject(stub, (_instance, state) => { state.storage.sql.exec('INSERT INTO locks VALUES(?, ?)', `upload:${ip}`, Date.now()); });
    expect((await req('/api/auth/google/start', { method: 'POST' })).status).toBe(200);
  });

  it('does not issue sessions or lock the user for token endpoint downtime or cancelled consent', async () => {
    const flow = await begin(); vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    expect((await req(flow.path, { cookie: flow.cookie, crossSite: true })).status).toBe(503);
    const other = await begin();
    expect((await req(other.path.replace('code=test-code', 'error=access_denied'), { cookie: other.cookie, crossSite: true })).status).toBe(400);
    expect((await (await req('/api/config')).json<{ uploadBlockedUntil: number }>()).uploadBlockedUntil).toBe(0);
  });

  it('revokes session access when allowlist changes, rejects tampering and expires after one hour', async () => {
    const cookie = (await googleSessionCookie(env, 'owner@example.com', 'owner')).split(';')[0];
    const request = new Request('https://lite.test/api/config', { headers: { Cookie: cookie } });
    expect(await authenticated(request, env)).toBe(true);
    expect(await authenticated(request, { ...env, GOOGLE_ALLOWED_EMAILS: 'other@gmail.com' })).toBe(false);
    expect(await authenticated(new Request('https://lite.test', { headers: { Cookie: `${cookie}tampered` } }), env)).toBe(false);
    const now = Date.now(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now + 3_600_001);
    expect(await authenticated(request, env)).toBe(false);
  });
});
