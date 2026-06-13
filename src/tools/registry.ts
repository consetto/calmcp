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
  // Contextual parameters (apply to specific resources; validated via `required`).
  project_id?: string;
  task_id?: string;
  team_id?: string;
  task_type?: string;
  status?: string;
  sub_status?: string;
  assignee_id?: string;
  tags?: string[];
  limit?: number;
  offset?: number;
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

/** A `calm_list` resource backed by a REST endpoint (contextual params, no `$orderby`). */
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

  // --- Tasks (REST) ---
  tasks: {
    kind: 'rest',
    service: 'tasks',
    required: ['project_id'],
    description: 'Tasks of a project. Filter by task_type (e.g. CALMDEF for Defects), status, etc.',
    build: (p) => ({
      path: '/tasks',
      query: buildQueryString({
        projectId: p.project_id,
        type: p.task_type,
        status: p.status,
        subStatus: p.sub_status,
        assigneeId: p.assignee_id,
        tags: p.tags,
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
};

/** Public `resource` values accepted by `calm_list`. */
export const LIST_RESOURCE_NAMES = Object.keys(LIST_RESOURCES);

/** Public `resource` values accepted by `calm_get`. */
export const GET_RESOURCE_NAMES = Object.keys(GET_RESOURCES);
