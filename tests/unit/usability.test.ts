// Usability features: tool annotations, instruction length, calm_get field projection, per-value
// group_by over array fields, "did you mean" hints, and context on empty lists.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import pino from 'pino';
import { MockAgent, setGlobalDispatcher } from 'undici';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildMcpServer } from '../../src/server.js';
import { handleCalmGet } from '../../src/tools/calmGet.js';
import { handleCalmList } from '../../src/tools/calmList.js';
import { unknownFieldsMessage } from '../../src/tools/shape.js';
import { makeClients, ORIGIN, parse } from './helpers.js';

const logger = pino({ level: 'silent' });

/** Connect an in-memory MCP client to a server built for the given write setting. */
async function connect(writeEnabled: boolean): Promise<Client> {
  const server = buildMcpServer(makeClients({ writeEnabled }), logger);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe('tool annotations and instructions', () => {
  it('marks the read tools read-only and calm_create as non-destructive', async () => {
    const client = await connect(true);
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations]));
    for (const name of ['calm_list', 'calm_get', 'calm_analytics', 'calm_resources']) {
      expect(byName[name]?.readOnlyHint).toBe(true);
    }
    expect(byName.calm_create).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    });
  });

  it('keeps the server instructions under the 2048 characters Claude Code shows', async () => {
    for (const write of [false, true]) {
      const instructions = (await connect(write)).getInstructions() ?? '';
      expect(instructions.length).toBeLessThan(2048);
    }
  });
});

describe('field-name hints', () => {
  it('suggests the real name for a common guess', () => {
    const message = unknownFieldsMessage(
      'fields',
      ['priority', 'titel'],
      ['priorityId', 'title', 'status'],
    );
    expect(message).toContain("'priority' → did you mean 'priorityId'?");
    expect(message).toContain("'titel' → did you mean 'title'?");
  });

  it('offers nothing when no field is close', () => {
    expect(unknownFieldsMessage('fields', ['zzzzzz'], ['title'])).not.toContain('did you mean');
  });
});

describe('network-backed usability', () => {
  let agent: MockAgent;
  beforeEach(() => {
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
  });
  afterEach(async () => {
    await agent.close();
  });

  it('projects a single entity with calm_get fields', async () => {
    agent
      .get(ORIGIN)
      .intercept({ path: '/api/calm-tasks/v1/tasks/t1' })
      .reply(200, { id: 't1', title: 'One', description: '<p>long</p>', priorityId: 2 });
    const result = await handleCalmGet(makeClients(), {
      resource: 'task',
      id: 't1',
      fields: 'id,title',
    });
    expect(parse(result)).toEqual({ id: 't1', title: 'One' });
  });

  it('rejects an unknown calm_get field with a suggestion', async () => {
    agent
      .get(ORIGIN)
      .intercept({ path: '/api/calm-tasks/v1/tasks/t1' })
      .reply(200, { id: 't1', priorityId: 2 });
    const result = await handleCalmGet(makeClients(), {
      resource: 'task',
      id: 't1',
      fields: 'priority',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("did you mean 'priorityId'");
  });

  it('counts each tag on its own when grouping by an array field', async () => {
    agent
      .get(ORIGIN)
      .intercept({ path: (path) => path.startsWith('/api/calm-tasks/v1/tasks?') })
      .reply(200, [
        { id: 'a', tags: ['finance', 'sap'] },
        { id: 'b', tags: ['finance'] },
        { id: 'c', tags: [] },
      ]);
    const body = parse(
      await handleCalmList(makeClients(), {
        resource: 'tasks',
        project_id: 'p1',
        group_by: 'tags',
      }),
    ) as {
      total: number;
      groups: { value: string; count: number }[];
      multiValued: string[];
      note: string;
    };
    expect(body.total).toBe(3);
    expect(body.groups).toEqual([
      { value: 'finance', count: 2 },
      { value: '(none)', count: 1 },
      { value: 'sap', count: 1 },
    ]);
    expect(body.multiValued).toEqual(['tags']);
    expect(body.note).toContain('overlap');
  });

  it('names the next OData page when this one is full', async () => {
    agent
      .get(ORIGIN)
      .intercept({ path: '/api/calm-features/v1/Features?$top=2&$skip=4' })
      .reply(200, { value: [{ uuid: 'a' }, { uuid: 'b' }] });
    const body = parse(
      await handleCalmList(makeClients(), { resource: 'features', top: 2, skip: 4 }),
    ) as { value: unknown[]; nextPage: unknown };
    expect(body.value).toHaveLength(2);
    expect(body.nextPage).toEqual({ skip: 6 });
  });

  it('names the next REST page when this one is full', async () => {
    agent
      .get(ORIGIN)
      .intercept({ path: '/api/calm-tasks/v1/tasks?projectId=p1&offset=4&limit=2' })
      .reply(200, [{ id: 'a' }, { id: 'b' }]);
    const body = parse(
      await handleCalmList(makeClients(), {
        resource: 'tasks',
        project_id: 'p1',
        limit: 2,
        offset: 4,
      }),
    );
    expect(body).toEqual({ records: [{ id: 'a' }, { id: 'b' }], nextPage: { offset: 6 } });
  });

  it('leaves a short last page as the service returned it', async () => {
    agent
      .get(ORIGIN)
      .intercept({ path: '/api/calm-tasks/v1/tasks?projectId=p1&limit=5' })
      .reply(200, [{ id: 'a' }]);
    const body = parse(
      await handleCalmList(makeClients(), { resource: 'tasks', project_id: 'p1', limit: 5 }),
    );
    expect(body).toEqual([{ id: 'a' }]);
  });

  it('names what was queried when a relation list is empty', async () => {
    agent
      .get(ORIGIN)
      .intercept({ path: '/api/calm-tasks/v1/tasks/Y/featureAssignments' })
      .reply(200, []);
    const body = parse(
      await handleCalmList(makeClients(), { resource: 'task_feature_assignments', task_id: 'Y' }),
    ) as { records: unknown[]; subject: Record<string, string> };
    expect(body.records).toEqual([]);
    expect(body.subject).toEqual({ resource: 'task_feature_assignments', task_id: 'Y' });
  });
});
