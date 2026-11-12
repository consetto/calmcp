// calm_create resource task_requirement_link: assigning a project task or user story to a
// requirement (src/tools/create.ts). Cloud ALM stores the assignment as a parent relation and would
// accept one between tasks that have nothing to do with requirements, so calmcp reads both ends
// first. Every refusal is checked to happen before the POST: net connect is disabled and no POST
// is intercepted, so a POST that slipped through would fail the call as NETWORK.

import { MockAgent, setGlobalDispatcher } from 'undici';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type CreateAuditEntry, handleCalmCreate } from '../../src/tools/calmCreate.js';
import { handleCalmResources } from '../../src/tools/calmResources.js';
import { LIST_RESOURCES } from '../../src/tools/registry.js';
import { makeClients, ORIGIN, parse, textOf } from './helpers.js';

const TASK = '22222222-2222-2222-2222-222222222222';
const REQUIREMENT = '33333333-3333-3333-3333-333333333333';
const OTHER = '44444444-4444-4444-4444-444444444444';
const PROJECT = '11111111-1111-1111-1111-111111111111';
const TASKS = '/api/calm-tasks/v1/tasks';

describe('calm_create task_requirement_link', () => {
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

  const link = (data: Record<string, unknown> = { taskId: TASK, requirementId: REQUIREMENT }) =>
    handleCalmCreate(makeClients({ writeEnabled: true }), {
      resource: 'task_requirement_link',
      data,
    });
  const get = (path: string, body: object, status = 200) =>
    agent.get(ORIGIN).intercept({ path }).reply(status, body);
  /** The two reads of the ends, then (when given) the task's relations. */
  const ends = (
    task: Record<string, unknown>,
    requirement: Record<string, unknown>,
    relations?: object,
  ) => {
    get(`${TASKS}/${TASK}`, { id: TASK, projectId: PROJECT, ...task });
    get(`${TASKS}/${REQUIREMENT}`, { id: REQUIREMENT, projectId: PROJECT, ...requirement });
    if (relations !== undefined) get(`${TASKS}/${TASK}/relations`, relations);
  };
  const errorOf = (result: Awaited<ReturnType<typeof handleCalmCreate>>) =>
    JSON.parse(textOf(result)) as { error: string; message: string };

  it.each([['CALMTASK'], ['CALMUS']])(
    'posts a parent relation on a %s, pointing at the requirement',
    async (type) => {
      // The task has other relations, none of them a parent.
      ends({ type }, { type: 'CALMREQU' }, [{ id: 'r-0', type: '1', relationTaskId: OTHER }]);
      const sent: unknown[] = [];
      agent
        .get(ORIGIN)
        .intercept({
          path: `${TASKS}/${TASK}/relations`,
          method: 'POST',
          body: (body) => {
            sent.splice(0, sent.length, JSON.parse(body));
            return true;
          },
        })
        .reply(201, { id: 'r-1', type: '10', relationTaskId: REQUIREMENT });
      const audit: CreateAuditEntry[] = [];
      const result = await handleCalmCreate(
        makeClients({ writeEnabled: true }),
        {
          resource: 'task_requirement_link',
          data: { taskId: TASK, requirementId: REQUIREMENT },
        },
        (entry) => audit.push(entry),
      );
      expect(result.isError).toBeFalsy();
      expect(sent).toEqual([{ type: '10', relationTaskId: REQUIREMENT }]);
      expect(parse(result)).toMatchObject({ created: true, id: 'r-1' });
      expect(audit).toMatchObject([{ resource: 'task_requirement_link', outcome: 'applied' }]);
    },
  );

  it.each([
    ['a display id for the task', { taskId: '3-50', requirementId: REQUIREMENT }, 'taskId'],
    ['a display id for the requirement', { taskId: TASK, requirementId: '3-52' }, 'requirementId'],
    ['a task assigned to itself', { taskId: TASK, requirementId: TASK }, 'itself'],
    ['a relation type of its own', { taskId: TASK, requirementId: REQUIREMENT, type: '0' }, 'type'],
    ['a missing requirement', { taskId: TASK }, 'requirementId'],
  ])('refuses %s before asking Cloud ALM anything', async (_, data, named) => {
    const result = await link(data);
    expect(errorOf(result).error).toBe('INVALID_ARGUMENT');
    expect(errorOf(result).message).toContain(named);
  });

  it.each([
    ['a defect', 'CALMDEF', 'Only a project task'],
    ['a risk', 'CALMRISK', 'Only a project task'],
    ['a sub-task', 'CALMST', 'assign that task'],
    ['a second requirement', 'CALMREQU', 'Only a project task'],
    ['a roadmap task', 'CALMTMPL', 'Only a project task'],
  ])('refuses %s as the task, without POSTing', async (_, type, named) => {
    ends({ type }, { type: 'CALMREQU' });
    const result = await link();
    expect(errorOf(result).error).toBe('INVALID_ARGUMENT');
    expect(errorOf(result).message).toContain(named);
  });

  it.each([
    ['a project task', 'CALMTASK', 'not a requirement'],
    ['a user story', 'CALMUS', 'not a requirement'],
  ])('refuses %s as the requirement, without POSTing', async (_, type, named) => {
    ends({ type: 'CALMTASK' }, { type });
    expect(errorOf(await link()).message).toContain(named);
  });

  it('says so when the two ids are the wrong way round', async () => {
    ends({ type: 'CALMREQU' }, { type: 'CALMUS' });
    expect(errorOf(await link()).message).toContain('swap them');
  });

  it('refuses a task and a requirement of different projects, without POSTing', async () => {
    ends({ type: 'CALMUS' }, { type: 'CALMREQU', projectId: OTHER });
    expect(errorOf(await link()).message).toContain('different projects');
  });

  it('refuses a repeat as a conflict, without POSTing', async () => {
    ends({ type: 'CALMUS' }, { type: 'CALMREQU' }, [
      { id: 'r-1', type: '10', relationTaskId: REQUIREMENT },
    ]);
    const result = await link();
    expect(errorOf(result)).toMatchObject({ error: 'CONFLICT' });
    expect(errorOf(result).message).toContain('already assigned to this requirement');
  });

  it('refuses a task that already has another requirement, naming it, without POSTing', async () => {
    ends({ type: 'CALMUS' }, { type: 'CALMREQU' }, [
      { id: 'r-1', type: 10, relationTaskId: OTHER },
    ]);
    const result = await link();
    expect(errorOf(result)).toMatchObject({ error: 'CONFLICT' });
    expect(errorOf(result).message).toContain(OTHER);
  });

  it.each([
    ['a task read without its type', { type: undefined }, { type: 'CALMREQU' }, undefined],
    [
      'a requirement read without its project',
      { type: 'CALMUS' },
      { type: 'CALMREQU', projectId: null },
      undefined,
    ],
    ['relations that are no list', { type: 'CALMUS' }, { type: 'CALMREQU' }, { message: 'x' }],
  ])(
    'refuses on %s instead of guessing, without POSTing',
    async (_, task, requirement, relations) => {
      ends(task, requirement, relations);
      const result = await link();
      expect(errorOf(result).error).toBe('UPSTREAM_ERROR');
      expect(errorOf(result).message.toLowerCase()).toContain('nothing was sent');
    },
  );

  it('passes on a task Cloud ALM does not know, without POSTing', async () => {
    get(`${TASKS}/${TASK}`, { message: 'Cannot find task' }, 404);
    expect(errorOf(await link())).toMatchObject({ error: 'NOT_FOUND' });
  });

  it('refuses when write access is off', async () => {
    const result = await handleCalmCreate(makeClients(), {
      resource: 'task_requirement_link',
      data: { taskId: TASK, requirementId: REQUIREMENT },
    });
    expect(textOf(result)).toContain('CALM_WRITE_ENABLED');
  });

  it('is described to callers who may create, and the read side says where to look', () => {
    const topic = parse(
      handleCalmResources({ topic: 'task_requirement_link' }, { writeEnabled: true }),
    ) as { create: { fields: unknown } };
    expect(JSON.stringify(topic.create.fields)).toContain('requirementId');
    expect(JSON.stringify(topic.create.fields)).not.toContain('"name":"type"');
    expect(LIST_RESOURCES.task_relations?.description).toContain('type 0');
    expect(LIST_RESOURCES.task_relations?.description).toContain('type 10');
    const recipes = JSON.stringify(parse(handleCalmResources({ topic: 'recipes' })));
    expect(recipes).toContain('task_requirement_link');
    expect(recipes).toContain('parentId');
    expect(recipes).toContain('task_tags');
  });
});

// Creating a task with a requirement as parentId. Cloud ALM stores that link as a relation and
// returns the new task with parentId null, so the echo cannot confirm it: calmcp reads the new
// task's relations and reports what they show.
describe('calm_create task with a requirement as parentId', () => {
  const NEW = '55555555-5555-5555-5555-555555555555';
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

  const data = (extra: Record<string, unknown> = {}) => ({
    type: 'CALMTASK',
    title: 'Build it',
    projectId: PROJECT,
    parentId: REQUIREMENT,
    ...extra,
  });
  const create = (payload: Record<string, unknown> = data()) =>
    handleCalmCreate(makeClients({ writeEnabled: true }), { resource: 'task', data: payload });
  /** The POST answers with the new task as Cloud ALM echoes it. */
  const posted = (echo: Record<string, unknown>) =>
    agent
      .get(ORIGIN)
      .intercept({ path: TASKS, method: 'POST' })
      .reply(201, { id: NEW, displayId: '3-99', title: 'Build it', projectId: PROJECT, ...echo });
  const parentIs = (body: object, status = 200) =>
    agent
      .get(ORIGIN)
      .intercept({ path: `${TASKS}/${REQUIREMENT}` })
      .reply(status, body);
  const relationsAre = (body: object, status = 200) =>
    agent
      .get(ORIGIN)
      .intercept({ path: `${TASKS}/${NEW}/relations` })
      .reply(status, body);

  it.each([['CALMTASK'], ['CALMUS']])(
    'reports the requirement of a new %s as linked, from its relations, not from parentId',
    async (type) => {
      posted({ type, parentId: null });
      parentIs({ id: REQUIREMENT, type: 'CALMREQU', displayId: '3-52' });
      relationsAre([{ id: 'r-1', type: '10', relationTaskId: REQUIREMENT }]);
      const result = await create(data({ type }));
      expect(result.isError).toBeFalsy();
      const body = parse(result) as Record<string, unknown> & { set: Record<string, unknown> };
      expect(body).toMatchObject({
        created: true,
        id: NEW,
        requirement: { id: REQUIREMENT, displayId: '3-52', linked: true },
      });
      expect(body.storedDiffersFromSent).toBeUndefined();
      expect(body.set).not.toHaveProperty('parentId');
      expect(body.note).toBeUndefined();
    },
  );

  it('says so when the task exists but the requirement link was not stored', async () => {
    posted({ type: 'CALMTASK', parentId: null });
    parentIs({ id: REQUIREMENT, type: 'CALMREQU', displayId: '3-52' });
    relationsAre([{ id: 'r-0', type: '1', relationTaskId: OTHER }]);
    const body = parse(await create()) as { note: string; storedDiffersFromSent?: unknown };
    expect(body).toMatchObject({ created: true, requirement: { id: REQUIREMENT, linked: false } });
    expect(body.note).toContain('NOT stored');
    expect(body.note).toContain('task_requirement_link');
    expect(body.note).toContain('Do not create the task again');
    expect(body.storedDiffersFromSent).toBeUndefined();
  });

  it.each([
    ['fails', { message: 'boom' }, 500],
    ['is no list', { message: 'x' }, 200],
  ])('reports the link as unknown when reading the relations %s', async (_, relations, status) => {
    posted({ type: 'CALMTASK', parentId: null });
    parentIs({ id: REQUIREMENT, type: 'CALMREQU', displayId: '3-52' });
    relationsAre(relations, status);
    const result = await create();
    expect(result.isError).toBeFalsy();
    const body = parse(result) as { note: string; storedDiffersFromSent?: unknown };
    expect(body).toMatchObject({ created: true, requirement: { linked: 'unknown' } });
    expect(body.note).toContain('unknown');
    expect(body.note).toContain('Do not create the task again');
    expect(body.storedDiffersFromSent).toBeUndefined();
  });

  it('still confirms the link when the parent itself cannot be read', async () => {
    posted({ type: 'CALMTASK', parentId: null });
    parentIs({ message: 'boom' }, 500);
    relationsAre([{ id: 'r-1', type: '10', relationTaskId: REQUIREMENT }]);
    expect(parse(await create())).toMatchObject({
      created: true,
      parent: { id: REQUIREMENT, linked: true },
    });
  });

  it('leaves a sub-task as it was: parentId comes back on the task, and nothing else is read', async () => {
    posted({ type: 'CALMST', parentId: REQUIREMENT });
    const body = parse(await create(data({ type: 'CALMST' }))) as Record<string, unknown> & {
      set: Record<string, unknown>;
    };
    expect(body.set.parentId).toBe(REQUIREMENT);
    expect(body.storedDiffersFromSent).toBeUndefined();
    expect(body).not.toHaveProperty('requirement');
    expect(body).not.toHaveProperty('parent');
  });

  it('reads nothing after creating a task without a parent', async () => {
    posted({ type: 'CALMTASK', parentId: null });
    const body = parse(await create({ type: 'CALMTASK', title: 'Build it', projectId: PROJECT }));
    expect(body).toMatchObject({ created: true, id: NEW });
    expect(body).not.toHaveProperty('requirement');
  });
});
