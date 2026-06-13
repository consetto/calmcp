// Integration test against a live SAP Cloud ALM tenant. Skipped automatically when no credentials
// are present, so the suite stays green in CI without secrets. Provide either:
//   - CALM_SANDBOX=true + CALM_API_KEY=<key>, or
//   - CALM_TENANT/CALM_REGION/CALM_CLIENT_ID/CALM_CLIENT_SECRET.
// Run with: npm run test:integration

import { describe, expect, it } from 'vitest';
import { createAuthProvider } from '../../src/auth/index.js';
import { CalmClients } from '../../src/calm/index.js';
import { Config } from '../../src/config.js';
import { createLogger } from '../../src/logging.js';

const hasCredentials =
  (process.env.CALM_SANDBOX === 'true' && !!process.env.CALM_API_KEY) ||
  (!!process.env.CALM_TENANT && !!process.env.CALM_CLIENT_ID && !!process.env.CALM_CLIENT_SECRET);

describe.skipIf(!hasCredentials)('live Cloud ALM', () => {
  function makeClients() {
    const config = Config.fromEnv();
    const logger = createLogger(config.debug);
    return new CalmClients(createAuthProvider(config, logger), config, logger);
  }

  it('lists features (top 1)', async () => {
    const clients = makeClients();
    const result = await clients.listOData('features', 'Features', { top: 1 });
    expect(Array.isArray(result.value)).toBe(true);
  });

  it('lists projects', async () => {
    const clients = makeClients();
    const result = await clients.getRest('projects', '/projects');
    expect(result).toBeDefined();
  });
});
