// Token renewal of the destination provider after Cloud ALM refused a token (401).
//
// The Cloud SDK is replaced by a fake that behaves like it in the one way that matters here: a
// cached lookup returns the token cached earlier, and a lookup with `useCache: false` returns the
// Destination service's current token WITHOUT writing it back to the cache.

import { MockAgent, setGlobalDispatcher } from 'undici';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({
  /** Token the SDK cache holds. */
  cachedToken: 'old',
  /** Token the Destination service hands out now. */
  serviceToken: 'old',
  /** Lifetime the Destination service states for its token, in seconds. */
  expiresIn: '3600' as string | undefined,
  lookups: [] as boolean[],
}));

vi.mock('@sap-cloud-sdk/connectivity', () => ({
  getDestination: async ({ useCache }: { useCache: boolean }) => {
    sdk.lookups.push(useCache);
    const token = useCache ? sdk.cachedToken : sdk.serviceToken;
    return {
      name: 'SAP_CALM',
      url: 'https://acme.eu10.alm.cloud.sap/api/',
      authTokens: [{ value: token, expiresIn: sdk.expiresIn }],
    };
  },
  buildHeadersForDestination: async (destination: { authTokens: { value: string }[] }) => ({
    authorization: `Bearer ${destination.authTokens[0]?.value}`,
  }),
}));

const { DestinationAuthProvider } = await import('../../src/auth/destination.js');
const { CalmHttpClient } = await import('../../src/calm/httpClient.js');
const { createLogger } = await import('../../src/logging.js');

const logger = createLogger(false);
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** The secret was rotated: the service now issues "new", the SDK cache still holds "old". */
function rotate() {
  sdk.serviceToken = 'new';
}

beforeEach(() => {
  sdk.cachedToken = 'old';
  sdk.serviceToken = 'old';
  sdk.expiresIn = '3600';
  sdk.lookups = [];
});

describe('DestinationAuthProvider', () => {
  it('uses the cached destination while nothing was refused', async () => {
    const provider = new DestinationAuthProvider('SAP_CALM', logger);
    const ctx = await provider.authorize();
    expect(ctx).toEqual({ baseUrl: 'https://acme.eu10.alm.cloud.sap/api', headers: bearer('old') });
    expect(sdk.lookups).toEqual([true]);
  });

  it('gives every waiting call the fresh token after a refusal, with one uncached lookup', async () => {
    const provider = new DestinationAuthProvider('SAP_CALM', logger);
    const refused = await provider.authorize();
    rotate();
    provider.invalidate(refused);

    const [a, b] = await Promise.all([provider.authorize(), provider.authorize()]);
    expect(a.headers).toEqual(bearer('new'));
    expect(b.headers).toEqual(bearer('new'));
    expect(sdk.lookups.filter((useCache) => !useCache)).toHaveLength(1);
  });

  it('keeps the fresh token while the SDK cache still holds the refused one', async () => {
    const provider = new DestinationAuthProvider('SAP_CALM', logger);
    provider.invalidate(await provider.authorize());
    rotate();
    await provider.authorize();
    sdk.lookups = [];

    expect((await provider.authorize()).headers).toEqual(bearer('new'));
    expect((await provider.authorize()).headers).toEqual(bearer('new'));
    expect(sdk.lookups).toEqual([]);
  });

  it('keeps the fresh token when a request sent before the renewal is refused late', async () => {
    const provider = new DestinationAuthProvider('SAP_CALM', logger);
    const old = await provider.authorize();
    rotate();
    provider.invalidate(old);
    await provider.authorize();
    sdk.lookups = [];

    provider.invalidate(old);
    expect((await provider.authorize()).headers).toEqual(bearer('new'));
    expect(sdk.lookups).toEqual([]);
  });

  it('renews again when the fresh token is refused too', async () => {
    const provider = new DestinationAuthProvider('SAP_CALM', logger);
    provider.invalidate(await provider.authorize());
    rotate();
    const fresh = await provider.authorize();
    sdk.serviceToken = 'newer';
    sdk.cachedToken = 'new';

    provider.invalidate(fresh);
    expect((await provider.authorize()).headers).toEqual(bearer('newer'));
  });

  it('returns to the SDK cache once the fresh token has expired', async () => {
    sdk.expiresIn = '10'; // shorter than the safety margin: kept for no time at all
    const provider = new DestinationAuthProvider('SAP_CALM', logger);
    provider.invalidate(await provider.authorize());
    rotate();
    await provider.authorize();
    sdk.cachedToken = 'new'; // the SDK cache expired and fetched the new token itself
    sdk.lookups = [];

    expect((await provider.authorize()).headers).toEqual(bearer('new'));
    expect(sdk.lookups).toEqual([true]);
  });
});

describe('CalmHttpClient with a destination after a secret rotation', () => {
  let agent: MockAgent;
  beforeEach(() => {
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
  });
  afterEach(async () => {
    agent.assertNoPendingInterceptors();
    await agent.close();
  });

  it('retries both of two concurrent refused requests with the fresh token', async () => {
    const pool = agent.get('https://acme.eu10.alm.cloud.sap');
    const path = '/api/calm-tasks/v1/workstreams';
    pool
      .intercept({ path, headers: bearer('old') })
      .reply(401, '')
      .times(2);
    pool
      .intercept({ path, headers: bearer('new') })
      .reply(200, [])
      .times(2);

    const provider = new DestinationAuthProvider('SAP_CALM', logger);
    await provider.authorize(); // the old token is in the cache
    rotate();
    const client = new CalmHttpClient(provider, 'tasks', { timeoutMs: 5000, logger });

    await expect(
      Promise.all([client.get('/workstreams'), client.get('/workstreams')]),
    ).resolves.toEqual([[], []]);
  });

  it('sends later requests with the fresh token, without another refusal', async () => {
    const pool = agent.get('https://acme.eu10.alm.cloud.sap');
    const path = '/api/calm-tasks/v1/workstreams';
    pool.intercept({ path, headers: bearer('old') }).reply(401, '');
    pool
      .intercept({ path, headers: bearer('new') })
      .reply(200, [])
      .times(3);

    const provider = new DestinationAuthProvider('SAP_CALM', logger);
    rotate();
    const client = new CalmHttpClient(provider, 'tasks', { timeoutMs: 5000, logger });

    await client.get('/workstreams');
    await client.get('/workstreams');
    await client.get('/workstreams');
  });
});
