import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { createHash, randomInt } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const base = process.env.LITE_DROP_URL || 'http://127.0.0.1:8787';
const output = new URL('../test-results/', import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
const errors = [];
const sessions = [];
const report = { target: new URL(base).origin, passed: false, checks: [], screenshots: [] };
const sha = buffer => createHash('sha256').update(buffer).digest('hex');
const screenshotPath = name => fileURLToPath(new URL(name, output));
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  const page = await context.newPage();
  page.on('response', async response => {
    if (new URL(response.url()).pathname === '/api/uploads' && response.request().method() === 'POST' && response.status() === 201) {
      try { sessions.push(await response.json()); } catch { /* An interrupted initialization expires server-side. */ }
    }
  });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && /Content Security Policy|Refused to/i.test(message.text())) errors.push(message.text()); });
  await page.goto(base);
  await page.locator('#download-panel').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#download-tab').getAttribute('aria-selected'), 'true');
  await page.screenshot({ path: screenshotPath('desktop-download.png'), fullPage: true });
  report.screenshots.push('desktop-download.png');
  report.checks.push('default download panel');
  await page.locator('#upload-tab').click();
  if (await page.locator('#auth-form').isVisible()) {
    let password = process.env.LITE_DROP_PASSWORD;
    if (!password && ['localhost', '127.0.0.1'].includes(new URL(base).hostname)) {
      password = (await readFile(new URL('../.dev.vars', import.meta.url), 'utf8')).match(/^UPLOAD_PASSWORD="([^"\r\n]*)"/m)?.[1];
    }
    assert.ok(password, 'LITE_DROP_PASSWORD is required');
    await page.locator('#upload-password').fill(password);
    await page.locator('#auth-button').click();
  }
  await page.locator('#upload-form').waitFor({ state: 'visible' });
  await page.screenshot({ path: screenshotPath('desktop-upload.png'), fullPage: true });
  report.screenshots.push('desktop-upload.png');
  const code = String(randomInt(100_000_000)).padStart(8, '0');
  await page.locator('#send-code').fill(code);
  const content = Buffer.alloc(9_000_123, 67);
  Buffer.from('真实浏览器分片上传验证').copy(content);
  let retried = false;
  await page.route('**/api/uploads/*/parts/*', async route => {
    if (!retried) {
      retried = true;
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'SIMULATED_OUTAGE', message: '模拟一次可重试故障' }) });
    } else await route.continue();
  });
  await page.locator('#file-input').setInputFiles({ name: '投送测试.bin', mimeType: 'application/octet-stream', buffer: content });
  await page.locator('#upload-button').click();
  await page.locator('#upload-success').waitFor({ state: 'visible', timeout: 90_000 });
  assert.equal(await page.locator('#success-code').textContent(), code);
  assert.equal(retried, true);
  await page.unroute('**/api/uploads/*/parts/*');
  report.checks.push('password authentication, failed-part retry and 9 MB multipart upload');
  await page.screenshot({ path: screenshotPath('upload-success.png'), fullPage: true });
  report.screenshots.push('upload-success.png');
  await page.locator('#download-tab').click();
  await page.locator('#receive-code').fill(code);
  const downloadPromise = page.waitForEvent('download', { timeout: 30_000 });
  await page.locator('#download-button').click();
  const downloaded = await downloadPromise;
  assert.equal(downloaded.suggestedFilename(), '投送测试.bin');
  const path = await downloaded.path();
  assert.equal(sha(await readFile(path)), sha(content));
  report.checks.push('native browser download, Chinese filename and SHA-256 integrity');

  await page.route('**/api/downloads/prepare', route => route.fulfill({
    status: 429,
    contentType: 'application/json',
    headers: { 'Retry-After': '3600' },
    body: JSON.stringify({ error: 'SITE_QUOTA_EXCEEDED', message: '站点今日下载额度已用完', retryAfter: 3600 }),
  }));
  await page.locator('#download-button').click();
  await page.waitForFunction(() => document.getElementById('download-message').textContent.includes('恢复时间'));
  assert.equal(await page.locator('#download-button').isEnabled(), true);
  await page.unroute('**/api/downloads/prepare');
  report.checks.push('simulated site quota response shows reset time without a password/code lock');

  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const mobilePage = await mobile.newPage();
  await mobilePage.goto(base);
  await mobilePage.locator('#download-panel').waitFor({ state: 'visible' });
  assert.equal(await mobilePage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await mobilePage.screenshot({ path: screenshotPath('mobile-download.png'), fullPage: true });
  await mobilePage.locator('#upload-tab').click();
  await mobilePage.screenshot({ path: screenshotPath('mobile-auth.png'), fullPage: true });
  report.screenshots.push('mobile-download.png', 'mobile-auth.png');
  report.checks.push('390 px mobile layout with no horizontal overflow');

  await page.locator('#upload-tab').click();
  await page.locator('#another-upload').click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: screenshotPath('mobile-upload.png'), fullPage: true });
  report.screenshots.push('mobile-upload.png');
  const held = [];
  await page.route('**/api/uploads/*/parts/*', route => { held.push(route); });
  await page.locator('#file-input').setInputFiles({ name: '取消测试.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(10_000_000) });
  const partStarted = page.waitForRequest(request => /\/parts\/\d+$/.test(new URL(request.url()).pathname));
  await page.locator('#upload-button').click();
  await partStarted;
  await page.locator('#cancel-upload').click();
  for (const route of held) await route.abort().catch(() => undefined);
  await page.unroute('**/api/uploads/*/parts/*');
  await page.waitForFunction(() => document.getElementById('upload-message').textContent.includes('已取消投送'));
  assert.equal(await page.locator('#upload-fields').isEnabled(), true);
  report.checks.push('cancel an in-flight upload and restore editable form');

  await page.locator('#download-tab').click();

  await page.locator('#download-button').click();
  await page.locator('#download-message.error').waitFor();
  assert.equal(await page.locator('#download-button').isDisabled(), true);
  await page.reload();
  await page.locator('#download-panel').waitFor({ state: 'visible' });
  assert.match(await page.locator('#download-button').textContent(), /秒后重试/);
  report.checks.push('exhausted code locks immediately and survives a page refresh');
  if (await mobilePage.locator('#auth-form').isVisible()) {
    await mobilePage.locator('#upload-password').fill('incorrect-test-password');
    await mobilePage.locator('#auth-button').click();
    await mobilePage.locator('#auth-message.error').waitFor();
    await mobilePage.reload();
    await mobilePage.locator('#download-panel').waitFor({ state: 'visible' });
    await mobilePage.locator('#upload-tab').click();
    assert.match(await mobilePage.locator('#auth-button').textContent(), /秒后重试/);
    report.checks.push('wrong upload password locks across reload independently of download lock');
  }
  assert.deepEqual(errors, []);
  report.checks.push('no JavaScript exceptions or CSP violations');
  report.passed = true;
} finally {
  for (const session of sessions) {
    await fetch(`${base.replace(/\/$/, '')}/api/uploads/${session.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${session.token}` } }).catch(() => undefined);
  }
  await browser.close();
  const result = { ...report, errors, checkedAt: new Date().toISOString() };
  await writeFile(new URL('browser.json', output), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
