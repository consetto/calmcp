import { describe, expect, it } from 'vitest';
import { Config } from '../../src/config.js';
import { ConfigError } from '../../src/errors.js';

// Verifies OAuth2 + sandbox URL construction and configuration validation.
describe('Config URL construction', () => {
  it('builds productive OAuth2 URLs', () => {
    const config = new Config({
      sandbox: false,
      tenant: 'mycompany',
      region: 'eu10',
      clientId: 'test-client',
      clientSecret: 'test-secret',
      debug: false,
      timeoutSeconds: 30,
      tokenRefreshBufferSeconds: 5,
    });

    expect(config.tokenUrl()).toBe(
      'https://mycompany.authentication.eu10.hana.ondemand.com/oauth/token',
    );
    expect(config.apiBaseUrl()).toBe('https://mycompany.eu10.alm.cloud.sap/api');
    expect(config.serviceUrl('features')).toBe(
      'https://mycompany.eu10.alm.cloud.sap/api/calm-features/v1',
    );
    expect(config.serviceUrl('analytics')).toBe(
      'https://mycompany.eu10.alm.cloud.sap/api/calm-analytics/v1/odata/v4/analytics',
    );
  });

  it('builds sandbox URLs without an /api prefix', () => {
    const config = new Config({
      sandbox: true,
      apiKey: 'test-api-key',
      debug: true,
      timeoutSeconds: 30,
      tokenRefreshBufferSeconds: 5,
    });

    expect(config.tokenUrl()).toBeUndefined();
    expect(config.apiBaseUrl()).toBe('https://sandbox.api.sap.com/SAPCALM');
    expect(config.serviceUrl('features')).toBe(
      'https://sandbox.api.sap.com/SAPCALM/calm-features/v1',
    );
    expect(config.serviceUrl('tasks')).toBe('https://sandbox.api.sap.com/SAPCALM/calm-tasks/v1');
  });
});

describe('Config.fromEnv validation', () => {
  const base = { CALM_TIMEOUT_SECONDS: '30' };

  it('requires api_key in sandbox mode', () => {
    expect(() => Config.fromEnv({ ...base, CALM_SANDBOX: 'true' })).toThrow(ConfigError);
  });

  it('requires tenant/region/client in OAuth2 mode', () => {
    expect(() => Config.fromEnv({ ...base, CALM_SANDBOX: 'false' })).toThrow(/tenant/);
  });

  it('rejects an unknown region', () => {
    expect(() =>
      Config.fromEnv({
        CALM_SANDBOX: 'false',
        CALM_TENANT: 'acme',
        CALM_REGION: 'mars99',
        CALM_CLIENT_ID: 'id',
        CALM_CLIENT_SECRET: 'secret',
      }),
    ).toThrow(/Invalid region/);
  });

  it('accepts a valid OAuth2 environment', () => {
    const config = Config.fromEnv({
      CALM_SANDBOX: 'false',
      CALM_TENANT: 'acme',
      CALM_REGION: 'eu10',
      CALM_CLIENT_ID: 'id',
      CALM_CLIENT_SECRET: 'secret',
    });
    expect(config.tenant).toBe('acme');
    expect(config.timeoutSeconds).toBe(30);
  });

  it('skips local credential checks when a destination is bound', () => {
    const config = Config.fromEnv({ CALM_DESTINATION_NAME: 'SAP_CALM', CALM_SANDBOX: 'false' });
    expect(config.destinationName).toBe('SAP_CALM');
  });
});
