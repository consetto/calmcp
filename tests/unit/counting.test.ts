import { MockAgent, setGlobalDispatcher } from 'undici';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleCalmAnalytics } from '../../src/tools/calmAnalytics.js';
import { handleCalmList } from '../../src/tools/calmList.js';
import { makeClients, ORIGIN, parse } from './helpers.js';

const ANALYTICS = '/api/calm-analytics/v1/odata/v4/analytics';
const TASKS = '/api/calm-tasks/v1/tasks';

/** The `$filter` calmcp pins onto an analytics count, percent-encoded as it goes on the wire. */
const PINNED = encodeURIComponent("period eq 'C1D' and resolution eq 'D'");

interface CountBody {
  total: number;
  filterVerified?: false;
  complete: boolean;
  method: string;
  filter?: string;
  pagesFetched?: number;
  groupBy?: string[];
  groups?: { value?: string; count: number }[];
  otherCount?: number;
  note?: string;
  subject: Record<string, string>;
}

/** Build `n` task records, cycling the status so a group-by has something to tally. */
function tasks(n: number, offset = 0): Record<string, unknown>[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `t${offset + i}`,
    status: (offset + i) % 2 === 0 ? 'CIPUSOPEN' : 'CIPUSCLOSE',
  }));
}

describe('counting via calm_analytics', () => {
  let agent: MockAgent;
  beforeEach(() => {
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
  });
  afterEach(async () => {
    await agent.close();
  });

  it('asks for the count alone and reports the total', async () => {
    agent
      .get(ORIGIN)
      .intercept({ path: `${ANALYTICS}/Tasks?$filter=${PINNED}&$top=0&$count=true` })
      .reply(200, { '@count': 935, value: [] });

    const result = await handleCalmAnalytics(makeClients(), {
      provider: 'Tasks',
      count_only: true,
    });
    expect(result.isError).toBeFalsy();
    const body = parse(result) as CountBody;
    expect(body.total).toBe(935);
    expect(body.complete).toBe(true);
    expect(body.method).toBe('odata-count');
    expect(body.subject).toEqual({ provider: 'Tasks' });
  });

  it('coerces a string count annotation to a number', async () => {
    agent
      .get(ORIGIN)
      .intercept({ path: `${ANALYTICS}/Tasks?$filter=${PINNED}&$top=0&$count=true` })
      .reply(200, { '@count': '935', value: [] });

    const body = parse(
      await handleCalmAnalytics(makeClients(), { provider: 'Tasks', count_only: true }),
    ) as CountBody;
    expect(body.total).toBe(935);
  });

  it('accepts the @odata.count spelling as well', async () => {
    agent
      .get(ORIGIN)
      .intercept({ path: `${ANALYTICS}/Tasks?$filter=${PINNED}&$top=0&$count=true` })
      .reply(200, { '@odata.count': 12, value: [] });

    const body = parse(
      await handleCalmAnalytics(makeClients(), { provider: 'Tasks', count_only: true }),
    ) as CountBody;
    expect(body.total).toBe(12);
  });

  it('retries at $top=1 when the service answers without a count annotation', async () => {
    const pool = agent.get(ORIGIN);
    pool
      .intercept({ path: `${ANALYTICS}/Tasks?$filter=${PINNED}&$top=0&$count=true` })
      .reply(200, { value: [] });
    pool
      .intercept({ path: `${ANALYTICS}/Tasks?$filter=${PINNED}&$top=1&$count=true` })
      .reply(200, { '@count': 7, value: [{ id: 'a' }] });

    const body = parse(
      await handleCalmAnalytics(makeClients(), { provider: 'Tasks', count_only: true }),
    ) as CountBody;
    expect(body.total).toBe(7);
    expect(body.method).toBe('odata-count');
  });

  it('falls back to paging when no count annotation ever arrives', async () => {
    const pool = agent.get(ORIGIN);
    pool
      .intercept({ path: `${ANALYTICS}/Tasks?$filter=${PINNED}&$top=0&$count=true` })
      .reply(200, { value: [] });
    pool
      .intercept({ path: `${ANALYTICS}/Tasks?$filter=${PINNED}&$top=1&$count=true` })
      .reply(200, { value: [{ id: 'a' }] });
    pool
      .intercept({ path: `${ANALYTICS}/Tasks?$filter=${PINNED}&$top=500&$skip=0` })
      .reply(200, { value: tasks(3) });

    const body = parse(
      await handleCalmAnalytics(makeClients(), { provider: 'Tasks', count_only: true }),
    ) as CountBody;
    expect(body.total).toBe(3);
    expect(body.method).toBe('client-paging');
  });

  it('pins the time window, echoes it, and labels the snapshot', async () => {
    const pool = agent.get(ORIGIN);
    pool
      .intercept({
        path:
          `${ANALYTICS}/Tasks?$filter=` +
          `${encodeURIComponent("typeID eq 'CALMUS' and period eq 'C1D' and resolution eq 'D'")}` +
          '&$top=0&$count=true',
      })
      .reply(200, { '@count': 412, value: [] });
    // The unfiltered baseline differs, so the filter was applied and nothing is flagged.
    pool
      .intercept({ path: `${ANALYTICS}/Tasks?$filter=${PINNED}&$top=0&$count=true` })
      .reply(200, { '@count': 5364, value: [] });

    const body = parse(
      await handleCalmAnalytics(makeClients(), {
        provider: 'Tasks',
        filter: "typeID eq 'CALMUS'",
        count_only: true,
      }),
    ) as CountBody;
    expect(body.total).toBe(412);
    expect(body.filter).toBe("typeID eq 'CALMUS' and period eq 'C1D' and resolution eq 'D'");
    expect(body.note).toContain('daily snapshot');
    expect(body.filterVerified).toBeUndefined();
  });

  it('flags a count the service may have produced by ignoring the filter', async () => {
    const pool = agent.get(ORIGIN);
    // The analytics service drops a filter on an unsupported field instead of erroring, and then
    // answers with every row. Both counts therefore come back identical.
    pool
      .intercept({
        path:
          `${ANALYTICS}/Tasks?$filter=` +
          `${encodeURIComponent("type eq 'User Story' and period eq 'C1D' and resolution eq 'D'")}` +
          '&$top=0&$count=true',
      })
      .reply(200, { '@count': 5364, value: [] });
    pool
      .intercept({ path: `${ANALYTICS}/Tasks?$filter=${PINNED}&$top=0&$count=true` })
      .reply(200, { '@count': 5364, value: [] });

    const body = parse(
      await handleCalmAnalytics(makeClients(), {
        provider: 'Tasks',
        filter: "type eq 'User Story'",
        count_only: true,
      }),
    ) as CountBody;
    expect(body.total).toBe(5364);
    expect(body.filterVerified).toBe(false);
    expect(body.note).toContain('ignored your filter');
    expect(body.note).toContain('group_by');
  });

  it('does not spend a baseline request when there is no filter to verify', async () => {
    agent
      .get(ORIGIN)
      .intercept({ path: `${ANALYTICS}/Tasks?$filter=${PINNED}&$top=0&$count=true` })
      .reply(200, { '@count': 5364, value: [] });

    const body = parse(
      await handleCalmAnalytics(makeClients(), { provider: 'Tasks', count_only: true }),
    ) as CountBody;
    expect(body.total).toBe(5364);
    expect(body.filterVerified).toBeUndefined();
  });

  it('lets a caller-supplied window win over the counting default', async () => {
    agent
      .get(ORIGIN)
      .intercept({
        path:
          `${ANALYTICS}/Tasks?$filter=${encodeURIComponent("period eq 'L4W' and resolution eq 'W'")}` +
          '&$top=0&$count=true',
      })
      .reply(200, { '@count': 4, value: [] });

    const body = parse(
      await handleCalmAnalytics(makeClients(), {
        provider: 'Tasks',
        count_only: true,
        period: 'L4W',
        resolution: 'W',
      }),
    ) as CountBody;
    expect(body.filter).toBe("period eq 'L4W' and resolution eq 'W'");
  });

  it('does not double-merge a window the caller already wrote into the filter', async () => {
    agent
      .get(ORIGIN)
      .intercept({
        path:
          `${ANALYTICS}/Tasks?$filter=` +
          `${encodeURIComponent("period eq 'L1M' and resolution eq 'M'")}&$top=0&$count=true`,
      })
      .reply(200, { '@count': 1, value: [] });
    agent
      .get(ORIGIN)
      .intercept({ path: `${ANALYTICS}/Tasks?$filter=${PINNED}&$top=0&$count=true` })
      .reply(200, { '@count': 5364, value: [] });

    const body = parse(
      await handleCalmAnalytics(makeClients(), {
        provider: 'Tasks',
        filter: "period eq 'L1M' and resolution eq 'M'",
        count_only: true,
      }),
    ) as CountBody;
    expect(body.filter).toBe("period eq 'L1M' and resolution eq 'M'");
  });

  it('leaves the window alone for a plain (non-counting) query', async () => {
    agent
      .get(ORIGIN)
      .intercept({ path: `${ANALYTICS}/Tasks?$top=2` })
      .reply(200, { value: [{ id: 'a' }, { id: 'b' }] });

    const result = await handleCalmAnalytics(makeClients(), { provider: 'Tasks', top: 2 });
    expect((parse(result) as { value: unknown[] }).value).toHaveLength(2);
  });

  it('passes count through alongside the records', async () => {
    agent
      .get(ORIGIN)
      .intercept({ path: `${ANALYTICS}/Tasks?$top=1&$count=true` })
      .reply(200, { '@count': 9, value: [{ id: 'a' }] });

    const body = parse(
      await handleCalmAnalytics(makeClients(), { provider: 'Tasks', top: 1, count: true }),
    ) as Record<string, unknown>;
    expect(body['@count']).toBe(9);
  });

  it('groups by paging, because analytics has no grouped count calmcp can trust', async () => {
    agent
      .get(ORIGIN)
      .intercept({ path: `${ANALYTICS}/Tasks?$filter=${PINNED}&$top=500&$skip=0` })
      .reply(200, { value: tasks(4) });

    const body = parse(
      await handleCalmAnalytics(makeClients(), { provider: 'Tasks', group_by: 'status' }),
    ) as CountBody;
    expect(body.total).toBe(4);
    expect(body.method).toBe('client-paging');
    expect(body.groupBy).toEqual(['status']);
    expect(body.groups).toEqual([
      { value: 'CIPUSCLOSE', count: 2 },
      { value: 'CIPUSOPEN', count: 2 },
    ]);
  });
});

describe('counting via calm_list', () => {
  let agent: MockAgent;
  beforeEach(() => {
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
  });
  afterEach(async () => {
    await agent.close();
  });

  it('counts a REST resource across pages and keeps only the total', async () => {
    const pool = agent.get(ORIGIN);
    pool
      .intercept({ path: `${TASKS}?projectId=p1&type=CALMUS&offset=0&limit=500` })
      .reply(200, tasks(500));
    pool
      .intercept({ path: `${TASKS}?projectId=p1&type=CALMUS&offset=500&limit=500` })
      .reply(200, tasks(12, 500));

    const body = parse(
      await handleCalmList(makeClients(), {
        resource: 'tasks',
        project_id: 'p1',
        task_type: 'CALMUS',
        count_only: true,
      }),
    ) as CountBody;
    expect(body.total).toBe(512);
    expect(body.complete).toBe(true);
    expect(body.pagesFetched).toBe(2);
    expect(body.method).toBe('client-paging');
    expect(body.subject).toEqual({ resource: 'tasks', project_id: 'p1', task_type: 'CALMUS' });
    expect(body.groups).toBeUndefined();
  });

  it('groups a REST resource, and the groups sum to the total', async () => {
    agent
      .get(ORIGIN)
      .intercept({ path: `${TASKS}?projectId=p1&offset=0&limit=500` })
      .reply(200, tasks(7));

    const body = parse(
      await handleCalmList(makeClients(), {
        resource: 'tasks',
        project_id: 'p1',
        group_by: 'status',
      }),
    ) as CountBody;
    expect(body.total).toBe(7);
    const summed = (body.groups ?? []).reduce((sum, g) => sum + g.count, 0);
    expect(summed).toBe(7);
  });

  it('says so when the page cap stops the walk short', async () => {
    const pool = agent.get(ORIGIN);
    for (let page = 0; page < 40; page += 1) {
      pool
        .intercept({ path: `${TASKS}?projectId=p1&offset=${page * 500}&limit=500` })
        .reply(200, tasks(500, page * 500));
    }

    const body = parse(
      await handleCalmList(makeClients(), {
        resource: 'tasks',
        project_id: 'p1',
        count_only: true,
      }),
    ) as CountBody;
    expect(body.total).toBe(20000);
    expect(body.complete).toBe(false);
    expect(body.note).toContain('higher');
  });

  it('counts an OData resource with a single server-side request', async () => {
    agent
      .get(ORIGIN)
      .intercept({ path: '/api/calm-features/v1/Features?$top=0&$count=true' })
      .reply(200, { '@count': 57, value: [] });

    const body = parse(
      await handleCalmList(makeClients(), { resource: 'features', count_only: true }),
    ) as CountBody;
    expect(body.total).toBe(57);
    expect(body.method).toBe('odata-count');
  });

  it('rejects an unknown group_by field, naming the ones that exist', async () => {
    agent
      .get(ORIGIN)
      .intercept({ path: `${TASKS}?projectId=p1&offset=0&limit=500` })
      .reply(200, tasks(3));

    const result = await handleCalmList(makeClients(), {
      resource: 'tasks',
      project_id: 'p1',
      group_by: 'nope',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('status');
  });

  it('rejects count on a REST resource and points at count_only', async () => {
    const result = await handleCalmList(makeClients(), {
      resource: 'tasks',
      project_id: 'p1',
      count: true,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('count_only');
  });

  it('rejects fields combined with a count, since a count returns no records', async () => {
    const result = await handleCalmList(makeClients(), {
      resource: 'tasks',
      project_id: 'p1',
      count_only: true,
      fields: 'displayId',
    });
    expect(result.isError).toBe(true);
  });

  it('rejects a timebox filter combined with a count', async () => {
    const result = await handleCalmList(makeClients(), {
      resource: 'tasks',
      project_id: 'p1',
      timebox_name: 'Sprint 5',
      count_only: true,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('group_by');
  });

  it('still enforces required params before counting', async () => {
    const result = await handleCalmList(makeClients(), { resource: 'tasks', count_only: true });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('project_id');
  });

  it('keeps a counting result tiny even for a very large collection', async () => {
    const pool = agent.get(ORIGIN);
    pool.intercept({ path: `${TASKS}?projectId=p1&offset=0&limit=500` }).reply(200, tasks(500));
    pool
      .intercept({ path: `${TASKS}?projectId=p1&offset=500&limit=500` })
      .reply(200, tasks(1, 500));

    const result = await handleCalmList(makeClients(), {
      resource: 'tasks',
      project_id: 'p1',
      group_by: 'status',
    });
    expect(Buffer.byteLength(result.content[0]?.text ?? '', 'utf8')).toBeLessThan(4096);
  });
});
