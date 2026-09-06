import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: './wrangler.jsonc' },
    miniflare: { bindings: {
      APP_SECRET: 'test-only-application-secret-do-not-use-in-production-123456789',
      UPLOAD_PASSWORD: 'test-upload-password',
      UPLOAD_AUTH_MODE: 'password',
    } },
  })],
  test: { include: ['tests/**/*.test.ts'], testTimeout: 20_000, hookTimeout: 20_000, fileParallelism: false },
});
