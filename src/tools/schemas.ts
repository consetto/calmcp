// Zod input schemas (raw shapes) for the four MCP tools. The MCP SDK turns these into the JSON
// Schema advertised to clients and validates incoming arguments against them.

import { z } from 'zod';
import { ANALYTICS_PROVIDERS, TASK_TYPE_CODES } from './constants.js';
import { GET_RESOURCE_NAMES, LIST_RESOURCE_NAMES } from './registry.js';

/** Cast a string list to the non-empty tuple shape `z.enum` requires. */
function toEnumValues(values: string[]): [string, ...string[]] {
  return values as [string, ...string[]];
}

// Shared OData system query options, reused by `calm_list` (OData resources) and `calm_analytics`.
// `orderby` is deliberately NOT in here: the Analytics service ignores it silently (verified on a
// tenant), so advertising it there would promise sorting that never happens. It is added to
// `calmListShape` alone.
const odataOptions = {
  filter: z.string().optional().describe('OData $filter, e.g. "status eq \'CIPDFCTOPEN\'"'),
  select: z.string().optional().describe('OData $select — comma-separated field list'),
  top: z.number().int().positive().optional().describe('OData $top — maximum number of records'),
  skip: z.number().int().nonnegative().optional().describe('OData $skip — records to skip'),
};

// Counting options, shared by `calm_list` and `calm_analytics`. These change what comes back, so
// each description says so: a model that cannot tell records from a tally will misread the result.
const countingOptions = {
  count_only: z
    .boolean()
    .optional()
    .describe(
      'Return ONLY the total number of matching records, no records at all. Use this for every ' +
        '"how many ...?" question — the answer is a few hundred bytes instead of hundreds of KB. ' +
        'Works for every resource and provider',
    ),
  group_by: z
    .string()
    .optional()
    .describe(
      'Comma-separated field name(s) to break the count down by, e.g. "status" or ' +
        '"projectName,status". Returns {total, groups:[{value,count}]} instead of records. Also ' +
        'the quickest way to discover which values a field actually takes',
    ),
  group_limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Maximum groups returned by group_by (default 50); the rest fold into otherCount'),
  count: z
    .boolean()
    .optional()
    .describe(
      'Return the total as "@count" ALONGSIDE the records (OData resources and analytics only). ' +
        'For a total without the records, use count_only instead',
    ),
};

/** Input shape for `calm_list`. */
export const calmListShape = {
  resource: z
    .enum(toEnumValues(LIST_RESOURCE_NAMES))
    .describe('Which collection to list (see calm_resources for the catalog and required params)'),
  ...odataOptions,
  ...countingOptions,
  orderby: z
    .string()
    .optional()
    .describe(
      'OData $orderby, e.g. "priority desc". OData resources only; REST resources and ' +
        'calm_analytics ignore it',
    ),
  expand: z.string().optional().describe('OData $expand — comma-separated navigation properties'),
  project_id: z.string().optional().describe('Project id (required for tasks/deliverables/etc.)'),
  program_id: z.string().optional().describe('Program id (required for program_teams)'),
  task_id: z.string().optional().describe('Task id (required for task sub-resources)'),
  team_id: z.string().optional().describe('Team id (required for team_roles/program_team_roles)'),
  task_type: z
    .enum(toEnumValues(TASK_TYPE_CODES))
    .optional()
    .describe('Task type filter (resource:tasks). CALMDEF = Defect'),
  status: z
    .string()
    .optional()
    .describe('Status code filter (e.g. CIPDFCTOPEN; or deployment plan status)'),
  sub_status: z.string().optional().describe('Sub-status code filter (resource:tasks)'),
  assignee_id: z.string().optional().describe('Assignee id filter (resource:tasks)'),
  tags: z.array(z.string()).optional().describe('Tag filters (resource:tasks)'),
  last_changed_date: z
    .string()
    .optional()
    .describe(
      'Last-changed date filter (resource:tasks). Prefix with an operator: gt:, eq: or lt:, ' +
        'e.g. "gt:2026-08-01"',
    ),
  last_changed_timestamp: z
    .string()
    .optional()
    .describe(
      'Last-changed timestamp filter (resource:tasks). Prefix with gt:, eq: or lt: and use ISO ' +
        '8601, e.g. "gt:2026-08-01T00:00:00Z". Use this for incremental "what changed since" queries',
    ),
  ids: z
    .array(z.string())
    .optional()
    .describe('Fetch specific tasks by id (resource:tasks); sent as a comma-separated list'),
  solution_process_id: z
    .string()
    .optional()
    .describe('Solution process id filter (resource:task_solution_process_assignments)'),
  timebox_id: z
    .string()
    .optional()
    .describe(
      'Timebox (sprint/phase) id filter (resource:tasks). Applied by calmcp after fetching, ' +
        'paging through the project automatically',
    ),
  timebox_name: z
    .string()
    .optional()
    .describe(
      'Timebox name filter, e.g. "Sprint 5" (resource:tasks). Resolved against the project\'s ' +
        'timeboxes; errors listing the known names when it does not match',
    ),
  fields: z
    .string()
    .optional()
    .describe(
      'Comma-separated field projection applied by calmcp to the returned records (any resource). ' +
        'Use it to keep responses small, e.g. "displayId,title,status,assigneeName,timeboxId". ' +
        'Unlike $select this works for REST resources too. Unknown names are rejected',
    ),
  limit: z.number().int().positive().optional().describe('REST page size (REST resources)'),
  offset: z.number().int().nonnegative().optional().describe('REST page offset (REST resources)'),
  filters: z
    .record(z.string(), z.string())
    .optional()
    .describe('Free-form REST filters for landscape_objects / bsm_events'),
};

/** Input shape for `calm_get`. */
export const calmGetShape = {
  resource: z
    .enum(toEnumValues(GET_RESOURCE_NAMES))
    .describe('Which single entity to fetch (see calm_resources)'),
  id: z.string().describe('Entity id (uuid, REST id, or feature display id like "6-123")'),
  expand: z.string().optional().describe('OData $expand for OData entities'),
};

/** Input shape for `calm_analytics`. */
export const calmAnalyticsShape = {
  provider: z
    .enum(toEnumValues(ANALYTICS_PROVIDERS))
    .describe(
      'Analytics provider (e.g. Defects, Tasks, Tests). Every provider spans the whole tenant, ' +
        'so this is the only way to count without naming a project. It aggregates but does not ' +
        'sort: the service ignores $orderby, so never present its output as sorted',
    ),
  ...odataOptions,
  ...countingOptions,
  period: z
    .string()
    .optional()
    .describe(
      'Analytics time window, sent inside $filter. Format <L|C><n><H|D|W|M|Y>, e.g. "L1D" (last ' +
        'day) or "C1M" (current month). Counting defaults to "C1D" so each record is counted once',
    ),
  resolution: z
    .string()
    .optional()
    .describe(
      'Analytics bucket size, sent inside $filter: D, W, M or Y. A record appears once per ' +
        'bucket, so a wide window with a small bucket multiplies the count. Counting defaults to "D"',
    ),
};

/** Input shape for `calm_resources`. */
export const calmResourcesShape = {
  topic: z
    .string()
    .optional()
    .describe('Optional: a resource/provider name, or "recipes" for worked examples'),
};
