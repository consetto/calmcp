// `calm_get` resources: each public `resource` value mapped to the request fetching one entity.

import type { ServiceName } from '../../config.js';
import type { GetResource, ODataGetResource, RestGetResource } from './types.js';

/** One OData entity, fetched by key. */
function odataEntity(
  service: ServiceName,
  entitySet: string,
  description: string,
): ODataGetResource {
  return { kind: 'odata', service, entitySet, description };
}

/** One REST entity at `<collection>/{id}`. */
function restEntity(
  service: ServiceName,
  collection: string,
  description: string,
): RestGetResource {
  return {
    kind: 'rest',
    service,
    description,
    build: (id) => `${collection}/${encodeURIComponent(id)}`,
  };
}

/** Resources retrievable via `calm_get`, keyed by the public `resource` value. */
export const GET_RESOURCES: Record<string, GetResource> = {
  feature: {
    kind: 'odata',
    service: 'features',
    entitySet: 'Features',
    allowDisplayId: true,
    description: 'A single feature by uuid or display id (e.g. "6-123")',
  },
  document: odataEntity('documents', 'Documents', 'A single document by uuid'),
  hierarchy_node: odataEntity(
    'processhierarchy',
    'HierarchyNodes',
    'A single hierarchy node by uuid',
  ),
  manual_test_case: odataEntity(
    'testmanagement',
    'ManualTestCases',
    'A single manual test case by uuid',
  ),
  automated_test_case: odataEntity(
    'testmanagement',
    'AutomatedTestCases',
    'A single automated test case by uuid',
  ),
  xlib_application: odataEntity(
    'xlibApplications',
    'Applications',
    'A single cross-library application by uuid',
  ),
  xlib_configuration: odataEntity(
    'xlibConfigurations',
    'Configurations',
    'A single cross-library configuration by uuid',
  ),
  xlib_development: odataEntity(
    'xlibDevelopments',
    'Developments',
    'A single cross-library development by uuid',
  ),
  xlib_interface: odataEntity(
    'xlibInterfaces',
    'Interfaces',
    'A single cross-library interface by uuid',
  ),
  task: restEntity('tasks', '/tasks', 'A single task (incl. defect) by id, with full description'),
  deliverable: restEntity('tasks', '/deliverables', 'A single deliverable by id'),
  project: restEntity('projects', '/projects', 'A single project by id'),
  program: restEntity('projects', '/programs', 'A single program by id (with its projects)'),
  timebox: restEntity('projects', '/timeboxes', 'A single timebox by id'),
  team: restEntity('projects', '/teams', 'A single team by id'),
  deployment_plan: restEntity('projects', '/deploymentPlans', 'A single deployment plan by id'),
  system_group: restEntity('projects', '/systemGroups', 'A single system group by id'),
  program_team: restEntity('projects', '/programTeams', 'A single program team by id'),
  scope: restEntity('processManagement', '/scopes', 'A single process scope by id'),
  solution_scenario_version: restEntity(
    'processManagement',
    '/solutionScenarioVersions',
    'A single solution scenario version by id',
  ),
  business_process: restEntity(
    'processAuthoring',
    '/businessProcesses',
    'A single authored business process by id',
  ),
  solution_process: restEntity(
    'processAuthoring',
    '/solutionProcesses',
    'A single authored solution process by id',
  ),
  solution_activity: restEntity(
    'processAuthoring',
    '/solutionActivities',
    'A single solution activity by id',
  ),
  process_asset: restEntity('processAuthoring', '/assets', 'A single process asset by id'),
  test_plan: odataEntity(
    'testPlans',
    'TestPlans',
    'A single test plan by uuid (BETA API — may change)',
  ),
  test_case_assignment: odataEntity(
    'testPlans',
    'TestCaseAssignments',
    'A single test-plan test case assignment by uuid (BETA API — may change)',
  ),
};

/** Public `resource` values accepted by `calm_get`. */
export const GET_RESOURCE_NAMES = Object.keys(GET_RESOURCES);
