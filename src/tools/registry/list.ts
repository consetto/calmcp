// `calm_list` resources: each public `resource` value mapped to a concrete Cloud ALM request.
//
// Most entries follow one of a few patterns, so they are built by small helpers rather than spelled
// out object by object; a resource with its own parameters still gets an explicit `build`.

import { buildQueryString } from '../../calm/odata.js';
import type { ServiceName } from '../../config.js';
import type { ListParams, ListResource, ODataListResource, RestListResource } from './types.js';

const enc = encodeURIComponent;

/**
 * Paging window for the process services, which read the OData system options rather than their own
 * `limit`/`offset`.
 *
 * calmcp pages these collections itself (counting, task windows) by driving `limit`/`offset`. A
 * build that forwarded only the caller's `$top`/`$skip` pinned every page to one URL, so the walk
 * stopped after a single request and reported the service's default page size as a complete total.
 * Letting the pager's window win makes the walk advance; the caller's own values still apply when
 * nothing is paging.
 *
 * @param p - The caller's parameters, with any pager window already merged in.
 * @returns The `$top`/`$skip` pair to put on the query.
 */
function systemPaging(p: ListParams): { $top?: number; $skip?: number } {
  return { $top: p.limit ?? p.top, $skip: p.offset ?? p.skip };
}

/** An OData entity set; `calm_list` forwards the OData system options to it. */
function odata(service: ServiceName, entitySet: string, description: string): ODataListResource {
  return { kind: 'odata', service, entitySet, description };
}

/** A REST collection of the process services, paged and sorted through the OData system options. */
function processCollection(
  service: ServiceName,
  path: string,
  description: string,
): RestListResource {
  return {
    kind: 'rest',
    service,
    required: [],
    description,
    build: (p) => ({ path, query: buildQueryString({ ...systemPaging(p), $orderby: p.orderby }) }),
  };
}

/** A REST collection that takes no query parameters at all. */
function plainCollection(
  service: ServiceName,
  path: string,
  description: string,
): RestListResource {
  return { kind: 'rest', service, required: [], description, build: () => ({ path, query: '' }) };
}

/** A REST collection below one parent entity, e.g. `/tasks/{task_id}/comments`. */
function childCollection(
  service: ServiceName,
  parent: 'task_id' | 'project_id' | 'team_id' | 'program_id',
  pathOf: (id: string) => string,
  description: string,
): RestListResource {
  return {
    kind: 'rest',
    service,
    required: [parent],
    description,
    build: (p) => ({ path: pathOf(enc(p[parent] ?? '')), query: '' }),
  };
}

/** A REST collection that takes a set of free-form `filters` plus `limit`/`offset`. */
function filteredCollection(
  service: ServiceName,
  path: string,
  description: string,
): RestListResource {
  return {
    kind: 'rest',
    service,
    required: [],
    description,
    build: (p) => ({
      path,
      query: buildQueryString({ ...(p.filters ?? {}), limit: p.limit, offset: p.offset }),
    }),
  };
}

/** Cross-library entity names as they appear in services, entity sets and code properties. */
const XLIB_ENTITIES = {
  application: { service: 'xlibApplications', set: 'Application' },
  configuration: { service: 'xlibConfigurations', set: 'Configuration' },
  development: { service: 'xlibDevelopments', set: 'Development' },
  interface: { service: 'xlibInterfaces', set: 'Interface' },
} as const;

type XlibEntity = keyof typeof XLIB_ENTITIES;

/** The classification code lists, as `[resource suffix, entity-set suffix, label]`. */
const XLIB_CODE_LISTS = {
  priorities: ['Priorities', 'Priority', 'priority'],
  readiness: ['Readiness', 'Readiness', 'readiness'],
  usage_statuses: ['UsageStatus', 'UsageStatus', 'usage status'],
  clean_core_levels: ['CleanCoreLevel', 'CleanCoreLevel', 'clean core level'],
  upgrade_impacts: ['UpgradeImpact', 'UpgradeImpact', 'upgrade impact'],
} as const;

/**
 * The classification code lists of one cross-library entity, e.g. `xlib_application_priorities`
 * for the `ApplicationPriorities` set that resolves `applicationPriorityCode`.
 */
function xlibCodeLists(
  entity: XlibEntity,
  kinds: (keyof typeof XLIB_CODE_LISTS)[],
): Record<string, ListResource> {
  const { service, set } = XLIB_ENTITIES[entity];
  return Object.fromEntries(
    kinds.map((kind) => {
      const [setSuffix, codeSuffix, label] = XLIB_CODE_LISTS[kind];
      return [
        `xlib_${entity}_${kind}`,
        odata(
          service,
          `${set}${setSuffix}`,
          `Cross-library ${entity} ${label} code list (${entity}${codeSuffix}Code)`,
        ),
      ];
    }),
  );
}

/** Resources listable via `calm_list`, keyed by the public `resource` value. */
export const LIST_RESOURCES: Record<string, ListResource> = {
  // --- Features (OData) ---
  features: odata('features', 'Features', 'Features'),
  feature_external_references: odata(
    'features',
    'ExternalReferences',
    'External references of features',
  ),
  feature_url_references: odata('features', 'URLReferences', 'URL references of features'),
  feature_task_assignments: odata('features', 'TaskAssignments', 'Task assignments of features'),
  feature_priorities: odata('features', 'FeaturePriorities', 'Feature priority code list'),
  feature_statuses: odata('features', 'FeatureStatus', 'Feature status code list'),

  // --- Documents (OData) ---
  documents: odata('documents', 'Documents', 'Documents'),
  document_types: odata('documents', 'DocumentTypes', 'Document type code list'),
  document_statuses: odata('documents', 'DocumentStatus', 'Document status code list'),
  document_sources: odata('documents', 'DocumentSources', 'Document source code list'),
  document_priorities: odata('documents', 'DocumentPriorities', 'Document priority code list'),
  document_approval_states: odata(
    'documents',
    'DocumentApprovalStates',
    'Document approval state code list',
  ),

  // --- Process Hierarchy (OData) ---
  hierarchy_nodes: odata('processhierarchy', 'HierarchyNodes', 'Process hierarchy nodes'),

  // --- Test Management (OData) ---
  manual_test_cases: odata('testmanagement', 'ManualTestCases', 'Manual test cases'),
  automated_test_cases: odata('testmanagement', 'AutomatedTestCases', 'Automated test cases'),
  test_activities: odata(
    'testmanagement',
    'Activities',
    'Test activities (steps within a test case)',
  ),
  test_actions: odata(
    'testmanagement',
    'Actions',
    'Test actions (individual steps with expected results)',
  ),

  // --- Cross-Library (OData) ---
  xlib_applications: odata('xlibApplications', 'Applications', 'Cross-library applications'),
  xlib_configurations: odata(
    'xlibConfigurations',
    'Configurations',
    'Cross-library configurations',
  ),
  xlib_developments: odata('xlibDevelopments', 'Developments', 'Cross-library developments'),
  xlib_interfaces: odata('xlibInterfaces', 'Interfaces', 'Cross-library interfaces'),
  // URL references were added to all four cross-library services in their 1.0.1/1.0.2 specs.
  xlib_application_url_references: odata(
    'xlibApplications',
    'URLReferences',
    'URL references of cross-library applications',
  ),
  xlib_configuration_url_references: odata(
    'xlibConfigurations',
    'URLReferences',
    'URL references of cross-library configurations',
  ),
  xlib_development_url_references: odata(
    'xlibDevelopments',
    'URLReferences',
    'URL references of cross-library developments',
  ),
  xlib_interface_url_references: odata(
    'xlibInterfaces',
    'URLReferences',
    'URL references of cross-library interfaces',
  ),
  // Configuration activities arrived with the Cross Library Configurations 1.0.1 spec.
  xlib_configuration_activities: odata(
    'xlibConfigurations',
    'ConfigurationActivities',
    'Cross-library configuration activities',
  ),
  xlib_configuration_activity_types: odata(
    'xlibConfigurations',
    'ConfigurationActivityTypes',
    'Cross-library configuration activity type code list',
  ),
  xlib_configuration_assignments: odata(
    'xlibConfigurations',
    'ConfigurationAssignments',
    'Assignments between configurations and configuration activities',
  ),

  // Classification code lists added by the September 2025 specs (Applications 1.0.4, Configurations
  // 1.0.2, Developments 1.0.4, Interfaces 1.0.3). Each main entity now carries the matching
  // `<entity>PriorityCode`, `<entity>ReadinessCode`, ... property; these resolve the codes to labels.
  // Configurations only have the first two.
  ...xlibCodeLists('application', [
    'priorities',
    'readiness',
    'usage_statuses',
    'clean_core_levels',
    'upgrade_impacts',
  ]),
  ...xlibCodeLists('configuration', ['priorities', 'readiness']),
  ...xlibCodeLists('development', [
    'priorities',
    'readiness',
    'usage_statuses',
    'clean_core_levels',
    'upgrade_impacts',
  ]),
  ...xlibCodeLists('interface', [
    'priorities',
    'readiness',
    'usage_statuses',
    'clean_core_levels',
    'upgrade_impacts',
  ]),

  // --- Process Scopes (REST, OData-style system options) ---
  scopes: {
    kind: 'rest',
    service: 'processManagement',
    required: [],
    description:
      'Process scopes. Resolves the scopeId/scopeName carried on every task. Optionally narrowed ' +
      'by project_id.',
    build: (p) => ({
      path: '/scopes',
      query: buildQueryString({
        projectId: p.project_id,
        ...systemPaging(p),
        $orderby: p.orderby,
      }),
    }),
  },
  solution_scenario_versions: processCollection(
    'processManagement',
    '/solutionScenarioVersions',
    'Solution scenario versions available for scoping',
  ),
  scope_solution_processes: processCollection(
    'processManagement',
    '/solutionProcesses',
    'Solution processes as seen by process management (scoping). For the authored process ' +
      "definitions use resource 'solution_processes' instead.",
  ),

  // --- Custom Processes / process authoring (REST, OData-style system options) ---
  business_processes: processCollection(
    'processAuthoring',
    '/businessProcesses',
    'Authored business processes',
  ),
  solution_processes: processCollection(
    'processAuthoring',
    '/solutionProcesses',
    'Authored solution processes, tenant-wide (not scoped to a project; archived ones included). ' +
      'Lifecycle is `state` (active/archived), not `status`: a process can be status "ACTIVE" ' +
      'and state "archived". For usable processes keep state "active"; group_by:"state" counts ' +
      'both. Solution processes carry no tags.',
  ),
  solution_process_flows: processCollection(
    'processAuthoring',
    '/solutionProcessFlows',
    'Process flows of authored solution processes',
  ),
  solution_activities: processCollection(
    'processAuthoring',
    '/solutionActivities',
    'Activities within authored solution processes',
  ),
  process_assets: processCollection(
    'processAuthoring',
    '/assets',
    'Assets (documents, links) attached to authored processes',
  ),

  // --- Test Plans (OData) ---
  test_plans: odata('testPlans', 'TestPlans', 'Test plans (BETA API — may change)'),
  test_case_assignments: odata(
    'testPlans',
    'TestCaseAssignments',
    'Test cases assigned to test plans (BETA API — may change)',
  ),
  test_plan_tag_assignments: odata(
    'testPlans',
    'TagAssignments',
    'Tags assigned to test plans (BETA API — may change)',
  ),

  // --- Tasks (REST) ---
  tasks: {
    kind: 'rest',
    service: 'tasks',
    required: ['project_id'],
    description:
      'Tasks of a project. Filter by task_type (e.g. CALMDEF for Defects), status, assignee_id, ' +
      'tags, and timebox_id/timebox_name (sprint). Use `fields` to keep the response small — a ' +
      'task carries 67 fields, so an unprojected list of a few hundred tasks is hundreds of KB.',
    build: (p) => ({
      path: '/tasks',
      query: buildQueryString({
        projectId: p.project_id,
        type: p.task_type,
        status: p.status,
        subStatus: p.sub_status,
        assigneeId: p.assignee_id,
        tags: p.tags,
        lastChangedDate: p.last_changed_date,
        lastChangedTimestamp: p.last_changed_timestamp,
        // The API takes a single comma-separated `id` value, not repeated keys.
        id: p.ids?.join(','),
        offset: p.offset,
        limit: p.limit,
      }),
    }),
  },
  task_solution_process_assignments: {
    kind: 'rest',
    service: 'tasks',
    required: ['project_id'],
    description: 'Solution processes assigned to the tasks of a project',
    build: (p) => ({
      path: '/tasks/solutionProcessAssignments',
      query: buildQueryString({
        projectId: p.project_id,
        taskId: p.task_id,
        solutionProcessId: p.solution_process_id,
        offset: p.offset,
        limit: p.limit,
      }),
    }),
  },
  task_subtasks: childCollection(
    'tasks',
    'task_id',
    (id) => `/tasks/${id}/subTasks`,
    'Sub-tasks of a task',
  ),
  task_comments: childCollection(
    'tasks',
    'task_id',
    (id) => `/tasks/${id}/comments`,
    'Comments on a task',
  ),
  task_references: childCollection(
    'tasks',
    'task_id',
    (id) => `/tasks/${id}/references`,
    'External references of a task',
  ),
  task_relations: childCollection(
    'tasks',
    'task_id',
    (id) => `/tasks/${id}/relations`,
    'Relations of a task to other tasks',
  ),
  task_feature_assignments: childCollection(
    'tasks',
    'task_id',
    (id) => `/tasks/${id}/featureAssignments`,
    'Features assigned to a task (e.g. to a defect)',
  ),
  task_document_assignments: childCollection(
    'tasks',
    'task_id',
    (id) => `/tasks/${id}/documentAssignments`,
    'Documents assigned to a task',
  ),
  task_hierarchy_assignments: childCollection(
    'tasks',
    'task_id',
    (id) => `/tasks/${id}/hierarchyNodeAssignments`,
    'Process hierarchy nodes assigned to a task',
  ),
  deliverables: {
    kind: 'rest',
    service: 'tasks',
    required: ['project_id'],
    description: 'Deliverables of a project',
    build: (p) => ({
      path: '/deliverables',
      query: buildQueryString({ projectId: p.project_id }),
    }),
  },
  workstreams: plainCollection('tasks', '/workstreams', 'Workstreams'),

  // --- Projects (REST) ---
  projects: plainCollection('projects', '/projects', 'Projects'),
  project_timeboxes: childCollection(
    'projects',
    'project_id',
    (id) => `/projects/${id}/timeboxes`,
    'Timeboxes (sprints/phases/milestones) of a project',
  ),
  project_teams: childCollection(
    'projects',
    'project_id',
    (id) => `/projects/${id}/teams`,
    'Teams of a project',
  ),
  team_roles: childCollection(
    'projects',
    'team_id',
    (id) => `/teams/${id}/roles`,
    'Roles and members of a team',
  ),
  programs: plainCollection('projects', '/programs', 'Programs'),
  program_teams: childCollection(
    'projects',
    'program_id',
    (id) => `/programs/${id}/teams`,
    'Teams of a program',
  ),
  program_team_roles: childCollection(
    'projects',
    'team_id',
    (id) => `/programTeams/${id}/roles`,
    'Roles and members of a program team',
  ),
  system_groups: {
    kind: 'rest',
    service: 'projects',
    required: [],
    description: 'System groups',
    build: (p) => ({
      path: '/systemGroups',
      query: buildQueryString({ limit: p.limit, offset: p.offset }),
    }),
  },
  deployment_plans: {
    kind: 'rest',
    service: 'projects',
    required: [],
    description: 'Deployment plans (filter by status: active/archived/all)',
    build: (p) => ({
      path: '/deploymentPlans',
      query: buildQueryString({ status: p.status, limit: p.limit, offset: p.offset }),
    }),
  },

  // --- Landscape (REST) ---
  landscape_objects: filteredCollection(
    'landscape',
    '/landscapeObjects',
    'Landscape objects (cloud services, technical/logical systems). REST filters via `filters` ' +
      '(objectType, role, serviceType, name, source, externalId, deploymentModel).',
  ),
  // Access control lists arrived in the Landscape spec of September 2025 (SCIM 2.0, RFC 7643/7644).
  // The response is a SCIM ListResponse (`Resources`, `totalResults`), which `locateRecords` in
  // `tools/shape.ts` unwraps. Paging is SCIM's 1-based `startIndex`/`count`, so the pager's
  // `offset`/`limit` window is translated here. Reading them needs the
  // `calm-api.landscape.access-control.admin` scope on the technical user.
  landscape_access_control_lists: {
    kind: 'rest',
    service: 'landscape',
    required: [],
    description:
      'Landscape access control lists (SCIM groups) with their members and grant levels. REST ' +
      'filters via `filters` (displayName, id).',
    build: (p) => ({
      path: '/scim/v2/Groups',
      query: buildQueryString({
        ...(p.filters ?? {}),
        startIndex: p.offset === undefined ? undefined : p.offset + 1,
        count: p.limit,
      }),
    }),
  },

  // --- BSM / Status Events (REST) ---
  bsm_events: filteredCollection(
    'bsm',
    '/events',
    'Business service status events (disruptions, degradations, maintenance). REST filters via ' +
      '`filters` (type, serviceName, eventType, serviceType, period, startTime, endTime).',
  ),
};

/** Public `resource` values accepted by `calm_list`. */
export const LIST_RESOURCE_NAMES = Object.keys(LIST_RESOURCES);
