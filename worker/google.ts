import { createRemoteJWKSet, jwtVerify } from 'jose';
import { authMode, clientHash, cookieValue, digest, fail, googleSessionCookie, googleSettings, HttpError, json, randomToken, responseHeaders, type Env } from './core';
import { stateCall } from './rpc';

const FLOW_COOKIE = '__Host-lite-drop-oauth';
const clearFlow = `${FLOW_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;
const googleKeys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'), { timeoutDuration: 8000 });

function settingsFor(request: Request, env: Env) {
  if (authMode(env) !== 'google') fail(404, 'NOT_FOUND', 'Google 登录未启用。');
  const settings = googleSettings(env);
  if (new URL(request.url).origin !== settings.redirect.origin) fail(403, 'AUTH_ORIGIN', '请在本站绑定的域名登录。');
  return settings;
}

export async function startGoogle(request: Request, env: Env) {
  const settings = settingsFor(request, env);
  const state = randomToken(), browser = randomToken(), verifier = randomToken(), nonce = randomToken();
  await stateCall(env, { action: 'oauth-create', ip: await clientHash(request, env),
    id: await digest(env, 'oauth-state', state), browser: await digest(env, 'oauth-browser', browser), verifier, nonce });
  const challenge = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({ client_id: settings.clientId, redirect_uri: settings.redirect.href,
    response_type: 'code', scope: 'openid email', state, nonce, code_challenge: challenge,
    code_challenge_method: 'S256', prompt: 'select_account' }).toString();
  return json({ url: url.href }, 200, { 'Set-Cookie': `${FLOW_COOKIE}=${browser}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600` });
}

export async function finishGoogle(request: Request, env: Env) {
  const settings = settingsFor(request, env);
  const ip = await clientHash(request, env);
  const params = new URL(request.url).searchParams;
  const headers = responseHeaders({ 'Set-Cookie': clearFlow });
  try {
    const state = params.get('state') ?? '', browser = cookieValue(request, FLOW_COOKIE) ?? '';
    if (!/^[a-f0-9]{64}$/.test(state) || !/^[a-f0-9]{64}$/.test(browser)) fail(403, 'OAUTH_STATE', '登录请求已失效，请重新登录。');
    const flow = await stateCall<{ verifier: string; nonce: string }>(env, { action: 'oauth-consume', ip,
      id: await digest(env, 'oauth-state', state), browser: await digest(env, 'oauth-browser', browser) });
    if (params.has('error')) fail(400, 'OAUTH_CANCELLED', 'Google 登录已取消。');
    const code = params.get('code');
    if (!code || code.length > 4096) fail(403, 'OAUTH_STATE', '登录请求已失效，请重新登录。');
    let tokenResponse: Response;
    try {
      tokenResponse = await fetch('https://oauth2.googleapis.com/token', { method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(10_000),
        body: new URLSearchParams({ client_id: settings.clientId, client_secret: settings.secret, code,
          grant_type: 'authorization_code', redirect_uri: settings.redirect.href, code_verifier: flow.verifier }) });
    } catch { return failure(headers, 503, 'unavailable'); }
    if (!tokenResponse.ok) { await tokenResponse.body?.cancel(); return failure(headers, 503, 'unavailable'); }
    const tokens = await tokenResponse.json<{ id_token?: string }>();
    let identity: { email: string; sub: string } | undefined;
    try {
      if (!tokens.id_token || tokens.id_token.length > 16_384) throw new Error('invalid');
      const { payload } = await jwtVerify(tokens.id_token, googleKeys, { algorithms: ['RS256'],
        issuer: ['https://accounts.google.com', 'accounts.google.com'], audience: settings.clientId,
        requiredClaims: ['exp', 'iat', 'sub', 'email', 'email_verified', 'nonce'], maxTokenAge: '10m' });
      if (payload.nonce === flow.nonce && payload.email_verified === true && typeof payload.email === 'string' &&
          typeof payload.sub === 'string' && payload.sub.length > 0 && payload.sub.length <= 255 &&
          (!payload.azp || payload.azp === settings.clientId) && settings.emails.includes(payload.email.toLowerCase())) {
        identity = { email: payload.email.toLowerCase(), sub: payload.sub };
      }
    } catch (error) {
      // A key endpoint outage is not a failed identity check. Do not lock the user.
      const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
      if (code === 'ERR_JWKS_TIMEOUT' || code === 'ERR_JOSE_GENERIC' || error instanceof TypeError) return failure(headers, 503, 'unavailable');
      // Never log tokens, authorization codes, or provider errors.
    }
    await stateCall(env, { action: 'auth', ip, valid: !!identity });
    if (!identity) fail(403, 'AUTH_DENIED', '此账号没有上传权限。');
    headers.append('Set-Cookie', await googleSessionCookie(env, identity.email, identity.sub));
    headers.set('Location', '/#upload');
    return new Response(null, { status: 303, headers });
  } catch (error) {
    if (error instanceof HttpError) {
      if (error.retryAfter) headers.set('Retry-After', String(error.retryAfter));
      return failure(headers, error.status, error.code === 'LOCKED' || error.code === 'AUTH_DENIED' ? 'denied' : error.code === 'OAUTH_CANCELLED' ? 'cancelled' : 'expired');
    }
    return failure(headers, 503, 'unavailable');
  }
}

function failure(headers: Headers, status: number, reason: string) {
  // Keep the HTTP failure/Retry-After while returning the browser to the countdown UI.
  headers.set('Content-Type', 'text/html; charset=utf-8');
  headers.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  const target = `/?auth=${reason}#upload`;
  return new Response(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${target}"><title>登录未完成</title><p>登录未完成。<a href="${target}">返回 Lite Drop</a></p></html>`, { status, headers });
}
