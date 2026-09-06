// Public production checks: no Google account access and no file creation.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
const base = process.env.LITE_DROP_URL;
if (!base) throw new Error('Set LITE_DROP_URL to your Google-mode test deployment.');
await mkdir('test-results', { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const checks = [];
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(base);
  await page.locator('#download-panel').waitFor({ state: 'visible' });
  const config = await (await page.request.get(`${base}/api/config`)).json();
  assert.equal(config.uploadAuthMode, 'google'); assert.equal(config.uploadConfigured, true);
  assert.equal(config.uploadAuthenticated, false); assert.equal(config.uploadPasswordRequired, false);
  checks.push('Google mode configured; fresh browser has no upload permission; download is the default');
  for (const path of ['/api/uploads', '/api/upload-auth']) {
    const response = await page.request.post(`${base}${path}`, { headers: { Origin: base }, data: { password: 'unused' } });
    assert.equal(response.status(), path === '/api/uploads' ? 401 : 403);
  }
  checks.push('Unauthenticated upload returns 401; password endpoint returns 403');
  await page.locator('#upload-tab').click();
  await page.locator('#google-auth').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#auth-form').isVisible(), false);
  assert.equal(await page.locator('#upload-form').isVisible(), false);
  assert.equal(await page.locator('#google-button').isEnabled(), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: 'test-results/google-mobile-login.png', fullPage: true });
  checks.push('390px Google login layout has no horizontal overflow or password form');
  await page.goto(`${base}/privacy.html`);
  await page.getByRole('heading', { name: '隐私说明', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  checks.push('Privacy page works on mobile; no frontend errors');
  const report = { target: base, checkedAt: new Date().toISOString(), passed: true, checks };
  await writeFile('test-results/google-ui.production.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); }
