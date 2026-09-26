// Types shared by the resource registry: the parameters `calm_list` accepts and the two shapes a
// list or get resource can take (an OData entity set, or a REST endpoint with its own build).

import type { ServiceName } from '../../config.js';

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
