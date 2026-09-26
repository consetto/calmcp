// The analytics catalogue: which providers exist and, for the common ones, which fields they filter
// on, return and measure, plus the traps worth stating before a caller hits them.

/**
 * Analytics providers — the entity sets exposed by the Analytics OData service. Each is queried
 * via `calm_analytics provider:<name>`. Each supports `$filter` and aggregates server-side, making
 * this the right tool for tenant-wide totals and breakdowns. It does not sort: the service accepts
 * `$orderby` and ignores it.
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
      "Rows are not records. The service returns one row per combination of a record's " +
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
