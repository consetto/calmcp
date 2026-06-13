import { MockAgent, setGlobalDispatcher } from 'undici';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AuthContext, AuthProvider } from '../../src/auth/index.js';
import { CalmClients } from '../../src/calm/index.js';
import { Config } from '../../src/config.js';
import { createLogger } from '../../src/logging.js';
import { handleCalmAnalytics } from '../../src/tools/calmAnalytics.js';
import { handleCalmGet } from '../../src/tools/calmGet.js';
import { handleCalmList } from '../../src/tools/calmList.js';
import { handleCalmResources } from '../../src/tools/calmResources.js';

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

/** Parse the JSON text block from a tool result. */
function parse(result: { content: { text: string }[] }): unknown {
  return JSON.parse(result.content[0]?.text ?? 'null');
}

describe('handleCalmList', () => {
  let agent: MockAgent;
  beforeEach(() => {
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
  });
  afterEach(async () => {
    await agent.close();
  });

  it('rejects an unknown resource without a network call', async () => {
    const result = await handleCalmList(makeClients(), { resource: 'nope' });
    expect(result.isError).toBe(true);
  });

  it('enforces required params for REST resources (tasks needs project_id)', async () => {
    const result = await handleCalmList(makeClients(), { resource: 'tasks' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('project_id');
  });

  it('lists defects via the tasks resource with task_type=CALMDEF', async () => {
    agent
      .get(ORIGIN)
      .intercept({ path: '/api/calm-tasks/v1/tasks?projectId=p1&type=CALMDEF&status=CIPDFCTOPEN' })
      .reply(200, [{ id: 'd1', type: 'CALMDEF' }]);

    const result = await handleCalmList(makeClients(), {
      resource: 'tasks',
      project_id: 'p1',
      task_type: 'CALMDEF',
      status: 'CIPDFCTOPEN',
    });
    expect(result.isError).toBeFalsy();
    expect(parse(result)).toEqual([{ id: 'd1', type: 'CALMDEF' }]);
  });

  it('lists an OData resource with query options', async () => {
    agent
      .get(ORIGIN)
      .intercept({ path: '/api/calm-features/v1/Features?$top=3' })
      .reply(200, { value: [{ uuid: '1' }] });

    const result = await handleCalmList(makeClients(), { resource: 'features', top: 3 });
    expect((parse(result) as { value: unknown[] }).value).toHaveLength(1);
  });

  it('resolves task feature assignments (recipe step 1)', async () => {
    agent
      .get(ORIGIN)
      .intercept({ path: '/api/calm-tasks/v1/tasks/Y/featureAssignments' })
      .reply(200, [{ featureId: 'f1' }]);

    const result = await handleCalmList(makeClients(), {
      resource: 'task_feature_assignments',
      task_id: 'Y',
    });
    expect(parse(result)).toEqual([{ featureId: 'f1' }]);
  });
});

describe('handleCalmGet', () => {
  let agent: MockAgent;
  beforeEach(() => {
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
  });
  afterEach(async () => {
    await agent.close();
  });

  it('gets a feature by uuid', async () => {
    const uuid = '11111111-1111-1111-1111-111111111111';
    agent
      .get(ORIGIN)
      .intercept({ path: `/api/calm-features/v1/Features/${uuid}` })
      .reply(200, { uuid, title: 'F' });

    const result = await handleCalmGet(makeClients(), { resource: 'feature', id: uuid });
    expect((parse(result) as { uuid: string }).uuid).toBe(uuid);
  });

  it('resolves a feature by display id via a filter', async () => {
    agent
      .get(ORIGIN)
      .intercept({ path: "/api/calm-features/v1/Features?$filter=displayId%20eq%20'6-123'&$top=1" })
      .reply(200, { value: [{ uuid: 'abc', displayId: '6-123' }] });

    const result = await handleCalmGet(makeClients(), { resource: 'feature', id: '6-123' });
    expect((parse(result) as { displayId: string }).displayId).toBe('6-123');
  });

  it('gets a task (defect) by id via REST', async () => {
    agent
      .get(ORIGIN)
      .intercept({ path: '/api/calm-tasks/v1/tasks/d1' })
      .reply(200, { id: 'd1', type: 'CALMDEF' });

    const result = await handleCalmGet(makeClients(), { resource: 'task', id: 'd1' });
    expect((parse(result) as { id: string }).id).toBe('d1');
  });
});

describe('handleCalmAnalytics', () => {
  let agent: MockAgent;
  beforeEach(() => {
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
  });
  afterEach(async () => {
    await agent.close();
  });

  it('queries the Defects provider ordered by priority (recipe)', async () => {
    agent
      .get(ORIGIN)
      .intercept({
        path: "/api/calm-analytics/v1/odata/v4/analytics/Defects?$filter=status%20eq%20'CIPDFCTOPEN'&$orderby=priority%20desc",
      })
      .reply(200, { value: [{ id: 'd1' }] });

    const result = await handleCalmAnalytics(makeClients(), {
      provider: 'Defects',
      filter: "status eq 'CIPDFCTOPEN'",
      orderby: 'priority desc',
    });
    expect((parse(result) as { value: unknown[] }).value).toHaveLength(1);
  });
});

describe('handleCalmResources', () => {
  it('returns the full catalog with code lists and recipes', () => {
    const catalog = parse(handleCalmResources({})) as {
      listResources: unknown[];
      analyticsProviders: string[];
      codeLists: { taskTypes: { code: string }[] };
      recipes: unknown[];
    };
    expect(catalog.listResources.length).toBeGreaterThan(10);
    expect(catalog.analyticsProviders).toContain('Defects');
    expect(catalog.codeLists.taskTypes.some((t) => t.code === 'CALMDEF')).toBe(true);
    expect(catalog.recipes.length).toBeGreaterThanOrEqual(2);
  });

  it('focuses on recipes when topic=recipes', () => {
    const result = parse(handleCalmResources({ topic: 'recipes' })) as { recipes: unknown[] };
    expect(result.recipes.length).toBeGreaterThanOrEqual(2);
  });

  it('focuses on a single resource when given its name', () => {
    const result = parse(handleCalmResources({ topic: 'tasks' })) as { required: string[] };
    expect(result.required).toContain('project_id');
  });
});
