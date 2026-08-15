import { describe, expect, it } from 'vitest';
import {
  GET_RESOURCE_NAMES,
  GET_RESOURCES,
  LIST_RESOURCE_NAMES,
  LIST_RESOURCES,
  type ListParams,
} from '../../src/tools/registry.js';

// Exercises every REST build function so URL composition is validated across the whole registry.
const PARAMS: ListParams = {
  project_id: 'p1',
  program_id: 'prog1',
  task_id: 't1',
  team_id: 'team1',
  task_type: 'CALMDEF',
  status: 'CIPDFCTOPEN',
  sub_status: 'DFC_NEW',
  assignee_id: 'u1',
  tags: ['a', 'b'],
  limit: 50,
  offset: 10,
  filters: { objectType: 'TechnicalSystem' },
};

describe('LIST_RESOURCES', () => {
  it('exposes a broad catalog including key resources', () => {
    expect(LIST_RESOURCE_NAMES.length).toBeGreaterThanOrEqual(25);
    for (const name of ['tasks', 'features', 'documents', 'landscape_objects', 'bsm_events']) {
      expect(LIST_RESOURCE_NAMES).toContain(name);
    }
  });

  it('every REST build produces a service-relative path (and valid query)', () => {
    for (const name of LIST_RESOURCE_NAMES) {
      const def = LIST_RESOURCES[name];
      if (def?.kind !== 'rest') continue;
      const { path, query } = def.build(PARAMS);
      expect(path.startsWith('/')).toBe(true);
      expect(query === '' || query.startsWith('?')).toBe(true);
    }
  });

  it('composes representative REST endpoints correctly', () => {
    const build = (name: string) =>
      (LIST_RESOURCES[name] as { build: (p: ListParams) => unknown }).build(PARAMS);
    expect(build('tasks')).toEqual({
      path: '/tasks',
      query:
        '?projectId=p1&type=CALMDEF&status=CIPDFCTOPEN&subStatus=DFC_NEW&assigneeId=u1&tags=a&tags=b&offset=10&limit=50',
    });
    expect(build('task_feature_assignments')).toEqual({
      path: '/tasks/t1/featureAssignments',
      query: '',
    });
    expect(build('project_timeboxes')).toEqual({ path: '/projects/p1/timeboxes', query: '' });
    expect(build('team_roles')).toEqual({ path: '/teams/team1/roles', query: '' });
    expect(build('deliverables')).toEqual({ path: '/deliverables', query: '?projectId=p1' });
    expect(build('deployment_plans')).toEqual({
      path: '/deploymentPlans',
      query: '?status=CIPDFCTOPEN&limit=50&offset=10',
    });
    expect(build('landscape_objects')).toEqual({
      path: '/landscapeObjects',
      query: '?objectType=TechnicalSystem&limit=50&offset=10',
    });
    expect(build('program_teams')).toEqual({ path: '/programs/prog1/teams', query: '' });
    expect(build('program_team_roles')).toEqual({ path: '/programTeams/team1/roles', query: '' });
    expect(build('task_solution_process_assignments')).toEqual({
      path: '/tasks/solutionProcessAssignments',
      query: '?projectId=p1&taskId=t1&offset=10&limit=50',
    });
  });

  it('sends the new task filters the way the Tasks API expects them', () => {
    const { query } = (
      LIST_RESOURCES.tasks as { build: (p: ListParams) => { query: string } }
    ).build({
      project_id: 'p1',
      last_changed_timestamp: 'gt:2026-08-01T00:00:00Z',
      last_changed_date: 'lt:2026-08-14',
      ids: ['3-1', '3-2'],
    });
    // `id` is one comma-separated value, not repeated keys.
    expect(query).toContain('id=3-1%2C3-2');
    expect(query).toContain('lastChangedTimestamp=gt%3A2026-08-01T00%3A00%3A00Z');
    expect(query).toContain('lastChangedDate=lt%3A2026-08-14');
  });

  it('keeps the OData system options literal on the process services', () => {
    const { path, query } = (
      LIST_RESOURCES.scopes as { build: (p: ListParams) => { path: string; query: string } }
    ).build({ project_id: 'p1', top: 5, skip: 10, orderby: 'name asc' });
    expect(path).toBe('/scopes');
    // `$` must not be percent-encoded to `%24` — the gateway expects the literal option name.
    expect(query).toBe('?projectId=p1&$top=5&$skip=10&$orderby=name%20asc');
  });
});

describe('GET_RESOURCES', () => {
  it('exposes single-entity resources including feature and task', () => {
    for (const name of ['feature', 'task', 'project', 'timebox']) {
      expect(GET_RESOURCE_NAMES).toContain(name);
    }
  });

  it('only features allow a display-id lookup', () => {
    const feature = GET_RESOURCES.feature;
    expect(feature?.kind).toBe('odata');
    expect(feature?.kind === 'odata' && feature.allowDisplayId).toBe(true);
  });

  it('every REST get builds an id path', () => {
    for (const name of GET_RESOURCE_NAMES) {
      const def = GET_RESOURCES[name];
      if (def?.kind !== 'rest') continue;
      expect(def.build('abc').startsWith('/')).toBe(true);
      expect(def.build('abc')).toContain('abc');
    }
  });
});
