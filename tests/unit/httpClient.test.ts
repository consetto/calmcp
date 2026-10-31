import { MockAgent, setGlobalDispatcher } from 'undici';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AuthContext, AuthProvider } from '../../src/auth/index.js';
import { CalmHttpClient, parseErrorResponse } from '../../src/calm/httpClient.js';
import { forbiddenHint } from '../../src/calm/scopes.js';
import { ApiError } from '../../src/errors.js';
import { createLogger } from '../../src/logging.js';

const ORIGIN = 'https://acme.eu10.alm.cloud.sap';

/** Minimal auth provider returning a fixed base URL and bearer header. */
class StubAuth implements AuthProvider {
  async authorize(): Promise<AuthContext> {
    return { baseUrl: `${ORIGIN}/api`, headers: { Authorization: 'Bearer test-token' } };
  }
}

function makeClient() {
  return new CalmHttpClient(new StubAuth(), 'features', {
    timeoutMs: 5000,
    logger: createLogger(false),
  });
}

describe('CalmHttpClient', () => {
  let agent: MockAgent;

  beforeEach(() => {
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
  });

  afterEach(async () => {
    await agent.close();
  });

  it('issues a GET to the composed service URL and parses JSON', async () => {
    agent
      .get(ORIGIN)
      .intercept({ path: '/api/calm-features/v1/Features?$top=2', method: 'GET' })
      .reply(200, { value: [{ uuid: '1' }, { uuid: '2' }] });

    const client = makeClient();
    const result = await client.get<{ value: { uuid: string }[] }>('/Features', '?$top=2');
    expect(result.value).toHaveLength(2);
    expect(result.value[0]?.uuid).toBe('1');
  });

  it('sends the auth header from the provider', async () => {
    agent
      .get(ORIGIN)
      .intercept({
        path: '/api/calm-features/v1/Features',
        method: 'GET',
        headers: { authorization: 'Bearer test-token' },
      })
      .reply(200, { value: [] });

    const client = makeClient();
    const result = await client.get<{ value: unknown[] }>('/Features');
    expect(result.value).toEqual([]);
  });

  it('maps an OData structured error to ApiError', async () => {
    agent
      .get(ORIGIN)
      .intercept({ path: '/api/calm-features/v1/Features', method: 'GET' })
      .reply(400, { error: { code: 'INVALID', message: 'bad filter' } });

    const client = makeClient();
    await expect(client.get('/Features')).rejects.toMatchObject({
      message: expect.stringContaining('INVALID'),
      status: 400,
    });
  });

  it('maps a plain HTTP error to ApiError', async () => {
    agent
      .get(ORIGIN)
      .intercept({ path: '/api/calm-features/v1/Features', method: 'GET' })
      .reply(503, 'service unavailable');

    const client = makeClient();
    await expect(client.get('/Features')).rejects.toBeInstanceOf(ApiError);
  });

  it('names the missing read scope on a 403', async () => {
    agent
      .get(ORIGIN)
      .intercept({ path: '/api/calm-features/v1/Features', method: 'GET' })
      .reply(403, 'Forbidden');

    const error = await makeClient()
      .get('/Features')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).hint).toContain('calm-api.features.read');
  });
});

describe('forbiddenHint', () => {
  it('asks for the write scope on a create', () => {
    expect(forbiddenHint('documents', 'POST')).toContain('calm-api.documents.write');
    expect(forbiddenHint('documents', 'GET')).toContain('calm-api.documents.read');
  });

  it('mentions the private and protected project scopes where they apply', () => {
    expect(forbiddenHint('analytics', 'GET')).toContain('calm-api.projects.private.read');
    expect(forbiddenHint('features', 'GET')).not.toContain('private');
  });
});

describe('parseErrorResponse', () => {
  it('prefers the OData envelope', () => {
    const err = parseErrorResponse(404, '{"error":{"code":"NF","message":"not found"}}');
    expect(err.message).toContain('NF');
    expect(err.status).toBe(404);
  });

  it('falls back to a plain HTTP error for non-JSON', () => {
    const err = parseErrorResponse(500, 'boom');
    expect(err.message).toContain('500');
    expect(err.message).toContain('boom');
  });
});

describe('CalmHttpClient token renewal and body limit', () => {
  let agent: MockAgent;

  beforeEach(() => {
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
  });

  afterEach(async () => {
    await agent.close();
  });

  /** An auth provider with a token cache, counting how often it was told to drop the token. */
  class RenewingAuth implements AuthProvider {
    invalidated = 0;
    async authorize(): Promise<AuthContext> {
      return {
        baseUrl: `${ORIGIN}/api`,
        headers: { Authorization: `Bearer token-${this.invalidated}` },
      };
    }
    invalidate(): void {
      this.invalidated += 1;
    }
  }
  const renewingClient = (auth: AuthProvider) =>
    new CalmHttpClient(auth, 'features', { timeoutMs: 5000, logger: createLogger(false) });

  it('retries once with a new token when Cloud ALM refuses the cached one', async () => {
    const pool = agent.get(ORIGIN);
    pool
      .intercept({
        path: '/api/calm-features/v1/Features',
        headers: { authorization: 'Bearer token-0' },
      })
      .reply(401, 'expired');
    pool
      .intercept({
        path: '/api/calm-features/v1/Features',
        headers: { authorization: 'Bearer token-1' },
      })
      .reply(200, { value: [] });
    const auth = new RenewingAuth();
    await expect(renewingClient(auth).get('/Features')).resolves.toEqual({ value: [] });
    expect(auth.invalidated).toBe(1);
  });

  it('gives up after one renewal, so a wrong secret fails fast', async () => {
    const pool = agent.get(ORIGIN);
    pool.intercept({ path: '/api/calm-features/v1/Documents', method: 'POST' }).reply(401, 'no');
    pool.intercept({ path: '/api/calm-features/v1/Documents', method: 'POST' }).reply(401, 'no');
    const auth = new RenewingAuth();
    const error = await renewingClient(auth)
      .post('/Documents', { title: 'x' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(401);
    expect(auth.invalidated).toBe(1);
  });

  it('refuses a body larger than it reads, before parsing it', async () => {
    agent
      .get(ORIGIN)
      .intercept({ path: '/api/calm-features/v1/Features' })
      .reply(200, 'x'.repeat(33 * 1024 * 1024));
    const error = await makeClient()
      .get('/Features')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).tooLarge).toBe(true);
  });
});
