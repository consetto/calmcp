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
  { code: 'CIPUSOPEN', label: 'Open (User Story)' },
  { code: 'CIPUSINP', label: 'In Progress (User Story)' },
  { code: 'CIPUSBLK', label: 'Blocked (User Story)' },
  { code: 'CIPUSCLOSE', label: 'Done (User Story)' },
  { code: 'CIPUSNO', label: 'Not Relevant (User Story)' },
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

/** A worked, multi-step example showing an AI client how to answer a common question. */
export interface Recipe {
  question: string;
  steps: string[];
}

/** Ready-made recipes surfaced by `calm_resources` so clients know how to chain queries. */
export const RECIPES: Recipe[] = [
  {
    question: 'Show me all open defects ordered by priority',
    steps: [
      "calm_analytics({ provider: 'Defects', filter: \"status eq 'CIPDFCTOPEN'\", orderby: 'priority desc' })",
      "Alternative (unsorted): calm_list({ resource: 'tasks', project_id: '<uuid>', task_type: 'CALMDEF', status: 'CIPDFCTOPEN' })",
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
