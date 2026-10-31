// Refusals that must happen before any request reaches Cloud ALM. The MockAgent has no interceptor
// and net connect disabled, so a call that got as far as sending would fail with NETWORK instead
// of the refusal asserted here.

import { MockAgent, setGlobalDispatcher } from 'undici';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleCalmAnalytics } from '../../src/tools/calmAnalytics.js';
import { handleCalmCreate } from '../../src/tools/calmCreate.js';
import { handleCalmList } from '../../src/tools/calmList.js';
import { handleCalmUpdate } from '../../src/tools/calmUpdate.js';
import { makeClients, textOf } from './helpers.js';

const PROJECT = '11111111-1111-1111-1111-111111111111';
const FEATURE = '55555555-5555-5555-5555-555555555555';

describe('refused before any request', () => {
  let agent: MockAgent;
  beforeEach(() => {
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
  });
  afterEach(async () => {
    await agent.close();
  });

  it.each([
    ['top with count_only', { resource: 'features', count_only: true, top: 5 }, 'top applies'],
    ['skip with group_by', { resource: 'features', group_by: 'statusCode', skip: 5 }, 'skip'],
    [
      'select with count_only',
      { resource: 'features', count_only: true, select: 'uuid' },
      'select',
    ],
    [
      'with_count with count_only',
      { resource: 'features', count_only: true, with_count: true },
      'with_count',
    ],
    [
      'a paging key in rest_filters',
      { resource: 'landscape_objects', rest_filters: { limit: '1000' } },
      "may not set 'limit'",
    ],
    [
      'a timebox on another resource',
      { resource: 'features', timebox_name: 'Sprint 5' },
      "apply to resource 'tasks' only",
    ],
  ] as const)('calm_list: %s', async (_, args, expected) => {
    const result = await handleCalmList(makeClients(), args);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(expected);
  });

  it('calm_analytics: top with count_only', async () => {
    const result = await handleCalmAnalytics(makeClients(), {
      provider: 'Tasks',
      count_only: true,
      top: 5,
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('top applies');
  });

  it('calm_update: no changes', async () => {
    const result = await handleCalmUpdate(makeClients({ updateEnabled: true }), {
      resource: 'feature',
      id: FEATURE,
      changes: {},
      expected_modified_at: '2026-10-01T09:30:00.000Z',
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('changes is empty');
  });

  it.each([
    ['a script', '<p>x</p><script>alert(1)</script>', '<script>'],
    ['a foreign image', '<img src="https://x.example/p.png">', 'image service'],
    ['an entity-disguised host', '<img src="&sol;&sol;x.example/ui/imageServiceAPI/x">', '&sol;'],
  ])('calm_create: a feature description with %s', async (_, description, expected) => {
    const result = await handleCalmCreate(makeClients({ writeEnabled: true }), {
      resource: 'feature',
      data: { title: 'x', projectId: PROJECT, description },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(expected);
  });
});
