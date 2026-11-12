// calm_update resource task_tags: adding and removing the tags of a task (src/tools/taskTags.ts).
//
// Cloud ALM replaces a task's whole tag list, so the checks here are about what goes into that
// list. Every refusal is checked to happen before any request: net connect is disabled, and a test
// that registers no intercept fails as NETWORK if the handler asks Cloud ALM anything.

import { MockAgent, setGlobalDispatcher } from 'undici';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleCalmResources } from '../../src/tools/calmResources.js';
import { handleCalmUpdate, type UpdateAuditEntry } from '../../src/tools/calmUpdate.js';
import { makeClients, ORIGIN, parse, textOf } from './helpers.js';

const ID = '66666666-6666-6666-6666-666666666666';
const PROJECT = '77777777-7777-7777-7777-777777777777';
const TASK = `/api/calm-tasks/v1/tasks/${ID}`;
const UPDATE_TAGS = '/api/calm-tasks/v1/tasks/updateTags';
const CHANGED = '2026-10-31T14:05:40.305183600Z';

const task = (tags: unknown) => ({
  id: ID,
  displayId: '3-50',
  projectId: PROJECT,
  type: 'CALMUS',
  title: 'A story',
  lastChangedTimestamp: CHANGED,
  tags,
});

describe('calm_update task_tags', () => {
  let agent: MockAgent;
  beforeEach(() => {
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
  });
  afterEach(async () => {
    // A leftover interceptor is a request the code stopped making.
    agent.assertNoPendingInterceptors();
    await agent.close();
  });

  const clients = () => makeClients({ updateEnabled: true });
  const call = (changes: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    resource: 'task_tags',
    id: ID,
    changes,
    ...extra,
  });
  const errorOf = (result: Awaited<ReturnType<typeof handleCalmUpdate>>) =>
    JSON.parse(textOf(result)) as { error: string; message: string; hint?: string };
  const read = (tags: unknown) =>
    agent.get(ORIGIN).intercept({ path: TASK }).reply(200, task(tags));
  /** Intercept the one POST and return what it carried. */
  const write = (status = 200) => {
    const sent: { body?: unknown } = {};
    agent
      .get(ORIGIN)
      .intercept({ path: UPDATE_TAGS, method: 'POST' })
      .reply(status, (request) => {
        sent.body = JSON.parse(String(request.body));
        // Cloud ALM echoes the payload whatever it stores.
        return status === 200 ? sent.body : 'gateway timeout';
      });
    return sent;
  };

  it('sends the whole list: the tags that stay, in their stored spelling, plus the new ones', async () => {
    read(['Wave: One', 'Team: Blue']);
    const sent = write();
    read(['Team: Blue', 'Wave: Two']);
    const audit: UpdateAuditEntry[] = [];
    const result = await handleCalmUpdate(
      clients(),
      call({ add: ['  Wave: Two '], remove: ['WAVE: ONE'] }),
      (entry) => audit.push(entry),
    );
    expect(sent.body).toEqual({ taskId: ID, tags: ['Team: Blue', 'Wave: Two'] });
    expect(parse(result)).toEqual({
      updated: true,
      resource: 'task_tags',
      id: ID,
      displayId: '3-50',
      tags: { before: ['Wave: One', 'Team: Blue'], after: ['Team: Blue', 'Wave: Two'] },
      added: ['Wave: Two'],
      removed: ['Wave: One'],
    });
    expect(audit).toEqual([
      {
        resource: 'task_tags',
        id: ID,
        displayId: '3-50',
        outcome: 'applied',
        modifiedBefore: CHANGED,
        changes: {
          tags: { before: ['Wave: One', 'Team: Blue'], after: ['Team: Blue', 'Wave: Two'] },
        },
      },
    ]);
  });

  it('never sends a second capitalisation of a tag the task already has', async () => {
    read(['Wave: One']);
    const sent = write();
    read(['Wave: One', 'New']);
    const result = await handleCalmUpdate(clients(), call({ add: ['wave: one', 'New', 'NEW'] }));
    expect(sent.body).toEqual({ taskId: ID, tags: ['Wave: One', 'New'] });
    expect(parse(result)).toMatchObject({ added: ['New'], alreadyPresent: ['Wave: One'] });
  });

  it('sends nothing when the task already is as asked, and shows its tags', async () => {
    read(['Wave: One']);
    const result = await handleCalmUpdate(
      clients(),
      call({ add: ['WAVE: ONE'], remove: ['Wave: Three'] }),
    );
    expect(result.isError).toBeFalsy();
    expect(parse(result)).toMatchObject({
      updated: false,
      tags: ['Wave: One'],
      alreadyPresent: ['Wave: One'],
      notOnTask: ['Wave: Three'],
    });
  });

  it.each([
    ['a task returned without tags', { ...task([]), tags: undefined }],
    ['tags that are not strings', task([{ name: 'x' }])],
  ])('refuses to merge into %s, and sends nothing', async (_, body) => {
    agent.get(ORIGIN).intercept({ path: TASK }).reply(200, body);
    const result = await handleCalmUpdate(clients(), call({ add: ['New'] }));
    expect(errorOf(result)).toMatchObject({ error: 'UPSTREAM_ERROR' });
    expect(errorOf(result).message).toContain('Nothing was sent');
  });

  it.each([
    ['a display id', call({ add: ['x'] }, { id: '3-50' }), 'uuid of the task'],
    [
      'expected_modified_at',
      call({ add: ['x'] }, { expected_modified_at: CHANGED }),
      'takes no expected_modified_at',
    ],
    ['remove_images', call({ add: ['x'] }, { remove_images: ['imageId:a'] }), 'no remove_images'],
    ['no tag at all', call({}), 'at least one tag'],
    ['the same tag added and removed', call({ add: ['Wave'], remove: ['wave'] }), 'in one call'],
    ['markup in a tag', call({ add: ['<b>x</b>'] }), 'may not contain'],
    ['a control character in a tag', call({ add: ['a\u0007b'] }), 'may not contain'],
    ['an empty tag', call({ add: ['   '] }), 'add.0'],
    ['a tag longer than Cloud ALM stores', call({ add: ['x'.repeat(257)] }), 'add.0'],
    ['an empty list', call({ remove: [] }), 'remove'],
    ['the whole list instead of add and remove', call({ tags: ['x'] }), 'tags'],
  ])('refuses %s before asking Cloud ALM anything', async (_, args, named) => {
    const result = await handleCalmUpdate(clients(), args);
    expect(errorOf(result).error).toBe('INVALID_ARGUMENT');
    expect(errorOf(result).message).toContain(named);
  });

  it('refuses when update access is off, also with write access on', async () => {
    const result = await handleCalmUpdate(
      makeClients({ writeEnabled: true }),
      call({ add: ['x'] }),
    );
    expect(errorOf(result).message).toContain('CALM_UPDATE_ENABLED');
    await expect(
      makeClients({ writeEnabled: true }).postChange('tasks', '/tasks/updateTags', {}),
    ).rejects.toThrow('CALM_UPDATE_ENABLED');
  });

  it('reports a tag Cloud ALM answered 200 to but did not store', async () => {
    read(['Old']);
    write();
    read([]);
    const result = await handleCalmUpdate(clients(), call({ add: ['wave: two'], remove: ['Old'] }));
    const body = parse(result) as { note: string };
    expect(body).toMatchObject({
      updated: true,
      allApplied: false,
      tags: { before: ['Old'], after: [] },
      added: [],
      removed: ['Old'],
      notStored: ['wave: two'],
    });
    expect(body.note).toContain('capitalisation');
    expect(body.note).toContain(`project_id: "${PROJECT}"`);
  });

  it('answers with an error when nothing was stored at all', async () => {
    read(['Old']);
    write();
    read(['Old']);
    const audit: UpdateAuditEntry[] = [];
    const result = await handleCalmUpdate(clients(), call({ add: ['wave: two'] }), (entry) =>
      audit.push(entry),
    );
    expect(errorOf(result)).toMatchObject({ error: 'UPSTREAM_ERROR', retryable: false });
    expect(errorOf(result).message).toContain('unchanged');
    expect(errorOf(result).message).toContain('"wave: two"');
    // Cloud ALM accepted the list, so the attempt is in the audit trail with what is stored now.
    expect(audit).toMatchObject([
      { outcome: 'applied', changes: { tags: { before: ['Old'], after: ['Old'] } } },
    ]);
  });

  it('names a tag that was kept in the list and is gone afterwards', async () => {
    read(['Keep', 'Old']);
    write();
    read([]);
    const body = parse(await handleCalmUpdate(clients(), call({ remove: ['Old'] }))) as {
      note: string;
    };
    expect(body).toMatchObject({ allApplied: false, lost: ['Keep'], removed: ['Old'] });
    expect(body.note).toContain('add them again');
  });

  it('audits a write with no answer as outcome unknown, and sends it once', async () => {
    read(['Old']);
    const sent = write(504);
    const audit: UpdateAuditEntry[] = [];
    const result = await handleCalmUpdate(clients(), call({ add: ['New'] }), (entry) =>
      audit.push(entry),
    );
    expect(sent.body).toEqual({ taskId: ID, tags: ['Old', 'New'] });
    expect(errorOf(result)).toMatchObject({ error: 'TIMEOUT', retryable: false });
    expect(errorOf(result).message).toContain('may or may not have been changed');
    expect(audit).toMatchObject([
      { outcome: 'unknown', changes: { tags: { before: ['Old'], after: ['Old', 'New'] } } },
    ]);
  });

  it('passes on a refusal by Cloud ALM, with the scope to add, and audits nothing', async () => {
    read(['Old']);
    agent.get(ORIGIN).intercept({ path: UPDATE_TAGS, method: 'POST' }).reply(403, '');
    const audit: UpdateAuditEntry[] = [];
    const result = await handleCalmUpdate(clients(), call({ add: ['New'] }), (entry) =>
      audit.push(entry),
    );
    expect(errorOf(result)).toMatchObject({ error: 'FORBIDDEN' });
    expect(errorOf(result).hint).toContain('calm-api.tasks.write');
    expect(audit).toEqual([]);
  });

  it('says so when the list was accepted but the task could not be read again', async () => {
    read(['Old']);
    write();
    agent.get(ORIGIN).intercept({ path: TASK }).reply(500, 'boom');
    const audit: UpdateAuditEntry[] = [];
    const result = await handleCalmUpdate(clients(), call({ add: ['New'] }), (entry) =>
      audit.push(entry),
    );
    const body = parse(result) as { note: string };
    expect(body).toMatchObject({ updated: true, tags: { before: ['Old'], sent: ['Old', 'New'] } });
    expect(body.note).toContain('not confirmed');
    expect(audit).toMatchObject([{ outcome: 'applied' }]);
  });

  it('is described by calm_resources only when update access is on', () => {
    const on = parse(
      handleCalmResources({ topic: 'task_tags' }, { writeEnabled: false, updateEnabled: true }),
    ) as { update: { fields: unknown; guards: string[]; example: string } };
    expect(JSON.stringify(on.update.fields)).toContain('add');
    expect(JSON.stringify(on.update.fields)).toContain('remove');
    expect(on.update.guards.join(' ')).toContain('expected_modified_at');
    expect(on.update.example).toContain("resource: 'task_tags'");
    const off = parse(handleCalmResources({ topic: 'task_tags' })) as { update?: unknown };
    expect(off.update).toBeUndefined();
  });
});

describe('calm_update feature', () => {
  it('still needs expected_modified_at, and asks nothing without it', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
    const result = await handleCalmUpdate(makeClients({ updateEnabled: true }), {
      resource: 'feature',
      id: '55555555-5555-5555-5555-555555555555',
      changes: { title: 'x' },
    });
    expect(JSON.parse(textOf(result))).toMatchObject({ error: 'INVALID_ARGUMENT' });
    expect(textOf(result)).toContain('needs expected_modified_at');
    await agent.close();
  });
});
