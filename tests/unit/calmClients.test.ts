import { MockAgent, setGlobalDispatcher } from 'undici';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AuthContext, AuthProvider } from '../../src/auth/index.js';
import { CalmClients } from '../../src/calm/index.js';
import { Config } from '../../src/config.js';
import { createLogger } from '../../src/logging.js';

const ORIGIN = 'https://acme.eu10.alm.cloud.sap';

class StubAuth implements AuthProvider {
  async authorize(): Promise<AuthContext> {
    return { baseUrl: `${ORIGIN}/api`, headers: { Authorization: 'Bearer t' } };
  }
}

function makeClients() {
  const config = new Config({
    sandbox: false,
    tenant: 'acme',
    region: 'eu10',
    clientId: 'id',
    clientSecret: 'secret',
    debug: false,
    timeoutSeconds: 30,
    tokenRefreshBufferSeconds: 5,
  });
  return new CalmClients(new StubAuth(), config, createLogger(false));
}

describe('CalmClients', () => {
  let agent: MockAgent;

  beforeEach(() => {
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
  });

  afterEach(async () => {
    await agent.close();
  });

  it('listOData composes the entity-set URL with query options', async () => {
    agent
      .get(ORIGIN)
      .intercept({ path: '/api/calm-features/v1/Features?$filter=title%20eq%20%27x%27&$top=5' })
      .reply(200, { value: [{ uuid: '1' }] });

    const clients = makeClients();
    const result = await clients.listOData('features', 'Features', {
      filter: "title eq 'x'",
      top: 5,
    });
    expect(result.value).toHaveLength(1);
  });

  it('getOData composes a keyed URL with expand', async () => {
    agent
      .get(ORIGIN)
      .intercept({ path: '/api/calm-features/v1/Features/abc-123?$expand=toStatus' })
      .reply(200, { uuid: 'abc-123', title: 'F' });

    const clients = makeClients();
    const result = (await clients.getOData('features', 'Features', 'abc-123', 'toStatus')) as {
      uuid: string;
    };
    expect(result.uuid).toBe('abc-123');
  });

  it('getRest composes a REST URL on the tasks service', async () => {
    agent
      .get(ORIGIN)
      .intercept({ path: '/api/calm-tasks/v1/tasks?projectId=p1&type=CALMDEF' })
      .reply(200, [{ id: 'd1', type: 'CALMDEF' }]);

    const clients = makeClients();
    const result = (await clients.getRest(
      'tasks',
      '/tasks',
      '?projectId=p1&type=CALMDEF',
    )) as unknown[];
    expect(result).toHaveLength(1);
  });

  it('routes analytics to its OData base path', async () => {
    agent
      .get(ORIGIN)
      .intercept({ path: '/api/calm-analytics/v1/odata/v4/analytics/Defects?$top=10' })
      .reply(200, { value: [] });

    const clients = makeClients();
    const result = await clients.listOData('analytics', 'Defects', { top: 10 });
    expect(result.value).toEqual([]);
  });
});
