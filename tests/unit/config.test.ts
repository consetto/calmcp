import { describe, expect, it } from 'vitest';
import { Config, httpSettingsFromEnv, transportFromEnv } from '../../src/config.js';
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

  it('accepts us20, added to every service spec in September 2025', () => {
    const config = Config.fromEnv({
      CALM_SANDBOX: 'false',
      CALM_TENANT: 'acme',
      CALM_REGION: 'us20',
      CALM_CLIENT_ID: 'id',
      CALM_CLIENT_SECRET: 'secret',
    });
    expect(config.region).toBe('us20');
  });

  it('authenticates an eu10-004 tenant at the eu10 token host', () => {
    const config = Config.fromEnv({
      CALM_SANDBOX: 'false',
      CALM_TENANT: 'acme',
      CALM_REGION: 'eu10-004',
      CALM_CLIENT_ID: 'id',
      CALM_CLIENT_SECRET: 'secret',
    });
    expect(config.tokenUrl()).toBe(
      'https://acme.authentication.eu10.hana.ondemand.com/oauth/token',
    );
    expect(config.apiBaseUrl()).toBe('https://acme.eu10-004.alm.cloud.sap/api');
  });

  it('lets CALM_AUTH_REGION override the token host region', () => {
    const config = Config.fromEnv({
      CALM_SANDBOX: 'false',
      CALM_TENANT: 'acme',
      CALM_REGION: 'eu10',
      CALM_AUTH_REGION: 'eu10-004',
      CALM_CLIENT_ID: 'id',
      CALM_CLIENT_SECRET: 'secret',
    });
    expect(config.tokenUrl()).toBe(
      'https://acme.authentication.eu10-004.hana.ondemand.com/oauth/token',
    );
  });

  it('rejects a CALM_AUTH_REGION that is not a region', () => {
    expect(() =>
      Config.fromEnv({
        CALM_SANDBOX: 'false',
        CALM_TENANT: 'acme',
        CALM_REGION: 'eu10',
        CALM_AUTH_REGION: 'evil.example.com/x',
        CALM_CLIENT_ID: 'id',
        CALM_CLIENT_SECRET: 'secret',
      }),
    ).toThrow(/CALM_AUTH_REGION/);
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

// A value the operator set but calmcp cannot honour stops the server at startup instead of being
// replaced by the default or read as false.
describe('Config.fromEnv refuses malformed values', () => {
  const oauth = {
    CALM_TENANT: 'acme',
    CALM_REGION: 'eu10',
    CALM_CLIENT_ID: 'id',
    CALM_CLIENT_SECRET: 'secret',
  };

  it.each([
    ['CALM_TIMEOUT_SECONDS', 'abc', /CALM_TIMEOUT_SECONDS must be a number between 1 and 600/],
    ['CALM_TIMEOUT_SECONDS', '0', /between 1 and 600, not 0/],
    ['CALM_TIMEOUT_SECONDS', '-5', /between 1 and 600/],
    ['CALM_MAX_RESPONSE_BYTES', '100kb', /CALM_MAX_RESPONSE_BYTES must be a whole number/],
    ['CALM_MAX_RESPONSE_BYTES', '1.5', /whole number/],
    ['CALM_MAX_RESPONSE_BYTES', '500', /at least 1000/],
    ['CALM_TOKEN_REFRESH_BUFFER_SECONDS', '-1', /between 0 and 3600/],
    ['CALM_WRITE_ENABLED', 'ture', /CALM_WRITE_ENABLED must be true or false/],
    ['CALM_UPDATE_ENABLED', 'on', /CALM_UPDATE_ENABLED must be true or false/],
    ['CALM_DEBUG', 'verbose', /CALM_DEBUG/],
    ['CALM_SANDBOX', 'maybe', /CALM_SANDBOX/],
  ])('%s=%s', (name, value, message) => {
    expect(() => Config.fromEnv({ ...oauth, [name]: value })).toThrow(message);
  });

  it.each([
    ['CALM_WRITE_ENABLED', 'TRUE', true],
    ['CALM_WRITE_ENABLED', ' yes ', true],
    ['CALM_WRITE_ENABLED', '1', true],
    ['CALM_WRITE_ENABLED', 'No', false],
    ['CALM_WRITE_ENABLED', '', false],
  ] as const)('accepts %s=%j', (name, value, expected) => {
    expect(Config.fromEnv({ ...oauth, [name]: value }).writeEnabled).toBe(expected);
  });

  it('treats a placeholder the MCPB host left unfilled as unset', () => {
    const config = Config.fromEnv({
      ...oauth,
      CALM_DEBUG: `\${user_config.calm_debug}`,
      CALM_TIMEOUT_SECONDS: `\${user_config.calm_timeout_seconds}`,
    });
    expect(config.debug).toBe(false);
    expect(config.timeoutSeconds).toBe(30);
  });

  it('keeps the defaults when nothing is set', () => {
    const config = Config.fromEnv(oauth);
    expect(config.timeoutSeconds).toBe(30);
    expect(config.maxResponseBytes).toBe(100_000);
    expect(config.tokenRefreshBufferSeconds).toBe(5);
  });

  it('accepts values inside the ranges', () => {
    const config = Config.fromEnv({
      ...oauth,
      CALM_TIMEOUT_SECONDS: '2.5',
      CALM_MAX_RESPONSE_BYTES: '250000',
      CALM_TOKEN_REFRESH_BUFFER_SECONDS: '0',
    });
    expect(config.timeoutSeconds).toBe(2.5);
    expect(config.maxResponseBytes).toBe(250_000);
    expect(config.tokenRefreshBufferSeconds).toBe(0);
  });
});

describe('transportFromEnv', () => {
  it.each([
    [{}, undefined, 'stdio'],
    [{ CALM_TRANSPORT: 'http' }, undefined, 'http'],
    [{ CALM_TRANSPORT: 'HTTP' }, undefined, 'http'],
    [{ CALM_TRANSPORT: 'stdio' }, undefined, 'stdio'],
    [{ CALM_TRANSPORT: 'stdio' }, true, 'http'],
  ] as const)('%j with --http=%s is %s', (env, cliHttp, expected) => {
    expect(transportFromEnv(env, cliHttp)).toBe(expected);
  });

  it('refuses an unknown transport instead of starting stdio', () => {
    expect(() => transportFromEnv({ CALM_TRANSPORT: 'https' })).toThrow(
      /CALM_TRANSPORT must be stdio or http/,
    );
  });
});

describe('httpSettingsFromEnv', () => {
  it('reads the HTTP variables', () => {
    const settings = httpSettingsFromEnv({
      PORT: '3000',
      CALM_HTTP_API_KEY: ' key ',
      CALM_CORS_ORIGINS: 'http://localhost:6274',
      CALM_DCR_SIGNING_SECRET: 'dcr',
      CALM_OAUTH_REDIRECT_PATTERNS: 'https://client.example.com/cb',
      CALM_HTTP_ALLOW_UNAUTHENTICATED: 'true',
    });
    expect(settings).toMatchObject({
      port: 3000,
      onCloudFoundry: false,
      allowUnauthenticated: true,
      apiKey: 'key',
      corsOrigins: ['http://localhost:6274'],
      dcrSigningSecret: 'dcr',
    });
    expect(settings.redirectPatterns).toContain('https://client.example.com/cb');
  });

  it('defaults to port 8080 and lets --port override PORT', () => {
    expect(httpSettingsFromEnv({}).port).toBe(8080);
    expect(httpSettingsFromEnv({ PORT: '3000' }, '4000').port).toBe(4000);
  });

  it.each([
    [{ PORT: 'eighty' }, undefined, /PORT must be a whole number/],
    [{ PORT: '70000' }, undefined, /between 1 and 65535/],
    [{}, 'abc', /--port must be a whole number/],
    [{ CALM_HTTP_ALLOW_UNAUTHENTICATED: 'sure' }, undefined, /CALM_HTTP_ALLOW_UNAUTHENTICATED/],
  ] as const)('refuses %j with --port=%s', (env, cliPort, message) => {
    expect(() => httpSettingsFromEnv(env, cliPort)).toThrow(message);
  });

  it('ignores the open-endpoint switch on Cloud Foundry', () => {
    const settings = httpSettingsFromEnv({
      VCAP_APPLICATION: '{}',
      CALM_HTTP_ALLOW_UNAUTHENTICATED: 'true',
    });
    expect(settings.onCloudFoundry).toBe(true);
    expect(settings.allowUnauthenticated).toBe(false);
  });
});
