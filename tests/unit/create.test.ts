import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import pino from 'pino';
import { MockAgent, setGlobalDispatcher } from 'undici';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Config } from '../../src/config.js';
import { createLogger } from '../../src/logging.js';
import { buildMcpServer } from '../../src/server.js';
import { type CreateAuditEntry, handleCalmCreate } from '../../src/tools/calmCreate.js';
import { handleCalmResources } from '../../src/tools/calmResources.js';
import { CREATE_RESOURCE_NAMES, CREATE_RESOURCES } from '../../src/tools/create.js';
import { GET_RESOURCES } from '../../src/tools/registry.js';
import { describeObject } from '../../src/tools/zodDoc.js';
import { makeClients, ORIGIN, parse, textOf } from './helpers.js';

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
    expect(instructions).toMatch(/^Read-only access to SAP Cloud ALM/);
  });

  it('adds calm_create, and says so in the instructions, when write access is on', async () => {
    const { names, instructions } = await listTools(true);
    expect(names).toContain('calm_create');
    expect(instructions).toContain('calm_create');
    expect(instructions).toContain('calm_create never changes or deletes an existing object');
    expect(instructions).toMatch(/^Access to SAP Cloud ALM/);
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
    expect(textOf(result)).toContain('CALM_WRITE_ENABLED');
  });

  it('rejects an unknown resource', async () => {
    const result = await handleCalmCreate(makeClients({ writeEnabled: true }), {
      resource: 'workstream',
      data: { title: 'x' },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Unknown resource 'workstream'");
  });

  it('rejects a document without the required title and projectId', async () => {
    const result = await handleCalmCreate(makeClients({ writeEnabled: true }), {
      resource: 'document',
      data: { content: '<p>hi</p>' },
    });
    expect(result.isError).toBe(true);
    const text = textOf(result);
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
    expect(textOf(result)).toContain('projectID');
  });

  it('rejects a code outside the spec enum', async () => {
    const result = await handleCalmCreate(makeClients({ writeEnabled: true }), {
      resource: 'xlib_interface',
      data: { title: 'x', interfaceTypeCode: 'CARRIER_PIGEON' },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('interfaceTypeCode');
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
    expect(parse(result)).toEqual({
      created: true,
      resource: 'document',
      uuid: 'd-1',
      displayId: '12-1',
      set: {
        title: 'Design',
        projectId: PROJECT,
        content: { length: 11, images: 0 },
        documentTypeCode: 'SD',
        toURLReferences: { items: 1 },
      },
    });
  });

  it('audits a created entity with its id and the fields set, not their values', async () => {
    agent
      .get(ORIGIN)
      .intercept({ path: '/api/calm-documents/v1/Documents', method: 'POST' })
      .reply(201, { uuid: 'd-2', displayId: '12-2', title: 'Design' });

    const audit: CreateAuditEntry[] = [];
    await handleCalmCreate(
      makeClients({ writeEnabled: true }),
      { resource: 'document', data: { title: 'Design', projectId: PROJECT, content: '<p>x</p>' } },
      (entry) => audit.push(entry),
    );
    expect(audit).toEqual([
      {
        resource: 'document',
        id: 'd-2',
        displayId: '12-2',
        fields: ['title', 'projectId', 'content'],
        outcome: 'applied',
      },
    ]);
  });

  it('reports a create that met no answer as maybe applied, audits it, and never invites a retry', async () => {
    agent
      .get(ORIGIN)
      .intercept({ path: '/api/calm-documents/v1/Documents', method: 'POST' })
      .replyWithError(new Error('socket hang up'));
    const audit: CreateAuditEntry[] = [];
    const result = await handleCalmCreate(
      makeClients({ writeEnabled: true }),
      { resource: 'document', data: { title: 'Design', projectId: PROJECT } },
      (entry) => audit.push(entry),
    );
    expect(parse(result)).toMatchObject({ error: 'NETWORK', retryable: false });
    expect(textOf(result)).toContain('may or may not have been created');
    expect(audit).toMatchObject([{ resource: 'document', outcome: 'unknown' }]);
  });

  it('reports a create Cloud ALM accepted with an unreadable answer as created', async () => {
    agent
      .get(ORIGIN)
      .intercept({ path: '/api/calm-documents/v1/Documents', method: 'POST' })
      .reply(201, 'created, but not JSON');
    const audit: CreateAuditEntry[] = [];
    const result = await handleCalmCreate(
      makeClients({ writeEnabled: true }),
      { resource: 'document', data: { title: 'Design', projectId: PROJECT } },
      (entry) => audit.push(entry),
    );
    expect(result.isError).toBeFalsy();
    expect(parse(result)).toMatchObject({ created: true, resource: 'document' });
    expect(audit).toMatchObject([{ outcome: 'applied' }]);
  });

  it('answers a successful create as created even when the stored answer cannot be summarised', async () => {
    // The text sent is clean; Cloud ALM's answer holds an image id whose escape does not decode.
    const stored = '<p>x</p><img src="/ui/imageServiceAPI/v1/getImage?imageId=%E0%A4%A">';
    agent
      .get(ORIGIN)
      .intercept({ path: '/api/calm-features/v1/Features', method: 'POST' })
      .reply(201, { uuid: 'f-1', displayId: '6-1', description: stored });
    const result = await handleCalmCreate(makeClients({ writeEnabled: true }), {
      resource: 'feature',
      data: { title: 'x', projectId: PROJECT, description: '<p>x</p>' },
    });
    expect(result.isError).toBeFalsy();
    expect(parse(result)).toMatchObject({ created: true, uuid: 'f-1' });
  });

  it('logs the audit entry with the caller when called through the server', async () => {
    agent
      .get(ORIGIN)
      .intercept({ path: '/api/calm-documents/v1/Documents', method: 'POST' })
      .reply(201, { uuid: 'd-3', displayId: '12-3' });

    const lines: string[] = [];
    const logger = pino({ level: 'info' }, { write: (line: string) => lines.push(line) });
    const server = buildMcpServer(makeClients({ writeEnabled: true }), logger);
    const client = new Client({ name: 'test', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    await client.callTool({
      name: 'calm_create',
      arguments: { resource: 'document', data: { title: 'Design', projectId: PROJECT } },
    });
    await client.close();

    const entries = lines.map((line) => JSON.parse(line)).filter((e) => e.audit);
    // No authInfo: a stdio or local caller, named "local".
    expect(entries).toMatchObject([
      { audit: 'calm_create', caller: 'local', resource: 'document', id: 'd-3', level: 30 },
    ]);
  });

  it('writes no audit entry when Cloud ALM refuses the create', async () => {
    agent
      .get(ORIGIN)
      .intercept({ path: '/api/calm-documents/v1/Documents', method: 'POST' })
      .reply(400, { error: { code: 'BAD', message: 'Project not found' } });

    const audit: CreateAuditEntry[] = [];
    const result = await handleCalmCreate(
      makeClients({ writeEnabled: true }),
      { resource: 'document', data: { title: 'Design', projectId: PROJECT } },
      (entry) => audit.push(entry),
    );
    expect(result.isError).toBe(true);
    expect(audit).toEqual([]);
  });

  it('refuses active content in a text field before sending anything', async () => {
    // No intercept: a POST that slipped through would fail the call as NETWORK instead.
    const result = await handleCalmCreate(makeClients({ writeEnabled: true }), {
      resource: 'feature',
      data: {
        title: 'Close periods',
        projectId: PROJECT,
        description: '<p>Steps</p><img src="https://evil.example/pixel.png">',
      },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('image service');
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
    expect(textOf(bad)).toContain('applicationCleanCoreLevelCode');

    // Configurations carry priority and readiness only.
    const unknown = await handleCalmCreate(clients, {
      resource: 'xlib_configuration',
      data: { title: 'x', configurationUsageStatusCode: 'USED' },
    });
    expect(unknown.isError).toBe(true);
    expect(textOf(unknown)).toContain('configurationUsageStatusCode');
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
      expect(parse(result)).toMatchObject({ created: true, resource, uuid: resource });
    }
  });

  it('POSTs a task to the Tasks REST API and audits its id', async () => {
    let sent: unknown;
    agent
      .get(ORIGIN)
      .intercept({
        path: '/api/calm-tasks/v1/tasks',
        method: 'POST',
        body: (body) => {
          sent = JSON.parse(body);
          return true;
        },
      })
      .reply(201, { id: 't-1', displayId: '3-12', title: 'Posting fails' });

    const data = {
      title: 'Posting fails',
      projectId: PROJECT,
      type: 'CALMDEF',
      priorityId: 20,
      classificationId: 'FUNCT',
      subClassifications: ['FUNCT_BUG'],
      dueDate: '2026-11-30',
      description: '<p>Steps to reproduce</p>',
    };
    const audit: CreateAuditEntry[] = [];
    const result = await handleCalmCreate(
      makeClients({ writeEnabled: true }),
      { resource: 'task', data },
      (entry) => audit.push(entry),
    );
    expect(result.isError).toBeFalsy();
    expect(sent).toEqual(data);
    expect(audit).toMatchObject([{ resource: 'task', id: 't-1', displayId: '3-12' }]);
  });

  it('POSTs a comment below its task, with the task id in the path and not in the body', async () => {
    let sent: unknown;
    agent
      .get(ORIGIN)
      .intercept({
        path: `/api/calm-tasks/v1/tasks/${PROJECT}/comments`,
        method: 'POST',
        body: (body) => {
          sent = JSON.parse(body);
          return true;
        },
      })
      .reply(201, { id: 'c-1', text: '<p>Fixed in QA</p>' });

    const audit: CreateAuditEntry[] = [];
    const result = await handleCalmCreate(
      makeClients({ writeEnabled: true }),
      { resource: 'task_comment', data: { taskId: PROJECT, text: '<p>Fixed in QA</p>' } },
      (entry) => audit.push(entry),
    );
    expect(result.isError).toBeFalsy();
    expect(sent).toEqual({ text: '<p>Fixed in QA</p>' });
    expect(audit).toMatchObject([
      { resource: 'task_comment', id: 'c-1', fields: ['taskId', 'text'] },
    ]);
  });

  // No intercepts below: a request that slipped through would fail the call as NETWORK, and the
  // assertions on the message would not match.
  it.each([
    ['a task without a type', { title: 'x', projectId: PROJECT }, 'type'],
    [
      'a task type calmcp does not create',
      { title: 'x', projectId: PROJECT, type: 'CALMQGATE' },
      'type',
    ],
    [
      'a sub-task without its parent',
      { title: 'x', projectId: PROJECT, type: 'CALMST' },
      'parentId',
    ],
    [
      'effort on a sub-task',
      { title: 'x', projectId: PROJECT, type: 'CALMST', parentId: PROJECT, effort: 2 },
      'effort',
    ],
    [
      'a risk field on a defect',
      { title: 'x', projectId: PROJECT, type: 'CALMDEF', impact: 3 },
      'risks (CALMRISK) only',
    ],
    [
      'a classification of another task type',
      { title: 'x', projectId: PROJECT, type: 'CALMUS', classificationId: 'FUNCT' },
      'CALMUS takes one of: US_GAP',
    ],
    [
      'a classification on a task type that has none',
      { title: 'x', projectId: PROJECT, type: 'CALMTASK', classificationId: 'FUNCT' },
      'takes no classification',
    ],
    [
      'a sub-classification under the wrong classification',
      {
        title: 'x',
        projectId: PROJECT,
        type: 'CALMDEF',
        classificationId: 'TECH',
        subClassifications: ['FUNCT_BUG'],
      },
      'FUNCT_BUG not valid under TECH',
    ],
    [
      'a sub-classification without a classification',
      { title: 'x', projectId: PROJECT, type: 'CALMDEF', subClassifications: ['FUNCT_BUG'] },
      'needs a classificationId',
    ],
    [
      'test classifications on a defect',
      { title: 'x', projectId: PROJECT, type: 'CALMDEF', testClassifications: ['REGRESSION'] },
      'testClassifications',
    ],
    [
      'a due date that is not YYYY-MM-DD',
      { title: 'x', projectId: PROJECT, type: 'CALMTASK', dueDate: '30.11.2026' },
      'dueDate',
    ],
    [
      'the source field, which calmcp leaves at MANUAL',
      { title: 'x', projectId: PROJECT, type: 'CALMTASK', source: 'EXTERNAL' },
      'source',
    ],
  ])('refuses %s before sending anything', async (_, data, message) => {
    const result = await handleCalmCreate(makeClients({ writeEnabled: true }), {
      resource: 'task',
      data,
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(message);
  });

  it('refuses active content in a comment before sending anything', async () => {
    const result = await handleCalmCreate(makeClients({ writeEnabled: true }), {
      resource: 'task_comment',
      data: { taskId: PROJECT, text: '<p onclick="steal()">Done</p>' },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('text:');
  });

  it('refuses a comment whose task id is not a uuid, so nothing lands in another path', async () => {
    const result = await handleCalmCreate(makeClients({ writeEnabled: true }), {
      resource: 'task_comment',
      data: { taskId: '../projects', text: 'x' },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('taskId');
  });

  it('answers with the key and the fields set, not the whole entity', async () => {
    agent.get(ORIGIN).intercept({ path: '/api/calm-tasks/v1/tasks', method: 'POST' }).reply(201, {
      id: 't-2',
      displayId: '3-13',
      title: 'Posting fails',
      projectId: PROJECT,
      type: 'CALMDEF',
      priorityId: 30,
      description: '<p>Steps</p>',
      startDate: '2026-10-26',
      customField1: null,
      tags: [],
    });

    const result = await handleCalmCreate(makeClients({ writeEnabled: true }), {
      resource: 'task',
      data: {
        title: 'Posting fails',
        projectId: PROJECT,
        type: 'CALMDEF',
        priorityId: 20,
        description: '<p>Steps</p>',
      },
    });
    expect(result.isError).toBeFalsy();
    // Cloud ALM stored another priority than was sent: the answer says so.
    expect(parse(result)).toEqual({
      created: true,
      resource: 'task',
      id: 't-2',
      displayId: '3-13',
      set: {
        title: 'Posting fails',
        projectId: PROJECT,
        type: 'CALMDEF',
        priorityId: 30,
        description: { length: 12, images: 0 },
      },
      storedDiffersFromSent: ['priorityId'],
    });
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
    expect(textOf(result)).toContain('Project not found');
  });
});

describe('calm_create links', () => {
  const TASK = '22222222-2222-2222-2222-222222222222';
  const OTHER = '33333333-3333-3333-3333-333333333333';
  const FEATURE = '44444444-4444-4444-4444-444444444444';
  const TASKS = '/api/calm-tasks/v1/tasks';
  let agent: MockAgent;
  beforeEach(() => {
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
  });
  afterEach(async () => {
    await agent.close();
  });

  const create = (resource: string, data: Record<string, unknown>) =>
    handleCalmCreate(makeClients({ writeEnabled: true }), { resource, data });
  /** Intercept a POST and keep its body. */
  const post = (path: string, reply: object) => {
    const sent: unknown[] = [];
    agent
      .get(ORIGIN)
      .intercept({
        path,
        method: 'POST',
        // The matcher may run more than once per request: keep the last body, not each call.
        body: (body) => {
          sent.splice(0, sent.length, JSON.parse(body));
          return true;
        },
      })
      .reply(201, reply);
    return sent;
  };
  const featureLookup = (rows: unknown[]) =>
    agent
      .get(ORIGIN)
      .intercept({
        path: (path) =>
          path.startsWith('/api/calm-features/v1/Features?') &&
          new URLSearchParams(path.split('?')[1]).get('$filter') === "displayId eq '6-132'",
      })
      .reply(200, { value: rows });

  it('links a feature to a task, with the task in the path and only the feature in the body', async () => {
    const sent = post(`${TASKS}/${TASK}/featureAssignments`, { id: 'a-1', featureId: FEATURE });
    const result = await create('task_feature_link', { taskId: TASK, featureId: FEATURE });
    expect(result.isError).toBeFalsy();
    expect(sent).toEqual([{ featureId: FEATURE }]);
    expect(parse(result)).toMatchObject({ created: true, id: 'a-1' });
  });

  it('resolves a feature display id to its uuid before linking', async () => {
    featureLookup([{ uuid: FEATURE, displayId: '6-132' }]);
    const sent = post(`${TASKS}/${TASK}/featureAssignments`, { id: 'a-1', featureId: FEATURE });
    const result = await create('task_feature_link', { taskId: TASK, featureId: '6-132' });
    expect(result.isError).toBeFalsy();
    expect(sent).toEqual([{ featureId: FEATURE }]);
  });

  it('refuses a display id that names no feature, before any POST', async () => {
    featureLookup([]);
    const result = await create('task_feature_link', { taskId: TASK, featureId: '6-132' });
    expect(parse(result)).toMatchObject({ error: 'NOT_FOUND' });
  });

  it('refuses a lookup answered with another feature, before any POST', async () => {
    featureLookup([{ uuid: OTHER, displayId: '6-1' }]);
    const result = await create('task_feature_link', { taskId: TASK, featureId: '6-132' });
    expect(parse(result)).toMatchObject({ error: 'UPSTREAM_ERROR', retryable: false });
  });

  it('refuses a task reference when the existing links come back in an unknown shape', async () => {
    agent
      .get(ORIGIN)
      .intercept({ path: `${TASKS}/${TASK}/references` })
      .reply(200, { items: [{ url: 'https://example.com/spec' }] });
    const result = await create('task_reference', {
      taskId: TASK,
      name: 'Spec',
      url: 'https://example.com/spec',
    });
    expect(parse(result)).toMatchObject({ error: 'UPSTREAM_ERROR' });
    expect(textOf(result)).toContain('nothing was sent');
  });

  it('refuses a display id that names two features, never picking one', async () => {
    featureLookup([
      { uuid: FEATURE, displayId: '6-132' },
      { uuid: OTHER, displayId: '6-132' },
    ]);
    const result = await create('task_feature_link', { taskId: TASK, featureId: '6-132' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('exactly one');
  });

  // No intercepts: a request that slipped through would fail as NETWORK, not with these messages.
  it.each([
    [
      'a task display id, which the Tasks API cannot look up',
      'task_feature_link',
      { taskId: '3-15', featureId: FEATURE },
      'taskId',
    ],
    [
      'a feature id that is neither uuid nor display id',
      'task_feature_link',
      { taskId: TASK, featureId: '../x' },
      'featureId',
    ],
    [
      'a child relation, which builds a hierarchy beside the sub-tasks',
      'task_relation',
      { taskId: TASK, type: '0', relationTaskId: OTHER },
      'type',
    ],
    [
      'a parent relation',
      'task_relation',
      { taskId: TASK, type: '10', relationTaskId: OTHER },
      'type',
    ],
    [
      "the spec's successor code 20, which Cloud ALM refuses",
      'task_relation',
      { taskId: TASK, type: '20', relationTaskId: OTHER },
      'type',
    ],
    [
      'a relation of a task to itself',
      'task_relation',
      { taskId: TASK, type: '2', relationTaskId: TASK },
      'itself',
    ],
    [
      'an http reference on a task, which the spec does not allow',
      'task_reference',
      { taskId: TASK, name: 'x', url: 'http://example.com' },
      'https',
    ],
    [
      'a javascript: link on a feature',
      'feature_url_reference',
      { featureId: FEATURE, name: 'x', url: 'javascript:alert(1)' },
      'url',
    ],
  ])('refuses %s before sending anything', async (_, resource, data, expected) => {
    const result = await create(resource, data);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(expected);
  });

  it('relates two tasks with the type code as Cloud ALM shows it', async () => {
    const sent = post(`${TASKS}/${TASK}/relations`, {
      id: 'r-1',
      type: '2',
      relationTaskId: OTHER,
    });
    const result = await create('task_relation', {
      taskId: TASK,
      type: '2',
      relationTaskId: OTHER,
    });
    expect(result.isError).toBeFalsy();
    expect(sent).toEqual([{ type: '2', relationTaskId: OTHER }]);
  });

  it('refuses a task reference whose URL the task already has, without POSTing', async () => {
    agent
      .get(ORIGIN)
      .intercept({ path: `${TASKS}/${TASK}/references` })
      .reply(200, [{ id: 'x', name: 'Spec', url: 'https://example.com/spec' }]);
    const result = await create('task_reference', {
      taskId: TASK,
      name: 'Spec again',
      url: 'https://example.com/spec',
    });
    expect(parse(result)).toMatchObject({ error: 'CONFLICT' });
  });

  it('adds a task reference whose URL is new', async () => {
    agent
      .get(ORIGIN)
      .intercept({ path: `${TASKS}/${TASK}/references` })
      .reply(200, []);
    const sent = post(`${TASKS}/${TASK}/references`, { id: 'ref-1' });
    const result = await create('task_reference', {
      taskId: TASK,
      name: 'Spec',
      url: 'https://example.com/spec',
    });
    expect(result.isError).toBeFalsy();
    expect(sent).toEqual([{ name: 'Spec', url: 'https://example.com/spec' }]);
  });

  it('checks feature links with a quoted parent_uuid and refuses a URL already there', async () => {
    agent
      .get(ORIGIN)
      .intercept({
        path: (path) =>
          path.startsWith('/api/calm-features/v1/URLReferences?') &&
          new URLSearchParams(path.split('?')[1]).get('$filter') === `parent_uuid eq '${FEATURE}'`,
      })
      .reply(200, { value: [{ url: 'https://example.com/spec' }] });
    const result = await create('feature_url_reference', {
      featureId: FEATURE,
      name: 'Spec',
      url: 'https://example.com/spec',
    });
    expect(parse(result)).toMatchObject({ error: 'CONFLICT' });
  });

  it('sends the test case under the name the Test Management spec uses', async () => {
    const sent = post('/api/calm-testmanagement/v1/TaskAssignments', { uuid: 'ta-1' });
    const result = await create('test_case_task_link', { testCaseId: OTHER, taskId: TASK });
    expect(result.isError).toBeFalsy();
    expect(sent).toEqual([{ parentTestCase_ID: OTHER, taskId: TASK }]);
  });
});

describe('create registry', () => {
  it('covers documents, features, tasks, comments, library entries and links, and nothing else', () => {
    expect([...CREATE_RESOURCE_NAMES].sort()).toEqual([
      'document',
      'feature',
      'feature_url_reference',
      'task',
      'task_comment',
      'task_document_link',
      'task_feature_link',
      'task_process_link',
      'task_reference',
      'task_relation',
      'test_case_task_link',
      'xlib_application',
      'xlib_configuration',
      'xlib_configuration_activity',
      'xlib_development',
      'xlib_interface',
    ]);
  });

  it('names the same collections calm_get reads, so a created id can be fetched back', () => {
    for (const [name, def] of Object.entries(CREATE_RESOURCES)) {
      const get = GET_RESOURCES[name];
      if (!get) continue; // configuration activities and comments have no calm_get resource
      expect(get.service).toBe(def.service);
      if (get.kind === 'odata') expect(get.entitySet).toBe(def.entitySet);
      else expect(get.build('x')).toBe(`/${def.entitySet}/x`);
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

  it('names every create resource when write access is on, and gives its fields by topic', () => {
    const catalog = parse(handleCalmResources({}, { writeEnabled: true })) as {
      createResources: { enabled: boolean; resources: { resource: string; fields: string }[] };
    };
    expect(catalog.createResources.enabled).toBe(true);
    expect(catalog.createResources.resources.map((r) => r.resource).sort()).toEqual(
      [...CREATE_RESOURCE_NAMES].sort(),
    );
    for (const r of catalog.createResources.resources) {
      expect(r.fields).toContain(`topic: '${r.resource}'`);
      const focused = parse(handleCalmResources({ topic: r.resource }, { writeEnabled: true })) as {
        create: { fields: unknown[] };
      };
      expect(focused.create.fields.length).toBeGreaterThan(0);
    }
  });

  it('gives each create resource an example with all its required fields', () => {
    for (const name of CREATE_RESOURCE_NAMES) {
      const focused = parse(handleCalmResources({ topic: name }, { writeEnabled: true })) as {
        create: { example: string; fields: { name: string; required: boolean }[] };
      };
      for (const field of focused.create.fields.filter((f) => f.required)) {
        expect(focused.create.example, name).toContain(`${field.name}: `);
      }
    }
  });

  it('keeps the full catalog within the response budget with every write tool on', () => {
    const result = handleCalmResources({}, { writeEnabled: true, updateEnabled: true });
    expect(textOf(result)).not.toContain('RESPONSE_TOO_LARGE');
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
