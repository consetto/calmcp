// Resource registry: the single source of truth mapping each `calm_list` / `calm_get` resource to
// a concrete Cloud ALM request. Keeping this declarative lets the four MCP tools stay generic and
// makes the supported resources (and their required parameters) discoverable via `calm_resources`.

import { buildQueryString } from '../calm/odata.js';
import type { ServiceName } from '../config.js';

/** Contextual parameters accepted by `calm_list` (in addition to the OData system options). */
export interface ListParams {
  // OData system query options (apply to `odata` resources).
  filter?: string;
  select?: string;
  expand?: string;
  orderby?: string;
  top?: number;
  skip?: number;
  /** `$count` — return the total alongside the records (OData resources only). */
  count?: boolean;
  // Counting options applied by calmcp itself; see `tools/counting.ts`.
  /** Return only the total, no records. Works for REST resources too, by paging. */
  count_only?: boolean;
  /** Comma-separated field name(s) to break the count down by. Implies counting. */
  group_by?: string;
  /** Maximum groups returned by `group_by`. */
  group_limit?: number;
  // Contextual parameters (apply to specific resources; validated via `required`).
  project_id?: string;
  program_id?: string;
  task_id?: string;
  team_id?: string;
  task_type?: string;
  /** `gt:`/`eq:`/`lt:` prefixed ISO date, e.g. `gt:2026-08-01` (resource:tasks). */
  last_changed_date?: string;
  /** `gt:`/`eq:`/`lt:` prefixed ISO 8601 timestamp (resource:tasks). */
  last_changed_timestamp?: string;
  /** Explicit display/UUID ids to fetch (resource:tasks). */
  ids?: string[];
  /** Solution process id filter (resource:task_solution_process_assignments). */
  solution_process_id?: string;
  status?: string;
  sub_status?: string;
  assignee_id?: string;
  tags?: string[];
  limit?: number;
  offset?: number;
  /** Timebox (sprint/phase) id — applied by calmcp after fetching; see `tools/shape.ts`. */
  timebox_id?: string;
  /** Timebox name (e.g. "Sprint 5") — resolved against the project's timeboxes. */
  timebox_name?: string;
  /** Comma-separated field projection applied by calmcp to the response records. */
  fields?: string;
  /** Free-form REST filters for the Landscape and BSM services (e.g. objectType, serviceName). */
  filters?: Record<string, string>;
}

/** A `calm_list` resource backed by an OData entity set (supports `$filter`/`$orderby`/etc.). */
export interface ODataListResource {
  kind: 'odata';
  service: ServiceName;
  entitySet: string;
  description: string;
}

/** A `calm_list` resource backed by a REST endpoint (only the params its build reads). */
export interface RestListResource {
  kind: 'rest';
  service: ServiceName;
  /** Contextual params that must be present (e.g. `['project_id']`). */
  required: string[];
  /** Build the service-relative path and query string from the supplied params. */
  build: (params: ListParams) => { path: string; query: string };
  description: string;
}

export type ListResource = ODataListResource | RestListResource;

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

/** Resources listable via `calm_list`, keyed by the public `resource` value. */
export const LIST_RESOURCES: Record<string, ListResource> = {
  // --- Features (OData) ---
  features: { kind: 'odata', service: 'features', entitySet: 'Features', description: 'Features' },
  feature_external_references: {
    kind: 'odata',
    service: 'features',
    entitySet: 'ExternalReferences',
    description: 'External references of features',
  },
  feature_url_references: {
    kind: 'odata',
    service: 'features',
    entitySet: 'URLReferences',
    description: 'URL references of features',
  },
  feature_task_assignments: {
    kind: 'odata',
    service: 'features',
    entitySet: 'TaskAssignments',
    description: 'Task assignments of features',
  },
  feature_priorities: {
    kind: 'odata',
    service: 'features',
    entitySet: 'FeaturePriorities',
    description: 'Feature priority code list',
  },
  feature_statuses: {
    kind: 'odata',
    service: 'features',
    entitySet: 'FeatureStatus',
    description: 'Feature status code list',
  },

  // --- Documents (OData) ---
  documents: {
    kind: 'odata',
    service: 'documents',
    entitySet: 'Documents',
    description: 'Documents',
  },
  document_types: {
    kind: 'odata',
    service: 'documents',
    entitySet: 'DocumentTypes',
    description: 'Document type code list',
  },
  document_statuses: {
    kind: 'odata',
    service: 'documents',
    entitySet: 'DocumentStatus',
    description: 'Document status code list',
  },
  document_sources: {
    kind: 'odata',
    service: 'documents',
    entitySet: 'DocumentSources',
    description: 'Document source code list',
  },
  document_priorities: {
    kind: 'odata',
    service: 'documents',
    entitySet: 'DocumentPriorities',
    description: 'Document priority code list',
  },
  document_approval_states: {
    kind: 'odata',
    service: 'documents',
    entitySet: 'DocumentApprovalStates',
    description: 'Document approval state code list',
  },

  // --- Process Hierarchy (OData) ---
  hierarchy_nodes: {
    kind: 'odata',
    service: 'processhierarchy',
    entitySet: 'HierarchyNodes',
    description: 'Process hierarchy nodes',
  },

  // --- Test Management (OData) ---
  manual_test_cases: {
    kind: 'odata',
    service: 'testmanagement',
    entitySet: 'ManualTestCases',
    description: 'Manual test cases',
  },
  automated_test_cases: {
    kind: 'odata',
    service: 'testmanagement',
    entitySet: 'AutomatedTestCases',
    description: 'Automated test cases',
  },
  test_activities: {
    kind: 'odata',
    service: 'testmanagement',
    entitySet: 'Activities',
    description: 'Test activities (steps within a test case)',
  },
  test_actions: {
    kind: 'odata',
    service: 'testmanagement',
    entitySet: 'Actions',
    description: 'Test actions (individual steps with expected results)',
  },

  // --- Cross-Library (OData) ---
  xlib_applications: {
    kind: 'odata',
    service: 'xlibApplications',
    entitySet: 'Applications',
    description: 'Cross-library applications',
  },
  xlib_configurations: {
    kind: 'odata',
    service: 'xlibConfigurations',
    entitySet: 'Configurations',
    description: 'Cross-library configurations',
  },
  xlib_developments: {
    kind: 'odata',
    service: 'xlibDevelopments',
    entitySet: 'Developments',
    description: 'Cross-library developments',
  },
  xlib_interfaces: {
    kind: 'odata',
    service: 'xlibInterfaces',
    entitySet: 'Interfaces',
    description: 'Cross-library interfaces',
  },
  // URL references were added to all four cross-library services in their 1.0.1/1.0.2 specs.
  xlib_application_url_references: {
    kind: 'odata',
    service: 'xlibApplications',
    entitySet: 'URLReferences',
    description: 'URL references of cross-library applications',
  },
  xlib_configuration_url_references: {
    kind: 'odata',
    service: 'xlibConfigurations',
    entitySet: 'URLReferences',
    description: 'URL references of cross-library configurations',
  },
  xlib_development_url_references: {
    kind: 'odata',
    service: 'xlibDevelopments',
    entitySet: 'URLReferences',
    description: 'URL references of cross-library developments',
  },
  xlib_interface_url_references: {
    kind: 'odata',
    service: 'xlibInterfaces',
    entitySet: 'URLReferences',
    description: 'URL references of cross-library interfaces',
  },
  // Configuration activities arrived with the Cross Library Configurations 1.0.1 spec.
  xlib_configuration_activities: {
    kind: 'odata',
    service: 'xlibConfigurations',
    entitySet: 'ConfigurationActivities',
    description: 'Cross-library configuration activities',
  },
  xlib_configuration_activity_types: {
    kind: 'odata',
    service: 'xlibConfigurations',
    entitySet: 'ConfigurationActivityTypes',
    description: 'Cross-library configuration activity type code list',
  },
  xlib_configuration_assignments: {
    kind: 'odata',
    service: 'xlibConfigurations',
    entitySet: 'ConfigurationAssignments',
    description: 'Assignments between configurations and configuration activities',
  },

  // Classification code lists added by the September 2025 specs (Applications 1.0.4, Configurations
  // 1.0.2, Developments 1.0.4, Interfaces 1.0.3). Each main entity now carries the matching
  // `<entity>PriorityCode`, `<entity>ReadinessCode`, ... property; these resolve the codes to labels.
  xlib_application_priorities: {
    kind: 'odata',
    service: 'xlibApplications',
    entitySet: 'ApplicationPriorities',
    description: 'Cross-library application priority code list (applicationPriorityCode)',
  },
  xlib_application_readiness: {
    kind: 'odata',
    service: 'xlibApplications',
    entitySet: 'ApplicationReadiness',
    description: 'Cross-library application readiness code list (applicationReadinessCode)',
  },
  xlib_application_usage_statuses: {
    kind: 'odata',
    service: 'xlibApplications',
    entitySet: 'ApplicationUsageStatus',
    description: 'Cross-library application usage status code list (applicationUsageStatusCode)',
  },
  xlib_application_clean_core_levels: {
    kind: 'odata',
    service: 'xlibApplications',
    entitySet: 'ApplicationCleanCoreLevel',
    description:
      'Cross-library application clean core level code list (applicationCleanCoreLevelCode)',
  },
  xlib_application_upgrade_impacts: {
    kind: 'odata',
    service: 'xlibApplications',
    entitySet: 'ApplicationUpgradeImpact',
    description:
      'Cross-library application upgrade impact code list (applicationUpgradeImpactCode)',
  },
  xlib_configuration_priorities: {
    kind: 'odata',
    service: 'xlibConfigurations',
    entitySet: 'ConfigurationPriorities',
    description: 'Cross-library configuration priority code list (configurationPriorityCode)',
  },
  xlib_configuration_readiness: {
    kind: 'odata',
    service: 'xlibConfigurations',
    entitySet: 'ConfigurationReadiness',
    description: 'Cross-library configuration readiness code list (configurationReadinessCode)',
  },
  xlib_development_priorities: {
    kind: 'odata',
    service: 'xlibDevelopments',
    entitySet: 'DevelopmentPriorities',
    description: 'Cross-library development priority code list (developmentPriorityCode)',
  },
  xlib_development_readiness: {
    kind: 'odata',
    service: 'xlibDevelopments',
    entitySet: 'DevelopmentReadiness',
    description: 'Cross-library development readiness code list (developmentReadinessCode)',
  },
  xlib_development_usage_statuses: {
    kind: 'odata',
    service: 'xlibDevelopments',
    entitySet: 'DevelopmentUsageStatus',
    description: 'Cross-library development usage status code list (developmentUsageStatusCode)',
  },
  xlib_development_clean_core_levels: {
    kind: 'odata',
    service: 'xlibDevelopments',
    entitySet: 'DevelopmentCleanCoreLevel',
    description:
      'Cross-library development clean core level code list (developmentCleanCoreLevelCode)',
  },
  xlib_development_upgrade_impacts: {
    kind: 'odata',
    service: 'xlibDevelopments',
    entitySet: 'DevelopmentUpgradeImpact',
    description:
      'Cross-library development upgrade impact code list (developmentUpgradeImpactCode)',
  },
  xlib_interface_priorities: {
    kind: 'odata',
    service: 'xlibInterfaces',
    entitySet: 'InterfacePriorities',
    description: 'Cross-library interface priority code list (interfacePriorityCode)',
  },
  xlib_interface_readiness: {
    kind: 'odata',
    service: 'xlibInterfaces',
    entitySet: 'InterfaceReadiness',
    description: 'Cross-library interface readiness code list (interfaceReadinessCode)',
  },
  xlib_interface_usage_statuses: {
    kind: 'odata',
    service: 'xlibInterfaces',
    entitySet: 'InterfaceUsageStatus',
    description: 'Cross-library interface usage status code list (interfaceUsageStatusCode)',
  },
  xlib_interface_clean_core_levels: {
    kind: 'odata',
    service: 'xlibInterfaces',
    entitySet: 'InterfaceCleanCoreLevel',
    description: 'Cross-library interface clean core level code list (interfaceCleanCoreLevelCode)',
  },
  xlib_interface_upgrade_impacts: {
    kind: 'odata',
    service: 'xlibInterfaces',
    entitySet: 'InterfaceUpgradeImpact',
    description: 'Cross-library interface upgrade impact code list (interfaceUpgradeImpactCode)',
  },

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
  solution_scenario_versions: {
    kind: 'rest',
    service: 'processManagement',
    required: [],
    description: 'Solution scenario versions available for scoping',
    build: (p) => ({
      path: '/solutionScenarioVersions',
      query: buildQueryString({ ...systemPaging(p), $orderby: p.orderby }),
    }),
  },
  scope_solution_processes: {
    kind: 'rest',
    service: 'processManagement',
    required: [],
    description:
      'Solution processes as seen by process management (scoping). For the authored process ' +
      "definitions use resource 'solution_processes' instead.",
    build: (p) => ({
      path: '/solutionProcesses',
      query: buildQueryString({ ...systemPaging(p), $orderby: p.orderby }),
    }),
  },

  // --- Custom Processes / process authoring (REST, OData-style system options) ---
  business_processes: {
    kind: 'rest',
    service: 'processAuthoring',
    required: [],
    description: 'Authored business processes',
    build: (p) => ({
      path: '/businessProcesses',
      query: buildQueryString({ ...systemPaging(p), $orderby: p.orderby }),
    }),
  },
  solution_processes: {
    kind: 'rest',
    service: 'processAuthoring',
    required: [],
    description: 'Authored solution processes',
    build: (p) => ({
      path: '/solutionProcesses',
      query: buildQueryString({ ...systemPaging(p), $orderby: p.orderby }),
    }),
  },
  solution_process_flows: {
    kind: 'rest',
    service: 'processAuthoring',
    required: [],
    description: 'Process flows of authored solution processes',
    build: (p) => ({
      path: '/solutionProcessFlows',
      query: buildQueryString({ ...systemPaging(p), $orderby: p.orderby }),
    }),
  },
  solution_activities: {
    kind: 'rest',
    service: 'processAuthoring',
    required: [],
    description: 'Activities within authored solution processes',
    build: (p) => ({
      path: '/solutionActivities',
      query: buildQueryString({ ...systemPaging(p), $orderby: p.orderby }),
    }),
  },
  process_assets: {
    kind: 'rest',
    service: 'processAuthoring',
    required: [],
    description: 'Assets (documents, links) attached to authored processes',
    build: (p) => ({
      path: '/assets',
      query: buildQueryString({ ...systemPaging(p), $orderby: p.orderby }),
    }),
  },

  // --- Test Plans (OData) ---
  test_plans: {
    kind: 'odata',
    service: 'testPlans',
    entitySet: 'TestPlans',
    description: 'Test plans (BETA API — may change)',
  },
  test_case_assignments: {
    kind: 'odata',
    service: 'testPlans',
    entitySet: 'TestCaseAssignments',
    description: 'Test cases assigned to test plans (BETA API — may change)',
  },
  test_plan_tag_assignments: {
    kind: 'odata',
    service: 'testPlans',
    entitySet: 'TagAssignments',
    description: 'Tags assigned to test plans (BETA API — may change)',
  },

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
  task_subtasks: {
    kind: 'rest',
    service: 'tasks',
    required: ['task_id'],
    description: 'Sub-tasks of a task',
    build: (p) => ({ path: `/tasks/${enc(p.task_id ?? '')}/subTasks`, query: '' }),
  },
  task_comments: {
    kind: 'rest',
    service: 'tasks',
    required: ['task_id'],
    description: 'Comments on a task',
    build: (p) => ({ path: `/tasks/${enc(p.task_id ?? '')}/comments`, query: '' }),
  },
  task_references: {
    kind: 'rest',
    service: 'tasks',
    required: ['task_id'],
    description: 'External references of a task',
    build: (p) => ({ path: `/tasks/${enc(p.task_id ?? '')}/references`, query: '' }),
  },
  task_relations: {
    kind: 'rest',
    service: 'tasks',
    required: ['task_id'],
    description: 'Relations of a task to other tasks',
    build: (p) => ({ path: `/tasks/${enc(p.task_id ?? '')}/relations`, query: '' }),
  },
  task_feature_assignments: {
    kind: 'rest',
    service: 'tasks',
    required: ['task_id'],
    description: 'Features assigned to a task (e.g. to a defect)',
    build: (p) => ({ path: `/tasks/${enc(p.task_id ?? '')}/featureAssignments`, query: '' }),
  },
  task_document_assignments: {
    kind: 'rest',
    service: 'tasks',
    required: ['task_id'],
    description: 'Documents assigned to a task',
    build: (p) => ({ path: `/tasks/${enc(p.task_id ?? '')}/documentAssignments`, query: '' }),
  },
  task_hierarchy_assignments: {
    kind: 'rest',
    service: 'tasks',
    required: ['task_id'],
    description: 'Process hierarchy nodes assigned to a task',
    build: (p) => ({ path: `/tasks/${enc(p.task_id ?? '')}/hierarchyNodeAssignments`, query: '' }),
  },
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
  workstreams: {
    kind: 'rest',
    service: 'tasks',
    required: [],
    description: 'Workstreams',
    build: () => ({ path: '/workstreams', query: '' }),
  },

  // --- Projects (REST) ---
  projects: {
    kind: 'rest',
    service: 'projects',
    required: [],
    description: 'Projects',
    build: () => ({ path: '/projects', query: '' }),
  },
  project_timeboxes: {
    kind: 'rest',
    service: 'projects',
    required: ['project_id'],
    description: 'Timeboxes (sprints/phases/milestones) of a project',
    build: (p) => ({ path: `/projects/${enc(p.project_id ?? '')}/timeboxes`, query: '' }),
  },
  project_teams: {
    kind: 'rest',
    service: 'projects',
    required: ['project_id'],
    description: 'Teams of a project',
    build: (p) => ({ path: `/projects/${enc(p.project_id ?? '')}/teams`, query: '' }),
  },
  team_roles: {
    kind: 'rest',
    service: 'projects',
    required: ['team_id'],
    description: 'Roles and members of a team',
    build: (p) => ({ path: `/teams/${enc(p.team_id ?? '')}/roles`, query: '' }),
  },
  programs: {
    kind: 'rest',
    service: 'projects',
    required: [],
    description: 'Programs',
    build: () => ({ path: '/programs', query: '' }),
  },
  program_teams: {
    kind: 'rest',
    service: 'projects',
    required: ['program_id'],
    description: 'Teams of a program',
    build: (p) => ({ path: `/programs/${enc(p.program_id ?? '')}/teams`, query: '' }),
  },
  program_team_roles: {
    kind: 'rest',
    service: 'projects',
    required: ['team_id'],
    description: 'Roles and members of a program team',
    build: (p) => ({ path: `/programTeams/${enc(p.team_id ?? '')}/roles`, query: '' }),
  },
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
  landscape_objects: {
    kind: 'rest',
    service: 'landscape',
    required: [],
    description:
      'Landscape objects (cloud services, technical/logical systems). REST filters via `filters` ' +
      '(objectType, role, serviceType, name, source, externalId, deploymentModel).',
    build: (p) => ({
      path: '/landscapeObjects',
      query: buildQueryString({ ...(p.filters ?? {}), limit: p.limit, offset: p.offset }),
    }),
  },
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
  bsm_events: {
    kind: 'rest',
    service: 'bsm',
    required: [],
    description:
      'Business service status events (disruptions, degradations, maintenance). REST filters via ' +
      '`filters` (type, serviceName, eventType, serviceType, period, startTime, endTime).',
    build: (p) => ({
      path: '/events',
      query: buildQueryString({ ...(p.filters ?? {}), limit: p.limit, offset: p.offset }),
    }),
  },
};

/** A `calm_get` resource backed by a single OData entity (by key, optionally by display id). */
export interface ODataGetResource {
  kind: 'odata';
  service: ServiceName;
  entitySet: string;
  /** When true, a non-UUID id is resolved via a `displayId` filter (Features). */
  allowDisplayId?: boolean;
  description: string;
}

/** A `calm_get` resource backed by a single REST entity. */
export interface RestGetResource {
  kind: 'rest';
  service: ServiceName;
  build: (id: string) => string;
  description: string;
}

export type GetResource = ODataGetResource | RestGetResource;

/** Resources retrievable via `calm_get`, keyed by the public `resource` value. */
export const GET_RESOURCES: Record<string, GetResource> = {
  feature: {
    kind: 'odata',
    service: 'features',
    entitySet: 'Features',
    allowDisplayId: true,
    description: 'A single feature by uuid or display id (e.g. "6-123")',
  },
  document: {
    kind: 'odata',
    service: 'documents',
    entitySet: 'Documents',
    description: 'A single document by uuid',
  },
  hierarchy_node: {
    kind: 'odata',
    service: 'processhierarchy',
    entitySet: 'HierarchyNodes',
    description: 'A single hierarchy node by uuid',
  },
  manual_test_case: {
    kind: 'odata',
    service: 'testmanagement',
    entitySet: 'ManualTestCases',
    description: 'A single manual test case by uuid',
  },
  automated_test_case: {
    kind: 'odata',
    service: 'testmanagement',
    entitySet: 'AutomatedTestCases',
    description: 'A single automated test case by uuid',
  },
  xlib_application: {
    kind: 'odata',
    service: 'xlibApplications',
    entitySet: 'Applications',
    description: 'A single cross-library application by uuid',
  },
  xlib_configuration: {
    kind: 'odata',
    service: 'xlibConfigurations',
    entitySet: 'Configurations',
    description: 'A single cross-library configuration by uuid',
  },
  xlib_development: {
    kind: 'odata',
    service: 'xlibDevelopments',
    entitySet: 'Developments',
    description: 'A single cross-library development by uuid',
  },
  xlib_interface: {
    kind: 'odata',
    service: 'xlibInterfaces',
    entitySet: 'Interfaces',
    description: 'A single cross-library interface by uuid',
  },
  task: {
    kind: 'rest',
    service: 'tasks',
    description: 'A single task (incl. defect) by id, with full description',
    build: (id) => `/tasks/${enc(id)}`,
  },
  deliverable: {
    kind: 'rest',
    service: 'tasks',
    description: 'A single deliverable by id',
    build: (id) => `/deliverables/${enc(id)}`,
  },
  project: {
    kind: 'rest',
    service: 'projects',
    description: 'A single project by id',
    build: (id) => `/projects/${enc(id)}`,
  },
  program: {
    kind: 'rest',
    service: 'projects',
    description: 'A single program by id (with its projects)',
    build: (id) => `/programs/${enc(id)}`,
  },
  timebox: {
    kind: 'rest',
    service: 'projects',
    description: 'A single timebox by id',
    build: (id) => `/timeboxes/${enc(id)}`,
  },
  team: {
    kind: 'rest',
    service: 'projects',
    description: 'A single team by id',
    build: (id) => `/teams/${enc(id)}`,
  },
  deployment_plan: {
    kind: 'rest',
    service: 'projects',
    description: 'A single deployment plan by id',
    build: (id) => `/deploymentPlans/${enc(id)}`,
  },
  system_group: {
    kind: 'rest',
    service: 'projects',
    description: 'A single system group by id',
    build: (id) => `/systemGroups/${enc(id)}`,
  },
  program_team: {
    kind: 'rest',
    service: 'projects',
    description: 'A single program team by id',
    build: (id) => `/programTeams/${enc(id)}`,
  },
  scope: {
    kind: 'rest',
    service: 'processManagement',
    description: 'A single process scope by id',
    build: (id) => `/scopes/${enc(id)}`,
  },
  solution_scenario_version: {
    kind: 'rest',
    service: 'processManagement',
    description: 'A single solution scenario version by id',
    build: (id) => `/solutionScenarioVersions/${enc(id)}`,
  },
  business_process: {
    kind: 'rest',
    service: 'processAuthoring',
    description: 'A single authored business process by id',
    build: (id) => `/businessProcesses/${enc(id)}`,
  },
  solution_process: {
    kind: 'rest',
    service: 'processAuthoring',
    description: 'A single authored solution process by id',
    build: (id) => `/solutionProcesses/${enc(id)}`,
  },
  solution_activity: {
    kind: 'rest',
    service: 'processAuthoring',
    description: 'A single solution activity by id',
    build: (id) => `/solutionActivities/${enc(id)}`,
  },
  process_asset: {
    kind: 'rest',
    service: 'processAuthoring',
    description: 'A single process asset by id',
    build: (id) => `/assets/${enc(id)}`,
  },
  test_plan: {
    kind: 'odata',
    service: 'testPlans',
    entitySet: 'TestPlans',
    description: 'A single test plan by uuid (BETA API — may change)',
  },
  test_case_assignment: {
    kind: 'odata',
    service: 'testPlans',
    entitySet: 'TestCaseAssignments',
    description: 'A single test-plan test case assignment by uuid (BETA API — may change)',
  },
};

/** Public `resource` values accepted by `calm_list`. */
export const LIST_RESOURCE_NAMES = Object.keys(LIST_RESOURCES);

/** Public `resource` values accepted by `calm_get`. */
export const GET_RESOURCE_NAMES = Object.keys(GET_RESOURCES);

/**
 * Every `calm_list` parameter that can end up on a Cloud ALM request, each with a placeholder to
 * probe a build with. Counting, shaping and timebox options are applied by calmcp itself and never
 * sent upstream, so they cannot be dropped on the way and are not listed.
 */
const PROBES: ListParams = {
  filter: 'x',
  select: 'x',
  expand: 'x',
  orderby: 'x',
  top: 1,
  skip: 1,
  project_id: 'x',
  program_id: 'x',
  task_id: 'x',
  team_id: 'x',
  task_type: 'x',
  last_changed_date: 'x',
  last_changed_timestamp: 'x',
  ids: ['x'],
  solution_process_id: 'x',
  status: 'x',
  sub_status: 'x',
  assignee_id: 'x',
  tags: ['x'],
  limit: 1,
  offset: 1,
  filters: { x: 'x' },
};

const PROBED = Object.keys(PROBES) as (keyof ListParams)[];

/** The OData system options `calm_list` forwards to an OData entity set. */
const ODATA_PARAMS: readonly (keyof ListParams)[] = [
  'filter',
  'select',
  'expand',
  'orderby',
  'top',
  'skip',
];

/** True when two builds produce the same request. */
function sameRequest(a: { path: string; query: string }, b: { path: string; query: string }) {
  return a.path === b.path && a.query === b.query;
}

/**
 * The parameters a REST resource reads.
 *
 * Found by probing the build rather than declared by hand, so the list cannot drift from what the
 * request actually carries when a build changes.
 *
 * @param def - The REST resource definition.
 * @returns The parameter names that change the request when set.
 */
export function readParams(def: RestListResource): (keyof ListParams)[] {
  const bare = def.build({});
  return PROBED.filter(
    (name) => !sameRequest(bare, def.build({ [name]: PROBES[name] } as ListParams)),
  );
}

/**
 * The parameters of the OData list options, for describing an OData resource.
 *
 * @returns The system option names `calm_list` forwards.
 */
export function odataParams(): (keyof ListParams)[] {
  return [...ODATA_PARAMS, 'count'];
}

/**
 * The supplied parameters a resource would never send upstream.
 *
 * Sending the request without them answers a different question than the one asked (an unfiltered
 * list for a filtered question), so callers reject these instead. For a REST resource each supplied
 * parameter is removed in turn; if the request is unchanged, the build never read it. That also
 * catches a parameter shadowed by another, such as `top` next to `limit` on the process services.
 * An OData resource forwards its system options and nothing else.
 *
 * @param def - The resource definition.
 * @param params - The caller's parameters.
 * @returns The supplied parameter names that do not reach the request.
 */
export function ignoredParams(def: ListResource, params: ListParams): (keyof ListParams)[] {
  const supplied = PROBED.filter((name) => params[name] !== undefined);
  if (def.kind === 'odata') return supplied.filter((name) => !ODATA_PARAMS.includes(name));

  const full = def.build(params);
  return supplied.filter((name) => sameRequest(full, def.build({ ...params, [name]: undefined })));
}
