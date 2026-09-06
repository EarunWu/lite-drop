import { createHash, randomInt } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';

const base = (process.env.LITE_DROP_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
const size = Number(process.env.LITE_DROP_BYTES || 500_000_000);
if (!Number.isSafeInteger(size) || size < 0 || size > 500_000_000) throw new Error('LITE_DROP_BYTES must be between 0 and 500000000');
let cookie = '';
let session;
const started = Date.now();

async function call(path, method = 'GET', body, extra = {}) {
  const headers = { ...extra, ...(cookie ? { Cookie: cookie } : {}) };
  if (body && !Buffer.isBuffer(body)) { body = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
  const response = await fetch(`${base}${path}`, { method, headers, body });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  return response;
}

try {
  const config = await (await call('/api/config')).json();
  if (config.uploadPasswordRequired) {
    let password = process.env.LITE_DROP_PASSWORD;
    if (!password && ['127.0.0.1', 'localhost'].includes(new URL(base).hostname)) {
      const local = await readFile(new URL('../.dev.vars', import.meta.url), 'utf8');
      password = local.match(/^UPLOAD_PASSWORD="([^"\r\n]*)"/m)?.[1];
    }
    if (!password) throw new Error('Set LITE_DROP_PASSWORD for the target test deployment.');
    const auth = await call('/api/upload-auth', 'POST', { password });
    cookie = auth.headers.get('set-cookie')?.split(';')[0] || '';
  }
  const code = String(randomInt(100_000_000)).padStart(8, '0');
  session = await (await call('/api/uploads', 'POST', { name: 'lite-drop-500mb-test.bin', code, size, downloads: 1, ttlSeconds: 300 })).json();
  const expected = createHash('sha256');
  // Reproducible data; memory stays bounded to a few parts, even at 500 MB.
  for (let offset = 0, part = 1; offset < size; offset += session.partSize, part++) {
    expected.update(Buffer.alloc(Math.min(session.partSize, size - offset), part % 251));
  }
  let next = 1;
  let uploaded = 0;
  let lastReport = 0;
  const uploadWorker = async () => {
    while (next <= session.partCount) {
      const number = next++;
      const length = Math.min(session.partSize, size - (number - 1) * session.partSize);
      const chunk = Buffer.alloc(length, number % 251);
      await call(`/api/uploads/${session.id}/parts/${number}`, 'PUT', chunk, { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/octet-stream' });
      uploaded += length;
      if (Date.now() - lastReport >= 3000 || uploaded === size) { console.log(`Uploaded ${uploaded}/${size} bytes`); lastReport = Date.now(); }
    }
  };
  // Wait for every stream before cleanup if one part fails.
  const uploads = await Promise.allSettled(Array.from({ length: Math.min(3, session.partCount) }, uploadWorker));
  const failure = uploads.find(result => result.status === 'rejected');
  if (failure) throw failure.reason;
  await call(`/api/uploads/${session.id}/complete`, 'POST', {}, { Authorization: `Bearer ${session.token}` });
  const { ticket } = await (await call('/api/downloads/prepare', 'POST', { code })).json();
  const response = await call(`/api/downloads/${ticket}`);
  const actual = createHash('sha256');
  let downloaded = 0;
  for await (const chunk of response.body) { actual.update(chunk); downloaded += chunk.length; }
  const digest = actual.digest('hex');
  if (downloaded !== size || digest !== expected.digest('hex')) throw new Error('Byte count or SHA-256 mismatch');
  const report = { target: new URL(base).origin, bytes: size, sha256: digest, elapsedSeconds: (Date.now() - started) / 1000, passed: true, checkedAt: new Date().toISOString() };
  await mkdir(new URL('../test-results/', import.meta.url), { recursive: true });
  await writeFile(new URL('../test-results/large-file.json', import.meta.url), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (session) await call(`/api/uploads/${session.id}`, 'DELETE', undefined, { Authorization: `Bearer ${session.token}` }).catch(() => undefined);
}
