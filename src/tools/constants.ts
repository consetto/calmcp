// Static reference data for the SAP Cloud ALM read tools: code lists (task types, statuses,
// priorities), the analytics provider list, and worked recipes. These values are stable parts of
// the Cloud ALM data model (verified against the OpenAPI specs) and are surfaced to AI clients via
// the `calm_resources` tool so they can build correct queries without guessing.

/** A code-list entry: a stable code plus its human-readable meaning. */
export interface CodeEntry {
  code: string;
  label: string;
}

/**
 * Task `type` codes. In Cloud ALM, Defects, User Stories, Requirements, etc. are all tasks
 * distinguished by this code (filter with `calm_list resource:tasks task_type:<code>`).
 */
export const TASK_TYPES: CodeEntry[] = [
  { code: 'CALMTMPL', label: 'Roadmap Task' },
  { code: 'CALMTASK', label: 'Project Task' },
  { code: 'CALMUS', label: 'User Story' },
  { code: 'CALMST', label: 'Sub-task' },
  { code: 'CALMREQU', label: 'Requirement' },
  { code: 'CALMDEF', label: 'Defect' },
  { code: 'CALMQGATE', label: 'Quality Gate' },
  { code: 'CALMCHKLI', label: 'Checklist Item' },
  { code: 'CALMRISK', label: 'Risk' },
];

/** Convenience list of just the task type codes (used to constrain the `task_type` parameter). */
export const TASK_TYPE_CODES = TASK_TYPES.map((t) => t.code);

/**
 * Task `status` codes, scoped by task type. The status applicable to a task depends on its type
 * (e.g. `CIPDFCTOPEN` for Defects). Filter with `calm_list resource:tasks status:<code>`.
 */
export const TASK_STATUSES: CodeEntry[] = [
  { code: 'CIPTKOPEN', label: 'Open (Task/Roadmap/Sub-task)' },
  { code: 'CIPTKINP', label: 'In Progress (Task/Roadmap/Sub-task)' },
  { code: 'CIPTKBLK', label: 'Blocked (Task/Roadmap/Sub-task)' },
  { code: 'CIPTKCLOSE', label: 'Done (Task/Roadmap/Sub-task)' },
  { code: 'CIPTKNO', label: 'Not Relevant (Task/Roadmap/Sub-task)' },
  { code: 'CIPTKREV', label: 'In Review (Task/Roadmap/Sub-task)' },
  { code: 'CIPUSOPEN', label: 'Open (User Story)' },
  { code: 'CIPUSINP', label: 'In Progress (User Story)' },
  { code: 'CIPUSBLK', label: 'Blocked (User Story)' },
  { code: 'CIPUSCLOSE', label: 'Done (User Story)' },
  { code: 'CIPUSNO', label: 'Not Relevant (User Story)' },
  { code: 'CIPUSREV', label: 'In Review (User Story)' },
  { code: 'CIPREQUOPEN', label: 'Open (Requirement)' },
  { code: 'CIPREQUINP', label: 'In Progress (Requirement)' },
  { code: 'CIPREQUBLK', label: 'Blocked (Requirement)' },
  { code: 'CIPREQUCLOSE', label: 'Done (Requirement)' },
  { code: 'CIPREQUNO', label: 'Not Relevant (Requirement)' },
  { code: 'CIPDFCTOPEN', label: 'Open (Defect)' },
  { code: 'CIPDFCTINP', label: 'In Progress (Defect)' },
  { code: 'CIPDFCTBLK', label: 'Blocked (Defect)' },
  { code: 'CIPDFCTDONE', label: 'Done (Defect)' },
  { code: 'CIPQGOPEN', label: 'Open (Quality Gate)' },
  { code: 'CIPQGBLK', label: 'Blocked (Quality Gate)' },
  { code: 'CIPQGNR', label: 'Not Relevant (Quality Gate)' },
  { code: 'CIPQGDONE', label: 'Done (Quality Gate)' },
  { code: 'CIPRIOPEN', label: 'Open (Risk)' },
  { code: 'CIPRIINP', label: 'In Progress (Risk)' },
  { code: 'CIPRIDONE', label: 'Done (Risk)' },
];

/**
 * Task `sub_status` codes. Sub-statuses refine a status and are type-specific (the `DFC_*` values
 * apply to Defects, `QG_*` to Quality Gates, the rest to implementation tasks). Filter with
 * `calm_list resource:tasks sub_status:<code>`.
 */
export const TASK_SUB_STATUSES: CodeEntry[] = [
  { code: 'CREATED', label: 'Created' },
  { code: 'TO_BE_APPROVED', label: 'To Be Approved' },
  { code: 'IN_PLANNING', label: 'In Planning' },
  { code: 'IN_REALIZATION', label: 'In Realization' },
  { code: 'APPROVED_FOR_DEPLOYMENT', label: 'Approved for Deployment' },
  { code: 'SUCCESSFULLY_TESTED', label: 'Successfully Tested' },
  { code: 'CONFIRMED', label: 'Confirmed' },
  { code: 'BLOCKED', label: 'Blocked' },
  { code: 'NOT_PLANNED', label: 'Not Planned' },
  { code: 'DFC_NEW', label: 'New (Defect)' },
  { code: 'DFC_INP', label: 'In Progress (Defect)' },
  { code: 'DFC_RETEST_REQ', label: 'Retest Required (Defect)' },
  { code: 'DFC_POSTPONE', label: 'Postponed (Defect)' },
  { code: 'DFC_CLOSED', label: 'Closed (Defect)' },
  { code: 'QG_UNCHECKED', label: 'Unchecked (Quality Gate)' },
  { code: 'QG_ACCEPTED', label: 'Accepted (Quality Gate)' },
  { code: 'QG_COND_ACCEPTED', label: 'Conditionally Accepted (Quality Gate)' },
  { code: 'QG_UNACCEPTED', label: 'Not Accepted (Quality Gate)' },
  { code: 'QG_NR', label: 'Not Relevant (Quality Gate)' },
];

/** Task `priority` codes (integers). */
export const TASK_PRIORITIES: CodeEntry[] = [
  { code: '10', label: 'Very High' },
  { code: '20', label: 'High' },
  { code: '30', label: 'Medium' },
  { code: '40', label: 'Low' },
];

/**
 * Analytics providers — the entity sets exposed by the Analytics OData service. Each is queried
 * via `calm_analytics provider:<name>` and supports `$filter`/`$orderby`, making this the right
 * tool for sorted/aggregated questions (e.g. "open defects ordered by priority").
 */
export const ANALYTICS_PROVIDERS: string[] = [
  'Requirements',
  'Projects',
  'Tasks',
  'Defects',
  'Tests',
  'Features',
  'ConfigurationItems',
  'Metrics',
  'Requests',
  'Exceptions',
  'StatusEvents',
  'QualityGates',
  'Jobs',
  'ServiceLevels',
  'ScenarioExecutions',
  'MonitoringEvents',
  'Messages',
];

/**
 * The dimensions and measures of one analytics provider.
 *
 * Transcribed from the endpoint descriptions in `YAML/CALM_ANALYTICS_ODATA.yaml`. The split
 * matters: the spec marks filterable dimensions with `(*)`, and the service **silently ignores**
 * a `$filter` on anything else rather than rejecting it, so filtering on a non-filterable field
 * returns unfiltered rows that look like a valid answer.
 */
export interface ProviderFields {
  /**
   * The field identifying one entity. An analytics row is not an entity: the service emits one row
   * per combination of a record's dimension values, so a single task with several tags and
   * workstreams produces many rows (192, in one observed case). Counting rows therefore massively
   * overstates the entity count, and only a distinct count over this field is meaningful.
   */
  identity?: string;
  /**
   * The measure holding the entity count. Selecting it together with dimensions makes the service
   * aggregate server-side and return one pre-counted row per group.
   */
  countMeasure?: string;
  /** Dimensions usable in `$filter`. */
  filterable: string[];
  /** Dimensions returned but not usable in `$filter`. */
  dimensions: string[];
  /** Measures, pre-aggregated per bucket by the service. */
  measures: string[];
  /** Provider-specific traps worth stating before a caller hits them. */
  notes?: string[];
}

/**
 * Field catalogues for the analytics providers behind the common questions.
 *
 * Deliberately partial. A provider absent from this map has not been transcribed from the spec,
 * and `calm_resources` says so rather than inventing field names; `group_by` is the reliable way
 * to discover what an untranscribed provider actually returns.
 */
export const ANALYTICS_PROVIDER_FIELDS: Record<string, ProviderFields> = {
  Tasks: {
    identity: 'taskGUID',
    countMeasure: 'counter',
    filterable: [
      'project',
      'scope',
      'requirementId',
      'requirementGUID',
      'parentTask',
      'parentTaskId',
      'status',
      'phase',
      'role',
      'type',
      // Not marked filterable by the spec, but honoured by the service; see `notes`.
      'typeID',
      'priority',
      'processor',
      'overDue',
      'team',
      'period',
      'resolution',
      'timeZone',
      'firstWeekDay',
      'timestampFormat',
    ],
    dimensions: [
      'projectName',
      'scopeName',
      'requirement',
      'name',
      'statusText',
      'taskGUID',
      'taskId',
      'dueDate',
      'timeboxName',
      'release',
      'process',
      'workstream',
      'tag',
      'timestamp',
      'date',
      'week',
      'dayOfWeek',
    ],
    measures: ['counter', 'storyPoint', 'storyPointAvg', 'effort', 'effortAvg'],
    notes: [
      'Filter by `typeID` (CALMUS, CALMDEF, CALMREQU), NOT by `type`. The OpenAPI spec marks ' +
        '`type` filterable and `typeID` not, but on a real tenant it is `typeID` that is ' +
        'honoured. A filter the service does not honour is dropped silently and every row comes ' +
        'back, so filtering on the wrong one yields the total task count looking like an answer.',
      "Confirm before trusting any filtered count: group_by:'typeID' uses no filter and so " +
        'cannot be dropped. It returns the real per-type counts and the values in use.',
      'Rows are not records. The service returns one row per combination of a record\'s ' +
        'dimension values (one observed task produced 192), so counting rows, or reading ' +
        '$count without a $select, overstates the number badly. calmcp counts distinct ' +
        '`taskGUID` and reads the `counter` measure instead.',
      '`status` is honoured. `timeboxName` is not: group_by it instead, or use calm_list with ' +
        'timebox_name for a live per-sprint read.',
    ],
  },
  Defects: {
    identity: 'GUID',
    countMeasure: 'counter',
    filterable: [
      'project',
      'scope',
      'name',
      'defectStatus',
      'team',
      'role',
      'priority',
      'testCaseId',
      'testPlan',
      'period',
      'resolution',
      'timeZone',
      'firstWeekDay',
    ],
    dimensions: [
      'projectName',
      'scopeName',
      'GUID',
      'defectId',
      'statusText',
      'dueDate',
      'creationDate',
      'updateDate',
      'completionDate',
      'workstream',
      'testCaseName',
      'assignee',
      'timestamp',
      'date',
      'week',
    ],
    measures: ['counter'],
    notes: [
      'The status dimension is `defectStatus` here, not `status` (values CIPDFCTOPEN, ' +
        'CIPDFCTINP, CIPDFCTBLK, CIPDFCTDONE).',
    ],
  },
  Features: {
    identity: 'featureId',
    countMeasure: 'counter',
    filterable: [
      'projectId',
      'scopeId',
      'requirementId',
      'featureId',
      'status',
      'priority',
      'responsible',
      'release',
      'period',
      'resolution',
      'timeZone',
      'firstWeekDay',
    ],
    dimensions: [
      'projectName',
      'scopeName',
      'requirementName',
      'featureName',
      'statusText',
      'workstream',
      'timestamp',
      'date',
      'week',
    ],
    measures: ['counter'],
  },
  Requirements: {
    identity: 'GUID',
    countMeasure: 'counter',
    filterable: [
      'project',
      'scope',
      'status',
      'team',
      'assignee',
      'priority',
      'role',
      'approval',
      'period',
      'resolution',
      'timeZone',
      'firstWeekDay',
    ],
    dimensions: [
      'projectName',
      'scopeName',
      'name',
      'GUID',
      'requirementId',
      'statusText',
      'workstream',
      'process',
      'release',
      'tag',
      'plannedCompDate',
      'timestamp',
      'date',
      'week',
    ],
    measures: ['counter'],
    notes: [
      'Status values here are the requirement lifecycle codes (CREATED, IN_REALIZATION, ' +
        'APPROVED_FOR_DEPLOYMENT, CONFIRMED, TO_BE_APPROVED, BLOCKED, NOT_PLANNED).',
    ],
  },
};

/** A worked, multi-step example showing an AI client how to answer a common question. */
export interface Recipe {
  question: string;
  steps: string[];
}

/** Ready-made recipes surfaced by `calm_resources` so clients know how to chain queries. */
export const RECIPES: Recipe[] = [
  {
    question: 'How many user stories are there in the tenant?',
    steps: [
      "Start here: calm_analytics({ provider: 'Tasks', group_by: 'typeID' })",
      'It uses no filter, so nothing can be silently dropped, and one call returns every task ' +
        'type with its count. Read the CALMUS row: that is the answer.',
      'The counts are entity counts. Do not compute them yourself from analytics rows: the ' +
        'service emits one row per combination of a record\'s dimension values, so a single task ' +
        'with several tags and workstreams can produce a hundred rows or more.',
      'Analytics providers span the whole tenant, so no project_id is needed. calm_list ' +
        "resource:'tasks' cannot answer this at all, because it requires one.",
      "For a filtered count instead: calm_analytics({ provider: 'Tasks', filter: \"typeID eq " +
        "'CALMUS'\", count_only: true }). Filter by typeID, never by type: the service drops a " +
        'filter it does not honour without erroring and then counts ALL tasks, which looks like a ' +
        'plausible answer. calmcp flags that when it can detect it, but the group_by above avoids ' +
        'the trap entirely.',
      'Never list the records and count them: a few hundred tasks are hundreds of KB and your ' +
        'client will truncate the response.',
      'The number is a daily snapshot. For a live count of one project use calm_list({ resource:' +
        " 'tasks', project_id: '<uuid>', task_type: 'CALMUS', count_only: true }), and expect the " +
        'two to differ.',
    ],
  },
  {
    question: 'How many open defects are there per project?',
    steps: [
      "calm_analytics({ provider: 'Defects', filter: \"defectStatus eq 'CIPDFCTOPEN'\", " +
        "group_by: 'projectName' })",
      'Returns { total, groups: [{ value, count }, ...] }: a few hundred bytes rather than a few ' +
        'hundred KB.',
      'Sanity-check any filtered analytics number against the same call without the filter. If ' +
        'the two totals match, the service ignored the filter rather than applying it.',
      "Swap group_by for 'priority', 'team', 'statusText' or 'assignee' to break the same set " +
        'down another way, or pass several: group_by: "projectName,priority".',
      'On the Defects provider the status dimension is `defectStatus`, not `status`. Call ' +
        "calm_resources({ topic: 'Defects' }) for the full field list.",
    ],
  },
  {
    question: 'How many user stories are open in project X, by sprint?',
    steps: [
      "calm_list({ resource: 'tasks', project_id: '<uuid>', task_type: 'CALMUS', status: " +
        "'CIPUSOPEN', group_by: 'timeboxId' })",
      'The Tasks REST API has no count of any kind, so calmcp pages through and returns only the ' +
        'tally. This is a live read, unlike the analytics snapshot.',
      'Drop group_by and pass count_only: true for the plain total.',
      "Resolve timebox ids to names with calm_list({ resource: 'project_timeboxes', project_id: " +
        "'<uuid>' }), which is a short list.",
    ],
  },
  {
    question: 'Show me all open defects ordered by priority',
    steps: [
      "calm_analytics({ provider: 'Defects', filter: \"status eq 'CIPDFCTOPEN'\", orderby: 'priority desc' })",
      "Alternative (unsorted): calm_list({ resource: 'tasks', project_id: '<uuid>', task_type: 'CALMDEF', status: 'CIPDFCTOPEN' })",
    ],
  },
  {
    question: 'Which user stories are open in Sprint 5?',
    steps: [
      "calm_list({ resource: 'tasks', project_id: '<uuid>', task_type: 'CALMUS', status: 'CIPUSOPEN', timebox_name: 'Sprint 5', fields: 'displayId,title,status,assigneeName,dueDate' })",
      'Always pass `fields` for tasks: a task has 67 attributes, so an unprojected list is hundreds of KB and overflows smaller agent hosts.',
      'Use timebox_id instead of timebox_name when you already resolved the sprint via project_timeboxes.',
    ],
  },
  {
    question: 'Show me the assigned Features for defect Y',
    steps: [
      "1) calm_list({ resource: 'task_feature_assignments', task_id: 'Y' }) -> collect each featureId",
      "2) calm_get({ resource: 'feature', id: '<featureId>' }) for each feature you need details on",
    ],
  },
];
