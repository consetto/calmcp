// Task code lists (types, statuses, sub-statuses, priorities). Stable parts of the Cloud ALM data
// model, verified against the OpenAPI specs, and surfaced via `calm_resources` so clients can build
// correct task queries without guessing.

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
