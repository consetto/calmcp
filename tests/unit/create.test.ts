import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { MockAgent, setGlobalDispatcher } from 'undici';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Config } from '../../src/config.js';
import { createLogger } from '../../src/logging.js';
import { buildMcpServer } from '../../src/server.js';
import { handleCalmCreate } from '../../src/tools/calmCreate.js';
import { handleCalmResources } from '../../src/tools/calmResources.js';
import { CREATE_RESOURCE_NAMES, CREATE_RESOURCES, describeObject } from '../../src/tools/create.js';
import { GET_RESOURCES } from '../../src/tools/registry.js';
import { makeClients, ORIGIN, parse } from './helpers.js';

const PROJECT = '11111111-1111-1111-1111-111111111111';

describe('CALM_WRITE_ENABLED', () => {
  const env = {
    CALM_TENANT: 'acme',
    CALM_REGION: 'eu10',
    CALM_CLIENT_ID: 'id',
    CALM_CLIENT_SECRET: 'secret',
  };

  it('is off unless set, so a deployment is read-only by default', () => {
    expect(Config.fromEnv(env).writeEnabled).toBe(false);
    expect(Config.fromEnv({ ...env, CALM_WRITE_ENABLED: 'false' }).writeEnabled).toBe(false);
    expect(Config.fromEnv({ ...env, CALM_WRITE_ENABLED: 'no' }).writeEnabled).toBe(false);
  });

  it('turns on with true', () => {
    expect(Config.fromEnv({ ...env, CALM_WRITE_ENABLED: 'true' }).writeEnabled).toBe(true);
  });
});

/** Connect an in-memory client to a server built for the given write setting. */
async function listTools(writeEnabled: boolean) {
  const server = buildMcpServer(makeClients({ writeEnabled }), createLogger(false));
  const client = new Client({ name: 'test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  const instructions = client.getInstructions();
  await client.close();
  await server.close();
  return { names: tools.map((t) => t.name).sort(), instructions };
}

describe('tool registration', () => {
  it('offers only the four read tools when write access is off', async () => {
    const { names, instructions } = await listTools(false);
    expect(names).toEqual(['calm_analytics', 'calm_get', 'calm_list', 'calm_resources']);
    expect(instructions).not.toContain('calm_create');
  });

  it('adds calm_create, and says so in the instructions, when write access is on', async () => {
    const { names, instructions } = await listTools(true);
    expect(names).toContain('calm_create');
    expect(instructions).toContain('calm_create');
    expect(instructions).toContain('Nothing is ever updated or deleted');
  });
});

describe('handleCalmCreate', () => {
  let agent: MockAgent;
  beforeEach(() => {
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
  });
  afterEach(async () => {
    await agent.close();
  });

  it('refuses to write when the switch is off, without a network call', async () => {
    const result = await handleCalmCreate(makeClients(), {
      resource: 'document',
      data: { title: 'x', projectId: PROJECT },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('CALM_WRITE_ENABLED');
  });

  it('rejects an unknown resource', async () => {
    const result = await handleCalmCreate(makeClients({ writeEnabled: true }), {
      resource: 'task',
      data: { title: 'x' },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Unknown resource 'task'");
  });

  it('rejects a document without the required title and projectId', async () => {
    const result = await handleCalmCreate(makeClients({ writeEnabled: true }), {
      resource: 'document',
      data: { content: '<p>hi</p>' },
    });
    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('title');
    expect(text).toContain('projectId');
    expect(text).toContain("calm_resources({ topic: 'document' })");
  });

  it('rejects an unknown field instead of silently dropping it', async () => {
    const result = await handleCalmCreate(makeClients({ writeEnabled: true }), {
      resource: 'document',
      data: { title: 'x', projectID: PROJECT },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('projectID');
  });

  it('rejects a code outside the spec enum', async () => {
    const result = await handleCalmCreate(makeClients({ writeEnabled: true }), {
      resource: 'xlib_interface',
      data: { title: 'x', interfaceTypeCode: 'CARRIER_PIGEON' },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('interfaceTypeCode');
  });

  it('POSTs a document with its deep-create children and returns the created entity', async () => {
    const data = {
      title: 'Design',
      projectId: PROJECT,
      content: '<h1>Hi</h1>',
      documentTypeCode: 'SD',
      toURLReferences: [{ name: 'SAP', url: 'https://www.sap.com' }],
    };
    agent
      .get(ORIGIN)
      .intercept({
        path: '/api/calm-documents/v1/Documents',
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer t' },
        body: (body) => JSON.parse(body).title === 'Design',
      })
      .reply(201, { uuid: 'd-1', displayId: '12-1', ...data });

    const result = await handleCalmCreate(makeClients({ writeEnabled: true }), {
      resource: 'document',
      data,
    });
    expect(result.isError).toBeFalsy();
    expect(parse(result)).toMatchObject({ uuid: 'd-1', displayId: '12-1', title: 'Design' });
  });

  it('sends exactly the validated payload, nothing added', async () => {
    let sent: unknown;
    agent
      .get(ORIGIN)
      .intercept({
        path: '/api/calm-crosslibraryapplications/v1/Applications',
        method: 'POST',
        body: (body) => {
          sent = JSON.parse(body);
          return true;
        },
      })
      .reply(201, { uuid: 'a-1' });

    const result = await handleCalmCreate(makeClients({ writeEnabled: true }), {
      resource: 'xlib_application',
      data: { title: 'Manage Payments', applicationTypeCode: 'FIORI_ACTION', intent: 'Pay-manage' },
    });
    expect(result.isError).toBeFalsy();
    expect(sent).toEqual({
      title: 'Manage Payments',
      applicationTypeCode: 'FIORI_ACTION',
      intent: 'Pay-manage',
    });
  });

  it('sends the classification codes added to the library entries in September 2025', async () => {
    let sent: unknown;
    agent
      .get(ORIGIN)
      .intercept({
        path: '/api/calm-crosslibrarydevelopments/v1/Developments',
        method: 'POST',
        body: (body) => {
          sent = JSON.parse(body);
          return true;
        },
      })
      .reply(201, { uuid: 'd-1' });

    const data = {
      title: 'ZCL_PAYMENT_EXPORT',
      packageName: 'ZFI',
      developmentPriorityCode: '2',
      developmentReadinessCode: 'PLANNED',
      developmentUsageStatusCode: 'USED_IMPACTED',
      developmentUsageNumber: 42,
      developmentCleanCoreLevelCode: 'C',
      developmentUpgradeImpactCode: 'DEV_UNCLASSIFIED',
    };
    const result = await handleCalmCreate(makeClients({ writeEnabled: true }), {
      resource: 'xlib_development',
      data,
    });
    expect(result.isError).toBeFalsy();
    expect(sent).toEqual(data);
  });

  it('rejects a classification code outside the spec enum, and one an entity does not carry', async () => {
    const clients = makeClients({ writeEnabled: true });
    const bad = await handleCalmCreate(clients, {
      resource: 'xlib_application',
      data: { title: 'x', applicationCleanCoreLevelCode: 'E' },
    });
    expect(bad.isError).toBe(true);
    expect(bad.content[0]?.text).toContain('applicationCleanCoreLevelCode');

    // Configurations carry priority and readiness only.
    const unknown = await handleCalmCreate(clients, {
      resource: 'xlib_configuration',
      data: { title: 'x', configurationUsageStatusCode: 'USED' },
    });
    expect(unknown.isError).toBe(true);
    expect(unknown.content[0]?.text).toContain('configurationUsageStatusCode');
  });

  it('routes each library resource to its own service', async () => {
    const paths: Record<string, string> = {
      xlib_configuration: '/api/calm-crosslibraryconfigurations/v1/Configurations',
      xlib_configuration_activity:
        '/api/calm-crosslibraryconfigurations/v1/ConfigurationActivities',
      xlib_development: '/api/calm-crosslibrarydevelopments/v1/Developments',
      xlib_interface: '/api/calm-crosslibraryinterfaces/v1/Interfaces',
    };
    for (const [resource, path] of Object.entries(paths)) {
      agent.get(ORIGIN).intercept({ path, method: 'POST' }).reply(201, { uuid: resource });
      const result = await handleCalmCreate(makeClients({ writeEnabled: true }), {
        resource,
        data: { title: resource },
      });
      expect(result.isError).toBeFalsy();
      expect(parse(result)).toEqual({ uuid: resource });
    }
  });

  it('surfaces an OData error from the service', async () => {
    agent
      .get(ORIGIN)
      .intercept({ path: '/api/calm-documents/v1/Documents', method: 'POST' })
      .reply(400, { error: { code: '400', message: 'Project not found' } });

    const result = await handleCalmCreate(makeClients({ writeEnabled: true }), {
      resource: 'document',
      data: { title: 'x', projectId: PROJECT },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Project not found');
  });
});

describe('create registry', () => {
  it('covers documents and the five library entry types, and nothing else', () => {
    expect(CREATE_RESOURCE_NAMES.sort()).toEqual([
      'document',
      'xlib_application',
      'xlib_configuration',
      'xlib_configuration_activity',
      'xlib_development',
      'xlib_interface',
    ]);
  });

  it('names the same entity sets calm_get reads, so a created uuid can be fetched back', () => {
    for (const [name, def] of Object.entries(CREATE_RESOURCES)) {
      const get = GET_RESOURCES[name];
      if (!get) continue; // configuration activities have no calm_get resource yet
      expect(get.kind).toBe('odata');
      if (get.kind === 'odata') {
        expect(get.service).toBe(def.service);
        expect(get.entitySet).toBe(def.entitySet);
      }
    }
  });

  it('documents every field from the schema, required first, with enum values', () => {
    const fields = describeObject(CREATE_RESOURCES.document!.schema);
    expect(fields[0]).toMatchObject({ name: 'title', type: 'string', required: true });
    expect(fields[1]).toMatchObject({ name: 'projectId', type: 'string', required: true });
    const type = fields.find((f) => f.name === 'documentTypeCode');
    expect(type).toMatchObject({ type: 'string', required: false });
    expect(type?.values).toContain('SD');
    const status = fields.find((f) => f.name === 'statusCode');
    expect(status?.values).toEqual([10, 20, 30]);
    const links = fields.find((f) => f.name === 'toURLReferences');
    expect(links?.type).toBe('array of object');
    expect(links?.fields?.map((f) => f.name)).toEqual(['name', 'url']);
  });
});

describe('calm_resources and write access', () => {
  it('says write access is off, and offers no create catalog, by default', () => {
    const catalog = parse(handleCalmResources({})) as {
      createResources: { enabled: boolean; note: string; resources?: unknown[] };
    };
    expect(catalog.createResources.enabled).toBe(false);
    expect(catalog.createResources.note).toContain('CALM_WRITE_ENABLED');
    expect(catalog.createResources.resources).toBeUndefined();
  });

  it('lists every create resource with its fields when write access is on', () => {
    const catalog = parse(handleCalmResources({}, { writeEnabled: true })) as {
      createResources: { enabled: boolean; resources: { resource: string; fields: unknown[] }[] };
    };
    expect(catalog.createResources.enabled).toBe(true);
    expect(catalog.createResources.resources.map((r) => r.resource).sort()).toEqual(
      [...CREATE_RESOURCE_NAMES].sort(),
    );
    for (const r of catalog.createResources.resources) {
      expect(r.fields.length).toBeGreaterThan(0);
    }
  });

  it('adds the create payload to a focused topic only when the tool is offered', () => {
    const off = parse(handleCalmResources({ topic: 'document' })) as { create?: unknown };
    expect(off.create).toBeUndefined();

    const on = parse(handleCalmResources({ topic: 'document' }, { writeEnabled: true })) as {
      resource: string;
      entitySet: string;
      create: { tool: string; fields: { name: string }[] };
    };
    expect(on.resource).toBe('document');
    expect(on.entitySet).toBe('Documents');
    expect(on.create.tool).toBe('calm_create');
    expect(on.create.fields.map((f) => f.name)).toContain('content');
  });

  it('focuses a create-only name such as xlib_configuration_activity', () => {
    const on = parse(
      handleCalmResources({ topic: 'xlib_configuration_activity' }, { writeEnabled: true }),
    ) as { resource: string; create?: { entitySet: string } };
    expect(on.create?.entitySet).toBe('ConfigurationActivities');
  });
});
