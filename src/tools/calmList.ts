// `calm_list` — list/query any Cloud ALM collection. The `resource` parameter selects the entity
// set or REST endpoint; OData resources accept $filter/$select/$expand/$orderby/$top/$skip, while
// REST resources accept the relevant contextual parameters (validated against the registry).
//
// Two response-shaping options are applied by calmcp itself rather than by Cloud ALM, because the
// upstream APIs do not offer them (see `tools/shape.ts` for why this matters):
//   - `timebox_id` / `timebox_name` — the Tasks REST endpoint has no timebox filter, so calmcp
//     pages through the project's tasks and selects the matching ones.
//   - `fields` — the REST endpoints ignore `$select`, so calmcp projects the records.
//
// `count_only` and `group_by` answer "how many" without returning the records at all; see
// `tools/counting.ts`. They count the full matching set, not one page, which is the whole point.

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { CalmClients } from '../calm/index.js';
import { countOData, countRest } from './counting.js';
import { fetchAllRest, MAX_PAGES_RETURN, PAGE_SIZE } from './paging.js';
import {
  ignoredParams,
  LIST_RESOURCES,
  type ListParams,
  type ListResource,
  type RestListResource,
  readParams,
} from './registry.js';
import { errorResult, errorResultFrom, jsonResult } from './result.js';
import {
  locateRecords,
  pickTimebox,
  projectFields,
  type Record_,
  resolveTimeboxName,
  ShapeError,
} from './shape.js';

/** Arguments accepted by the `calm_list` tool (validated by `calmListShape`). */
export type CalmListArgs = ListParams & { resource: string };

/**
 * Fetch every task matching the caller's filters, paging until the last page is short.
 *
 * Needed because the timebox filter is applied locally: filtering a single page would silently
 * miss matches on later pages.
 *
 * @param clients - The Cloud ALM client container.
 * @param def - The `tasks` resource definition.
 * @param args - Validated tool arguments.
 * @returns Every matching task record.
 * @throws {ShapeError} When the safety cap is reached, rather than truncating silently.
 */
async function fetchAllTasks(
  clients: CalmClients,
  def: RestListResource,
  args: CalmListArgs,
): Promise<Record_[]> {
  const { records, complete } = await fetchAllRest(clients, def, args, {
    maxPages: MAX_PAGES_RETURN,
  });
  if (complete) return records;

  throw new ShapeError(
    `More than ${MAX_PAGES_RETURN * PAGE_SIZE} tasks match before the timebox filter. ` +
      'Narrow the query first (task_type, status, assignee_id).',
  );
}

/**
 * Apply the caller's `offset`/`limit` to a locally filtered list.
 *
 * @param records - The filtered records.
 * @param offset - Records to skip, if any.
 * @param limit - Maximum records to return, if any.
 * @returns The requested window.
 */
function applyWindow(records: Record_[], offset?: number, limit?: number): Record_[] {
  const start = offset ?? 0;
  return limit === undefined ? records.slice(start) : records.slice(start, start + limit);
}

/**
 * List the tasks of a project that belong to one timebox.
 *
 * @param clients - The Cloud ALM client container.
 * @param def - The `tasks` resource definition.
 * @param args - Validated tool arguments (`timebox_id` or `timebox_name` set).
 * @returns The matching tasks.
 * @throws {ShapeError} When the timebox name cannot be resolved or the safety cap is reached.
 */
async function listTasksInTimebox(
  clients: CalmClients,
  def: RestListResource,
  args: CalmListArgs,
): Promise<Record_[]> {
  let timeboxId = args.timebox_id;

  if (timeboxId === undefined) {
    // Resolve the name against the project's timeboxes, reusing the registry's path builder.
    const timeboxDef = LIST_RESOURCES.project_timeboxes as RestListResource;
    const { path, query } = timeboxDef.build(args);
    const timeboxes = await clients.getRest(timeboxDef.service, path, query);
    timeboxId = resolveTimeboxName(timeboxes, args.timebox_name as string);
  }

  const matching = pickTimebox(await fetchAllTasks(clients, def, args), timeboxId);
  return applyWindow(matching, args.offset, args.limit);
}

/**
 * Describe what a query covered, for the `subject` of a count or an empty result.
 *
 * @param args - Validated tool arguments.
 * @returns The resource plus whichever scoping and filtering parameters were supplied.
 */
function querySubject(args: CalmListArgs): Record<string, string> {
  const subject: Record<string, string> = { resource: args.resource };
  const scoping = [
    'project_id',
    'program_id',
    'task_id',
    'team_id',
    'task_type',
    'status',
    'sub_status',
    'assignee_id',
    'solution_process_id',
    'timebox_id',
    'timebox_name',
    'filter',
  ] as const;
  for (const name of scoping) {
    const value = args[name];
    if (typeof value === 'string') subject[name] = value;
  }
  if (args.tags && args.tags.length > 0) subject.tags = args.tags.join(',');
  return subject;
}

/**
 * Replace an empty collection by a note naming what was queried. A bare `[]` does not tell a
 * caller whether nothing exists at all or only nothing under this parent and these filters.
 */
function withEmptyNote(data: unknown, args: CalmListArgs): unknown {
  const located = locateRecords(data);
  if (!located || located.records.length > 0) return data;
  return {
    records: [],
    subject: querySubject(args),
    note:
      'No records matched. This covers only the resource, parent ids and filters in subject; ' +
      'it says nothing about other resources or relation types.',
  };
}

/**
 * Explain which supplied parameters a resource does not read, and what it reads instead.
 *
 * @param resource - The public resource name.
 * @param def - The resource definition.
 * @param ignored - The supplied parameters that would not reach the request.
 * @returns The error message.
 */
function unsupportedParamsMessage(resource: string, def: ListResource, ignored: string[]): string {
  const names = ignored.join(', ');
  if (def.kind === 'odata') {
    return (
      `Resource '${resource}' is an OData entity set and does not read: ${names}. ` +
      'Express conditions in filter and page with top/skip.'
    );
  }
  const reads = readParams(def);
  return (
    `Resource '${resource}' is a REST endpoint and does not read: ${names}. The request would ` +
    'go out without them and return records they were meant to exclude, so calmcp rejects the ' +
    `call instead. This resource reads: ${reads.length > 0 ? reads.join(', ') : 'nothing'}. ` +
    'Shape the response with fields, or count with count_only/group_by.'
  );
}

/**
 * Handle a `calm_list` call.
 *
 * @param clients - The Cloud ALM client container.
 * @param args - Validated tool arguments.
 * @returns The collection as a JSON tool result, or an error result.
 */
export async function handleCalmList(
  clients: CalmClients,
  args: CalmListArgs,
): Promise<CallToolResult> {
  const def = LIST_RESOURCES[args.resource];
  if (!def) {
    return errorResult(
      `Unknown resource '${args.resource}'. Use calm_resources to list valid ones.`,
    );
  }
  const problem = validateListArgs(def, args);
  if (problem) return errorResult(problem);

  try {
    if (args.count_only === true || args.group_by !== undefined) {
      return jsonResult(await countList(clients, def, args));
    }
    const data = await fetchList(clients, def, args);
    return jsonResult(withEmptyNote(args.fields ? projectFields(data, args.fields) : data, args));
  } catch (error) {
    return errorResultFrom(error);
  }
}

/**
 * Reject argument combinations that would be dropped or answer a different question.
 *
 * @param def - The resource definition.
 * @param args - Validated tool arguments.
 * @returns The error message, or undefined when the call may proceed.
 */
function validateListArgs(def: ListResource, args: CalmListArgs): string | undefined {
  if (args.timebox_id !== undefined && args.timebox_name !== undefined) {
    return 'Pass either timebox_id or timebox_name, not both.';
  }
  const byTimebox = args.timebox_id !== undefined || args.timebox_name !== undefined;
  if (byTimebox && args.resource !== 'tasks') {
    return "timebox_id/timebox_name apply to resource 'tasks' only.";
  }

  // A parameter the resource does not read would be dropped on the way out, and the answer would
  // come back unfiltered while looking filtered. Reject it and name what the resource does read.
  const ignored = ignoredParams(def, args);
  if (ignored.length > 0) {
    return unsupportedParamsMessage(args.resource, def, ignored);
  }

  const counting = args.count_only === true || args.group_by !== undefined;
  if (counting && args.fields !== undefined) {
    return "'fields' projects records, but count_only/group_by return no records. Drop one of them.";
  }
  if (counting && byTimebox) {
    return (
      'timebox_id/timebox_name cannot be combined with count_only/group_by. Count the project ' +
      "first, or add group_by:'timeboxId' to get the per-sprint breakdown in one call."
    );
  }
  // `count` rides along with the records via `$count`, which only an OData gateway offers. Saying
  // so beats ignoring it: a silently dropped option is how a caller ends up trusting a number that
  // was never returned.
  if (args.count === true && def.kind !== 'odata') {
    return (
      `Resource '${args.resource}' is a REST endpoint with no server-side count. ` +
      'Use count_only:true instead, which counts by paging.'
    );
  }

  if (def.kind === 'rest') {
    const missing = def.required.filter((name) => !args[name as keyof ListParams]);
    if (missing.length > 0) {
      return `Missing required parameter(s) for resource '${args.resource}': ${missing.join(', ')}`;
    }
  }
  return undefined;
}

/** Answer a count_only/group_by call without returning records. */
function countList(clients: CalmClients, def: ListResource, args: CalmListArgs) {
  const request = {
    subject: querySubject(args),
    groupBy: args.group_by,
    groupLimit: args.group_limit,
  };
  if (def.kind === 'odata') {
    return countOData(
      clients,
      def.service,
      def.entitySet,
      { filter: args.filter, orderby: args.orderby },
      request,
    );
  }
  return countRest(clients, def, args, request);
}

/** Fetch the records of one page (or of one timebox) as the service returns them. */
async function fetchList(
  clients: CalmClients,
  def: ListResource,
  args: CalmListArgs,
): Promise<unknown> {
  if (def.kind === 'odata') {
    return clients.listOData(def.service, def.entitySet, {
      filter: args.filter,
      select: args.select,
      expand: args.expand,
      orderby: args.orderby,
      top: args.top,
      skip: args.skip,
      count: args.count,
    });
  }
  if (args.timebox_id !== undefined || args.timebox_name !== undefined) {
    return listTasksInTimebox(clients, def, args);
  }
  const { path, query } = def.build(args);
  return clients.getRest(def.service, path, query);
}
