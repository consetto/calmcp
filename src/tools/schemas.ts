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
const odataOptions = {
  filter: z.string().optional().describe('OData $filter, e.g. "status eq \'CIPDFCTOPEN\'"'),
  select: z.string().optional().describe('OData $select — comma-separated field list'),
  orderby: z
    .string()
    .optional()
    .describe('OData $orderby, e.g. "priority desc" (OData resources / analytics only)'),
  top: z.number().int().positive().optional().describe('OData $top — maximum number of records'),
  skip: z.number().int().nonnegative().optional().describe('OData $skip — records to skip'),
};

/** Input shape for `calm_list`. */
export const calmListShape = {
  resource: z
    .enum(toEnumValues(LIST_RESOURCE_NAMES))
    .describe('Which collection to list (see calm_resources for the catalog and required params)'),
  ...odataOptions,
  expand: z.string().optional().describe('OData $expand — comma-separated navigation properties'),
  project_id: z.string().optional().describe('Project id (required for tasks/deliverables/etc.)'),
  task_id: z.string().optional().describe('Task id (required for task sub-resources)'),
  team_id: z.string().optional().describe('Team id (required for team_roles)'),
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
    .describe('Analytics provider (e.g. Defects, Tasks, Tests). Supports $orderby.'),
  ...odataOptions,
};

/** Input shape for `calm_resources`. */
export const calmResourcesShape = {
  topic: z
    .string()
    .optional()
    .describe('Optional: a resource/provider name, or "recipes" for worked examples'),
};
