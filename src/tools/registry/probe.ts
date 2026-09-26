// Parameter probing: which `calm_list` parameters a resource actually sends upstream. Found by
// building the request with and without each parameter rather than declared by hand, so it cannot
// drift from the builds in `list.ts`.

import type { ListParams, ListResource, RestListResource } from './types.js';

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
