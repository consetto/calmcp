// calm_update: the guards that stand between a model and an existing Cloud ALM object
// (docs/UPDATES.md). Every refusal is checked to happen before any PATCH is sent: with net connect
// disabled and no PATCH intercept, a PATCH that slipped through would fail the call as NETWORK
// instead of the expected code.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import pino from 'pino';
import { MockAgent, setGlobalDispatcher } from 'undici';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Config } from '../../src/config.js';
import { buildMcpServer } from '../../src/server.js';
import { handleCalmResources } from '../../src/tools/calmResources.js';
import { handleCalmUpdate, type UpdateAuditEntry } from '../../src/tools/calmUpdate.js';
import { featureCreateSchema } from '../../src/tools/create.js';
import { droppedImages, imageKeys } from '../../src/tools/richText.js';
import { makeClients, ORIGIN, parse, textOf } from './helpers.js';

const ID = '5a4d46a3-13c4-492e-9bc4-5512ff56ef5c';
const FEATURE = `/api/calm-features/v1/Features/${ID}`;
const MODIFIED = '2026-09-14T11:20:58.396Z';
const img = (id: string) => `<img src="/ui/imageServiceAPI/v1/getImage?imageId=${id}" alt="x" />`;

const stored = {
  uuid: ID,
  displayId: '6-132',
  title: 'Close periods',
  description: `<p>Steps</p>${img('aaa')}<p>then</p>${img('bbb')}`,
  statusCode: 'IN_REALIZATION',
  priorityCode: 30,
  modifiedAt: MODIFIED,
};

describe('image keys', () => {
  it('keys image-service images by id, whatever the rest of the tag says', () => {
    expect(
      imageKeys(
        `${img('AAA')}<IMG alt='y' src='/ui/imageServiceAPI/v1/getImage?imageId=aaa'>` +
          '<img src="/ui/imageServiceAPI/v1/getImage?x=1&amp;imageId=ccc">',
      ),
    ).toEqual(['imageId:aaa', 'imageId:ccc']);
  });

  it('keys any other image by its src', () => {
    expect(imageKeys('<img src="https://example.com/a.png">')).toEqual([
      'src:https://example.com/a.png',
    ]);
    expect(imageKeys(undefined)).toEqual([]);
  });

  it('reports the images a new value drops, not the ones it moves', () => {
    const current = `${img('aaa')}${img('bbb')}`;
    expect(droppedImages(current, `<p>moved</p>${img('bbb')}<p>and</p>${img('aaa')}`)).toEqual([]);
    expect(droppedImages(current, `<p>shorter</p>${img('bbb')}`)).toEqual(['imageId:aaa']);
  });
});

describe('handleCalmUpdate', () => {
  let agent: MockAgent;
  beforeEach(() => {
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
  });
  afterEach(async () => {
    await agent.close();
  });

  const clients = () => makeClients({ updateEnabled: true });
  const call = (changes: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    resource: 'feature',
    id: ID,
    changes,
    expected_modified_at: MODIFIED,
    ...extra,
  });
  const errorOf = (result: Awaited<ReturnType<typeof handleCalmUpdate>>) =>
    JSON.parse(textOf(result)) as { error: string; message: string; hint?: string };

  it('refuses when update access is off', async () => {
    const result = await handleCalmUpdate(makeClients(), call({ title: 'x' }));
    expect(result.isError).toBe(true);
    expect(errorOf(result).message).toContain('CALM_UPDATE_ENABLED');
  });

  it('asks for the uuid when given a display id', async () => {
    const result = await handleCalmUpdate(clients(), { ...call({ title: 'x' }), id: '6-132' });
    expect(errorOf(result).message).toContain('calm_get');
  });

  it('rejects fields outside the allowlist, such as moving the feature to another project', async () => {
    const result = await handleCalmUpdate(clients(), call({ projectId: ID }));
    expect(errorOf(result)).toMatchObject({ error: 'INVALID_ARGUMENT' });
    expect(errorOf(result).message).toContain('projectId');
  });

  it('refuses when the feature changed since it was read', async () => {
    agent
      .get(ORIGIN)
      .intercept({ path: FEATURE })
      .reply(200, { ...stored, modifiedAt: '2026-09-30T08:00:00Z' });
    const result = await handleCalmUpdate(clients(), call({ title: 'New' }));
    expect(errorOf(result)).toMatchObject({ error: 'CONFLICT' });
    expect(errorOf(result).message).toContain('2026-09-30T08:00:00Z');
  });

  it('sends nothing when every field already holds the requested value', async () => {
    agent.get(ORIGIN).intercept({ path: FEATURE }).reply(200, stored);
    const result = await handleCalmUpdate(clients(), call({ statusCode: 'IN_REALIZATION' }));
    expect(parse(result)).toMatchObject({ updated: false });
  });

  it('refuses a description that drops an image, naming it', async () => {
    agent.get(ORIGIN).intercept({ path: FEATURE }).reply(200, stored);
    const result = await handleCalmUpdate(
      clients(),
      call({ description: `<p>Shorter</p>${img('bbb')}` }),
    );
    expect(errorOf(result)).toMatchObject({ error: 'INVALID_ARGUMENT' });
    expect(errorOf(result).message).toContain('imageId:aaa');
    expect(errorOf(result).message).toContain('remove_images: ["imageId:aaa"]');
  });

  it('sends only the changed fields, reports before and after, and audits the update', async () => {
    const newDescription = `<p>Steps, reworded</p>${img('aaa')}${img('bbb')}`;
    let sent: unknown;
    agent.get(ORIGIN).intercept({ path: FEATURE }).reply(200, stored);
    agent
      .get(ORIGIN)
      .intercept({ path: FEATURE, method: 'PATCH' })
      .reply(200, (request) => {
        sent = JSON.parse(String(request.body));
        return {};
      });
    agent
      .get(ORIGIN)
      .intercept({ path: FEATURE })
      .reply(200, {
        ...stored,
        statusCode: 'IN_TESTING',
        description: newDescription,
        modifiedAt: '2026-09-30T09:00:00Z',
      });

    const audit: UpdateAuditEntry[] = [];
    const result = await handleCalmUpdate(
      clients(),
      // priorityCode is unchanged and must not be sent.
      call({ statusCode: 'IN_TESTING', priorityCode: 30, description: newDescription }),
      (entry) => audit.push(entry),
    );

    expect(sent).toEqual({ statusCode: 'IN_TESTING', description: newDescription });
    expect(parse(result)).toMatchObject({
      updated: true,
      displayId: '6-132',
      modifiedAt: '2026-09-30T09:00:00Z',
      changes: {
        statusCode: { before: 'IN_REALIZATION', after: 'IN_TESTING' },
        description: { before: { images: 2 }, after: { images: 2 } },
      },
    });
    expect(audit).toEqual([
      {
        resource: 'feature',
        id: ID,
        displayId: '6-132',
        outcome: 'applied',
        // The replaced values, so the change can be undone by hand; HTML as length and images.
        changes: {
          description: {
            before: { length: stored.description.length, images: 2 },
            after: { length: newDescription.length, images: 2 },
          },
          statusCode: { before: 'IN_REALIZATION', after: 'IN_TESTING' },
        },
        modifiedBefore: MODIFIED,
        modifiedAfter: '2026-09-30T09:00:00Z',
      },
    ]);
  });

  it('removes exactly the images the caller names', async () => {
    agent.get(ORIGIN).intercept({ path: FEATURE }).reply(200, stored);
    agent.get(ORIGIN).intercept({ path: FEATURE, method: 'PATCH' }).reply(204, '');
    agent
      .get(ORIGIN)
      .intercept({ path: FEATURE })
      .reply(200, { ...stored, description: `<p>one left</p>${img('bbb')}` });
    const result = await handleCalmUpdate(
      clients(),
      // A bare id is accepted as an image-service id.
      call({ description: `<p>one left</p>${img('bbb')}` }, { remove_images: ['AAA'] }),
    );
    expect(parse(result)).toMatchObject({
      updated: true,
      changes: { description: { after: { images: 1 } } },
    });
  });

  it('still refuses an image the caller did not name', async () => {
    agent.get(ORIGIN).intercept({ path: FEATURE }).reply(200, stored);
    const result = await handleCalmUpdate(
      clients(),
      call({ description: '<p>none</p>' }, { remove_images: ['imageId:aaa'] }),
    );
    expect(errorOf(result).message).toContain('remove_images: ["imageId:bbb"]');
  });

  it('reports a change Cloud ALM accepted as done, and audits it, when reading it back fails', async () => {
    agent.get(ORIGIN).intercept({ path: FEATURE }).reply(200, stored);
    agent.get(ORIGIN).intercept({ path: FEATURE, method: 'PATCH' }).reply(204, '');
    agent.get(ORIGIN).intercept({ path: FEATURE }).reply(500, 'read-back failed');
    const audit: UpdateAuditEntry[] = [];
    const result = await handleCalmUpdate(clients(), call({ title: 'New' }), (entry) =>
      audit.push(entry),
    );
    expect(result.isError).toBeFalsy();
    expect(parse(result)).toMatchObject({
      updated: true,
      changes: { title: { before: 'Close periods', after: 'New' } },
    });
    expect((parse(result) as { note: string }).note).toContain('reading it back failed');
    expect(audit).toMatchObject([{ outcome: 'applied', modifiedAfter: undefined }]);
  });

  it('audits a PATCH with no answer as outcome unknown and says it may have been applied', async () => {
    agent.get(ORIGIN).intercept({ path: FEATURE }).reply(200, stored);
    agent.get(ORIGIN).intercept({ path: FEATURE, method: 'PATCH' }).reply(504, 'gateway timeout');
    const audit: UpdateAuditEntry[] = [];
    const result = await handleCalmUpdate(clients(), call({ title: 'New' }), (entry) =>
      audit.push(entry),
    );
    expect(errorOf(result)).toMatchObject({ error: 'TIMEOUT', retryable: false });
    expect(errorOf(result).message).toContain('may or may not have been applied');
    expect(audit).toMatchObject([
      { outcome: 'unknown', changes: { title: { before: 'Close periods', after: 'New' } } },
    ]);
  });

  it('writes no audit entry when Cloud ALM rejects the PATCH', async () => {
    agent.get(ORIGIN).intercept({ path: FEATURE }).reply(200, stored);
    agent
      .get(ORIGIN)
      .intercept({ path: FEATURE, method: 'PATCH' })
      .reply(400, { error: { code: 'BAD', message: 'invalid status transition' } });
    const audit: UpdateAuditEntry[] = [];
    const result = await handleCalmUpdate(clients(), call({ statusCode: 'CONFIRMED' }), (entry) =>
      audit.push(entry),
    );
    expect(errorOf(result)).toMatchObject({ error: 'BAD_REQUEST' });
    expect(audit).toEqual([]);
  });

  it.each([
    ['a script', '<p>x</p><script>alert(1)</script>', '<script>'],
    ['an event handler', '<p onmouseover="steal()">x</p>', 'onmouseover='],
    ['a javascript link', '<a href="javascript:steal()">x</a>', 'javascript:'],
    ['an entity-disguised javascript link', '<a href="jav&#x61;script:x()">x</a>', 'javascript:'],
    ['a foreign image', '<img src="https://evil.example/p.png">', 'image service'],
    [
      'a foreign image posing as an image-service id',
      '<img src="https://evil.example/x?imageId=aaa">',
      'image service',
    ],
    ['a CSS url', '<p style="background:url(https://evil.example/p)">x</p>', 'url('],
  ])('refuses a description with %s, before any PATCH', async (_, extra, named) => {
    agent.get(ORIGIN).intercept({ path: FEATURE }).reply(200, stored);
    const result = await handleCalmUpdate(
      clients(),
      call({ description: `${stored.description}${extra}` }),
    );
    expect(errorOf(result)).toMatchObject({ error: 'INVALID_ARGUMENT' });
    expect(errorOf(result).message).toContain(named);
  });

  it('keeps an image someone added in the UI from elsewhere, so the update is not blocked', async () => {
    const outside = '<img src="https://intranet.example/diagram.png">';
    agent
      .get(ORIGIN)
      .intercept({ path: FEATURE })
      .reply(200, { ...stored, description: `${stored.description}${outside}` });
    agent.get(ORIGIN).intercept({ path: FEATURE, method: 'PATCH' }).reply(204, '');
    agent.get(ORIGIN).intercept({ path: FEATURE }).reply(200, stored);
    const result = await handleCalmUpdate(
      clients(),
      call({ description: `<p>Reworded</p>${img('aaa')}${img('bbb')}${outside}` }),
    );
    expect(parse(result)).toMatchObject({ updated: true });
  });

  it('clears an assignment with null', async () => {
    let sent: unknown;
    agent
      .get(ORIGIN)
      .intercept({ path: FEATURE })
      .reply(200, { ...stored, responsibleId: 'jane' });
    agent
      .get(ORIGIN)
      .intercept({ path: FEATURE, method: 'PATCH' })
      .reply(204, (request) => {
        sent = JSON.parse(String(request.body));
        return '';
      });
    agent.get(ORIGIN).intercept({ path: FEATURE }).reply(200, stored);
    await handleCalmUpdate(clients(), call({ responsibleId: null }));
    expect(sent).toEqual({ responsibleId: null });
  });

  it('never retries a PATCH the service throttled', async () => {
    agent.get(ORIGIN).intercept({ path: FEATURE }).reply(200, stored);
    agent
      .get(ORIGIN)
      .intercept({ path: FEATURE, method: 'PATCH' })
      .reply(503, 'busy', { headers: { 'retry-after': '0' } });
    const result = await handleCalmUpdate(clients(), call({ title: 'New' }));
    // A retry would find no second PATCH intercept and fail as NETWORK instead.
    expect(errorOf(result)).toMatchObject({ error: 'UPSTREAM_ERROR' });
  });

  it('names the write scope when Cloud ALM refuses the PATCH', async () => {
    agent.get(ORIGIN).intercept({ path: FEATURE }).reply(200, stored);
    agent.get(ORIGIN).intercept({ path: FEATURE, method: 'PATCH' }).reply(403, 'Forbidden');
    const result = await handleCalmUpdate(clients(), call({ title: 'New' }));
    expect(errorOf(result)).toMatchObject({ error: 'FORBIDDEN' });
    expect(errorOf(result).hint).toContain('calm-api.features.write');
  });
});

describe('calm_update audit log', () => {
  let agent: MockAgent;
  beforeEach(() => {
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
  });
  afterEach(async () => {
    await agent.close();
  });

  it('logs the update with the XSUAA user as caller, through the server', async () => {
    agent.get(ORIGIN).intercept({ path: FEATURE }).reply(200, stored);
    agent.get(ORIGIN).intercept({ path: FEATURE, method: 'PATCH' }).reply(204, '');
    agent
      .get(ORIGIN)
      .intercept({ path: FEATURE })
      .reply(200, { ...stored, title: 'New' });

    const lines: string[] = [];
    const logger = pino({ level: 'info' }, { write: (line: string) => lines.push(line) });
    const authInfo: AuthInfo = {
      token: 't',
      clientId: 'c',
      scopes: ['Viewer', 'Writer'],
      extra: { userName: 'jane.doe' },
    };
    const server = buildMcpServer(makeClients({ updateEnabled: true }), logger, authInfo);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'audit-test', version: '1' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    await client.callTool({
      name: 'calm_update',
      arguments: {
        resource: 'feature',
        id: ID,
        changes: { title: 'New' },
        expected_modified_at: MODIFIED,
      },
    });
    await client.close();

    const entries = lines.map((line) => JSON.parse(line)).filter((entry) => entry.audit);
    expect(entries).toMatchObject([
      {
        level: 30,
        audit: 'calm_update',
        caller: 'jane.doe',
        outcome: 'applied',
        changes: { title: { before: 'Close periods', after: 'New' } },
      },
    ]);
  });
});

describe('who gets calm_update', () => {
  async function toolNames(options: { updateEnabled: boolean }, authInfo?: AuthInfo) {
    const server = buildMcpServer(makeClients(options), pino({ level: 'silent' }), authInfo);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'update-test', version: '1' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return (await client.listTools()).tools.map((tool) => tool.name);
  }
  const caller = (scopes: string[]): AuthInfo => ({ token: 't', clientId: 'c', scopes });

  it('is absent unless the operator enabled it', async () => {
    expect(await toolNames({ updateEnabled: false })).not.toContain('calm_update');
    expect(await toolNames({ updateEnabled: true })).toContain('calm_update');
  });

  it('is offered over HTTP only to callers with the Writer scope', async () => {
    expect(await toolNames({ updateEnabled: true }, caller(['Viewer']))).not.toContain(
      'calm_update',
    );
    expect(await toolNames({ updateEnabled: true }, caller(['Viewer', 'Writer']))).toContain(
      'calm_update',
    );
  });

  it('reads CALM_UPDATE_ENABLED, off by default', () => {
    const base = { CALM_SANDBOX: 'true', CALM_API_KEY: 'x' };
    expect(Config.fromEnv(base as NodeJS.ProcessEnv).updateEnabled).toBe(false);
    expect(
      Config.fromEnv({ ...base, CALM_UPDATE_ENABLED: 'true' } as NodeJS.ProcessEnv).updateEnabled,
    ).toBe(true);
  });

  it('lists the changeable fields in calm_resources only when offered', () => {
    const off = parse(handleCalmResources({ topic: 'feature' })) as { update?: unknown };
    expect(off.update).toBeUndefined();
    const on = parse(
      handleCalmResources({ topic: 'feature' }, { writeEnabled: false, updateEnabled: true }),
    ) as { update: { fields: { name: string }[] } };
    expect(on.update.fields.map((field) => field.name)).toContain('statusCode');
    expect(on.update.fields.map((field) => field.name)).not.toContain('projectId');
  });
});

describe('feature create payload', () => {
  it('needs title and projectId and takes external references keyed by id', () => {
    expect(featureCreateSchema.safeParse({ title: 't' }).success).toBe(false);
    const ok = featureCreateSchema.safeParse({
      title: 'Close periods',
      projectId: ID,
      priorityCode: 20,
      toExternalReferences: [{ id: 'JIRA-7', name: 'Jira' }],
    });
    expect(ok.success).toBe(true);
    expect(
      featureCreateSchema.safeParse({
        title: 't',
        projectId: ID,
        toExternalReferences: [{ externalReferenceId: 'JIRA-7', name: 'Jira' }],
      }).success,
    ).toBe(false);
  });
});
