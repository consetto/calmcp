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
