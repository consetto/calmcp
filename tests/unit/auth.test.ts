import { MockAgent, setGlobalDispatcher } from 'undici';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClientCredentialsAuthProvider } from '../../src/auth/clientCredentials.js';
import { DestinationAuthProvider } from '../../src/auth/destination.js';
import { createAuthProvider } from '../../src/auth/index.js';
import { Config } from '../../src/config.js';
import { createLogger } from '../../src/logging.js';

const logger = createLogger(false);

function oauthConfig() {
  return new Config({
    sandbox: false,
    tenant: 'acme',
    region: 'eu10',
    clientId: 'id',
    clientSecret: 'secret',
    debug: false,
    timeoutSeconds: 30,
    tokenRefreshBufferSeconds: 5,
  });
}

describe('ClientCredentialsAuthProvider', () => {
  it('returns an APIKey header in sandbox mode without any HTTP call', async () => {
    const config = new Config({
      sandbox: true,
      apiKey: 'sk-123',
      debug: false,
      timeoutSeconds: 30,
      tokenRefreshBufferSeconds: 5,
    });
    const provider = new ClientCredentialsAuthProvider(config, logger);
    const ctx = await provider.authorize();
    expect(ctx.baseUrl).toBe('https://sandbox.api.sap.com/SAPCALM');
    expect(ctx.headers).toEqual({ APIKey: 'sk-123' });
  });

  describe('OAuth2 token flow', () => {
    let agent: MockAgent;

    beforeEach(() => {
      agent = new MockAgent();
      agent.disableNetConnect();
      setGlobalDispatcher(agent);
    });

    afterEach(async () => {
      await agent.close();
    });

    it('fetches and caches a bearer token', async () => {
      const pool = agent.get('https://acme.authentication.eu10.hana.ondemand.com');
      // Intercept exactly once; a second authorize() must hit the cache, not the network.
      pool
        .intercept({ path: '/oauth/token', method: 'POST' })
        .reply(200, { access_token: 'tok-abc', expires_in: 3600 });

      const provider = new ClientCredentialsAuthProvider(oauthConfig(), logger);

      const first = await provider.authorize();
      expect(first.baseUrl).toBe('https://acme.eu10.alm.cloud.sap/api');
      expect(first.headers).toEqual({ Authorization: 'Bearer tok-abc' });

      // No second interceptor registered → if this made a request, MockAgent would throw.
      const second = await provider.authorize();
      expect(second.headers).toEqual({ Authorization: 'Bearer tok-abc' });
    });

    it('throws AuthError on a failed token request', async () => {
      agent
        .get('https://acme.authentication.eu10.hana.ondemand.com')
        .intercept({ path: '/oauth/token', method: 'POST' })
        .reply(401, 'invalid_client');

      const provider = new ClientCredentialsAuthProvider(oauthConfig(), logger);
      await expect(provider.authorize()).rejects.toThrow(/401/);
    });
  });
});

describe('createAuthProvider', () => {
  it('selects the destination provider when one is bound', () => {
    const config = Config.fromEnv({ CALM_DESTINATION_NAME: 'SAP_CALM' });
    expect(createAuthProvider(config, logger)).toBeInstanceOf(DestinationAuthProvider);
  });

  it('selects local credentials otherwise', () => {
    expect(createAuthProvider(oauthConfig(), logger)).toBeInstanceOf(ClientCredentialsAuthProvider);
  });
});
