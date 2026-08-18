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
  unit?: string;
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

  it('counts distinct entities, not rows, for a grand total', async () => {
    // An analytics row is one dimension combination, not one record, so $count over the identity
    // is the only figure that answers "how many are there?".
    agent
      .get(ORIGIN)
      .intercept({
        path: `${ANALYTICS}/Tasks?$filter=${PINNED}&$select=taskGUID&$top=0&$count=true`,
      })
      .reply(200, { '@count': 428, value: [] });

    const body = parse(
      await handleCalmAnalytics(makeClients(), { provider: 'Tasks', count_only: true }),
    ) as CountBody;
    expect(body.total).toBe(428);
    expect(body.unit).toBe('entities');
    expect(body.method).toBe('analytics-distinct');
    expect(body.complete).toBe(true);
  });

  it('coerces a string count annotation to a number', async () => {
    agent
      .get(ORIGIN)
      .intercept({
        path: `${ANALYTICS}/Tasks?$filter=${PINNED}&$select=taskGUID&$top=0&$count=true`,
      })
      .reply(200, { '@count': '428', value: [] });

    const body = parse(
      await handleCalmAnalytics(makeClients(), { provider: 'Tasks', count_only: true }),
    ) as CountBody;
    expect(body.total).toBe(428);
  });

  it('accepts the @odata.count spelling as well', async () => {
    agent
      .get(ORIGIN)
      .intercept({
        path: `${ANALYTICS}/Tasks?$filter=${PINNED}&$select=taskGUID&$top=0&$count=true`,
      })
      .reply(200, { '@odata.count': 12, value: [] });

    const body = parse(
      await handleCalmAnalytics(makeClients(), { provider: 'Tasks', count_only: true }),
    ) as CountBody;
    expect(body.total).toBe(12);
  });

  it('lets the service aggregate a breakdown, one row per group', async () => {
    // $select of dimensions plus the measure makes the service pre-aggregate: no paging, and the
    // counts are entity counts rather than row counts.
    agent
      .get(ORIGIN)
      .intercept({
        path: `${ANALYTICS}/Tasks?$filter=${PINNED}&$select=typeID%2Ccounter&$top=500&$skip=0`,
      })
      .reply(200, {
        value: [
          { typeID: 'CALMST', counter: 1356 },
          { typeID: 'CALMTASK', counter: 905 },
          { typeID: 'CALMTMPL', counter: 21 },
          { typeID: 'CALMUS', counter: 428 },
        ],
      });

    const body = parse(
      await handleCalmAnalytics(makeClients(), { provider: 'Tasks', group_by: 'typeID' }),
    ) as CountBody;
    expect(body.method).toBe('analytics-measure');
    expect(body.unit).toBe('entities');
    expect(body.total).toBe(2710);
    expect(body.groups?.[0]).toEqual({ value: 'CALMST', count: 1356 });
    expect(body.groups?.find((g) => g.value === 'CALMUS')?.count).toBe(428);
  });

  it('groups by several dimensions at once', async () => {
    agent
      .get(ORIGIN)
      .intercept({
        path: `${ANALYTICS}/Tasks?$filter=${PINNED}&$select=typeID%2CstatusText%2Ccounter&$top=500&$skip=0`,
      })
      .reply(200, {
        value: [
          { typeID: 'CALMUS', statusText: 'Done', counter: 168 },
          { typeID: 'CALMUS', statusText: 'Open', counter: 75 },
        ],
      });

    const body = parse(
      await handleCalmAnalytics(makeClients(), {
        provider: 'Tasks',
        group_by: 'typeID,statusText',
      }),
    ) as CountBody;
    expect(body.total).toBe(243);
    expect(body.groups?.[0]).toEqual({
      values: { typeID: 'CALMUS', statusText: 'Done' },
      count: 168,
    });
  });

  it('labels the count as rows when the provider has nothing catalogued', async () => {
    // Jobs has no identity or measure recorded, so calmcp must not pass data points off as records.
    agent
      .get(ORIGIN)
      .intercept({ path: `${ANALYTICS}/Jobs?$filter=${PINNED}&$top=500&$skip=0` })
      .reply(200, { value: [{ a: 1 }, { a: 2 }] });

    const body = parse(
      await handleCalmAnalytics(makeClients(), { provider: 'Jobs', count_only: true }),
    ) as CountBody;
    expect(body.total).toBe(2);
    expect(body.unit).toBe('rows');
    expect(body.note).toContain('not records');
    expect(body.note).toContain('calm_list');
  });

  it('pins the time window, echoes it, and labels the snapshot', async () => {
    const pool = agent.get(ORIGIN);
    pool
      .intercept({
        path:
          `${ANALYTICS}/Tasks?$filter=` +
          `${encodeURIComponent("typeID eq 'CALMUS' and period eq 'C1D' and resolution eq 'D'")}` +
          '&$select=taskGUID&$top=0&$count=true',
      })
      .reply(200, { '@count': 428, value: [] });
    // The unfiltered baseline differs, so the filter was applied and nothing is flagged.
    pool
      .intercept({
        path: `${ANALYTICS}/Tasks?$filter=${PINNED}&$select=taskGUID&$top=0&$count=true`,
      })
      .reply(200, { '@count': 2710, value: [] });

    const body = parse(
      await handleCalmAnalytics(makeClients(), {
        provider: 'Tasks',
        filter: "typeID eq 'CALMUS'",
        count_only: true,
      }),
    ) as CountBody;
    expect(body.total).toBe(428);
    expect(body.filter).toBe("typeID eq 'CALMUS' and period eq 'C1D' and resolution eq 'D'");
    expect(body.note).toContain('daily snapshot');
    expect(body.filterVerified).toBeUndefined();
  });

  it('flags a count the service may have produced by ignoring the filter', async () => {
    const pool = agent.get(ORIGIN);
    pool
      .intercept({
        path:
          `${ANALYTICS}/Tasks?$filter=` +
          `${encodeURIComponent("type eq 'User Story' and period eq 'C1D' and resolution eq 'D'")}` +
          '&$select=taskGUID&$top=0&$count=true',
      })
      .reply(200, { '@count': 2710, value: [] });
    pool
      .intercept({
        path: `${ANALYTICS}/Tasks?$filter=${PINNED}&$select=taskGUID&$top=0&$count=true`,
      })
      .reply(200, { '@count': 2710, value: [] });

    const body = parse(
      await handleCalmAnalytics(makeClients(), {
        provider: 'Tasks',
        filter: "type eq 'User Story'",
        count_only: true,
      }),
    ) as CountBody;
    expect(body.total).toBe(2710);
    expect(body.filterVerified).toBe(false);
    expect(body.note).toContain('ignored your filter');
  });

  it('does not spend a baseline request when there is no filter to verify', async () => {
    agent
      .get(ORIGIN)
      .intercept({
        path: `${ANALYTICS}/Tasks?$filter=${PINNED}&$select=taskGUID&$top=0&$count=true`,
      })
      .reply(200, { '@count': 2710, value: [] });

    const body = parse(
      await handleCalmAnalytics(makeClients(), { provider: 'Tasks', count_only: true }),
    ) as CountBody;
    expect(body.filterVerified).toBeUndefined();
  });

  it('lets a caller-supplied window win over the counting default', async () => {
    agent
      .get(ORIGIN)
      .intercept({
        path:
          `${ANALYTICS}/Tasks?$filter=${encodeURIComponent("period eq 'L4W' and resolution eq 'W'")}` +
          '&$select=taskGUID&$top=0&$count=true',
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
