import { MockAgent, setGlobalDispatcher } from 'undici';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AuthContext, AuthProvider } from '../../src/auth/index.js';
import { CalmHttpClient, parseErrorResponse } from '../../src/calm/httpClient.js';
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
