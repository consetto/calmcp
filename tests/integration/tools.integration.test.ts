// Live checks of the tool handlers themselves (not just the clients), so behaviour that only a
// real Cloud ALM exhibits, such as its error bodies, paging and array fields, is covered.
// Run with: npm run test:integration (reads .env). See gates.ts for what each suite needs.

import { expect, it } from 'vitest';
import { createAuthProvider } from '../../src/auth/index.js';
import { CalmClients } from '../../src/calm/index.js';
import { Config } from '../../src/config.js';
import { createLogger } from '../../src/logging.js';
import { handleCalmGet } from '../../src/tools/calmGet.js';
import { handleCalmList } from '../../src/tools/calmList.js';
import { describeLive, describeWithProject, testProjectId } from './gates.js';

function makeClients(): CalmClients {
  const config = Config.fromEnv();
  const logger = createLogger(false);
  return new CalmClients(createAuthProvider(config, logger), config, logger);
}

/** Parse the JSON text of a tool result. */
function parse(result: { content: unknown[] }): unknown {
  return JSON.parse((result.content[0] as { text: string }).text);
}

describeLive('tools against a live backend', () => {
  it('reports a missing entity as NOT_FOUND', async () => {
    const result = await handleCalmGet(makeClients(), {
      resource: 'feature',
      id: '00000000-0000-0000-0000-000000000000',
    });
    expect(result.isError).toBe(true);
    expect(parse(result)).toMatchObject({ error: 'NOT_FOUND', retryable: false });
  });

  it('hints at the next page of a full OData page', async () => {
    const body = parse(await handleCalmList(makeClients(), { resource: 'features', top: 1 })) as {
      value: unknown[];
      nextPage?: unknown;
    };
    if (body.value.length === 1) expect(body.nextPage).toEqual({ skip: 1 });
  });
});

describeWithProject('tools against a live project', () => {
  const project_id = testProjectId as string;

  it('counts the project tasks completely', async () => {
    const body = parse(
      await handleCalmList(makeClients(), { resource: 'tasks', project_id, count_only: true }),
    ) as { total: number; complete: boolean };
    expect(body.complete).toBe(true);
    expect(body.total).toBeGreaterThanOrEqual(0);
  });

  it('breaks tags down per tag, never per combination', async () => {
    const body = parse(
      await handleCalmList(makeClients(), { resource: 'tasks', project_id, group_by: 'tags' }),
    ) as { groups: { value: string }[] };
    for (const group of body.groups) expect(group.value).not.toContain(',');
  });

  it('projects a single task to the requested fields', async () => {
    const list = parse(
      await handleCalmList(makeClients(), {
        resource: 'tasks',
        project_id,
        limit: 1,
        fields: 'id',
      }),
    ) as { records?: { id: string }[] } | { id: string }[];
    const first = (Array.isArray(list) ? list : (list.records ?? []))[0];
    if (!first) return;
    const task = parse(
      await handleCalmGet(makeClients(), { resource: 'task', id: first.id, fields: 'id,title' }),
    );
    expect(Object.keys(task as object).sort()).toEqual(['id', 'title']);
  });
});
