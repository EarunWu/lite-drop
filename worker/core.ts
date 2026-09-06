import { MAX_FILE_SIZE, PART_SIZE, type CreateUpload, type SiteLimits } from '../shared/contracts';
import { SignJWT, jwtVerify } from 'jose';

// Bindings come from Wrangler. Variables remain optional so missing/invalid
// configuration is checked at runtime rather than hidden by a type assertion.
type RequiredBindings = 'ASSETS' | 'FILES' | 'STATE' | 'APP_SECRET';
export type Env = Pick<CloudflareBindings, RequiredBindings> & Partial<Omit<CloudflareBindings, RequiredBindings>> & {
  UPLOAD_AUTH_MODE?: string; GOOGLE_CLIENT_ID?: string; GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REDIRECT_URI?: string; GOOGLE_ALLOWED_EMAILS?: string;
};

export function authMode(env: Env): 'google' | 'password' | 'none' {
  if (env.UPLOAD_AUTH_MODE === 'google') return 'google';
  if (env.UPLOAD_AUTH_MODE && env.UPLOAD_AUTH_MODE !== 'password') fail(503, 'CONFIG_ERROR', '上传验证方式配置有误。');
  return env.UPLOAD_PASSWORD_REQUIRED === 'false' ? 'none' : 'password';
}

export function googleSettings(env: Env) {
  const emails = (env.GOOGLE_ALLOWED_EMAILS ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean).sort();
  let redirect: URL;
  try { redirect = new URL(env.GOOGLE_REDIRECT_URI ?? ''); }
  catch { return fail(503, 'CONFIG_ERROR', 'Google 登录尚未配置，请联系管理员。'); }
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !emails.length || emails.some(e => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) ||
      redirect.protocol !== 'https:' || redirect.pathname !== '/api/auth/google/callback' || redirect.search || redirect.hash || redirect.username || redirect.password) {
    fail(503, 'CONFIG_ERROR', 'Google 登录尚未配置，请联系管理员。');
  }
  return { clientId: env.GOOGLE_CLIENT_ID, secret: env.GOOGLE_CLIENT_SECRET, redirect, emails };
}

export function uploadConfigured(env: Env) {
  if (authMode(env) === 'google') { try { googleSettings(env); return true; } catch { return false; } }
  return authMode(env) === 'none' || !!env.UPLOAD_PASSWORD;
}

export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string, public retryAfter?: number) {
    super(message);
  }
}

export function fail(status: number, code: string, message: string): never {
  throw new HttpError(status, code, message);
}

export function siteLimits(env: Env): SiteLimits {
  const read = (value: string | undefined, fallback: number, min = 0) => {
    const number = value === undefined ? fallback : Number(value);
    if (value?.trim() === '' || !Number.isSafeInteger(number) || number < min) {
      fail(503, 'CONFIG_ERROR', '站点额度配置有误，请联系管理员。');
    }
    return number;
  };
  return {
    maxStoredBytes: read(env.MAX_STORED_BYTES, 5_000_000_000),
    maxActiveFiles: read(env.MAX_ACTIVE_FILES, 200),
    uploadsPerDay: read(env.MAX_UPLOADS_PER_DAY, 50),
    downloadsPerDay: read(env.MAX_DOWNLOADS_PER_DAY, 1000),
    downloadsPerMonth: read(env.MAX_DOWNLOADS_PER_MONTH, 20_000),
    r2ClassAPerDay: read(env.MAX_R2_CLASS_A_PER_DAY, 1000),
    r2ClassAPerMonth: read(env.MAX_R2_CLASS_A_PER_MONTH, 10_000),
    r2ClassBPerDay: read(env.MAX_R2_CLASS_B_PER_DAY, 2000),
    r2ClassBPerMonth: read(env.MAX_R2_CLASS_B_PER_MONTH, 50_000),
    maxPartAttempts: read(env.MAX_PART_ATTEMPTS, 4, 1),
    maxCompleteAttempts: read(env.MAX_COMPLETE_ATTEMPTS, 4, 1),
  };
}

export function policy(env: Env) {
  const integer = (value: string | undefined, fallback: number, min: number, max: number) => {
    const number = value === undefined ? fallback : Number(value);
    if (!Number.isSafeInteger(number) || number < min || number > max) {
      fail(503, 'CONFIG_ERROR', '服务配置有误，请联系管理员。');
    }
    return number;
  };
  if (env.UPLOAD_PASSWORD_REQUIRED !== undefined && !['true', 'false'].includes(env.UPLOAD_PASSWORD_REQUIRED)) {
    fail(503, 'CONFIG_ERROR', '上传验证开关必须配置为 true 或 false。');
  }
  const maxTtlSeconds = integer(env.MAX_TTL_SECONDS, 2_592_000, 60, 31_536_000);
  const maxDownloads = integer(env.MAX_DOWNLOADS, 1000, 1, 1_000_000);
  return {
    uploadAuthMode: authMode(env),
    uploadPasswordRequired: authMode(env) === 'password',
    maxFileSize: MAX_FILE_SIZE,
    partSize: PART_SIZE,
    maxTtlSeconds,
    maxDownloads,
    defaultTtlSeconds: integer(env.DEFAULT_TTL_SECONDS, 86_400, 60, maxTtlSeconds),
    defaultDownloads: integer(env.DEFAULT_DOWNLOADS, 1, 1, maxDownloads),
    siteLimits: siteLimits(env),
  };
}

export function validateUpload(body: CreateUpload, env: Env): CreateUpload {
  const limits = policy(env);
  if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 240 || /[\x00-\x1f\x7f/\\]/.test(body.name)) {
    fail(400, 'INVALID_NAME', '文件名不能为空，且不能包含路径或控制字符。');
  }
  if (!Number.isSafeInteger(body.size) || body.size < 0 || body.size > MAX_FILE_SIZE) {
    fail(413, 'FILE_TOO_LARGE', '文件不能超过 500 MB。');
  }
  if (typeof body.code !== 'string' || !/^\d{6,12}$/.test(body.code)) {
    fail(400, 'INVALID_CODE', '接收码应为 6～12 位数字。');
  }
  if (!Number.isSafeInteger(body.ttlSeconds) || body.ttlSeconds < 60 || body.ttlSeconds > limits.maxTtlSeconds) {
    fail(400, 'INVALID_TTL', '有效期超出了允许范围。');
  }
  if (!Number.isSafeInteger(body.downloads) || body.downloads < 1 || body.downloads > limits.maxDownloads) {
    fail(400, 'INVALID_DOWNLOADS', '下载次数超出了允许范围。');
  }
  return body;
}

const encoder = new TextEncoder();
const hex = (buffer: ArrayBuffer) => Array.from(new Uint8Array(buffer), b => b.toString(16).padStart(2, '0')).join('');
let keyCache: { secret: string; key: Promise<CryptoKey> } | undefined;

function appKey(env: Env) {
  if (typeof env.APP_SECRET !== 'string' || env.APP_SECRET.length < 32) {
    fail(503, 'CONFIG_ERROR', '服务尚未配置 APP_SECRET，请联系管理员。');
  }
  if (keyCache?.secret !== env.APP_SECRET) {
    keyCache = {
      secret: env.APP_SECRET,
      key: crypto.subtle.importKey('raw', encoder.encode(env.APP_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']),
    };
  }
  return keyCache.key;
}

export async function digest(env: Env, scope: string, value: string) {
  return hex(await crypto.subtle.sign('HMAC', await appKey(env), encoder.encode(`${scope}\0${value}`)));
}

export async function passwordMatches(env: Env, candidate: unknown) {
  if (!env.UPLOAD_PASSWORD) fail(503, 'CONFIG_ERROR', '上传密码尚未配置，请联系管理员。');
  if (typeof candidate !== 'string' || candidate.length > 1024) return false;
  const [expected, actual] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(env.UPLOAD_PASSWORD)),
    crypto.subtle.digest('SHA-256', encoder.encode(candidate)),
  ]);
  return crypto.subtle.timingSafeEqual(expected, actual);
}

export const randomToken = () => hex(crypto.getRandomValues(new Uint8Array(32)).buffer);
const COOKIE = '__Host-lite-drop-upload';
const DEV_COOKIE = 'lite-drop-upload';
const isLocal = (url: URL) => ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);

export async function clientHash(request: Request, env: Env) {
  const ip = request.headers.get('CF-Connecting-IP') || (isLocal(new URL(request.url)) ? '127.0.0.1' : '');
  if (!ip) fail(403, 'MISSING_IP', '无法验证访问来源。');
  return digest(env, 'ip', ip);
}

export function sameOrigin(request: Request) {
  const url = new URL(request.url);
  const origin = request.headers.get('Origin');
  const site = request.headers.get('Sec-Fetch-Site');
  if ((origin && origin !== url.origin) || (site && !['same-origin', 'none'].includes(site))) {
    fail(403, 'CROSS_ORIGIN', '不允许跨站请求。');
  }
  // CLI clients may omit Origin. Browser mutations must supply it.
  if (!['GET', 'HEAD'].includes(request.method) && site && !origin) {
    fail(403, 'CROSS_ORIGIN', '请求缺少来源信息。');
  }
}

export async function issueCookie(request: Request, env: Env) {
  const expiry = Date.now() + 3_600_000;
  const signature = await digest(env, 'session', `${expiry}:${env.UPLOAD_PASSWORD ?? ''}`);
  const local = isLocal(new URL(request.url)) && new URL(request.url).protocol === 'http:';
  return `${local ? DEV_COOKIE : COOKIE}=${expiry}.${signature}; Path=/; HttpOnly; SameSite=Strict; Max-Age=3600${local ? '' : '; Secure'}`;
}

export async function authenticated(request: Request, env: Env) {
  if (authMode(env) === 'google') return !!await googleIdentity(request, env);
  if (!policy(env).uploadPasswordRequired) return true;
  if (!env.UPLOAD_PASSWORD) return false;
  const cookieName = isLocal(new URL(request.url)) && new URL(request.url).protocol === 'http:' ? DEV_COOKIE : COOKIE;
  const value = request.headers.get('Cookie')?.split(';').map(s => s.trim()).find(s => s.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
  if (!value || !/^\d+\.[a-f0-9]{64}$/.test(value)) return false;
  const [expiry, signature] = value.split('.');
  if (Number(expiry) <= Date.now() || Number(expiry) > Date.now() + 3_600_000) return false;
  const expected = await digest(env, 'session', `${expiry}:${env.UPLOAD_PASSWORD}`);
  return crypto.subtle.timingSafeEqual(encoder.encode(signature), encoder.encode(expected));
}

export async function requireUploadAuth(request: Request, env: Env) {
  if (authMode(env) === 'google') googleSettings(env);
  if (policy(env).uploadPasswordRequired && !env.UPLOAD_PASSWORD) {
    fail(503, 'CONFIG_ERROR', '上传密码尚未配置，请联系管理员。');
  }
  if (!await authenticated(request, env)) fail(401, 'AUTH_REQUIRED', '请先验证上传权限。');
}

export function cookieValue(request: Request, name: string) {
  return request.headers.get('Cookie')?.split(';').map(s => s.trim()).find(s => s.startsWith(`${name}=`))?.slice(name.length + 1);
}

export const GOOGLE_COOKIE = '__Host-lite-drop-google';
async function googleSessionKey(env: Env) {
  const settings = googleSettings(env);
  return encoder.encode(await digest(env, 'google-session-key', JSON.stringify([settings.clientId, settings.redirect.href, settings.emails])));
}

export async function googleSessionCookie(env: Env, email: string, sub: string) {
  const token = await new SignJWT({ email }).setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(sub).setIssuer('lite-drop').setAudience(googleSettings(env).clientId)
    .setIssuedAt().setExpirationTime('1h').sign(await googleSessionKey(env));
  return `${GOOGLE_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=3600`;
}

export async function googleIdentity(request: Request, env: Env): Promise<string | null> {
  try {
    const settings = googleSettings(env);
    if (new URL(request.url).origin !== settings.redirect.origin) return null;
    const token = cookieValue(request, GOOGLE_COOKIE);
    if (!token || token.length > 4096) return null;
    const { payload } = await jwtVerify(token, await googleSessionKey(env), {
      algorithms: ['HS256'], issuer: 'lite-drop', audience: settings.clientId,
      requiredClaims: ['exp', 'iat', 'sub', 'email'], maxTokenAge: '1h',
    });
    return typeof payload.email === 'string' && settings.emails.includes(payload.email) ? payload.email : null;
  } catch { return null; }
}

export async function jsonBody<T>(request: Request): Promise<T> {
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) {
    fail(415, 'JSON_REQUIRED', '请求必须使用 JSON 格式。');
  }
  const reader = request.body?.getReader();
  if (!reader) fail(400, 'INVALID_JSON', '请求内容为空。');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 8192) {
        await reader.cancel();
        fail(413, 'BODY_TOO_LARGE', '请求内容过大。');
      }
      chunks.push(value);
    }
    const buffer = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.length; }
    const parsed: unknown = JSON.parse(new TextDecoder().decode(buffer));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid');
    return parsed as T;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    return fail(400, 'INVALID_JSON', '请求内容无效。');
  } finally { reader.releaseLock(); }
}

export function responseHeaders(extra?: HeadersInit) {
  const headers = new Headers(extra);
  headers.set('Cache-Control', 'no-store, private, max-age=0');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  headers.set('X-Frame-Options', 'SAMEORIGIN');
  return headers;
}

export const json = (body: unknown, status = 200, extra?: HeadersInit) => Response.json(body, { status, headers: responseHeaders(extra) });

export function errorResponse(error: unknown) {
  if (error instanceof HttpError) {
    return json({ error: error.code, message: error.message, ...(error.retryAfter ? { retryAfter: error.retryAfter } : {}) }, error.status,
      error.retryAfter ? { 'Retry-After': String(error.retryAfter) } : undefined);
  }
  // Never log raw exceptions: storage/runtime errors can contain object keys or tokens.
  console.error('lite-drop: internal operation failed');
  return json({ error: 'INTERNAL_ERROR', message: '服务暂时不可用，请稍后重试。' }, 503);
}
